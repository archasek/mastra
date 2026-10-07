import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

import { RequestError } from '@agentclientprotocol/sdk';
import type { LoadSessionRequest, McpServer, NewSessionRequest } from '@agentclientprotocol/sdk';
import { MastraCodeGateway } from '../agents/mastracode-gateway.js';
import { bootLocalAgentController } from '../index.js';
import type { MastraCodeConfig } from '../index.js';
import type { McpHttpServerConfig } from '../mcp/types.js';
import { loadSettings, resolveDefaultThinkingLevel } from '../onboarding/settings.js';
import { remapOpenAIModelForCodexOAuth, stripMastraGatewayPrefix } from '../providers/model-ids.js';
import { readCodexCatalog } from '../providers/openai-codex-catalog.js';
import { detectProject, getAppDataDir } from '../utils/project.js';
import type { AcpSessionRuntime } from './agent.js';
import { withCleanupFailure } from './errors.js';

export async function createAcpSession(
  request: NewSessionRequest | LoadSessionRequest,
  options: Pick<MastraCodeConfig, 'coAuthor'> = {},
): Promise<AcpSessionRuntime> {
  if (!isAbsolute(request.cwd)) throw RequestError.invalidParams(undefined, 'cwd must be an absolute path');
  if (request.additionalDirectories?.length) {
    throw RequestError.invalidParams(undefined, 'ACP additionalDirectories are not supported');
  }
  const cwd = resolve(request.cwd);
  const projectRoot = detectProject(cwd).rootPath;
  const mcpServers = mapAcpMcpServers(request.mcpServers);
  const requestedMcpNames = new Set(Object.keys(mcpServers));
  const isResume = 'sessionId' in request;
  const initialThreadId = isResume ? request.sessionId : randomUUID();
  let settings: ReturnType<typeof loadSettings>;
  try {
    settings = loadSettings();
  } catch {
    throw RequestError.internalError(undefined, 'Mastra Code ACP settings could not be loaded');
  }
  let result: Awaited<ReturnType<typeof bootLocalAgentController>>;
  try {
    result = await bootLocalAgentController({
      cwd,
      resourceId: `mastracode-acp-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 24)}`,
      initialThreadId,
      ...(isResume ? { requireExistingThread: true } : {}),
      coAuthor: options.coAuthor,
      mcpServers,
      disableMcpConfigDiscovery: true,
      disableMcpOAuth: true,
      disableHooks: true,
      disablePlugins: true,
      disableEnvFile: true,
      disallowExperimentalAgent: true,
      disableGithubSignals: true,
      disableSettingsOmSeed: true,
      unixSocketPubSub: false,
      initialState: {
        projectPath: cwd,
        yolo: false,
        permissionRules: { categories: {}, tools: {} },
      },
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Experimental agent mode is not supported by ACP; use the regular agent.'
    ) {
      throw RequestError.invalidParams(
        undefined,
        'Experimental agent mode is not supported by ACP; use the regular agent.',
      );
    }
    if (error instanceof Error && /thread not found/i.test(error.message)) {
      throw RequestError.invalidParams(undefined, 'ACP session not found');
    }
    throw RequestError.internalError(undefined, 'Mastra Code ACP session initialization failed');
  }

  let cleanupPromise: Promise<void> | undefined;
  const appDataDir = getAppDataDir({ create: false });
  // OAuth ownership is sticky for this conversation; sign-out cannot silently
  // turn its OpenAI model into an API-key request.
  let oauthOwned =
    result.session.state.get().openaiAuthRoute === 'oauth' || result.authStorage.get('openai-codex')?.type === 'oauth';
  const isOAuthModel = (modelId: string) => {
    result.authStorage.reload();
    oauthOwned ||= result.authStorage.get('openai-codex')?.type === 'oauth';
    const explicitGateway = modelId.startsWith('mastra/') && Boolean(MastraCodeGateway.getMastraGatewayApiKey());
    return oauthOwned && !explicitGateway && stripMastraGatewayPrefix(modelId).startsWith('openai/');
  };
  const runtime: AcpSessionRuntime = {
    controller: result.controller,
    session: result.session,
    modes: result.controller.listModes(),
    modelCatalog: {
      isOAuthModel,
      admitModel: async modelId => {
        if (!isOAuthModel(modelId)) return;
        runtime.modelCatalog!.assertModel(modelId);
        await result.session.thread.setSetting({ key: 'openaiAuthRoute', value: 'oauth' });
        await result.session.state.set({ openaiAuthRoute: 'oauth' });
      },
      filterModels: models => {
        isOAuthModel('openai/');
        if (!oauthOwned) return models;
        const catalog = readCodexCatalog(appDataDir);
        return [
          ...models.filter(model => !isOAuthModel(model.id)),
          ...catalog.models.map(id => ({ id, hasApiKey: true })),
        ];
      },
      assertModel: modelId => {
        if (!isOAuthModel(modelId)) return;
        if (result.authStorage.get('openai-codex')?.type !== 'oauth') {
          throw RequestError.authRequired(
            undefined,
            'Sign in to OpenAI Codex to restore this OAuth-owned conversation.',
          );
        }
        const catalog = readCodexCatalog(appDataDir);
        const nativeId = stripMastraGatewayPrefix(remapOpenAIModelForCodexOAuth(modelId));
        if (catalog.status !== 'ready' || !new Set<string>(catalog.models).has(nativeId)) {
          throw RequestError.invalidParams(
            undefined,
            'OpenAI Codex model is unavailable for this account. Refresh the Mastra Code model catalog.',
          );
        }
      },
    },
    getSkills: async () => (await result.controller.resolveWorkspace({ session: result.session }))?.skills,
    getThinkingLevel: () =>
      result.session.state.get().thinkingLevel ??
      resolveDefaultThinkingLevel(settings, result.session.mode.get()).level,
    cleanup: () => (cleanupPromise ??= cleanupRuntime(result)),
  };
  try {
    // SDK-owned metadata is not among core's automatically persisted state
    // preferences. Hydrate it before any catalog authorization or replay.
    // Core's native model-persistence migration owns legacy selection restore.
    // Do not overwrite its single-model result with a second ACP hydration rule.
    const savedRoute = await result.session.thread.getSetting({ key: 'openaiAuthRoute' });
    oauthOwned ||= savedRoute === 'oauth';
    if (isOAuthModel(result.session.model.get() ?? '') && result.session.state.get().openaiAuthRoute !== 'oauth') {
      await result.session.thread.setSetting({ key: 'openaiAuthRoute', value: 'oauth' });
      await result.session.state.set({ openaiAuthRoute: 'oauth' });
    }
    const status = await result.mcpManager?.initInBackground();
    const failed = status?.failed.some(server => requestedMcpNames.has(server.name)) ?? false;
    const disabled = result.mcpManager?.getDisabledServers?.().some(name => requestedMcpNames.has(name)) ?? false;
    if (failed || disabled)
      throw RequestError.internalError(undefined, 'Mastra Code ACP HTTP MCP initialization failed');

    return runtime;
  } catch (error) {
    const safeError =
      error instanceof RequestError
        ? error
        : RequestError.internalError(undefined, 'Mastra Code ACP session setup failed');
    try {
      await runtime.cleanup?.();
    } catch (cleanupError) {
      throw withCleanupFailure(safeError, cleanupError);
    }
    throw safeError;
  }
}

/** Convert untrusted ACP entries to HTTP-only config; never launch client commands. */
export function mapAcpMcpServers(servers: McpServer[]): Record<string, McpHttpServerConfig> {
  const mapped = Object.create(null) as Record<string, McpHttpServerConfig>;
  const names = new Set<string>();

  for (const server of servers) {
    if (!server || typeof server !== 'object' || !('url' in server) || !('type' in server) || server.type !== 'http') {
      throw RequestError.invalidParams(undefined, 'Only HTTP MCP servers are supported by ACP');
    }
    if (
      typeof server.name !== 'string' ||
      !server.name.trim() ||
      server.name !== server.name.trim() ||
      ['__proto__', 'constructor', 'prototype'].includes(server.name) ||
      names.has(server.name)
    ) {
      throw RequestError.invalidParams(undefined, 'Invalid or duplicate ACP MCP server name');
    }
    names.add(server.name);

    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw RequestError.invalidParams(undefined, 'Invalid ACP HTTP MCP URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw RequestError.invalidParams(undefined, 'Unsupported ACP HTTP MCP URL');
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      throw RequestError.invalidParams(undefined, 'Remote ACP HTTP MCP servers must use HTTPS');
    }

    const headers = Object.create(null) as Record<string, string>;
    const seenHeaders = new Set<string>();
    for (const header of server.headers ?? []) {
      if (!header || typeof header.name !== 'string' || typeof header.value !== 'string') {
        throw RequestError.invalidParams(undefined, 'Invalid ACP HTTP MCP headers');
      }
      const normalizedName = header.name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(header.name) ||
        /[\u0000-\u0008\u000a-\u001f\u007f]/.test(header.value) ||
        seenHeaders.has(normalizedName)
      ) {
        throw RequestError.invalidParams(undefined, 'Invalid ACP HTTP MCP headers');
      }
      seenHeaders.add(normalizedName);
      headers[header.name] = header.value;
    }

    mapped[server.name] = {
      url: url.toString(),
      ...(Object.keys(headers).length ? { headers } : {}),
      allowedHosts: [url.host],
      fetch: (target, init) => {
        const destination = new URL(target);
        if (destination.origin !== url.origin || destination.username || destination.password) {
          throw new Error('ACP MCP transport target is outside the validated origin');
        }
        // Fail before following any redirect; custom auth headers never leave
        // the explicitly validated HTTPS or loopback HTTP endpoint.
        return globalThis.fetch(destination, { ...init, redirect: 'error' });
      },
    };
  }
  return mapped;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.split('.')[0] === '127';
}

async function cleanupRuntime(result: Awaited<ReturnType<typeof bootLocalAgentController>>): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => unknown | Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  await attempt(() => result.session.abort());
  await attempt(() => result.session.thread.detachFromCurrent());
  await attempt(() => result.stopPluginSignalProviders());
  await attempt(() => result.githubSignals?.stopAllPolling());
  await attempt(() => result.threadScheduler.stop());
  // The upstream dispatch grace is not cancellation: retain owned drain before shutdown/release.
  await attempt(() => result.stopNotificationDispatch());

  const signalsPubSub = result.signalsPubSub as { close?: () => Promise<void> | void } | undefined;
  // Shutdown drains durable work and needs workers/storage to remain available.
  await attempt(() => result.controller.getMastra()?.shutdown());
  const settled = await Promise.allSettled([
    Promise.resolve().then(() => result.mcpManager?.disconnect()),
    Promise.resolve().then(() => result.controller.getMastra()?.stopWorkers()),
    Promise.resolve().then(() => result.controller.stopIntervals()),
    Promise.resolve().then(() => signalsPubSub?.close?.()),
    Promise.resolve().then(() => result.storageMaintenance.closeStorage?.()),
  ]);
  failures.push(...settled.filter(item => item.status === 'rejected').map(item => item.reason));
  // Even a failed shutdown must retain ownership until fallback cleanup settles.
  await attempt(() => result.session.thread.clearAndReleaseLock());
  if (failures.length) throw new AggregateError(failures, 'ACP runtime cleanup failed');
}

const { appDataDir, previousEnv } = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/mastracode-model-kimi-${process.pid}`;
  const previous = {
    appDataDir: process.env.MASTRA_APP_DATA_DIR,
    kimiApiKey: process.env.KIMI_API_KEY,
    mastraGatewayApiKey: process.env.MASTRA_GATEWAY_API_KEY,
  };
  process.env.MASTRA_APP_DATA_DIR = dir;
  return { appDataDir: dir, previousEnv: previous };
});

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { MastraGateway } from '@mastra/core/llm';
import { RequestContext } from '@mastra/core/request-context';
import { InMemoryStore } from '@mastra/core/storage';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRotationProcessor, AccountStartNoticeProcessor } from '../auth/account-rotation-processor.js';
import { setRequestAccountSelection, markRequestAccountRoutingExhausted } from '../auth/account-routing-context.js';
import type { CredentialStore } from '../auth/types.js';
import { MODEL_ROUTE_MAX_ENTRIES } from '../constants.js';
import { loadSettings } from '../onboarding/settings.js';
import {
  CODEX_CATALOG_CLIENT_VERSION,
  CODEX_CATALOG_ENDPOINT,
  CODEX_CATALOG_FILENAME,
  CODEX_CATALOG_TTL_MS,
  codexCatalogPath,
} from '../providers/openai-codex-catalog.js';
import * as codexProvider from '../providers/openai-codex.js';
import { setCredentialStoreProvider } from './credential-resolver.js';
import { getGlobalAuthStorage, MastraCodeGateway } from './mastracode-gateway.js';
import { createRequestScopedCredentialStore, getDynamicModel, resolveModel, withNativeOAuthRoute } from './model.js';

describe('native OAuth model admission', () => {
  it('constructs a pinned B model before input routing and probes B fallbacks independently of A', async () => {
    mkdirSync(appDataDir, { recursive: true });
    const now = Date.now();
    const accounts = ['a', 'b'].map((accountId, index) => ({
      type: 'oauth-account',
      id: `openai-codex:${accountId}`,
      label: accountId,
      active: index === 0,
      addedAt: '2026-10-07T00:00:00Z',
      access: `token-${accountId}`,
      refresh: `refresh-${accountId}`,
      expires: now + 60_000,
      accountId,
    }));
    writeFileSync(
      join(appDataDir, 'auth.json'),
      JSON.stringify({
        'openai-codex': { ...accounts[0], type: 'oauth' },
        ...Object.fromEntries(accounts.map(account => [`accounts:${account.id}`, account])),
      }),
    );
    for (const account of accounts) {
      const scope = { kind: 'registered' as const, accountInstanceId: account.id, accountId: account.accountId };
      writeFileSync(
        codexCatalogPath(appDataDir, scope),
        JSON.stringify({
          schemaVersion: 1,
          provider: 'openai-codex',
          scope,
          endpoint: CODEX_CATALOG_ENDPOINT,
          clientVersion: CODEX_CATALOG_CLIENT_VERSION,
          fetchedAt: now,
          expiresAt: now + CODEX_CATALOG_TTL_MS,
          slugs: account.accountId === 'a' ? ['gpt-5.6-sol'] : ['gpt-6-luna'],
        }),
      );
    }
    vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
    vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth').mockReturnValue({ apiKey: 'synthetic' });
    const native = vi.spyOn(codexProvider, 'openaiCodexProvider').mockReturnValue({} as never);
    const context = new RequestContext();
    const state = {
      modelRoute: { entries: [{ id: 'b', label: 'B', modelId: 'openai/gpt-6-luna', accountId: accounts[1]!.id }] },
    };
    const metadata: Record<string, unknown> = {};
    context.set('controller', {
      session: { modelId: 'openai/gpt-6-luna', modeId: 'fast' },
      getState: () => state,
      setState: async () => {},
      getThreadSetting: async (key: string) => metadata[key],
      setThreadSetting: async ({ key, value }: { key: string; value: unknown }) => {
        metadata[key] = value;
      },
    });
    // Real Agent construction precedes AccountStartNoticeProcessor.processInput.
    expect(() => getDynamicModel({ requestContext: context })).not.toThrow();
    await expect(native.mock.calls.at(-1)![1]!.authStorage!.getOAuthCredential!('openai-codex')).resolves.toMatchObject(
      {
        accountInstanceId: accounts[1]!.id,
        access: 'token-b',
      },
    );
    expect(getGlobalAuthStorage().getActiveAccount('openai-codex')?.id).toBe(accounts[0]!.id);
    setRequestAccountSelection(context, 'openai-codex', accounts[0]!.id);
    state.modelRoute.entries.unshift({
      id: 'a',
      label: 'A',
      modelId: 'openai/gpt-5.6-sol',
      accountId: accounts[0]!.id,
    });
    const controller = context.get('controller') as { session: { modelId: string } };
    controller.session.modelId = 'openai/gpt-5.6-sol';
    const cascade = getDynamicModel({ requestContext: context });
    expect(Array.isArray(cascade)).toBe(true);
    expect((cascade as Array<{ id: string }>).map(entry => entry.id)).toEqual(['a', 'b']);
    expect(() =>
      resolveModel('openai/gpt-6-luna', { requestContext: context, accountId: accounts[1]!.id }),
    ).not.toThrow();
    await expect(native.mock.calls.at(-1)![1]!.authStorage!.getOAuthCredential!('openai-codex')).resolves.toMatchObject(
      { accountInstanceId: accounts[1]!.id },
    );
    expect(() =>
      resolveModel('openai/gpt-6-luna', { requestContext: context, accountId: 'openai-codex:deleted' }),
    ).toThrow('OAuth is required');
    const aScope = { kind: 'registered' as const, accountInstanceId: accounts[0]!.id, accountId: 'a' };
    const aCachePath = codexCatalogPath(appDataDir, aScope);
    const aCache = JSON.parse(readFileSync(aCachePath, 'utf8'));
    aCache.slugs.push('gpt-6-luna');
    writeFileSync(aCachePath, JSON.stringify(aCache));
    const automatic = new RequestContext();
    automatic.set('controller', {
      ...(context.get('controller') as object),
      session: { modelId: 'openai/gpt-6-luna', modeId: 'fast' },
      getState: () => ({
        modelRoute: { entries: [{ id: 'automatic', label: 'Automatic', modelId: 'openai/gpt-6-luna' }] },
      }),
    });
    setRequestAccountSelection(automatic, 'openai-codex', accounts[0]!.id);
    resolveModel('openai/gpt-6-luna', { requestContext: automatic });
    const automaticFacade = native.mock.calls.at(-1)![1]!.authStorage!;
    await expect(automaticFacade.getOAuthCredential!('openai-codex')).resolves.toMatchObject({ access: 'token-a' });
    const owner = getGlobalAuthStorage();
    const rotation = new AccountRotationProcessor({ credentialStore: owner });
    await expect(
      rotation.processAPIError({
        error: Object.assign(new Error('synthetic rate limit'), {
          statusCode: 429,
          url: 'https://chatgpt.com/backend-api/codex/responses',
        }),
        state: {},
        retryCount: 0,
        stepNumber: 0,
        steps: [],
        requestContext: automatic,
        writer: { custom: vi.fn(async () => {}) },
      } as never),
    ).resolves.toEqual({ retry: true });
    // Reuse the same prepared provider facade, as core's retry does.
    await expect(automaticFacade.getOAuthCredential!('openai-codex')).resolves.toMatchObject({
      accountInstanceId: accounts[1]!.id,
      access: 'token-b',
    });
  });
  it.each(['main', 'non-forked-subagent'] as const)(
    'persists first non-ACP %s OAuth admission and rejects a restored key fallback',
    async entrypoint => {
      mkdirSync(appDataDir, { recursive: true });
      const now = Date.now();
      const credential = {
        type: 'oauth',
        access: 'synthetic',
        refresh: 'synthetic',
        expires: now + 60_000,
        accountId: 'a',
      };
      const id = 'openai-codex:registered-a';
      writeFileSync(
        join(appDataDir, 'auth.json'),
        JSON.stringify({
          'openai-codex': credential,
          [`accounts:${id}`]: {
            ...credential,
            type: 'oauth-account',
            id,
            label: 'A',
            active: true,
            addedAt: '2026-10-07T00:00:00Z',
          },
        }),
      );
      const scope = { kind: 'registered' as const, accountInstanceId: id, accountId: 'a' };
      writeFileSync(
        codexCatalogPath(appDataDir, scope),
        JSON.stringify({
          schemaVersion: 1,
          provider: 'openai-codex',
          scope,
          endpoint: CODEX_CATALOG_ENDPOINT,
          clientVersion: CODEX_CATALOG_CLIENT_VERSION,
          fetchedAt: now,
          expiresAt: now + CODEX_CATALOG_TTL_MS,
          slugs: ['gpt-6-luna'],
        }),
      );
      const nativeStorage = new InMemoryStore();
      const makeController = () =>
        new AgentController({
          id: 'route-proof',
          storage: nativeStorage,
          subagents: [
            {
              id: 'explore',
              name: 'Explore',
              description: 'Fixture',
              instructions: 'Never infer.',
              defaultModelId: 'openai/gpt-6-luna',
              tools: {},
            },
          ],
          resolveSubagentModel: (modelId, options) => resolveModel(modelId, options),
          modes: [
            {
              id: 'build',
              name: 'Build',
              default: true,
              agent: new Agent({
                id: 'route-agent',
                name: 'Route',
                instructions: 'Never invoked.',
                model: 'anthropic/claude-haiku-4-5',
              }),
            },
          ],
        });
      const first = makeController();
      await first.init();
      const session = await first.createSession({ id: 'first', ownerId: 'owner' });
      const thread = await session.thread.create();
      const context = new RequestContext();
      context.set('controller', {
        getThreadSetting: (key: string) => session.thread.getSetting({ key }),
        setThreadSetting: (setting: { key: string; value: unknown }) => session.thread.setSetting(setting),
        getState: () => session.state.get(),
        setState: (state: { openaiAuthRoute: 'oauth' }) => session.state.set(state),
      });
      vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
      const nativeProvider = vi.spyOn(codexProvider, 'openaiCodexProvider').mockReturnValue({
        specificationVersion: 'v2',
        provider: 'synthetic-codex',
        modelId: 'gpt-6-luna',
        supportedUrls: {},
        doGenerate: vi.fn(() => {
          throw new Error('External inference forbidden');
        }),
        doStream: vi.fn(() => {
          throw new Error('External inference forbidden');
        }),
      } as never);
      const auth = vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth').mockReturnValue({ apiKey: 'synthetic' });
      if (entrypoint === 'main') {
        await withNativeOAuthRoute(context, () => resolveModel('openai/gpt-6-luna', { requestContext: context }));
      } else {
        const stream = vi.spyOn(Agent.prototype, 'stream').mockImplementation(async () => {
          const facade = nativeProvider.mock.calls.at(-1)![1]!.authStorage!;
          await facade.getOAuthCredential!('openai-codex');
          expect(await session.thread.getSetting({ key: 'openaiAuthRoute' })).toBe('oauth');
          return {
            fullStream: (async function* () {})(),
            getFullOutput: async () => ({ text: 'synthetic child result' }),
          } as never;
        });
        const toolsets = await (first as any).buildToolsets(session, context);
        const result = await toolsets.controllerBuiltIn.subagent.execute(
          { agentType: 'explore', task: 'Fixture', forked: false },
          { requestContext: context },
        );
        expect(result).toMatchObject({ isError: false, content: 'synthetic child result' });
        expect(stream).toHaveBeenCalledOnce();
        stream.mockRestore();
      }
      const memory = await nativeStorage.getStore('memory');
      expect((await memory!.getThreadById({ threadId: thread.id }))?.metadata?.openaiAuthRoute).toBe('oauth');
      await session.thread.detachFromCurrent();
      writeFileSync(
        join(appDataDir, 'auth.json'),
        JSON.stringify({ 'apikey:openai-codex': { type: 'api_key', key: 'synthetic-key' } }),
      );
      const restarted = makeController();
      await restarted.init();
      const restored = await restarted.createSession({ id: 'restored', ownerId: 'owner' });
      await restored.thread.switch({ threadId: thread.id });
      const restoredContext = new RequestContext();
      restoredContext.set('controller', {
        getThreadSetting: (key: string) => restored.thread.getSetting({ key }),
        setThreadSetting: (setting: { key: string; value: unknown }) => restored.thread.setSetting(setting),
        getState: () => restored.state.get(),
        setState: (state: { openaiAuthRoute: 'oauth' }) => restored.state.set(state),
      });
      auth.mockClear();
      await expect(
        withNativeOAuthRoute(restoredContext, () =>
          resolveModel('openai/gpt-6-luna', { requestContext: restoredContext }),
        ),
      ).rejects.toThrow('OAuth is required');
      expect(auth).not.toHaveBeenCalled();
      if (entrypoint === 'non-forked-subagent') {
        const stream = vi.spyOn(Agent.prototype, 'stream');
        const toolsets = await (restarted as any).buildToolsets(restored, restoredContext);
        const result = await toolsets.controllerBuiltIn.subagent.execute(
          { agentType: 'explore', task: 'Fixture', forked: false },
          { requestContext: restoredContext },
        );
        expect(result.isError).toBe(true);
        expect(stream).not.toHaveBeenCalled();
        expect(auth).not.toHaveBeenCalled();
      }
      await restored.thread.detachFromCurrent();
    },
  );

  it('admits a real native provisional legacy identity without writing auth or cache', async () => {
    mkdirSync(appDataDir, { recursive: true });
    const now = Date.now();
    const credential = {
      type: 'oauth',
      access: 'legacy',
      refresh: 'legacy',
      expires: now + 60_000,
      accountId: 'legacy-a',
    };
    const authPath = join(appDataDir, 'auth.json');
    const cachePath = join(appDataDir, CODEX_CATALOG_FILENAME);
    writeFileSync(authPath, JSON.stringify({ 'openai-codex': credential }));
    writeFileSync(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        provider: 'openai-codex',
        scope: { kind: 'legacy', accountId: 'legacy-a' },
        endpoint: CODEX_CATALOG_ENDPOINT,
        clientVersion: CODEX_CATALOG_CLIENT_VERSION,
        fetchedAt: now,
        expiresAt: now + CODEX_CATALOG_TTL_MS,
        slugs: ['gpt-6-luna'],
      }),
    );
    const before = [readFileSync(authPath, 'utf8'), readFileSync(cachePath, 'utf8')];
    const owner = getGlobalAuthStorage();
    owner.reload();
    expect(owner.getActiveAccount('openai-codex')?.id).toBeDefined();
    vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
    vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth').mockReturnValue({ apiKey: 'synthetic' });
    const native = vi.spyOn(codexProvider, 'openaiCodexProvider').mockReturnValue({} as never);
    const automatic = new RequestContext();
    const routeState: Record<string, unknown> = {
      modelRoute: { entries: [{ id: 'openai', label: 'OpenAI', modelId: 'openai/gpt-6-luna' }] },
    };
    const metadata: Record<string, unknown> = {};
    automatic.set('controller', {
      session: { modelId: 'openai/gpt-6-luna', modeId: 'fast' },
      getState: () => routeState,
      setState: async (updates: Record<string, unknown>) => Object.assign(routeState, updates),
      getThreadSetting: async (key: string) => metadata[key],
      setThreadSetting: async ({ key, value }: { key: string; value: unknown }) => {
        metadata[key] = value;
      },
    });
    await new AccountStartNoticeProcessor({ credentialStore: owner }).processInput({
      state: {},
      messageList: [],
      systemMessages: [],
      writer: { custom: vi.fn(async () => {}) },
      requestContext: automatic,
    } as never);
    resolveModel('openai/gpt-6-luna', { requestContext: automatic });
    await expect(native.mock.calls[0]![1]!.authStorage!.getOAuthCredential!('openai-codex')).resolves.toMatchObject({
      accountId: 'legacy-a',
    });
    expect([readFileSync(authPath, 'utf8'), readFileSync(cachePath, 'utf8')]).toEqual(before);
    const selected = new RequestContext();
    setRequestAccountSelection(selected, 'openai-codex', 'openai-codex:deleted');
    expect(() => resolveModel('openai/gpt-6-luna', { requestContext: selected })).toThrow('OAuth is required');
  });
  it('hydrates durable OAuth authority before resolving a restored background request', async () => {
    const storage = getGlobalAuthStorage();
    vi.spyOn(storage, 'reload').mockImplementation(() => {});
    vi.spyOn(storage, 'get').mockReturnValue(undefined);
    vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
    const auth = vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth');
    const state: { openaiAuthRoute?: string } = {};
    const context = new RequestContext();
    const setState = vi.fn(async (update: typeof state) => {
      Object.assign(state, update);
    });
    context.set('controller', {
      getThreadSetting: async (key: string) => (key === 'openaiAuthRoute' ? 'oauth' : undefined),
      getState: () => state,
      setState,
    });
    await expect(
      withNativeOAuthRoute(context, () =>
        resolveModel('openai/gpt-6-luna', {
          requestContext: context,
        }),
      ),
    ).rejects.toThrow('OAuth is required');
    expect(setState).toHaveBeenCalledWith({ openaiAuthRoute: 'oauth' });
    expect(auth).not.toHaveBeenCalled();
  });

  it('keeps restored OAuth background requests from falling through to an environment key', () => {
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'synthetic-never-used';
    try {
      const storage = getGlobalAuthStorage();
      vi.spyOn(storage, 'reload').mockImplementation(() => {});
      vi.spyOn(storage, 'get').mockReturnValue(undefined);
      vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
      const auth = vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth');
      const context = new RequestContext();
      context.set('controller', { getState: () => ({ openaiAuthRoute: 'oauth' }) });
      expect(() => resolveModel('openai/gpt-6-luna', { requestContext: context })).toThrow('OAuth is required');
      expect(auth).not.toHaveBeenCalled();
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
  });

  it('rejects a deleted selected OAuth account before constructing an environment-key provider', () => {
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'synthetic-never-used';
    try {
      const storage = getGlobalAuthStorage();
      vi.spyOn(storage, 'reload').mockImplementation(() => {});
      vi.spyOn(storage, 'listAccounts').mockReturnValue([]);
      vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
      const auth = vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth');
      const context = new RequestContext();
      setRequestAccountSelection(context, 'openai-codex', 'deleted-b');
      expect(() => resolveModel('openai/gpt-6-luna', { requestContext: context })).toThrow('OAuth is required');
      expect(() => resolveModel('mastra/openai/gpt-6-luna', { requestContext: context })).toThrow('OAuth is required');
      const exhausted = new RequestContext();
      markRequestAccountRoutingExhausted(exhausted, 'openai-codex');
      expect(() => resolveModel('openai/gpt-6-luna', { requestContext: exhausted })).toThrow('OAuth is required');
      expect(() => resolveModel('mastra/openai/gpt-6-luna', { requestContext: exhausted })).toThrow(
        'OAuth is required',
      );
      expect(auth).not.toHaveBeenCalled();
    } finally {
      if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldKey;
    }
  });
  it('rejects unlisted background models and rechecks account identity at native acquisition', async () => {
    mkdirSync(appDataDir, { recursive: true });
    const storage = getGlobalAuthStorage();
    const now = Date.now();
    const credential = {
      type: 'oauth' as const,
      access: 'synthetic',
      refresh: 'synthetic',
      expires: now + 60_000,
      accountId: 'account-a',
    };
    writeFileSync(join(appDataDir, 'auth.json'), JSON.stringify({ 'openai-codex': credential }));
    writeFileSync(
      join(appDataDir, CODEX_CATALOG_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'openai-codex',
        scope: { kind: 'legacy', accountId: 'account-a' },
        endpoint: CODEX_CATALOG_ENDPOINT,
        clientVersion: CODEX_CATALOG_CLIENT_VERSION,
        fetchedAt: now,
        expiresAt: now + CODEX_CATALOG_TTL_MS,
        slugs: ['gpt-6-luna'],
      }),
    );
    vi.spyOn(storage, 'reload').mockImplementation(() => {});
    vi.spyOn(storage, 'get').mockImplementation(provider => (provider === 'openai-codex' ? credential : undefined));
    vi.spyOn(storage, 'getActiveAccount').mockReturnValue(undefined);
    const acquisition = vi.spyOn(storage, 'getOAuthCredential').mockResolvedValue(credential);
    const native = vi.spyOn(codexProvider, 'openaiCodexProvider').mockReturnValue({} as never);
    const auth = vi.spyOn(MastraCodeGateway.prototype, 'resolveAuth').mockImplementation(function () {
      return { apiKey: 'synthetic' } as never;
    });
    expect(() => resolveModel('openai/gpt-5.4-mini')).toThrow('unavailable');
    expect(auth).not.toHaveBeenCalled();
    expect(() => resolveModel('openai/gpt-6-luna')).not.toThrow();
    const facade = native.mock.calls[0]![1]!.authStorage!;
    await expect(facade.getOAuthCredential!('openai-codex')).resolves.toMatchObject({ accountId: 'account-a' });
    acquisition.mockResolvedValue({ ...credential, accountId: 'account-b' });
    await expect(facade.getOAuthCredential!('openai-codex')).rejects.toThrow('unavailable');
    writeFileSync(join(appDataDir, 'auth.json'), '{}');
    expect(() => resolveModel('openai/gpt-6-luna')).toThrow('unavailable');
  });
});

afterEach(() => {
  if (previousEnv.kimiApiKey === undefined) delete process.env.KIMI_API_KEY;
  else process.env.KIMI_API_KEY = previousEnv.kimiApiKey;
  if (previousEnv.mastraGatewayApiKey === undefined) delete process.env.MASTRA_GATEWAY_API_KEY;
  else process.env.MASTRA_GATEWAY_API_KEY = previousEnv.mastraGatewayApiKey;
  setCredentialStoreProvider(undefined);
  vi.restoreAllMocks();
});

afterAll(() => {
  if (previousEnv.appDataDir === undefined) delete process.env.MASTRA_APP_DATA_DIR;
  else process.env.MASTRA_APP_DATA_DIR = previousEnv.appDataDir;
  rmSync(appDataDir, { recursive: true, force: true });
});

describe('request-scoped credentials', () => {
  it('keeps concurrent request account selections independent', async () => {
    const accounts = [
      {
        type: 'oauth-account' as const,
        id: 'anthropic:a',
        label: 'Account A',
        addedAt: '2026-01-01T00:00:00.000Z',
        active: true,
        access: 'token-a',
        refresh: 'refresh-a',
        expires: Date.now() + 60_000,
      },
      {
        type: 'oauth-account' as const,
        id: 'anthropic:b',
        label: 'Account B',
        addedAt: '2026-01-01T00:00:00.000Z',
        active: false,
        access: 'token-b',
        refresh: 'refresh-b',
        expires: Date.now() + 60_000,
      },
    ];
    const base = {
      reload: vi.fn(),
      get: vi.fn(() => ({ type: 'oauth', access: 'token-a', refresh: 'refresh-a', expires: Date.now() + 60_000 })),
      getStoredApiKey: vi.fn(),
      getApiKey: vi.fn(async (_providerId: string, accountId?: string) =>
        accountId === accounts[1]!.id ? 'token-b' : 'token-a',
      ),
      getOAuthCredential: vi.fn(async (_providerId: string, accountId?: string) => ({
        type: 'oauth' as const,
        access: accountId === accounts[1]!.id ? 'token-b' : 'token-a',
        refresh: accountId === accounts[1]!.id ? 'refresh-b' : 'refresh-a',
        expires: Date.now() + 60_000,
        accountInstanceId: accountId,
      })),
      listAccounts: vi.fn(() => accounts),
    } satisfies CredentialStore;
    const requestA = new RequestContext();
    const requestB = new RequestContext();
    setRequestAccountSelection(requestA, 'anthropic', accounts[0]!.id);
    setRequestAccountSelection(requestB, 'anthropic', accounts[1]!.id);
    const scopedA = createRequestScopedCredentialStore(base, requestA);
    const scopedB = createRequestScopedCredentialStore(base, requestB);

    await expect(scopedA.getOAuthCredential?.('anthropic')).resolves.toMatchObject({ access: 'token-a' });
    await expect(scopedB.getOAuthCredential?.('anthropic')).resolves.toMatchObject({ access: 'token-b' });
    await expect(scopedA.getOAuthCredential?.('anthropic')).resolves.toMatchObject({ access: 'token-a' });
  });

  it('fails closed when a recorded selection no longer resolves to an account', () => {
    const base = {
      reload: vi.fn(),
      // The provider's active credential — the account routing passed over.
      get: vi.fn(() => ({
        type: 'oauth' as const,
        access: 'active-token',
        refresh: 'r',
        expires: Date.now() + 60_000,
      })),
      getStoredApiKey: vi.fn(),
      getApiKey: vi.fn(async () => 'active-token'),
      listAccounts: vi.fn(() => []),
    } satisfies CredentialStore;
    const requestContext = new RequestContext();
    // Selected, then removed before the credential read.
    setRequestAccountSelection(requestContext, 'anthropic', 'anthropic:gone');
    const scoped = createRequestScopedCredentialStore(base, requestContext);

    // Falling through to `base.get` would serve the active account, i.e. the
    // exhausted one routing just refused.
    expect(scoped.get('anthropic')).toBeUndefined();
    expect(base.get).not.toHaveBeenCalled();
  });

  it('still uses the base credential when the request has no selection', () => {
    const base = {
      reload: vi.fn(),
      get: vi.fn(() => ({
        type: 'oauth' as const,
        access: 'active-token',
        refresh: 'r',
        expires: Date.now() + 60_000,
      })),
      getStoredApiKey: vi.fn(),
      getApiKey: vi.fn(async () => 'active-token'),
      listAccounts: vi.fn(() => []),
    } satisfies CredentialStore;
    const scoped = createRequestScopedCredentialStore(base, new RequestContext());

    expect(scoped.get('anthropic')).toMatchObject({ access: 'active-token' });
  });

  it('fails closed on the stored API-key slot when the request selected an account', () => {
    const base = {
      reload: vi.fn(),
      get: vi.fn(),
      getStoredApiKey: vi.fn((provider: string) => (provider === 'anthropic' ? 'sk-ant-provider-wide' : 'sk-other')),
      getApiKey: vi.fn(async () => 'active-token'),
      listAccounts: vi.fn(() => [
        {
          type: 'oauth-account' as const,
          id: 'anthropic:b',
          label: 'Account B',
          addedAt: '2026-01-01T00:00:00.000Z',
          active: false,
          access: 'token-b',
          refresh: 'refresh-b',
          expires: Date.now() + 60_000,
        },
      ]),
    } satisfies CredentialStore;
    const requestContext = new RequestContext();
    setRequestAccountSelection(requestContext, 'anthropic', 'anthropic:b');
    const scoped = createRequestScopedCredentialStore(base, requestContext);

    // The `apikey:` slot is provider-wide, not the account routing selected.
    // Serving it would be an OAuth -> API-key fallback for the same provider.
    expect(scoped.getStoredApiKey('anthropic')).toBeUndefined();
    expect(base.getStoredApiKey).not.toHaveBeenCalled();
    // An unrouted provider on the same request still reads its stored key.
    expect(scoped.getStoredApiKey('openai-codex')).toBe('sk-other');
    expect(base.getStoredApiKey).toHaveBeenCalledWith('openai-codex');
  });

  it('passes the selected account through to getApiKey so the provider slot cannot answer for it', async () => {
    const base = {
      reload: vi.fn(),
      get: vi.fn(),
      getStoredApiKey: vi.fn(),
      getApiKey: vi.fn(async () => 'selected-token'),
    } satisfies CredentialStore;
    const requestContext = new RequestContext();
    setRequestAccountSelection(requestContext, 'anthropic', 'anthropic:b');
    const scoped = createRequestScopedCredentialStore(base, requestContext);

    await expect(scoped.getApiKey('anthropic')).resolves.toBe('selected-token');
    // The selection has to reach the store: with no account argument a provider
    // slot holding an API key answers the call instead of the routed account.
    expect(base.getApiKey).toHaveBeenCalledWith('anthropic', 'anthropic:b');
    // An unrouted provider on the same request is not narrowed.
    await scoped.getApiKey('openai-codex');
    expect(base.getApiKey).toHaveBeenCalledWith('openai-codex', undefined);
  });
});

describe('getDynamicModel error branches', () => {
  it('points at the missing controller context when the run has no session request context at all', () => {
    const requestContext = new RequestContext();
    expect(() => getDynamicModel({ requestContext })).toThrow(
      'No model available: this run started without a controller session context, so no model selection could be resolved.',
    );
  });

  it('keeps the /models guidance when a controller context exists but has no model selected', () => {
    const requestContext = new RequestContext();
    requestContext.set('controller', { session: { modelId: '' } });
    expect(() => getDynamicModel({ requestContext })).toThrow(
      'No model selected. Use /models to select a model first.',
    );
  });
});

describe('getDynamicModel model route', () => {
  const route = [
    { id: 'anthropic', label: 'Anthropic', modelId: 'anthropic/claude-fable-5' },
    { id: 'openai', label: 'OpenAI', modelId: 'openai/gpt-5.6-sol' },
    { id: 'github-copilot', label: 'GitHub Copilot', modelId: 'github-copilot/gpt-4.1' },
  ];

  function requestWithSession(
    modelId: string,
    options?: {
      threadId?: string;
      route?: typeof route;
      pending?: {
        fromEntryId: string;
        toEntryId: string;
        toModelId: string;
        threadId?: string;
        reason: 'pool-exhausted' | 'persistent-outage';
        at: string;
      };
    },
  ) {
    const requestContext = new RequestContext();
    requestContext.set('controller', {
      session: { modelId, modeId: 'build' },
      threadId: options?.threadId,
      getState: () => ({
        modelRoute: options?.route ? { entries: options.route } : undefined,
        mastracodePendingModelFallback: options?.pending,
      }),
    });
    return { requestContext };
  }

  it('returns a bare model when no route is configured', () => {
    const model = getDynamicModel(requestWithSession('anthropic/claude-fable-5'));

    expect(Array.isArray(model)).toBe(false);
    expect((model as { modelId?: string }).modelId).toBe('claude-fable-5');
  });

  it('returns a bare model when the route does not start with the selected model', () => {
    const model = getDynamicModel(requestWithSession('openai/gpt-5.4-mini', { route }));

    expect(Array.isArray(model)).toBe(false);
    expect((model as { modelId?: string }).modelId).toBe('gpt-5.4-mini');
  });

  it('builds a fallback array from the host-supplied route', () => {
    const model = getDynamicModel(requestWithSession('anthropic/claude-fable-5', { route }));
    const entries = model as Array<{ id?: string; model: { modelId?: string } }>;

    expect(entries.map(entry => entry.id)).toEqual(['anthropic', 'openai', 'github-copilot']);
    expect(entries.map(entry => entry.model.modelId)).toEqual(['claude-fable-5', 'gpt-5.6-sol', 'gpt-4.1']);
  });

  it('starts at a same-thread pending route hop', () => {
    const model = getDynamicModel(
      requestWithSession('anthropic/claude-fable-5', {
        threadId: 'thread-1',
        route,
        pending: {
          fromEntryId: 'anthropic',
          toEntryId: 'openai',
          toModelId: 'openai/gpt-5.6-sol',
          threadId: 'thread-1',
          reason: 'pool-exhausted',
          at: '2026-10-05T00:00:00.000Z',
        },
      }),
    );
    const entries = model as Array<{ id?: string; model: { modelId?: string } }>;

    expect(entries.map(entry => entry.id)).toEqual(['openai', 'github-copilot']);
    expect(entries.map(entry => entry.model.modelId)).toEqual(['gpt-5.6-sol', 'gpt-4.1']);
  });

  it('ignores pending fallback state captured for another thread', () => {
    const model = getDynamicModel(
      requestWithSession('anthropic/claude-fable-5', {
        threadId: 'thread-2',
        route,
        pending: {
          fromEntryId: 'anthropic',
          toEntryId: 'openai',
          toModelId: 'openai/gpt-5.6-sol',
          threadId: 'thread-1',
          reason: 'pool-exhausted',
          at: '2026-10-05T00:00:00.000Z',
        },
      }),
    );
    const entries = model as Array<{ id?: string }>;

    expect(entries.map(entry => entry.id)).toEqual(['anthropic', 'openai', 'github-copilot']);
  });

  it('returns the pending model as a bare model when the pending entry is absent from the route', () => {
    const model = getDynamicModel(
      requestWithSession('anthropic/claude-fable-5', {
        threadId: 'thread-1',
        route,
        pending: {
          fromEntryId: 'anthropic',
          toEntryId: 'removed',
          toModelId: 'openai/gpt-5.4-mini',
          threadId: 'thread-1',
          reason: 'pool-exhausted',
          at: '2026-10-05T00:00:00.000Z',
        },
      }),
    );

    expect(Array.isArray(model)).toBe(false);
    expect((model as { modelId?: string }).modelId).toBe('gpt-5.4-mini');
  });

  it('caps route resolution for persisted state that bypassed schema validation', () => {
    const oversizedRoute = Array.from({ length: MODEL_ROUTE_MAX_ENTRIES + 1 }, (_, index) => ({
      id: `route-${index}`,
      label: `Route ${index}`,
      modelId: 'anthropic/claude-fable-5',
    }));
    const model = getDynamicModel(requestWithSession('anthropic/claude-fable-5', { route: oversizedRoute }));

    expect((model as Array<{ id?: string }>).map(entry => entry.id)).toHaveLength(MODEL_ROUTE_MAX_ENTRIES);
    expect((model as Array<{ id?: string }>).at(-1)?.id).toBe(`route-${MODEL_ROUTE_MAX_ENTRIES - 1}`);
  });

  it('truncates the route at an entry whose model cannot resolve', () => {
    const model = getDynamicModel(
      requestWithSession('anthropic/claude-fable-5', {
        route: [route[0]!, { id: 'invalid', label: 'Invalid', modelId: 'not-a-model-id' }, route[1]!],
      }),
    );

    expect(Array.isArray(model)).toBe(false);
    expect((model as { modelId?: string }).modelId).toBe('claude-fable-5');
  });

  it('gives a revisited entry id a unique occurrence suffix', () => {
    const repeatedRoute = [route[0]!, route[1]!, { ...route[0]! }];
    const model = getDynamicModel(requestWithSession('anthropic/claude-fable-5', { route: repeatedRoute }));

    expect((model as Array<{ id?: string }>).map(entry => entry.id)).toEqual(['anthropic', 'openai', 'anthropic#2']);
  });
});

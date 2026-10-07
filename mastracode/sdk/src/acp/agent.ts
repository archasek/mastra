import { isAbsolute } from 'node:path';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AuthMethod,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  ContentBlock,
  ToolCall,
  SessionConfigOption,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  AvailableCommand,
} from '@agentclientprotocol/sdk';
import type {
  AgentController,
  AgentControllerEvent,
  AgentControllerMode,
  MastraDBMessage,
  Session,
} from '@mastra/core/agent-controller';
import { AuthStorage, getOAuthProviders, PROVIDER_DEFAULT_MODELS } from '../auth/storage.js';
import { seedProviderOMDefault } from '../onboarding/om-settings.js';
import {
  getAvailableThinkingLevelsForModel,
  isThinkingLevelSetting,
  normalizeThinkingLevelForModel,
  THINKING_LEVEL_DESCRIPTION,
} from '../thinking.js';
import type { ThinkingLevelSetting } from '../thinking.js';
import { openUrlInBrowser } from '../utils/open-url.js';
import { getCurrentVersion } from '../utils/update-check.js';
import { withCleanupFailure } from './errors.js';
import { handleAgentControllerEvent, mapToolKind } from './event-mapper.js';
import type { PromptState } from './event-mapper.js';
import { expandSkillCommand, listSkillCommands } from './skills.js';
import type { AcpSkills } from './skills.js';

export interface AcpSessionRuntime {
  controller: AgentController;
  session: Session;
  modes: AgentControllerMode[];
  getThinkingLevel?: () => ThinkingLevelSetting;
  getSkills?: () => Promise<AcpSkills | undefined>;
  cleanup?: () => Promise<void>;
  modelCatalog?: {
    filterModels: (models: { id: string; hasApiKey: boolean }[]) => { id: string; hasApiKey: boolean }[];
    isOAuthModel: (modelId: string) => boolean;
    assertModel: (modelId: string) => void;
    admitModel?: (modelId: string) => Promise<void>;
  };
}

export type AcpSessionFactory = (request: NewSessionRequest | LoadSessionRequest) => Promise<AcpSessionRuntime>;

interface SessionEntry extends AcpSessionRuntime {
  models: { modelId: string; name: string }[];
  state: PromptState | null;
  continuationState?: PromptState;
  approvalGates: Set<string>;
  queue: Promise<void>;
  turns: Set<{ cancelled: boolean }>;
  unsubscribe: () => void;
  commands?: AvailableCommand[];
}

const TERMINAL_LOGIN_METHOD_ID = 'mastracode-login';
const BROWSER_LOGIN_PROVIDER_IDS = ['openai-codex', 'kimi-for-coding', 'xai'];
const TERMINAL_LOGIN_PROVIDER_IDS = ['anthropic', 'github-copilot'];

function terminalLogin(id: string, name: string, description: string, loginArgs: string[]): AuthMethod {
  return {
    id,
    name,
    description,
    type: 'terminal',
    args: loginArgs,
    _meta: {
      'terminal-auth': {
        command: process.execPath,
        args: [...process.argv.slice(1, 2), ...loginArgs],
        label: name,
      },
    },
  };
}

function listAuthMethods({ auth, _meta }: InitializeRequest['clientCapabilities'] = {}): AuthMethod[] {
  const providers = getOAuthProviders();
  const methods: AuthMethod[] = providers
    .filter(provider => BROWSER_LOGIN_PROVIDER_IDS.includes(provider.id))
    .map(provider => ({
      id: provider.id,
      name: `Log in with ${provider.name}`,
      description: 'Opens your browser to sign in',
    }));
  if (!auth?.terminal && _meta?.['terminal-auth'] !== true) return methods;
  return [
    ...methods,
    ...providers
      .filter(provider => TERMINAL_LOGIN_PROVIDER_IDS.includes(provider.id))
      .map(provider =>
        terminalLogin(provider.id, `Log in with ${provider.name}`, 'Sign in from a terminal', [
          'login',
          '--provider',
          provider.id,
        ]),
      ),
    terminalLogin(
      TERMINAL_LOGIN_METHOD_ID,
      'Log in with Mastra Code',
      'Sign in to another provider or add an API key from a terminal',
      ['login'],
    ),
  ];
}

function hasUsableModel(available: { id: string; hasApiKey: boolean }[], currentModelId: string): boolean {
  if (available.some(model => model.hasApiKey)) return true;
  return currentModelId !== '' && !available.some(model => model.id === currentModelId);
}

function credentialedDefaultModel(
  available: { id: string; hasApiKey: boolean }[],
  currentModelId: string,
): string | undefined {
  const current = available.find(model => model.id === currentModelId);
  if (currentModelId !== '' && (!current || current.hasApiKey)) return undefined;
  const credentialed = new Set(available.filter(model => model.hasApiKey).map(model => model.id));
  return (
    Object.values(PROVIDER_DEFAULT_MODELS).find(modelId => credentialed.has(modelId)) ??
    available.find(model => model.hasApiKey)?.id
  );
}

/** One ACP connection, with an independent Mastra Code runtime for each conversation. */
export class MastraCodeAcpAgent implements Agent {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingCreations = new Set<Promise<NewSessionResponse | LoadSessionResponse>>();
  private readonly pendingLoads = new Set<string>();
  private readonly startupCleanupFailures: unknown[] = [];
  private supportsElicitation = false;
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly createSession: AcpSessionFactory,
    private readonly version = getCurrentVersion(),
  ) {}

  private getSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry || this.disposed) throw RequestError.invalidParams({ sessionId }, 'Unknown ACP session');
    return entry;
  }

  private enqueue<T>(entry: SessionEntry, operation: () => Promise<T>): Promise<T> {
    const result = entry.queue.then(operation);
    entry.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    const cleanup = Promise.allSettled([
      // A runtime under construction owns its cleanup until it joins sessions.
      Promise.allSettled([...this.pendingCreations]),
      ...entries.map(async entry => {
        for (const turn of entry.turns) turn.cancelled = true;
        if (entry.continuationState) {
          entry.continuationState.cancelled = true;
          entry.continuationState.resolve('aborted');
          entry.session.abort();
        }
        if (entry.state) {
          entry.state.cancelled = true;
          entry.session.abort();
          entry.state?.resolve('aborted');
        }
        // Keep the thread lock until any in-flight prompt has actually left
        // the session queue. Abort can signal completion before sendMessage
        // itself settles, so releasing runtime resources first could admit a
        // second writer to the same thread.
        await entry.queue;
        const failures: unknown[] = [];
        try {
          entry.unsubscribe();
        } catch (error) {
          failures.push(error);
        }
        try {
          await entry.cleanup?.();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'ACP unsubscribe and runtime cleanup both failed');
        }
      }),
    ]).then(results => {
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      failures.push(...this.startupCleanupFailures);
      if (failures.length) throw new AggregateError(failures, 'ACP session cleanup failed');
    });
    // A provider or MCP startup can stall. Keep its cleanup ownership, but let
    // the host terminate the connection if shutdown cannot finish in time.
    this.disposal = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ACP shutdown timed out after 10 seconds')), 10_000);
      void cleanup.then(resolve, reject).finally(() => clearTimeout(timeout));
    });
    return this.disposal;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.supportsElicitation = Boolean(request.clientCapabilities?.elicitation?.form);
    return {
      authMethods: listAuthMethods(request.clientCapabilities),
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'mastracode', title: 'Mastra Code', version: this.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
    };
  }

  async authenticate({ methodId }: AuthenticateRequest): Promise<void> {
    if (methodId === TERMINAL_LOGIN_METHOD_ID || TERMINAL_LOGIN_PROVIDER_IDS.includes(methodId)) return;
    if (!BROWSER_LOGIN_PROVIDER_IDS.includes(methodId)) {
      throw RequestError.invalidParams(undefined, `Unknown authentication method: ${methodId}`);
    }
    const needsTerminal = () =>
      RequestError.internalError(
        undefined,
        "Browser sign-in can't finish on its own. Run `mastracode login` in a terminal to sign in.",
      );
    await new AuthStorage().login(methodId, {
      authMode: 'browser',
      onAuth: ({ url, userCode }) => {
        if (userCode && !url.includes(userCode)) throw needsTerminal();
        process.stderr.write(`Open ${url} to sign in\n`);
        openUrlInBrowser(url);
      },
      onPrompt: async () => {
        throw needsTerminal();
      },
    });
    try {
      seedProviderOMDefault(methodId);
    } catch (error) {
      process.stderr.write(`[acp] memory model unchanged after sign-in: ${error}\n`);
    }
  }

  newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return this.trackCreation(Promise.resolve().then(() => this.createNewSession(request)));
  }

  loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.trackCreation(Promise.resolve().then(() => this.restoreSession(request)));
  }

  private trackCreation<T extends NewSessionResponse | LoadSessionResponse>(creating: Promise<T>): Promise<T> {
    this.pendingCreations.add(creating);
    void creating.then(
      () => this.pendingCreations.delete(creating),
      () => this.pendingCreations.delete(creating),
    );
    return creating;
  }

  private validateSessionRequest(request: NewSessionRequest | LoadSessionRequest): void {
    if (!isAbsolute(request.cwd)) throw RequestError.invalidParams(undefined, 'cwd must be an absolute path');
    if (request.additionalDirectories?.length) {
      throw RequestError.invalidParams(undefined, 'ACP additionalDirectories are not supported');
    }
  }

  private async createNewSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
    this.validateSessionRequest(request);
    const runtime = await this.createSession(request);
    let sessionId: string | undefined;
    let entry: SessionEntry | undefined;
    try {
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      const discovered = await runtime.controller.listAvailableModels();
      const available = runtime.modelCatalog?.filterModels(discovered) ?? discovered;
      if (runtime.modelCatalog?.isOAuthModel('openai/') && !runtime.session.model.get()) {
        throw RequestError.invalidParams(
          undefined,
          'No configured OpenAI Codex default is available. Refresh the Mastra Code model catalog.',
        );
      }
      runtime.modelCatalog?.assertModel(runtime.session.model.get() ?? '');
      if (!hasUsableModel(available, runtime.session.model.get() ?? '')) {
        throw RequestError.authRequired(undefined, 'Sign in to a model provider or add an API key to use Mastra Code');
      }
      const defaultModelId = credentialedDefaultModel(available, runtime.session.model.get() ?? '');
      if (defaultModelId) await runtime.session.model.switch(defaultModelId);
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      sessionId = runtime.session.thread.getId() ?? undefined;
      if (!sessionId) {
        throw RequestError.internalError(undefined, 'Mastra Code ACP runtime has no active thread');
      }
      entry = await this.registerSession(sessionId, runtime);
      const response = { sessionId, ...this.sessionInfo(entry) };
      this.scheduleCommandRefresh(sessionId, entry);
      return response;
    } catch (error) {
      if (entry && sessionId && this.sessions.get(sessionId) === entry) {
        this.sessions.delete(sessionId);
        try {
          entry.unsubscribe();
        } catch (unsubscribeError) {
          if (this.disposed) this.startupCleanupFailures.push(unsubscribeError);
          else error = withCleanupFailure(error, unsubscribeError);
        }
      }
      try {
        await runtime.cleanup?.();
      } catch (cleanupError) {
        if (this.disposed) this.startupCleanupFailures.push(cleanupError);
        else error = withCleanupFailure(error, cleanupError);
      }
      throw error;
    }
  }

  private async restoreSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
    this.validateSessionRequest(request);
    if (this.sessions.has(request.sessionId) || this.pendingLoads.has(request.sessionId)) {
      throw RequestError.invalidParams(undefined, 'ACP session is already loaded');
    }
    this.pendingLoads.add(request.sessionId);
    let runtime: AcpSessionRuntime | undefined;
    let entry: SessionEntry | undefined;
    let stopCapture: (() => void) | undefined;
    try {
      runtime = await this.createSession(request);
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      // Boot already binds and locks the requested thread; switching to the same ID would release that lock.
      if (runtime.session.thread.getId() !== request.sessionId) {
        throw RequestError.invalidParams(undefined, 'ACP session not found');
      }
      const captured: AgentControllerEvent[] = [];
      stopCapture = runtime.session.subscribe(event => {
        captured.push(event.type === 'message_start' ? { ...event, message: structuredClone(event.message) } : event);
      });
      // This synchronous snapshot and subscription share one event-loop boundary.
      // Stored history can include later deltas; use the captured message identity
      // instead of replaying that newer row and then duplicating its live deltas.
      const display = runtime.session.displayState?.get();
      const current = display?.currentMessage;
      const initialMessage = current ? structuredClone(current) : undefined;
      const pendingInteractions: AgentControllerEvent[] = [
        ...[...(display?.pendingApprovals?.values() ?? [])].map(approval => ({
          type: 'tool_approval_required' as const,
          ...structuredClone(approval),
        })),
        ...[...(display?.pendingSuspensions?.values() ?? [])].map(suspension => ({
          type: 'tool_suspended' as const,
          ...structuredClone(suspension),
        })),
      ];
      // Keep capture and the initial snapshot ahead of asynchronous discovery,
      // but authorize the saved selection before any history or live publication.
      const discovered = await runtime.controller.listAvailableModels();
      const available = runtime.modelCatalog?.filterModels(discovered) ?? discovered;
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      const currentModelId = runtime.session.model.get() ?? '';
      await runtime.modelCatalog?.admitModel?.(currentModelId);
      runtime.modelCatalog?.assertModel(currentModelId);
      const currentModel = available.find(model => model.id === currentModelId);
      if (currentModel?.hasApiKey === false || !hasUsableModel(available, currentModelId)) {
        throw RequestError.authRequired(undefined, 'Sign in to a model provider or add an API key to use Mastra Code');
      }
      const messages = await runtime.session.thread.listMessages({ threadId: request.sessionId });
      runtime.modelCatalog?.assertModel(runtime.session.model.get() ?? '');
      const capturedIds = new Set(
        captured.flatMap(event => (event.type === 'message_start' ? [event.message.id] : [])),
      );
      if (initialMessage) capturedIds.add(initialMessage.id);
      const replayedIds = new Set<string>();
      for (const message of messages) {
        if (capturedIds.has(message.id)) continue;
        runtime.modelCatalog?.assertModel(runtime.session.model.get() ?? '');
        await this.replayHistory(request.sessionId, [message]);
        replayedIds.add(message.id);
      }
      entry = await this.registerSession(request.sessionId, runtime, false);
      if (initialMessage) {
        await this.replayHistory(request.sessionId, [initialMessage]);
        replayedIds.add(initialMessage.id);
        this.handleSessionEvent(request.sessionId, entry, { type: 'message_start', message: initialMessage });
      }
      const deliveredInteractions = new Set<string>();
      const restoredApprovals: Array<{
        event: Extract<AgentControllerEvent, { type: 'tool_approval_required' }>;
        after: number;
      }> = [];
      const obsoleteInteraction = (toolCallId: string, after: number, suspension: boolean): boolean =>
        captured
          .slice(after + 1)
          .some(
            next =>
              (suspension && next.type === 'agent_end' && next.reason !== 'suspended') ||
              ((next.type === 'tool_end' || next.type === 'tool_suspension_cancelled') &&
                next.toolCallId === toolCallId),
          );
      for (const event of pendingInteractions) {
        if (event.type !== 'tool_approval_required' && event.type !== 'tool_suspended') continue;
        if (obsoleteInteraction(event.toolCallId, -1, event.type === 'tool_suspended')) continue;
        // A captured transition is newer than the initial parked snapshot.
        if (captured.some(next => 'toolCallId' in next && next.toolCallId === event.toolCallId)) continue;
        deliveredInteractions.add(`${event.type}:${event.toolCallId}`);
        if (event.type === 'tool_approval_required') restoredApprovals.push({ event, after: -1 });
        else this.handleSessionEvent(request.sessionId, entry, event);
      }
      for (let index = 0; index < captured.length; index++) {
        if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
        const event = captured[index]!;
        if (event.type === 'message_start' && !replayedIds.has(event.message.id)) {
          await this.replayHistory(request.sessionId, [event.message]);
          replayedIds.add(event.message.id);
        }
        if (event.type === 'tool_approval_required' || event.type === 'tool_suspended') {
          if (obsoleteInteraction(event.toolCallId, index, event.type === 'tool_suspended')) continue;
          const key = `${event.type}:${event.toolCallId}`;
          if (deliveredInteractions.has(key)) continue;
          deliveredInteractions.add(key);
          if (event.type === 'tool_approval_required') {
            restoredApprovals.push({ event, after: index });
            continue;
          }
        }
        this.handleSessionEvent(request.sessionId, entry, event);
      }
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      // Approvals survive unrelated agent_end events in the native display.
      // Dispatch after buffered lifecycle replay so those events cannot finish
      // the mapper state before a still-armed approval receives its answer.
      for (const { event, after } of restoredApprovals) {
        if (!obsoleteInteraction(event.toolCallId, after, false)) {
          this.handleSessionEvent(request.sessionId, entry, event);
        }
      }
      // Handoff is synchronous: there is no await or unobserved event between
      // the private capture and the public subscription.
      const unsubscribeCapture = stopCapture;
      stopCapture = undefined;
      unsubscribeCapture();
      entry.unsubscribe = runtime.session.subscribe(event => this.handleSessionEvent(request.sessionId, entry!, event));
      this.sessions.set(request.sessionId, entry);
      const response = this.sessionInfo(entry);
      this.scheduleCommandRefresh(request.sessionId, entry);
      return response;
    } catch (error) {
      // Revoke private callbacks before attempting any cleanup, including an
      // unsubscribe implementation which itself throws.
      if (entry?.continuationState) {
        entry.continuationState.cancelled = true;
        entry.continuationState.resolve('aborted');
      }
      if (stopCapture) {
        try {
          stopCapture();
        } catch (unsubscribeError) {
          if (this.disposed) this.startupCleanupFailures.push(unsubscribeError);
          else error = withCleanupFailure(error, unsubscribeError);
        }
        stopCapture = undefined;
      }
      if (entry) {
        this.sessions.delete(request.sessionId);
        try {
          entry.unsubscribe();
        } catch (unsubscribeError) {
          if (this.disposed) this.startupCleanupFailures.push(unsubscribeError);
          else error = withCleanupFailure(error, unsubscribeError);
        }
      }
      if (runtime) {
        try {
          await runtime.cleanup?.();
        } catch (cleanupError) {
          if (this.disposed) this.startupCleanupFailures.push(cleanupError);
          else error = withCleanupFailure(error, cleanupError);
        }
      }
      if (error instanceof Error && /thread not found/i.test(error.message)) {
        throw RequestError.invalidParams(undefined, 'ACP session not found');
      }
      throw error;
    } finally {
      this.pendingLoads.delete(request.sessionId);
    }
  }

  private async registerSession(sessionId: string, runtime: AcpSessionRuntime, publish = true): Promise<SessionEntry> {
    if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
    await runtime.modelCatalog?.admitModel?.(runtime.session.model.get() ?? '');
    runtime.modelCatalog?.assertModel(runtime.session.model.get() ?? '');
    let models: NewSessionResponse['models'];
    try {
      const currentModelId = runtime.session.model.get() ?? '';
      const discovered = await runtime.controller.listAvailableModels();
      const available = runtime.modelCatalog?.filterModels(discovered) ?? discovered;
      models = {
        currentModelId,
        availableModels: includeCurrentModel(
          [
            ...new Map(
              available
                .filter(model => model.hasApiKey || model.id === currentModelId)
                .map(
                  model =>
                    [
                      model.id,
                      { modelId: model.id, name: model.hasApiKey ? model.id : `${model.id} (provider not configured)` },
                    ] as const,
                ),
            ).values(),
          ],
          runtime.modelCatalog?.isOAuthModel(currentModelId) ? '' : currentModelId,
        ),
      };
    } catch {
      // Discovery may be unavailable before provider authentication.
    }
    if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
    const entry: SessionEntry = {
      ...runtime,
      models: models?.availableModels ?? [],
      state: null,
      approvalGates: new Set(),
      queue: Promise.resolve(),
      turns: new Set(),
      unsubscribe: () => {},
      commands: [],
    };
    if (publish) {
      entry.unsubscribe = runtime.session.subscribe(event => this.handleSessionEvent(sessionId, entry, event));
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }

  private handleSessionEvent(sessionId: string, entry: SessionEntry, event: AgentControllerEvent): void {
    if (event.type === 'tool_approval_required') entry.approvalGates.add(event.toolCallId);
    if (event.type === 'tool_end' || event.type === 'tool_suspension_cancelled') {
      entry.approvalGates.delete(event.toolCallId);
    }
    // Durable continuations emit outside an ACP prompt request. They still
    // require a mapper state, but must not resolve or overwrite a prompt.
    if (
      !entry.state &&
      (event.type === 'agent_start' ||
        event.type === 'message_start' ||
        event.type === 'tool_approval_required' ||
        event.type === 'tool_suspended')
    ) {
      if (!entry.continuationState || entry.continuationState.finished) {
        const state: PromptState = {
          sessionId,
          supportsElicitation: this.supportsElicitation,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          isActive: () => !this.disposed && entry.continuationState === state && !state.finished,
          isApprovalActive: toolCallId => !this.disposed && !state.cancelled && entry.approvalGates.has(toolCallId),
          resolve: () => {
            state.finished = true;
          },
        };
        entry.continuationState = state;
      }
    }
    handleAgentControllerEvent(event, entry.state ?? entry.continuationState ?? null, this.connection, entry.session);
    if (event.type === 'mode_changed') {
      void this.connection
        .sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'current_mode_update', currentModeId: entry.session.mode.get() },
        })
        .catch(() => process.stderr.write('[acp] Mode update delivery failed.\n'));
    }
    if (
      event.type === 'mode_changed' ||
      event.type === 'model_changed' ||
      (event.type === 'state_changed' && event.changedKeys.includes('thinkingLevel'))
    ) {
      void this.connection
        .sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: this.configOptions(entry) },
        })
        .catch(() => process.stderr.write('[acp] Configuration update delivery failed.\n'));
    }
  }

  private scheduleCommandRefresh(sessionId: string, entry: SessionEntry): void {
    // Let the SDK send the session response; loadSession also finishes ordered
    // history replay before any command-discovery notification is sent.
    setImmediate(() => {
      void this.enqueue(entry, async () => {
        if (!this.disposed && this.sessions.get(sessionId) === entry) {
          await this.refreshCommands(sessionId, entry);
        }
      }).catch(() => process.stderr.write('[acp] Command discovery failed.\n'));
    });
  }

  private sessionInfo(entry: SessionEntry): Omit<NewSessionResponse, 'sessionId'> {
    const modelId = entry.session.model.get() ?? '';
    const availableModels = this.catalogModels(entry);
    return {
      modes: {
        currentModeId: entry.session.mode.get(),
        availableModes: entry.modes.map(mode => ({ id: mode.id, name: mode.name ?? mode.id })),
      },
      models: availableModels.length ? { currentModelId: modelId, availableModels } : undefined,
      configOptions: this.configOptions(entry),
    };
  }

  private async replayHistory(sessionId: string, messages: MastraDBMessage[]): Promise<void> {
    for (const message of messages) {
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' =
        message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk';
      for (const replayPart of getReplayParts(message)) {
        if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
        const update =
          replayPart.kind === 'tool'
            ? { sessionUpdate: 'tool_call' as const, ...replayPart.toolCall }
            : { sessionUpdate, content: replayPart.content };
        await this.connection.sessionUpdate({ _meta: { isReplay: true }, sessionId, update });
      }
    }
  }

  private async refreshCommands(sessionId: string, entry: SessionEntry): Promise<AcpSkills | undefined> {
    const skills = await entry.getSkills?.();
    const commands = await listSkillCommands(skills);
    if (JSON.stringify(commands) !== JSON.stringify(entry.commands)) {
      await this.connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
      });
      entry.commands = commands;
    }
    return skills;
  }

  private configOptions(entry: SessionEntry): SessionConfigOption[] {
    const modelId = entry.session.model.get() ?? '';
    const options: SessionConfigOption[] = [];
    const models = this.catalogModels(entry);
    if (models.length)
      options.push({
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: modelId,
        options: models.map(model => ({ value: model.modelId, name: model.name })),
      });
    options.push({
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: entry.session.mode.get(),
      options: entry.modes.map(mode => ({ value: mode.id, name: mode.name ?? mode.id })),
    });
    if (entry.getThinkingLevel)
      options.push({
        id: 'thought_level',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        description: THINKING_LEVEL_DESCRIPTION,
        currentValue: this.thinkingLevel(entry),
        options: getAvailableThinkingLevelsForModel(modelId).map(value => ({
          value,
          name: value === 'off' ? 'Default' : value[0]!.toUpperCase() + value.slice(1),
        })),
      });
    return options;
  }

  private thinkingLevel(entry: SessionEntry, modelId = entry.session.model.get() ?? ''): ThinkingLevelSetting {
    const level = entry.getThinkingLevel?.() ?? 'off';
    return normalizeThinkingLevelForModel(level, modelId);
  }

  private catalogModels(entry: SessionEntry): SessionEntry['models'] {
    const modelId = entry.session.model.get() ?? '';
    const models = entry.modelCatalog
      ? entry.modelCatalog
          .filterModels(entry.models.map(model => ({ id: model.modelId, hasApiKey: true })))
          .map(model => ({ modelId: model.id, name: model.id }))
      : entry.models;
    return includeCurrentModel(models, entry.modelCatalog?.isOAuthModel(modelId) ? '' : modelId);
  }

  private async authorizeMode(entry: SessionEntry, _modeId: string): Promise<void> {
    if (!entry.modelCatalog) return;
    // Native controller modes now retain one session-wide selected model.
    const modelId = entry.session.model.get();
    await entry.modelCatalog.admitModel?.(modelId ?? '');
    entry.modelCatalog.assertModel(modelId ?? '');
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const entry = this.getSession(params.sessionId);
    return this.enqueue(entry, async () => {
      this.getSession(params.sessionId);
      const option = this.configOptions(entry).find(option => option.id === params.configId);
      if (
        !option ||
        option.type !== 'select' ||
        !option.options.some(item => 'value' in item && item.value === params.value)
      ) {
        throw RequestError.invalidParams(undefined, 'Unknown session configuration selection');
      }
      if (params.configId === 'model') {
        const modelId = String(params.value);
        await entry.modelCatalog?.admitModel?.(modelId);
        entry.modelCatalog?.assertModel(modelId);
        await entry.session.model.switch(modelId, {
          ...(entry.getThinkingLevel ? { thinkingLevel: this.thinkingLevel(entry, modelId) } : {}),
        });
      } else if (params.configId === 'mode') {
        await this.authorizeMode(entry, String(params.value));
        await entry.session.mode.switch({ modeId: String(params.value) });
      } else if (isThinkingLevelSetting(params.value)) {
        await entry.session.state.set({ thinkingLevel: params.value });
      }
      if (entry.getThinkingLevel && entry.getThinkingLevel() !== this.thinkingLevel(entry)) {
        await entry.session.state.set({ thinkingLevel: this.thinkingLevel(entry) });
      }
      return { configOptions: this.configOptions(entry) };
    });
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    const entry = this.getSession(request.sessionId);
    const message = mapPromptContent(request.prompt);
    const content = message.content;
    const turn = { cancelled: false };
    entry.turns.add(turn);
    try {
      return await this.enqueue(entry, async () => {
        if (turn.cancelled || this.disposed) return { stopReason: 'cancelled' };
        await this.authorizeMode(entry, entry.session.mode.get());
        entry.modelCatalog?.assertModel(entry.session.model.get() ?? '');
        const usage: PromptState['usage'] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        let complete!: PromptState['resolve'];
        const completion = new Promise<Parameters<PromptState['resolve']>[0]>(resolve => {
          complete = resolve;
        });
        const state: PromptState = {
          sessionId: request.sessionId,
          supportsElicitation: this.supportsElicitation,
          isActive: () => entry.state === state && !state.finished && !state.cancelled,
          usage,
          resolve: reason => {
            state.finished = true;
            complete(reason);
          },
        };
        entry.state = state;
        try {
          const skills = await this.refreshCommands(request.sessionId, entry);
          const expanded = await expandSkillCommand(content, skills, entry.commands ?? []);
          if (turn.cancelled || this.disposed) return { stopReason: 'cancelled' };
          await this.authorizeMode(entry, entry.session.mode.get());
          entry.modelCatalog?.assertModel(entry.session.model.get() ?? '');
          await entry.session.sendMessage({
            content: expanded,
            ...(message.files.length ? { files: message.files } : {}),
          });
          const reason = await completion;
          if (reason === 'error' && !state.cancelled && !state.stopReason) {
            throw RequestError.internalError(undefined, 'Mastra Code turn failed');
          }
          return {
            stopReason: state.cancelled ? 'cancelled' : (state.stopReason ?? mapStopReason(reason)),
            usage: {
              inputTokens: usage.promptTokens,
              outputTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              thoughtTokens: usage.reasoningTokens,
              cachedReadTokens: usage.cachedInputTokens,
              cachedWriteTokens: usage.cacheCreationInputTokens,
            },
          };
        } catch (error) {
          if (state.cancelled) return { stopReason: 'cancelled' };
          if (error instanceof RequestError) throw error;
          throw RequestError.internalError(undefined, 'Mastra Code turn failed');
        } finally {
          state.finished = true;
          if (entry.state === state) entry.state = null;
        }
      });
    } finally {
      entry.turns.delete(turn);
    }
  }

  async cancel(notification: CancelNotification): Promise<void> {
    const entry = this.sessions.get(notification.sessionId);
    if (!entry) return;
    const approvals = [...entry.approvalGates];
    entry.approvalGates.clear();
    for (const turn of entry.turns) turn.cancelled = true;
    const state = entry.state ?? entry.continuationState;
    if (state && (!state.finished || approvals.length > 0) && !state.cancelled) {
      state.cancelled = true;
      for (const toolCallId of approvals) {
        entry.session.respondToToolApproval({ decision: 'decline', toolCallId });
      }
      // Persist denial before aborting, otherwise a parked snapshot can replay on the next turn.
      for (const deny of state.cancelSuspensions?.values() ?? []) {
        try {
          await deny();
        } catch {
          /* Still abort if the suspended run is no longer available. */
        }
      }
      state.cancelSuspensions?.clear();
      if ((entry.state ?? entry.continuationState) !== state) return;
      entry.session.abort();
      // A suspended run has already ended and will not emit another agent_end.
      if (state.suspended) {
        entry.session.stream.detach();
        state.resolve('aborted');
      }
    }
  }

  async setSessionMode(params: { sessionId: string; modeId: string }): Promise<void> {
    const entry = this.getSession(params.sessionId);
    if (!entry.modes.some(mode => mode.id === params.modeId))
      throw RequestError.invalidParams(undefined, 'Unknown mode');
    await this.enqueue(entry, async () => {
      if (this.disposed) return;
      await this.authorizeMode(entry, params.modeId);
      await entry.session.mode.switch({ modeId: params.modeId });
    });
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const entry = this.getSession(params.sessionId);
    await this.enqueue(entry, async () => {
      if (this.disposed) return;
      if (!this.catalogModels(entry).some(model => model.modelId === params.modelId)) {
        throw RequestError.invalidParams(
          undefined,
          'Model is unavailable or its provider is not configured. Refresh the model list.',
        );
      }
      await entry.modelCatalog?.admitModel?.(params.modelId);
      entry.modelCatalog?.assertModel(params.modelId);
      await entry.session.model.switch(params.modelId);
    });
  }
}

function includeCurrentModel(models: SessionEntry['models'], currentModelId: string): SessionEntry['models'] {
  // Saved/custom model IDs may work even when discovery only returns a gateway-qualified alias.
  return currentModelId && !models.some(model => model.modelId === currentModelId)
    ? [{ modelId: currentModelId, name: currentModelId }, ...models]
    : models;
}

export function mapPromptContent(blocks: ContentBlock[]): {
  content: string;
  files: { data: string; mediaType: string; filename?: string }[];
} {
  const textParts: string[] = [];
  const files: { data: string; mediaType: string; filename?: string }[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'resource_link') {
      textParts.push(`[resource: ${block.uri}]`);
    } else if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource) {
        if (resource.uri) textParts.push(`[resource: ${resource.uri}]`);
        textParts.push(resource.text);
      } else if (resource.mimeType?.startsWith('image/')) {
        files.push({
          data: `data:${resource.mimeType};base64,${resource.blob}`,
          mediaType: resource.mimeType,
          ...(resource.uri ? { filename: resource.uri } : {}),
        });
      } else {
        throw RequestError.invalidParams(undefined, 'Unsupported embedded ACP resource');
      }
    } else if (block.type === 'image') {
      if (!block.mimeType.startsWith('image/')) {
        throw RequestError.invalidParams(undefined, 'Unsupported ACP image MIME type');
      }
      files.push({ data: `data:${block.mimeType};base64,${block.data}`, mediaType: block.mimeType });
    } else {
      throw RequestError.invalidParams(undefined, `Unsupported prompt content: ${block.type}`);
    }
  }
  return { content: textParts.join('\n'), files };
}

/** Kept for callers that need only text from ACP content blocks. */
export function extractTextFromContentBlocks(blocks: ContentBlock[]): string {
  return mapPromptContent(blocks).content;
}

type ReplayPart = { kind: 'content'; content: ContentBlock } | { kind: 'tool'; toolCall: ToolCall };

function getReplayParts(message: MastraDBMessage): ReplayPart[] {
  const content = message.content as unknown as { parts?: unknown[]; content?: unknown };
  const replayParts: ReplayPart[] = [];
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (!part || typeof part !== 'object') continue;
      const value = part as {
        type?: unknown;
        text?: unknown;
        data?: unknown;
        mediaType?: unknown;
        error?: unknown;
        toolInvocation?: unknown;
      };
      if (value.type === 'text' && typeof value.text === 'string') {
        replayParts.push({ kind: 'content', content: { type: 'text', text: value.text } });
      } else if (message.role === 'assistant' && value.type === 'error') {
        const error =
          value.error && typeof value.error === 'object'
            ? (value.error as { name?: unknown; message?: unknown })
            : undefined;
        const name = typeof error?.name === 'string' && error.name ? `${error.name}: ` : '';
        const detail =
          typeof error?.message === 'string' && error.message ? `${name}${error.message}` : 'Stored operation error';
        replayParts.push({
          kind: 'content',
          content: { type: 'text', text: `[Stored error: ${detail}]` },
        });
      } else if (
        value.type === 'file' &&
        typeof value.data === 'string' &&
        typeof value.mediaType === 'string' &&
        value.mediaType.startsWith('image/')
      ) {
        replayParts.push({
          kind: 'content',
          content:
            /^https?:\/\//i.test(value.data) && URL.canParse(value.data)
              ? { type: 'resource_link', uri: value.data, name: 'Stored image', mimeType: value.mediaType }
              : { type: 'image', data: stripDataUrl(value.data), mimeType: value.mediaType },
        });
      } else if (value.type === 'file') {
        replayParts.push({
          kind: 'content',
          content: { type: 'text', text: '[Stored non-image file attachment omitted from ACP replay.]' },
        });
      } else if (message.role === 'assistant' && value.type === 'tool-invocation') {
        const toolCall = getReplayToolCall(value.toolInvocation);
        replayParts.push(
          toolCall
            ? { kind: 'tool', toolCall }
            : { kind: 'content', content: { type: 'text', text: '[Stored tool activity could not be displayed.]' } },
        );
      }
    }
  }
  if (replayParts.length === 0 && typeof content.content === 'string' && content.content) {
    replayParts.push({ kind: 'content', content: { type: 'text', text: content.content } });
  }
  return replayParts;
}

function getReplayToolCall(value: unknown): ToolCall | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const invocation = value as {
    state?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    title?: unknown;
    args?: unknown;
    result?: unknown;
    isError?: unknown;
    errorText?: unknown;
    approval?: { reason?: unknown };
  };
  if (
    typeof invocation.toolCallId !== 'string' ||
    !invocation.toolCallId ||
    typeof invocation.toolName !== 'string' ||
    !invocation.toolName
  ) {
    return null;
  }
  const completed = invocation.state === 'result' && invocation.isError !== true;
  const pending = invocation.state === 'call' || invocation.state === 'partial-call';
  const result =
    invocation.state === 'output-error' &&
    typeof invocation.result === 'string' &&
    invocation.result.trim().length === 0
      ? undefined
      : invocation.result;
  const rawOutput =
    result ??
    (invocation.state === 'output-error' &&
    typeof invocation.errorText === 'string' &&
    invocation.errorText.trim().length > 0
      ? invocation.errorText
      : invocation.state === 'output-denied' && typeof invocation.approval?.reason === 'string'
        ? invocation.approval.reason
        : `No completed result was saved for this tool call (stored state: ${String(invocation.state ?? 'unknown')}).`);
  return {
    toolCallId: invocation.toolCallId,
    title: typeof invocation.title === 'string' && invocation.title ? invocation.title : invocation.toolName,
    kind: mapToolKind(invocation.toolName),
    status: completed ? 'completed' : pending ? 'in_progress' : 'failed',
    ...(invocation.args !== undefined ? { rawInput: invocation.args } : {}),
    ...(!pending ? { rawOutput } : {}),
  };
}

function stripDataUrl(data: string): string {
  const match = data.match(/^data:[^;,]+;base64,(.*)$/s);
  return match?.[1] ?? data;
}

export function mapStopReason(
  reason: 'complete' | 'aborted' | 'error' | 'suspended',
): 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal' {
  switch (reason) {
    case 'complete':
      return 'end_turn';
    case 'aborted':
      return 'cancelled';
    case 'error':
      throw RequestError.internalError(undefined, 'Mastra Code turn failed');
    case 'suspended':
      return 'end_turn';
  }
}

import { isAbsolute } from 'node:path';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type {
  Agent,
  AgentSideConnection,
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
import type { AgentController, AgentControllerMode, MastraDBMessage, Session } from '@mastra/core/agent-controller';
import { getAvailableThinkingLevelsForModel, isThinkingLevelSetting } from '../thinking.js';
import type { ThinkingLevelSetting } from '../thinking.js';
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
}

export type AcpSessionFactory = (request: NewSessionRequest | LoadSessionRequest) => Promise<AcpSessionRuntime>;

interface SessionEntry extends AcpSessionRuntime {
  models: { modelId: string; name: string }[];
  state: PromptState | null;
  queue: Promise<void>;
  turns: Set<{ cancelled: boolean }>;
  unsubscribe: () => void;
  commands?: AvailableCommand[];
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
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'mastracode', title: 'Mastra Code', version: this.version },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
    };
  }

  async authenticate(): Promise<void> {
    throw RequestError.invalidParams(undefined, 'Configure authentication through Mastra Code before starting ACP');
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
    try {
      runtime = await this.createSession(request);
      if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
      // Boot already binds and locks the requested thread; switching to the same ID would release that lock.
      if (runtime.session.thread.getId() !== request.sessionId) {
        throw RequestError.invalidParams(undefined, 'ACP session not found');
      }
      const messages = await runtime.session.thread.listMessages({ threadId: request.sessionId });
      entry = await this.registerSession(request.sessionId, runtime);
      await this.replayHistory(request.sessionId, messages);
      const response = this.sessionInfo(entry);
      this.scheduleCommandRefresh(request.sessionId, entry);
      return response;
    } catch (error) {
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

  private async registerSession(sessionId: string, runtime: AcpSessionRuntime): Promise<SessionEntry> {
    if (this.disposed) throw RequestError.internalError(undefined, 'ACP connection is closed');
    let models: NewSessionResponse['models'];
    try {
      const currentModelId = runtime.session.model.get() ?? '';
      const available = await runtime.controller.listAvailableModels();
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
          currentModelId,
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
      queue: Promise.resolve(),
      turns: new Set(),
      unsubscribe: () => {},
      commands: [],
    };
    entry.unsubscribe = runtime.session.subscribe(event => {
      handleAgentControllerEvent(event, entry.state, this.connection, entry.session);
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
    });
    this.sessions.set(sessionId, entry);
    return entry;
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
    return {
      modes: {
        currentModeId: entry.session.mode.get(),
        availableModes: entry.modes.map(mode => ({ id: mode.id, name: mode.name ?? mode.id })),
      },
      models: entry.models.length
        ? { currentModelId: modelId, availableModels: includeCurrentModel(entry.models, modelId) }
        : undefined,
      configOptions: this.configOptions(entry),
    };
  }

  private async replayHistory(sessionId: string, messages: MastraDBMessage[]): Promise<void> {
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      const sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' =
        message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk';
      for (const replayPart of getReplayParts(message)) {
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
    const models = includeCurrentModel(entry.models, modelId);
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
        description: 'Requested reasoning level. The provider may adjust it for the selected model.',
        currentValue: this.thinkingLevel(entry),
        options: getAvailableThinkingLevelsForModel(modelId).map(value => ({
          value,
          name: value[0]!.toUpperCase() + value.slice(1),
        })),
      });
    return options;
  }

  private thinkingLevel(entry: SessionEntry): ThinkingLevelSetting {
    const level = entry.getThinkingLevel?.() ?? 'off';
    const levels = getAvailableThinkingLevelsForModel(entry.session.model.get() ?? '');
    return levels.includes(level) ? level : 'xhigh';
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
        await entry.session.model.switch({ modelId: String(params.value) });
      } else if (params.configId === 'mode') {
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
    for (const turn of entry.turns) turn.cancelled = true;
    if (entry.state && !entry.state.finished && !entry.state.cancelled) {
      const state = entry.state;
      state.cancelled = true;
      // Persist denial before aborting, otherwise a parked snapshot can replay on the next turn.
      for (const deny of state.cancelSuspensions?.values() ?? []) {
        try {
          await deny();
        } catch {
          /* Still abort if the suspended run is no longer available. */
        }
      }
      state.cancelSuspensions?.clear();
      if (entry.state !== state) return;
      entry.session.abort();
      // A suspended run has already ended and will not emit another agent_end.
      if (entry.state?.suspended) {
        entry.session.stream.detach();
        entry.state.resolve('aborted');
      }
    }
  }

  async setSessionMode(params: { sessionId: string; modeId: string }): Promise<void> {
    const entry = this.getSession(params.sessionId);
    if (!entry.modes.some(mode => mode.id === params.modeId))
      throw RequestError.invalidParams(undefined, 'Unknown mode');
    await this.enqueue(entry, async () => {
      if (this.disposed) return;
      await entry.session.mode.switch({ modeId: params.modeId });
    });
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const entry = this.getSession(params.sessionId);
    await this.enqueue(entry, async () => {
      if (this.disposed) return;
      if (
        !includeCurrentModel(entry.models, entry.session.model.get() ?? '').some(
          model => model.modelId === params.modelId,
        )
      ) {
        throw RequestError.invalidParams(
          undefined,
          'Model is unavailable or its provider is not configured. Refresh the model list.',
        );
      }
      await entry.session.model.switch({ modelId: params.modelId });
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
          content: { type: 'image', data: stripDataUrl(value.data), mimeType: value.mediaType },
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
    status: completed ? 'completed' : 'failed',
    ...(invocation.args !== undefined ? { rawInput: invocation.args } : {}),
    rawOutput,
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

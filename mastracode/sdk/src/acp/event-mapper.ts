import type {
  AgentSideConnection,
  ElicitationPropertySchema,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentControllerEvent, Session, TokenUsage } from '@mastra/core/agent-controller';

let autoApprove = false;

/**
 * Enable or disable automatic tool approval (set via --dangerous-auto-approve CLI flag).
 */
export function setAutoApprove(value: boolean): void {
  autoApprove = value;
}

/**
 * Map a mastracode tool name to an ACP ToolKind.
 */
export function mapToolKind(
  toolName: string,
): 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other' {
  const name = toolName.toLowerCase();
  if (name.includes('edit') || name.includes('write') || name.includes('replace') || name.includes('patch'))
    return 'edit';
  if (name.includes('read') || name.includes('view') || name.includes('list') || name.includes('find')) return 'read';
  if (name.includes('delete') || name.includes('remove')) return 'delete';
  if (name.includes('search') || name.includes('grep') || name.includes('query')) return 'search';
  if (name.includes('execute') || name.includes('run') || name.includes('command') || name.includes('shell'))
    return 'execute';
  if (
    name.includes('fetch') ||
    name.includes('curl') ||
    name.includes('http') ||
    name.includes('browse') ||
    name.includes('navigate')
  )
    return 'fetch';
  if (name.includes('think') || name.includes('reason')) return 'think';
  return 'other';
}

/**
 * Accumulated state for an active prompt turn.
 */
export interface PromptState {
  sessionId: string;
  supportsElicitation?: boolean;
  isActive?: () => boolean;
  activeAssistantMessageId?: string;
  usage: TokenUsage;
  error?: Error;
  stopReason?: 'max_tokens' | 'refusal';
  finished?: boolean;
  cancelled?: boolean;
  suspended?: boolean;
  cancelSuspensions?: Map<string, () => Promise<void>>;
  resolve: (reason: 'complete' | 'aborted' | 'error' | 'suspended') => void;
}

/**
 * Translate an AgentControllerEvent into an ACP SessionNotification and send it
 * via the provided connection. Returns null for events that don't produce
 * a session update.
 */
export function handleAgentControllerEvent(
  event: AgentControllerEvent,
  state: PromptState | null,
  connection: AgentSideConnection,
  session: Session,
): void {
  if (!state || state.finished) return;

  switch (event.type) {
    case 'agent_start':
      state.suspended = false;
      // Startup can arm its controller after cancel first called abort().
      if (state.cancelled && !state.cancelSuspensions?.size) session.completeDeferredAbort();
      break;

    case 'message_start': {
      if (event.message.role === 'assistant') {
        state.activeAssistantMessageId = event.message.id;
        break;
      }
      break;
    }

    case 'message_update':
      if (event.event.type === 'text-delta' && event.id === state.activeAssistantMessageId && event.event.delta) {
        sendUpdate(connection, state.sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: event.event.delta },
        });
      }
      break;

    case 'message_end':
      if (event.id === state.activeAssistantMessageId) {
        state.activeAssistantMessageId = undefined;
      }
      break;

    case 'tool_start':
      sendUpdate(connection, state.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: event.toolCallId,
        title: event.toolName,
        kind: mapToolKind(event.toolName),
        status: 'in_progress',
        rawInput: JSON.stringify(event.args),
      });
      break;

    case 'tool_end':
      sendUpdate(connection, state.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: event.isError ? 'failed' : 'completed',
        rawOutput: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
      });
      break;

    case 'tool_approval_required':
      void handleToolApproval(state, connection, session, event).catch(() => {
        failTurn(state, session, new Error('ACP permission request failed'));
      });
      break;

    case 'tool_suspended':
      void handleToolSuspended(state, connection, session, event).catch(() => {
        failTurn(state, session, new Error('ACP suspended tool could not be resumed'));
      });
      break;

    case 'usage_update':
      accumulateUsage(state.usage, event.usage);
      break;

    case 'error': {
      state.error = event.error;
      // Local core adds provider finish reasons before its generated workspace
      // declarations are rebuilt; keep ACP compilable against the prior package d.ts.
      const finishReason = (event as typeof event & { finishReason?: string }).finishReason;
      if (finishReason === 'length') state.stopReason = 'max_tokens';
      else if (finishReason === 'content-filter') state.stopReason = 'refusal';
      // Retryable provider errors may be followed by another attempt. A final
      // core error can be followed by agent_end:aborted, so resolve it here.
      if (!event.retryable) failTurn(state, session, event.error);
      break;
    }

    case 'agent_end':
      // A suspended run continues after the client answers the permission request.
      if (event.reason === 'suspended') {
        state.suspended = true;
        if (state.cancelled && !state.cancelSuspensions?.size) {
          session.stream.detach();
          state.resolve('aborted');
        }
        break;
      }
      state.finished = true;
      state.resolve(event.reason ?? 'complete');
      break;

    // Ignored in v1: om_*, subagent_*, workspace_*, task_updated, etc.
    default:
      break;
  }
}

function sendUpdate(connection: AgentSideConnection, sessionId: string, update: SessionNotification['update']): void {
  connection.sessionUpdate({ sessionId, update }).catch(() => {
    process.stderr.write('[acp] Session update delivery failed.\n');
  });
}

async function handleToolApproval(
  state: PromptState,
  connection: AgentSideConnection,
  session: Session,
  event: Extract<AgentControllerEvent, { type: 'tool_approval_required' }>,
): Promise<void> {
  if (state.cancelled) {
    session.respondToToolApproval({ decision: 'decline', toolCallId: event.toolCallId });
    return;
  }
  // Auto-approve if --dangerous-auto-approve flag is set
  if (autoApprove) {
    session.respondToToolApproval({ decision: 'approve', toolCallId: event.toolCallId });
    return;
  }

  const req: RequestPermissionRequest = {
    sessionId: state.sessionId,
    toolCall: {
      toolCallId: event.toolCallId,
      title: event.toolName,
      rawInput: JSON.stringify(event.args),
    },
    options: [
      { optionId: 'approve', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  };

  try {
    const resp = await connection.requestPermission(req);
    if (state.finished || state.cancelled) return;
    if (resp.outcome.outcome === 'selected') {
      const decision = resp.outcome.optionId === 'approve' ? 'approve' : 'decline';
      session.respondToToolApproval({ decision, toolCallId: event.toolCallId });
    } else {
      session.respondToToolApproval({ decision: 'decline', toolCallId: event.toolCallId });
    }
  } catch {
    if (state.finished || state.cancelled) return;
    process.stderr.write('[acp] Permission request failed; denying the tool call.\n');
    session.respondToToolApproval({ decision: 'decline', toolCallId: event.toolCallId });
  }
}

async function handleToolSuspended(
  state: PromptState,
  connection: AgentSideConnection,
  session: Session,
  event: Extract<AgentControllerEvent, { type: 'tool_suspended' }>,
): Promise<void> {
  const { toolCallId, toolName, args, suspendPayload } = event;

  const isSandboxAccess =
    toolName === 'request_access' ||
    (typeof suspendPayload === 'object' &&
      suspendPayload !== null &&
      'kind' in suspendPayload &&
      suspendPayload.kind === 'sandbox_access_request');
  if (isSandboxAccess || toolName === 'submit_plan') {
    state.cancelSuspensions ??= new Map();
    state.cancelSuspensions.set(toolCallId, () =>
      session.resumeToolCall({
        toolCallId,
        resumeData: isSandboxAccess ? 'No' : { action: 'rejected' },
        resolveOnToolEnd: true,
      }),
    );
  }
  if (state.cancelled) {
    try {
      await state.cancelSuspensions?.get(toolCallId)?.();
    } finally {
      state.cancelSuspensions?.delete(toolCallId);
      if (!state.finished) {
        session.completeDeferredAbort();
        state.resolve('aborted');
      }
    }
    return;
  }
  if (isSandboxAccess) {
    let approved = autoApprove;
    if (!autoApprove) {
      try {
        const response = await connection.requestPermission({
          sessionId: state.sessionId,
          toolCall: { toolCallId, title: toolName, rawInput: JSON.stringify(args) },
          options: [
            { optionId: 'approve', name: 'Allow access', kind: 'allow_once' },
            { optionId: 'reject', name: 'Deny access', kind: 'reject_once' },
          ],
        });
        approved = response.outcome.outcome === 'selected' && response.outcome.optionId === 'approve';
      } catch {
        approved = false;
      }
    }
    if (state.finished || state.cancelled) return;
    state.cancelSuspensions?.delete(toolCallId);
    await session.respondToToolSuspension({ toolCallId, resumeData: approved ? 'Yes' : 'No' });
    return;
  }

  if (toolName === 'submit_plan') {
    // Request permission for plan approval
    const req: RequestPermissionRequest = {
      sessionId: state.sessionId,
      toolCall: {
        toolCallId,
        title: toolName,
        rawInput: JSON.stringify(args),
      },
      options: [
        { optionId: 'approve', name: 'Approve Plan', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject Plan', kind: 'reject_once' },
      ],
    };

    let action: 'approved' | 'rejected' = 'rejected';
    try {
      const resp = await connection.requestPermission(req);
      if (resp.outcome.outcome === 'selected' && resp.outcome.optionId === 'approve') action = 'approved';
    } catch {
      // A missing answer never grants permission.
    }
    if (state.finished || state.cancelled) return;
    state.cancelSuspensions?.delete(toolCallId);
    await session.respondToToolSuspension({ toolCallId, resumeData: { action } });
    return;
  }

  if (toolName === 'ask_user') {
    if (!state.supportsElicitation || !connection.unstable_createElicitation) {
      failTurn(state, session, new Error('The ACP client does not support Mastra Code questions'));
      return;
    }
    const payload = parseAskUserPayload(suspendPayload);
    if (!payload) {
      failTurn(state, session, new Error('Mastra Code question payload is invalid'));
      return;
    }

    // ask_user resumes with labels, not option IDs. Equal labels are the same
    // native answer and must not create overlapping oneOf branches.
    const answerOptions = [...new Set(payload.options.map(option => option.label))].map(label => ({
      const: label,
      title: label,
    }));
    const answerSchema: ElicitationPropertySchema = answerOptions.length
      ? payload.selectionMode === 'multi_select'
        ? {
            type: 'array',
            title: 'Your answer',
            items: { anyOf: answerOptions },
            minItems: 1,
          }
        : {
            type: 'string',
            title: 'Your answer',
            oneOf: answerOptions,
          }
      : { type: 'string', title: 'Your answer' };

    const response = await connection.unstable_createElicitation({
      sessionId: state.sessionId,
      toolCallId,
      mode: 'form',
      message: payload.question,
      requestedSchema: {
        type: 'object',
        title: 'Mastra Code question',
        properties: { answer: answerSchema },
        required: ['answer'],
      },
    });

    if (state.finished || state.cancelled || state.isActive?.() === false) return;
    if (response.action !== 'accept') {
      // Core persists a denial for parked tools before emitting agent_end.
      // Do not release the ACP turn while that asynchronous settlement is pending.
      session.abort();
      return;
    }
    const answer = response.content?.answer;
    if (typeof answer !== 'string' && !(Array.isArray(answer) && answer.every(item => typeof item === 'string'))) {
      failTurn(state, session, new Error('Mastra Code question response is invalid'));
      return;
    }
    await session.respondToToolSuspension({ toolCallId, resumeData: answer });
    return;
  }

  throw new Error('This ACP server does not support the suspended tool interaction');
}

function failTurn(state: PromptState, session: Session, error: unknown): void {
  if (state.finished || state.cancelled) return;
  state.error = error instanceof Error ? error : new Error(String(error));
  state.finished = true;
  state.resolve('error');
  session.abort();
}

function accumulateUsage(target: TokenUsage, usage: TokenUsage): void {
  target.promptTokens += usage.promptTokens;
  target.completionTokens += usage.completionTokens;
  target.totalTokens += usage.totalTokens;
  if (usage.reasoningTokens) target.reasoningTokens = (target.reasoningTokens ?? 0) + usage.reasoningTokens;
  if (usage.cachedInputTokens) target.cachedInputTokens = (target.cachedInputTokens ?? 0) + usage.cachedInputTokens;
  if (usage.cacheCreationInputTokens) {
    target.cacheCreationInputTokens = (target.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
  }
}

function parseAskUserPayload(value: unknown): {
  question: string;
  options: Array<{ label: string }>;
  selectionMode: 'single_select' | 'multi_select';
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as { question?: unknown; options?: unknown; selectionMode?: unknown };
  if (typeof payload.question !== 'string' || !payload.question.trim()) return null;
  const options = Array.isArray(payload.options)
    ? payload.options.flatMap(option =>
        option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string'
          ? [{ label: (option as { label: string }).label }]
          : [],
      )
    : [];
  const selectionMode = payload.selectionMode === 'multi_select' ? 'multi_select' : 'single_select';
  if (payload.options !== undefined && (!Array.isArray(payload.options) || options.length !== payload.options.length)) {
    return null;
  }
  if (options.length === 0 && payload.selectionMode !== undefined) return null;
  return { question: payload.question, options, selectionMode };
}

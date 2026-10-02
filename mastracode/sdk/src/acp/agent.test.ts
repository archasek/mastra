import type {
  AgentSideConnection,
  ContentBlock,
  LoadSessionRequest,
  NewSessionRequest,
} from '@agentclientprotocol/sdk';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { AgentController, AgentControllerEvent, Session } from '@mastra/core/agent-controller';

import { describe, it, expect, vi } from 'vitest';

import { MastraCodeAcpAgent, extractTextFromContentBlocks, mapPromptContent, mapStopReason } from './agent.js';
import type { AcpSkills } from './skills.js';

it('reports the CLI release version rather than the SDK package version', async () => {
  const agent = new MastraCodeAcpAgent({} as AgentSideConnection, vi.fn(), '0.43.0');
  const response = await agent.initialize({ protocolVersion: PROTOCOL_VERSION });
  expect(response.agentInfo?.version).toBe('0.43.0');
});

describe('ACP Agent - Text Extraction', () => {
  it('extracts text from text blocks', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'Hello, world!' }];

    expect(extractTextFromContentBlocks(blocks)).toBe('Hello, world!');
  });

  it('concatenates multiple text blocks with newlines', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Line 1' },
      { type: 'text', text: 'Line 2' },
      { type: 'text', text: 'Line 3' },
    ];

    expect(extractTextFromContentBlocks(blocks)).toBe('Line 1\nLine 2\nLine 3');
  });

  it('handles resource_link blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Check this file:' },
      { type: 'resource_link', uri: 'file:///path/to/file.ts', name: 'file.ts' },
    ];

    expect(extractTextFromContentBlocks(blocks)).toBe('Check this file:\n[resource: file:///path/to/file.ts]');
  });

  it('handles resource blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Here is the content:' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///path/to/file.ts',
          mimeType: 'text/plain',
          text: 'file content',
        },
      },
    ];

    expect(extractTextFromContentBlocks(blocks)).toBe(
      'Here is the content:\n[resource: file:///path/to/file.ts]\nfile content',
    );
  });

  it('handles mixed content blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Start' },
      { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
      { type: 'text', text: 'Middle' },
      {
        type: 'resource',
        resource: {
          uri: 'file:///b.ts',
          mimeType: 'text/plain',
          text: 'content',
        },
      },
      { type: 'text', text: 'End' },
    ];

    expect(extractTextFromContentBlocks(blocks)).toBe(
      'Start\n[resource: file:///a.ts]\nMiddle\n[resource: file:///b.ts]\ncontent\nEnd',
    );
  });

  it.each<ContentBlock>([
    { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    { type: 'resource', resource: { uri: 'file:///binary', blob: 'AA==' } },
  ])('rejects unsupported content instead of silently discarding it: $type', block => {
    expect(() => extractTextFromContentBlocks([{ type: 'text', text: 'Keep this' }, block])).toThrow();
  });

  it('handles empty blocks array', () => {
    expect(extractTextFromContentBlocks([])).toBe('');
  });

  it('passes image content through to Mastra Code without flattening the bytes', () => {
    expect(
      mapPromptContent([
        { type: 'text', text: 'Inspect this image' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ]),
    ).toEqual({
      content: 'Inspect this image',
      files: [{ data: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }],
    });
  });
});

describe('ACP Agent - StopReason Mapping', () => {
  it('maps complete to end_turn', () => {
    expect(mapStopReason('complete')).toBe('end_turn');
  });

  it('maps aborted to cancelled', () => {
    expect(mapStopReason('aborted')).toBe('cancelled');
  });

  it('does not map failure to a successful stop reason', () => {
    expect(() => mapStopReason('error')).toThrow();
  });

  it('maps suspended to end_turn', () => {
    expect(mapStopReason('suspended')).toBe('end_turn');
  });
});

describe('ACP Agent - Sessions and turns', () => {
  function setup(
    messages: unknown[] = [],
    options: {
      getSkills?: () => Promise<AcpSkills | undefined>;
      sessionUpdate?: AgentSideConnection['sessionUpdate'];
      getMode?: () => string;
      runtimeThreadId?: string;
      unsubscribe?: () => void;
      cleanup?: () => Promise<void>;
    } = {},
  ) {
    let listener: (event: AgentControllerEvent) => void = () => {};
    let nextThreadId = 0;
    let currentThreadId = 'runtime-thread';
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn();
    const createThread = vi.fn(async () => {
      currentThreadId = `thread-${++nextThreadId}`;
      return { id: currentThreadId };
    });
    const switchThread = vi.fn(async ({ threadId }: { threadId: string }) => {
      currentThreadId = threadId;
    });
    const listMessages = vi.fn().mockResolvedValue(messages);
    const session = {
      subscribe: (callback: typeof listener) => {
        listener = callback;
        return options.unsubscribe ?? (() => {});
      },
      thread: {
        create: createThread,
        getId: () => currentThreadId,
        switch: switchThread,
        listMessages,
      },
      mode: { get: options.getMode ?? (() => 'default') },
      model: { get: () => 'test-model' },
      sendMessage,
      abort,
    } as unknown as Session;
    const sessionUpdate = options.sessionUpdate ?? vi.fn().mockResolvedValue(undefined);
    const connection = { sessionUpdate } as unknown as AgentSideConnection;
    const createSession = vi.fn(async (request: NewSessionRequest | LoadSessionRequest) => {
      currentThreadId =
        options.runtimeThreadId ?? ('sessionId' in request && request.sessionId ? request.sessionId : currentThreadId);
      return {
        controller: { listAvailableModels: async () => [] } as unknown as AgentController,
        session,
        modes: [],
        ...(options.getSkills ? { getSkills: options.getSkills } : {}),
        ...(options.cleanup ? { cleanup: options.cleanup } : {}),
      };
    });
    const agent = new MastraCodeAcpAgent(connection, createSession);
    return {
      agent,
      sendMessage,
      abort,
      connection,
      createSession,
      createThread,
      switchThread,
      listMessages,
      getThreadId: () => currentThreadId,
      emit: (event: AgentControllerEvent) => listener(event),
    };
  }

  it('rejects a failed turn without returning provider details, then allows the next prompt', async () => {
    const { agent, emit, sendMessage } = setup();
    const { sessionId } = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    sendMessage.mockImplementationOnce(async () => {
      emit({ type: 'error', error: new Error('Provider authentication failed') });
      emit({ type: 'agent_end', reason: 'error' });
    });
    await expect(agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Hello' }] })).rejects.toMatchObject({
      code: -32603,
      message: 'Internal error: Mastra Code turn failed',
    });
    sendMessage.mockImplementationOnce(async () => emit({ type: 'agent_end', reason: 'complete' }));
    await expect(agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Try again' }] })).resolves.toMatchObject({
      stopReason: 'end_turn',
    });
  });

  it('reports failure even when agent_end has no preceding error event', async () => {
    const { agent, emit, sendMessage } = setup();
    const { sessionId } = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    sendMessage.mockImplementationOnce(async () => emit({ type: 'agent_end', reason: 'error' }));
    await expect(agent.prompt({ sessionId, prompt: [] })).rejects.toMatchObject({ code: -32603 });
  });

  it('does not fail a turn that recovers from a retryable error', async () => {
    const { agent, emit, sendMessage } = setup();
    const { sessionId } = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    sendMessage.mockImplementationOnce(async () => {
      emit({ type: 'error', error: new Error('Retrying'), retryable: true });
      emit({ type: 'agent_end', reason: 'complete' });
    });
    await expect(agent.prompt({ sessionId, prompt: [] })).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('does not abort another session when an unknown session is cancelled', async () => {
    const { agent, emit, sendMessage, abort } = setup();
    const first = await agent.newSession({ cwd: '/tmp', mcpServers: [] });
    const prompt = agent.prompt({ sessionId: first.sessionId, prompt: [] });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await agent.cancel({ sessionId: 'unknown' });
    expect(abort).not.toHaveBeenCalled();
    await agent.cancel({ sessionId: first.sessionId });
    expect(abort).toHaveBeenCalledTimes(1);
    emit({ type: 'agent_end', reason: 'aborted' });
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    await agent.cancel({ sessionId: first.sessionId });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('holds runtime cleanup until an in-flight sendMessage settles during dispose', async () => {
    let releaseSend!: () => void;
    const sendGate = new Promise<void>(resolve => {
      releaseSend = resolve;
    });
    const cleanup = vi.fn(async () => {});
    const harness = setup([], { cleanup });
    const { sessionId } = await harness.agent.newSession({ cwd: '/tmp', mcpServers: [] });
    harness.sendMessage.mockImplementationOnce(async () => sendGate);

    const prompt = harness.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Hold the lock' }] });
    await vi.waitFor(() => expect(harness.sendMessage).toHaveBeenCalledOnce());
    const disposal = harness.agent.dispose();

    expect(harness.abort).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    releaseSend();
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    await disposal;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('still releases runtime resources when unsubscribe fails during dispose', async () => {
    const unsubscribeFailure = new Error('unsubscribe failed');
    const cleanupFailure = new Error('runtime cleanup failed');
    const cleanup = vi.fn(async () => {
      throw cleanupFailure;
    });
    const harness = setup([], {
      unsubscribe: () => {
        throw unsubscribeFailure;
      },
      cleanup,
    });
    await harness.agent.newSession({ cwd: '/tmp', mcpServers: [] });

    await expect(harness.agent.dispose()).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [unsubscribeFailure, cleanupFailure] })],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('loadSession preserves the boot-bound thread lock while restoring its history', async () => {
    const priorMessages = [
      { role: 'user', content: { parts: [{ type: 'text', text: 'Earlier request' }] } },
      { role: 'assistant', content: { parts: [{ type: 'text', text: 'Earlier answer' }] } },
    ];
    const harness = setup(priorMessages);
    const initialized = await harness.agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect(initialized.agentCapabilities?.loadSession).toBe(true);
    expect(initialized.agentCapabilities?.promptCapabilities).toEqual({ image: true, embeddedContext: true });

    const request: LoadSessionRequest = { cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' };
    const response = await harness.agent.loadSession(request);
    expect(response.modes).toEqual({ currentModeId: 'default', availableModes: [] });
    expect(harness.createSession).toHaveBeenCalledWith(request);
    expect(harness.createThread).not.toHaveBeenCalled();
    expect(harness.getThreadId()).toBe('existing-thread');
    expect(harness.switchThread).not.toHaveBeenCalled();
    expect(harness.listMessages).toHaveBeenCalledWith({ threadId: 'existing-thread' });
    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { isReplay: true },
        sessionId: 'existing-thread',
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier request' } },
      }),
    );
    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { isReplay: true },
        sessionId: 'existing-thread',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } },
      }),
    );
  });

  it('replays stored terminal errors and failed tool output', async () => {
    const priorMessages = [
      {
        role: 'assistant',
        content: {
          parts: [
            { type: 'error', error: { name: 'MastraError', message: 'Earlier turn failed' } },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-failed',
                toolName: 'readFile',
                title: 'Read file',
                args: { path: 'missing.txt' },
                errorText: 'File not found.',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-empty-error-text',
                toolName: 'readFile',
                errorText: '',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-whitespace-error-text',
                toolName: 'readFile',
                errorText: ' \t\n ',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-missing-error-text',
                toolName: 'readFile',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-empty-result-empty-error-text',
                toolName: 'readFile',
                result: '',
                errorText: '',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-whitespace-result-missing-error-text',
                toolName: 'readFile',
                result: ' \t\n ',
              },
            },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'output-error',
                toolCallId: 'call-empty-result-with-error-text',
                toolName: 'readFile',
                result: '',
                errorText: 'File not found.',
              },
            },
          ],
        },
      },
    ];
    const harness = setup(priorMessages);
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });

    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { isReplay: true },
        sessionId: 'existing-thread',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '[Stored error: MastraError: Earlier turn failed]' },
        },
      }),
    );
    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { isReplay: true },
        sessionId: 'existing-thread',
        update: expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-failed',
          status: 'failed',
          rawOutput: 'File not found.',
        }),
      }),
    );
    for (const toolCallId of [
      'call-empty-error-text',
      'call-whitespace-error-text',
      'call-missing-error-text',
      'call-empty-result-empty-error-text',
      'call-whitespace-result-missing-error-text',
    ]) {
      expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _meta: { isReplay: true },
          sessionId: 'existing-thread',
          update: expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId,
            status: 'failed',
            rawOutput: 'No completed result was saved for this tool call (stored state: output-error).',
          }),
        }),
      );
    }
    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: { isReplay: true },
        sessionId: 'existing-thread',
        update: expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-empty-result-with-error-text',
          status: 'failed',
          rawOutput: 'File not found.',
        }),
      }),
    );
    await harness.agent.dispose();
  });

  it('waits for load history replay before sending command-discovery updates', async () => {
    const priorMessages = [
      { role: 'user', content: { parts: [{ type: 'text', text: 'Earlier request' }] } },
      { role: 'assistant', content: { parts: [{ type: 'text', text: 'Earlier answer' }] } },
    ];
    let finishFirstReplay!: () => void;
    const firstReplay = new Promise<void>(resolve => {
      finishFirstReplay = resolve;
    });
    const sessionUpdate = vi.fn(async (notification: Parameters<AgentSideConnection['sessionUpdate']>[0]) => {
      if (notification.update.sessionUpdate === 'user_message_chunk') await firstReplay;
    });
    const skills = {
      list: async () => [
        { name: 'review', path: '/skills/review', description: 'Review code', 'user-invocable': true },
      ],
      get: async () => null,
      maybeRefresh: async () => {},
    } as unknown as AcpSkills;
    const harness = setup(priorMessages, { getSkills: async () => skills, sessionUpdate });
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });

    await vi.waitFor(() => expect(sessionUpdate).toHaveBeenCalledTimes(1));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sessionUpdate).toHaveBeenCalledTimes(1);

    finishFirstReplay();
    await load;
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(sessionUpdate).toHaveBeenCalledTimes(3);
    expect(sessionUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: 'existing-thread',
        update: expect.objectContaining({ sessionUpdate: 'available_commands_update' }),
      }),
    );
  });

  it('still cleans up a newly registered runtime when unsubscribe throws', async () => {
    const sessionInfoError = new Error('session info failed');
    const unsubscribeError = new Error('unsubscribe failed');
    const unsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const cleanup = vi.fn(async () => {});
    const harness = setup([], {
      getMode: () => {
        throw sessionInfoError;
      },
      unsubscribe,
      cleanup,
    });

    await expect(harness.agent.newSession({ cwd: '/tmp', mcpServers: [] })).rejects.toBe(sessionInfoError);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(sessionInfoError.cause).toBeInstanceOf(AggregateError);
  });

  it('still cleans up a restored runtime when unsubscribe throws during replay failure', async () => {
    const replayError = new Error('history replay failed');
    const unsubscribeError = new Error('unsubscribe failed');
    const unsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const cleanup = vi.fn(async () => {});
    const sessionUpdate = vi.fn(async () => {
      throw replayError;
    });
    const harness = setup([{ role: 'user', content: { parts: [{ type: 'text', text: 'Earlier request' }] } }], {
      sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'],
      unsubscribe,
      cleanup,
    });

    await expect(harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' })).rejects.toBe(
      replayError,
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(replayError.cause).toBeInstanceOf(AggregateError);
  });

  it('fails closed when the requested saved thread does not exist', async () => {
    const harness = setup();
    harness.createSession.mockRejectedValueOnce(new Error('Thread not found: private-thread-id'));
    await expect(
      harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'private-thread-id' }),
    ).rejects.toMatchObject({ code: -32602, message: 'Invalid params: ACP session not found' });
    expect(harness.createThread).not.toHaveBeenCalled();
  });

  it('fails closed when boot binds a different thread instead of switching and dropping the lock', async () => {
    const harness = setup([], { runtimeThreadId: 'unexpected-thread' });
    await expect(
      harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' }),
    ).rejects.toMatchObject({ code: -32602, message: 'Invalid params: ACP session not found' });
    expect(harness.switchThread).not.toHaveBeenCalled();
    expect(harness.listMessages).not.toHaveBeenCalled();
    await harness.agent.dispose();
  });

  it('rejects extra workspace roots rather than silently widening access', async () => {
    const harness = setup();
    await expect(
      harness.agent.loadSession({
        cwd: '/tmp',
        mcpServers: [],
        sessionId: 'existing-thread',
        additionalDirectories: ['/private/extra-root'],
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(harness.createSession).not.toHaveBeenCalled();
  });
});

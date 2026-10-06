import type {
  AgentSideConnection,
  ContentBlock,
  LoadSessionRequest,
  NewSessionRequest,
} from '@agentclientprotocol/sdk';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import type { AgentController, AgentControllerEvent, Session } from '@mastra/core/agent-controller';

import { describe, it, expect, vi } from 'vitest';

import { MastraCodeAcpAgent, extractTextFromContentBlocks, mapPromptContent, mapStopReason } from './agent.js';
import type { AcpSessionRuntime } from './agent.js';
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
      getModel?: () => string;
      listAvailableModels?: () => Promise<{ id: string; hasApiKey: boolean }[]>;
      runtimeThreadId?: string;
      unsubscribe?: () => void;
      cleanup?: () => Promise<void>;
      modelCatalog?: AcpSessionRuntime['modelCatalog'];
      resolveForMode?: () => Promise<string | null>;
      currentMessage?: unknown;
      requestPermission?: AgentSideConnection['requestPermission'];
      pendingApprovals?: Map<string, { toolCallId: string; toolName: string; args: unknown }>;
      pendingSuspensions?: Map<
        string,
        { toolCallId: string; toolName: string; args: unknown; suspendPayload: unknown }
      >;
    } = {},
  ) {
    let listener: (event: AgentControllerEvent) => void = () => {};
    let nextThreadId = 0;
    let currentThreadId = 'runtime-thread';
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn();
    const resumeToolCall = vi.fn(async () => {});
    const respondToToolSuspension = vi.fn(async () => {});
    const respondToToolApproval = vi.fn();
    const detach = vi.fn();
    const createThread = vi.fn(async () => {
      currentThreadId = `thread-${++nextThreadId}`;
      return { id: currentThreadId };
    });
    const switchThread = vi.fn(async ({ threadId }: { threadId: string }) => {
      currentThreadId = threadId;
    });
    const listMessages = vi.fn().mockResolvedValue(messages);
    const listAvailableModels = vi.fn(
      options.listAvailableModels ?? (async () => [{ id: 'test-model', name: 'Test model', hasApiKey: true }]),
    );
    const switchModel = vi.fn(async () => {});
    const switchMode = vi.fn(async () => {});
    const session = {
      displayState: {
        get: () => ({
          currentMessage: options.currentMessage ?? null,
          pendingApprovals: options.pendingApprovals,
          pendingSuspensions: options.pendingSuspensions,
        }),
      },
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
      mode: { get: options.getMode ?? (() => 'default'), switch: switchMode },
      model: {
        get: options.getModel ?? (() => 'test-model'),
        switch: switchModel,
        resolveForMode: options.resolveForMode ?? (async () => options.getModel?.() ?? 'test-model'),
      },
      sendMessage,
      abort,
      resumeToolCall,
      respondToToolSuspension,
      respondToToolApproval,
      stream: { detach },
    } as unknown as Session;
    const sessionUpdate = options.sessionUpdate ?? vi.fn().mockResolvedValue(undefined);
    const connection = {
      sessionUpdate,
      requestPermission: options.requestPermission,
    } as unknown as AgentSideConnection;
    const createSession = vi.fn(async (request: NewSessionRequest | LoadSessionRequest) => {
      currentThreadId =
        options.runtimeThreadId ?? ('sessionId' in request && request.sessionId ? request.sessionId : currentThreadId);
      return {
        controller: {
          listAvailableModels,
        } as unknown as AgentController,
        session,
        modes: options.modelCatalog ? [{ id: 'default', defaultModelId: 'openai/gpt-6-luna' }] : [],
        ...(options.modelCatalog ? { modelCatalog: options.modelCatalog } : {}),
        ...(options.getSkills ? { getSkills: options.getSkills } : {}),
        ...(options.cleanup ? { cleanup: options.cleanup } : {}),
      };
    });
    const agent = new MastraCodeAcpAgent(connection, createSession);
    return {
      agent,
      sendMessage,
      abort,
      resumeToolCall,
      respondToToolSuspension,
      respondToToolApproval,
      detach,
      connection,
      createSession,
      createThread,
      switchThread,
      listMessages,
      listAvailableModels,
      switchModel,
      switchMode,
      getThreadId: () => currentThreadId,
      emit: (event: AgentControllerEvent) => listener(event),
    };
  }

  it('rejects an unavailable saved OAuth model before history replay and cleans the runtime', async () => {
    const cleanup = vi.fn(async () => {});
    const catalog = {
      filterModels: () => [{ id: 'openai/gpt-6-luna', hasApiKey: true }],
      isOAuthModel: () => true,
      assertModel: () => {
        throw RequestError.invalidParams(undefined, 'Refresh catalog');
      },
    };
    const harness = setup([], { getModel: () => 'openai/gpt-5.4-mini', modelCatalog: catalog, cleanup });
    await expect(harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'saved' })).rejects.toThrow(
      'Refresh catalog',
    );
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(harness.connection.sessionUpdate).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(harness.switchModel).not.toHaveBeenCalled();
  });

  it('admits backend members absent from the generic registry without adding saved mini', async () => {
    const modelId = 'openai/gpt-6-luna';
    const harness = setup([], {
      getModel: () => modelId,
      modelCatalog: {
        filterModels: () => [{ id: modelId, hasApiKey: true }],
        isOAuthModel: () => true,
        assertModel: id => {
          if (id !== modelId) throw RequestError.invalidParams(undefined, 'Refresh catalog');
        },
      },
    });
    const response = await harness.agent.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(response.models?.availableModels).toEqual([{ modelId, name: modelId }]);
    await expect(
      harness.agent.unstable_setSessionModel({ sessionId: response.sessionId, modelId: 'openai/gpt-5.4-mini' }),
    ).rejects.toThrow();
    expect(harness.switchModel).not.toHaveBeenCalled();
  });

  it('rechecks live catalog admission for both model and mode setters and prompt', async () => {
    let fresh = true;
    const modelId = 'openai/gpt-6-luna';
    const harness = setup([], {
      getModel: () => modelId,
      modelCatalog: {
        filterModels: () => (fresh ? [{ id: modelId, hasApiKey: true }] : []),
        isOAuthModel: () => true,
        assertModel: () => {
          if (!fresh) throw RequestError.invalidParams(undefined, 'Refresh catalog');
        },
      },
    });
    const { sessionId } = await harness.agent.newSession({ cwd: '/tmp', mcpServers: [] });
    fresh = false;
    await expect(harness.agent.unstable_setSessionModel({ sessionId, modelId })).rejects.toThrow();
    await expect(
      harness.agent.setSessionConfigOption({ sessionId, configId: 'model', value: modelId }),
    ).rejects.toThrow();
    await expect(harness.agent.setSessionMode({ sessionId, modeId: 'default' })).rejects.toThrow('Refresh catalog');
    await expect(
      harness.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'default' }),
    ).rejects.toThrow('Refresh catalog');
    await expect(harness.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'No inference' }] })).rejects.toThrow(
      'Refresh catalog',
    );
    expect(harness.switchModel).not.toHaveBeenCalled();
    expect(harness.switchMode).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

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
    const harness = setup(priorMessages, {
      getMode: () => 'plan',
      getModel: () => 'openai/gpt-5.5',
      listAvailableModels: async () => [{ id: 'openai/gpt-5.5', hasApiKey: true }],
    });
    const initialized = await harness.agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    });
    expect(initialized.agentCapabilities?.loadSession).toBe(true);
    expect(initialized.agentCapabilities?.promptCapabilities).toEqual({ image: true, embeddedContext: true });

    const request: LoadSessionRequest = { cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' };
    const response = await harness.agent.loadSession(request);
    expect(response.modes).toEqual({ currentModeId: 'plan', availableModes: [] });
    expect(response.models?.currentModelId).toBe('openai/gpt-5.5');
    expect(harness.switchModel).not.toHaveBeenCalled();
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

  it.each([false, true])(
    'rejects removed restore credentials even with another credentialed model=%s',
    async otherKey => {
      const unsubscribe = vi.fn();
      const cleanup = vi.fn(async () => {});
      let hasApiKey = false;
      const harness = setup([{ role: 'user', content: { parts: [{ type: 'text', text: 'Private history' }] } }], {
        getModel: () => 'openai/gpt-5.5',
        listAvailableModels: async () => [
          { id: 'openai/gpt-5.5', hasApiKey },
          { id: 'xai/grok-4.5', hasApiKey: otherKey },
        ],
        unsubscribe,
        cleanup,
      });
      const request = { cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' };

      const load = harness.agent.loadSession(request);
      await expect(load).rejects.toBeInstanceOf(RequestError);
      await expect(load).rejects.toMatchObject({ code: -32000 });
      expect(harness.connection.sessionUpdate).not.toHaveBeenCalled();
      expect(harness.listMessages).not.toHaveBeenCalled();
      expect(harness.switchModel).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      await expect(harness.agent.prompt({ sessionId: request.sessionId, prompt: [] })).rejects.toMatchObject({
        code: -32602,
      });

      hasApiKey = true;
      const restored = await harness.agent.loadSession(request);
      expect(restored.models?.currentModelId).toBe('openai/gpt-5.5');
      expect(harness.getThreadId()).toBe(request.sessionId);
      expect(harness.createThread).not.toHaveBeenCalled();
      expect(harness.switchThread).not.toHaveBeenCalled();
      expect(harness.switchModel).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
      await harness.agent.dispose();
      expect(cleanup).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['no selection', '', false, false],
    ['catalog selection without credentials', 'openai/gpt-5.5', false, false],
    ['custom selection outside the catalog', 'local/llama', false, true],
    ['no selection with a credentialed provider', '', true, true],
  ] as const)('preserves restore authentication semantics for %s', async (_label, modelId, hasApiKey, allowed) => {
    const cleanup = vi.fn(async () => {});
    const harness = setup([], {
      getModel: () => modelId,
      listAvailableModels: async () => [{ id: 'openai/gpt-5.5', hasApiKey }],
      cleanup,
    });
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    if (allowed) {
      await expect(load).resolves.toMatchObject({ modes: { currentModeId: 'default' } });
      expect(harness.switchModel).not.toHaveBeenCalled();
    } else {
      await expect(load).rejects.toMatchObject({ code: -32000 });
      expect(harness.connection.sessionUpdate).not.toHaveBeenCalled();
      expect(harness.listMessages).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledOnce();
    }
    await harness.agent.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('tears down private capture before cleanup when restore discovery rejects, then permits retry', async () => {
    const discovery = Promise.withResolvers<{ id: string; hasApiKey: boolean }[]>();
    const started = Promise.withResolvers<void>();
    const order: string[] = [];
    const unsubscribe = vi.fn(() => {
      order.push('unsubscribe');
    });
    const cleanup = vi.fn(async () => {
      order.push('cleanup');
    });
    const harness = setup([], { unsubscribe, cleanup });
    harness.listAvailableModels.mockImplementationOnce(() => {
      started.resolve();
      return discovery.promise;
    });
    const request = { cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' };
    const load = harness.agent.loadSession(request);
    const failure = new Error('catalog unavailable');
    const rejected = expect(load).rejects.toBe(failure);
    await started.promise;
    expect(harness.connection.sessionUpdate).not.toHaveBeenCalled();
    expect(harness.listMessages).not.toHaveBeenCalled();
    await expect(harness.agent.loadSession(request)).rejects.toMatchObject({ code: -32602 });
    discovery.reject(failure);
    await rejected;
    expect(order).toEqual(['unsubscribe', 'cleanup']);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    await harness.agent.loadSession(request);
    await harness.agent.dispose();
  });

  it('disposes a private restore during model discovery without replay or publication', async () => {
    const discovery = Promise.withResolvers<{ id: string; hasApiKey: boolean }[]>();
    const started = Promise.withResolvers<void>();
    const unsubscribe = vi.fn();
    const cleanup = vi.fn(async () => {});
    const harness = setup([], { unsubscribe, cleanup });
    harness.listAvailableModels.mockImplementationOnce(() => {
      started.resolve();
      return discovery.promise;
    });
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    const rejected = expect(load).rejects.toMatchObject({ code: -32603 });
    await started.promise;
    const disposal = harness.agent.dispose();
    expect(cleanup).not.toHaveBeenCalled();
    discovery.resolve([{ id: 'test-model', hasApiKey: true }]);
    await rejected;
    await disposal;
    expect(harness.connection.sessionUpdate).not.toHaveBeenCalled();
    expect(harness.listMessages).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('preserves the restore auth error when capture teardown and runtime cleanup both fail', async () => {
    const unsubscribeError = new Error('unsubscribe failed');
    const cleanupError = new Error('cleanup failed');
    const unsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const cleanup = vi.fn(async () => {
      throw cleanupError;
    });
    const harness = setup([], {
      listAvailableModels: async () => [{ id: 'test-model', hasApiKey: false }],
      unsubscribe,
      cleanup,
    });
    await expect(
      harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' }),
    ).rejects.toMatchObject({
      code: -32000,
      cause: { errors: [expect.objectContaining({ errors: [unsubscribeError] }), cleanupError] },
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(harness.connection.sessionUpdate).not.toHaveBeenCalled();
    expect(harness.listMessages).not.toHaveBeenCalled();
    await harness.agent.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('replays remote images as resource links and inline images as base64', async () => {
    const harness = setup([
      {
        role: 'user',
        content: {
          parts: [
            { type: 'file', data: 'https://example.test/image.png', mediaType: 'image/png' },
            { type: 'file', data: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' },
          ],
        },
      },
    ]);
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'image-thread' });
    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'image-thread',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'resource_link',
            uri: 'https://example.test/image.png',
            name: 'Stored image',
            mimeType: 'image/png',
          },
        },
      }),
    );
    expect(harness.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        },
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

    await expect(
      harness.agent.prompt({ sessionId: 'existing-thread', prompt: [{ type: 'text', text: 'Too early' }] }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(harness.agent.setSessionMode({ sessionId: 'existing-thread', modeId: 'build' })).rejects.toMatchObject(
      { code: -32602 },
    );
    await expect(
      harness.agent.unstable_setSessionModel({ sessionId: 'existing-thread', modelId: 'openai/gpt-5' }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      harness.agent.setSessionConfigOption({
        sessionId: 'existing-thread',
        configId: 'thinking_level',
        value: 'medium',
      }),
    ).rejects.toMatchObject({ code: -32602 });

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

  it('cleans up an unregistered restored runtime when history replay fails', async () => {
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

  it('captures a durable continuation during private history replay and continues delivery after load', async () => {
    const replay = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const sessionUpdate = vi.fn(async (_notification: unknown) => {});
    sessionUpdate.mockImplementationOnce(async () => {
      started.resolve();
      await replay.promise;
    });
    const harness = setup([{ id: 'old', role: 'user', content: { parts: [{ type: 'text', text: 'Earlier' }] } }], {
      sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'],
    });
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    await started.promise;
    harness.emit({ type: 'agent_start' });
    harness.emit({
      type: 'message_start',
      message: {
        id: 'continued',
        role: 'assistant',
        content: { format: 2, parts: [] },
      } as never,
    });
    harness.emit({ type: 'message_update', id: 'continued', event: { type: 'text-delta', delta: 'During replay' } });
    await expect(harness.agent.prompt({ sessionId: 'existing-thread', prompt: [] })).rejects.toMatchObject({
      code: -32602,
    });
    replay.resolve();
    await load;
    harness.emit({ type: 'message_update', id: 'continued', event: { type: 'text-delta', delta: ' after load' } });
    const chunks = sessionUpdate.mock.calls
      .map(
        ([notification]) =>
          notification as unknown as {
            update: { content?: { text?: string } };
          },
      )
      .flatMap(notification => (notification.update.content?.text ? [notification.update.content.text] : []));
    expect(chunks).toEqual(['Earlier', 'During replay', ' after load']);
    await harness.agent.dispose();
  });

  it('uses stable message identity to avoid snapshot and captured-live duplication', async () => {
    const sessionUpdate = vi.fn(async (_notification: unknown) => {});
    const harness = setup([], { sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'] });
    harness.listMessages.mockImplementationOnce(async () => {
      harness.emit({ type: 'agent_start' });
      harness.emit({
        type: 'message_start',
        message: {
          id: 'overlap',
          role: 'assistant',
          content: { format: 2, parts: [] },
        } as never,
      });
      harness.emit({ type: 'message_update', id: 'overlap', event: { type: 'text-delta', delta: 'Once only' } });
      harness.emit({ type: 'message_end', id: 'overlap' });
      harness.emit({ type: 'agent_end', reason: 'complete' });
      return [{ id: 'overlap', role: 'assistant', content: { parts: [{ type: 'text', text: 'Once only' }] } }];
    });
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    const chunks = sessionUpdate.mock.calls
      .map(
        ([notification]) =>
          notification as unknown as {
            update: { content?: { text?: string } };
          },
      )
      .flatMap(notification => (notification.update.content?.text ? [notification.update.content.text] : []));
    expect(chunks).toEqual(['Once only']);
    await harness.agent.dispose();
  });

  it('disposes a private restored runtime after replay settles without publishing it', async () => {
    const replay = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const unsubscribe = vi.fn();
    const cleanup = vi.fn(async () => {});
    const sessionUpdate = vi.fn(async (_notification: unknown) => {
      started.resolve();
      await replay.promise;
    });
    const harness = setup([{ id: 'old', role: 'user', content: { parts: [{ type: 'text', text: 'Earlier' }] } }], {
      sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'],
      unsubscribe,
      cleanup,
    });
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    // Install the rejection observer before triggering disposal.
    const failedLoad = expect(load).rejects.toMatchObject({ code: -32603 });
    await started.promise;
    const disposal = harness.agent.dispose();
    expect(cleanup).not.toHaveBeenCalled();
    replay.resolve();
    await failedLoad;
    await disposal;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('snapshots a streaming message and parked approval before deferred discovery, then captures live deltas once', async () => {
    const discovery = Promise.withResolvers<{ id: string; hasApiKey: boolean }[]>();
    const started = Promise.withResolvers<void>();
    const currentMessage = {
      id: 'stream',
      role: 'assistant',
      content: { parts: [{ type: 'text', text: 'Prefix' }] },
    };
    const approval = { toolCallId: 'approval', toolName: 'write_file', args: { path: 'file' } };
    const pendingApprovals = new Map([['approval', approval]]);
    const requestPermission = vi.fn(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'approve' } }));
    const sessionUpdate = vi.fn(async (_notification: unknown) => {});
    const harness = setup([], {
      currentMessage,
      pendingApprovals,
      requestPermission,
      sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'],
    });
    harness.listAvailableModels.mockImplementationOnce(() => {
      started.resolve();
      return discovery.promise;
    });
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    await started.promise;
    currentMessage.content.parts[0]!.text = 'Prefix suffix';
    pendingApprovals.clear();
    approval.args.path = 'newer-file';
    harness.emit({ type: 'message_update', id: 'stream', event: { type: 'text-delta', delta: ' suffix' } });
    harness.emit({ type: 'message_end', id: 'stream' });
    harness.emit({
      type: 'message_start',
      message: {
        id: 'next',
        role: 'assistant',
        content: { format: 2, parts: [] },
      } as never,
    });
    harness.emit({ type: 'message_update', id: 'next', event: { type: 'text-delta', delta: 'Next message' } });
    harness.listMessages.mockResolvedValueOnce([
      { id: 'stream', role: 'assistant', content: { parts: [{ type: 'text', text: 'Prefix suffix' }] } },
      { id: 'next', role: 'assistant', content: { parts: [{ type: 'text', text: 'Next message' }] } },
    ]);
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(harness.listMessages).not.toHaveBeenCalled();
    await expect(harness.agent.prompt({ sessionId: 'existing-thread', prompt: [] })).rejects.toMatchObject({
      code: -32602,
    });
    discovery.resolve([{ id: 'test-model', hasApiKey: true }]);
    await load;
    harness.emit({ type: 'message_update', id: 'next', event: { type: 'text-delta', delta: ' after load' } });
    const chunks = sessionUpdate.mock.calls
      .map(
        ([notification]) =>
          notification as {
            update: { content?: { text?: string } };
          },
      )
      .flatMap(notification => (notification.update.content?.text ? [notification.update.content.text] : []));
    expect(chunks).toEqual(['Prefix', ' suffix', 'Next message', ' after load']);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ rawInput: JSON.stringify({ path: 'file' }) }),
      }),
    );
    await harness.agent.dispose();
  });

  it('denies a restored continuation plan on cancel and ignores a late approval', async () => {
    const answer = Promise.withResolvers<Awaited<ReturnType<AgentSideConnection['requestPermission']>>>();
    const requestPermission = vi.fn(() => answer.promise);
    const harness = setup([], { requestPermission });
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    harness.emit({ type: 'agent_start' });
    harness.emit({ type: 'tool_suspended', toolCallId: 'plan', toolName: 'submit_plan', args: {}, suspendPayload: {} });
    harness.emit({ type: 'agent_end', reason: 'suspended' });
    expect(requestPermission).toHaveBeenCalledOnce();
    await harness.agent.cancel({ sessionId: 'existing-thread' });
    expect(harness.resumeToolCall).toHaveBeenCalledWith({
      toolCallId: 'plan',
      resumeData: { action: 'rejected' },
      resolveOnToolEnd: true,
    });
    expect(harness.abort).toHaveBeenCalledOnce();
    expect(harness.detach).toHaveBeenCalledOnce();
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'approve' } });
    await answer.promise;
    await Promise.resolve();
    expect(harness.respondToToolSuspension).not.toHaveBeenCalled();
    await harness.agent.dispose();
  });

  it.each([false, true])('restores parked approval and plan exactly once with captured overlap=%s', async overlap => {
    const requestPermission = vi.fn(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'approve' } }));
    const harness = setup([], {
      requestPermission,
      pendingApprovals: new Map([
        ['approval', { toolCallId: 'approval', toolName: 'write_file', args: { path: 'file' } }],
      ]),
      pendingSuspensions: new Map([
        [
          'plan',
          {
            toolCallId: 'plan',
            toolName: 'submit_plan',
            args: { plan: 'Original plan' },
            suspendPayload: { plan: 'Original plan' },
          },
        ],
      ]),
    });
    if (overlap) {
      harness.listMessages.mockImplementationOnce(async () => {
        harness.emit({
          type: 'tool_approval_required',
          toolCallId: 'approval',
          toolName: 'write_file',
          args: { path: 'file' },
        });
        const plan = {
          type: 'tool_suspended' as const,
          toolCallId: 'plan',
          toolName: 'submit_plan',
          args: { plan: 'Original plan' },
          suspendPayload: { plan: 'Original plan' },
        };
        harness.emit(plan);
        harness.emit(plan);
        return [];
      });
    }
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    await Promise.resolve();
    expect(requestPermission).toHaveBeenCalledTimes(2);
    expect(harness.respondToToolApproval).toHaveBeenCalledWith({ decision: 'approve', toolCallId: 'approval' });
    expect(harness.respondToToolSuspension).toHaveBeenCalledExactlyOnceWith({
      toolCallId: 'plan',
      resumeData: { action: 'approved' },
    });
    await harness.agent.dispose();
  });

  it.each([false, true])('preserves a parked approval across unrelated completion with captured=%s', async captured => {
    const answer = Promise.withResolvers<Awaited<ReturnType<AgentSideConnection['requestPermission']>>>();
    const requestPermission = vi.fn(() => answer.promise);
    const approval = { toolCallId: 'approval', toolName: 'write_file', args: { path: 'file' } };
    const harness = setup([], {
      requestPermission,
      pendingApprovals: captured ? new Map() : new Map([['approval', approval]]),
    });
    harness.listMessages.mockImplementationOnce(async () => {
      if (captured) harness.emit({ type: 'tool_approval_required', ...approval });
      harness.emit({ type: 'agent_end', reason: 'complete' });
      return [];
    });
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    expect(requestPermission).toHaveBeenCalledOnce();
    harness.emit({ type: 'agent_end', reason: 'complete' });
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'approve' } });
    await answer.promise;
    await Promise.resolve();
    expect(harness.respondToToolApproval).toHaveBeenCalledWith({ decision: 'approve', toolCallId: 'approval' });
    await harness.agent.dispose();
  });

  it.each(['tool_end', 'cancel', 'dispose'] as const)(
    'invalidates a deferred restored approval after %s',
    async terminal => {
      const answer = Promise.withResolvers<Awaited<ReturnType<AgentSideConnection['requestPermission']>>>();
      const harness = setup([], {
        requestPermission: vi.fn(() => answer.promise),
        pendingApprovals: new Map([['approval', { toolCallId: 'approval', toolName: 'write_file', args: {} }]]),
      });
      await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
      harness.emit({ type: 'agent_end', reason: 'complete' });
      if (terminal === 'tool_end')
        harness.emit({ type: 'tool_end', toolCallId: 'approval', result: {}, isError: false });
      else if (terminal === 'cancel') {
        await harness.agent.cancel({ sessionId: 'existing-thread' });
        expect(harness.respondToToolApproval).toHaveBeenCalledExactlyOnceWith({
          decision: 'decline',
          toolCallId: 'approval',
        });
        expect(harness.abort).toHaveBeenCalledOnce();
      } else await harness.agent.dispose();
      answer.resolve({ outcome: { outcome: 'selected', optionId: 'approve' } });
      await answer.promise;
      await Promise.resolve();
      expect(harness.respondToToolApproval).not.toHaveBeenCalledWith({ decision: 'approve', toolCallId: 'approval' });
      await harness.agent.dispose();
    },
  );

  it.each(['call', 'partial-call'])('replays unresolved stored tool state %s as in progress', async state => {
    const sessionUpdate = vi.fn(async (_notification: unknown) => {});
    const harness = setup(
      [
        {
          role: 'assistant',
          content: {
            parts: [
              {
                type: 'tool-invocation',
                toolInvocation: {
                  state,
                  toolCallId: 'pending',
                  toolName: 'write_file',
                  args: { path: 'file' },
                },
              },
            ],
          },
        },
      ],
      { sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'] },
    );
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ toolCallId: 'pending', status: 'in_progress' }),
      }),
    );
    const update = sessionUpdate.mock.calls
      .map(([notification]) => notification as { update: { toolCallId?: string; rawOutput?: unknown } })
      .find(notification => notification.update.toolCallId === 'pending')!.update;
    expect(update).not.toHaveProperty('rawOutput');
    await harness.agent.dispose();
  });

  it('invalidates a continuation permission response when disposal starts', async () => {
    const answer = Promise.withResolvers<Awaited<ReturnType<AgentSideConnection['requestPermission']>>>();
    const harness = setup([], { requestPermission: vi.fn(() => answer.promise) });
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    harness.emit({ type: 'tool_suspended', toolCallId: 'plan', toolName: 'submit_plan', args: {}, suspendPayload: {} });
    await harness.agent.dispose();
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'approve' } });
    await answer.promise;
    await Promise.resolve();
    expect(harness.respondToToolSuspension).not.toHaveBeenCalled();
    expect(harness.abort).toHaveBeenCalledOnce();
  });

  it('invalidates a private plan permission if capture unsubscribe fails during load', async () => {
    const answer = Promise.withResolvers<Awaited<ReturnType<AgentSideConnection['requestPermission']>>>();
    const failure = new Error('capture unsubscribe failed');
    const cleanup = vi.fn(async () => {});
    const unsubscribe = vi.fn(() => {
      throw failure;
    });
    const harness = setup([], {
      requestPermission: vi.fn(() => answer.promise),
      cleanup,
      unsubscribe,
      pendingSuspensions: new Map([
        ['plan', { toolCallId: 'plan', toolName: 'submit_plan', args: {}, suspendPayload: {} }],
      ]),
    });
    await expect(harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' })).rejects.toBe(
      failure,
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    answer.resolve({ outcome: { outcome: 'selected', optionId: 'approve' } });
    await answer.promise;
    await Promise.resolve();
    expect(harness.respondToToolSuspension).not.toHaveBeenCalled();
    expect(harness.resumeToolCall).not.toHaveBeenCalled();
    await harness.agent.dispose();
  });

  it.each(['cancelled', 'tool_end', 'agent_end'] as const)(
    'does not redispatch a captured plan after %s',
    async terminal => {
      const replay = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const requestPermission = vi.fn(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'approve' } }));
      const sessionUpdate = vi.fn(async (_notification: unknown) => {
        started.resolve();
        await replay.promise;
      });
      const harness = setup([{ id: 'old', role: 'user', content: { parts: [{ type: 'text', text: 'Earlier' }] } }], {
        requestPermission,
        sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'],
      });
      const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
      await started.promise;
      harness.emit({
        type: 'tool_suspended',
        toolCallId: 'plan',
        toolName: 'submit_plan',
        args: {},
        suspendPayload: {},
      });
      if (terminal === 'cancelled')
        harness.emit({
          type: 'tool_suspension_cancelled',
          toolCallId: 'plan',
          toolName: 'submit_plan',
          reason: 'aborted',
        });
      else if (terminal === 'tool_end')
        harness.emit({ type: 'tool_end', toolCallId: 'plan', result: {}, isError: false });
      else harness.emit({ type: 'agent_end', reason: 'complete' });
      replay.resolve();
      await load;
      expect(requestPermission).not.toHaveBeenCalled();
      expect(harness.respondToToolSuspension).not.toHaveBeenCalled();
      await harness.agent.dispose();
    },
  );

  it('does not redispatch an initial parked plan after captured terminal completion', async () => {
    const requestPermission = vi.fn(async () => ({ outcome: { outcome: 'selected' as const, optionId: 'approve' } }));
    const harness = setup([], {
      requestPermission,
      pendingSuspensions: new Map([
        ['plan', { toolCallId: 'plan', toolName: 'submit_plan', args: {}, suspendPayload: {} }],
      ]),
    });
    harness.listMessages.mockImplementationOnce(async () => {
      harness.emit({ type: 'agent_end', reason: 'complete' });
      return [];
    });
    await harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    expect(requestPermission).not.toHaveBeenCalled();
    await harness.agent.dispose();
  });

  it('does not replay a persisted signal twice when its start arrives during history delivery', async () => {
    const replay = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const sessionUpdate = vi.fn(async (_notification: unknown) => {});
    sessionUpdate.mockImplementationOnce(async () => {
      started.resolve();
      await replay.promise;
    });
    const signal = {
      id: 'signal',
      role: 'assistant' as const,
      content: { parts: [{ type: 'text', text: 'Persisted signal' }] },
    };
    const harness = setup(
      [{ id: 'old', role: 'user', content: { parts: [{ type: 'text', text: 'Earlier' }] } }, signal],
      {
        sessionUpdate: sessionUpdate as unknown as AgentSideConnection['sessionUpdate'],
      },
    );
    const load = harness.agent.loadSession({ cwd: '/tmp', mcpServers: [], sessionId: 'existing-thread' });
    await started.promise;
    harness.emit({ type: 'message_start', message: signal as never });
    harness.emit({ type: 'message_end', id: 'signal' });
    replay.resolve();
    await load;
    const chunks = sessionUpdate.mock.calls
      .map(
        ([notification]) =>
          notification as {
            update: { content?: { text?: string } };
          },
      )
      .flatMap(notification => (notification.update.content?.text ? [notification.update.content.text] : []));
    expect(chunks).toEqual(['Earlier', 'Persisted signal']);
    await harness.agent.dispose();
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

describe('ACP Agent - Provider authentication', () => {
  function newSession(models: { id: string; hasApiKey: boolean }[] | Error, currentModelId: string) {
    const createThread = vi.fn(async () => ({ id: 'thread-1' }));
    const cleanup = vi.fn().mockResolvedValue(undefined);
    let modelId = currentModelId;
    const switchModel = vi.fn(async ({ modelId: next }: { modelId: string }) => {
      modelId = next;
    });
    const subscribe = vi.fn(() => () => {});
    const sessionUpdate = vi.fn().mockResolvedValue(undefined);
    const session = {
      subscribe,
      thread: { getId: () => 'thread-1', create: createThread, switch: async () => {} },
      mode: { get: () => 'default' },
      model: { get: () => modelId, switch: switchModel },
    } as unknown as Session;
    const agent = new MastraCodeAcpAgent({ sessionUpdate } as unknown as AgentSideConnection, async () => ({
      controller: {
        listAvailableModels: async () => {
          if (models instanceof Error) throw models;
          return models;
        },
      } as unknown as AgentController,
      session,
      modes: [],
      cleanup,
    }));
    return {
      created: agent.newSession({ cwd: '/tmp', mcpServers: [] }),
      agent,
      createThread,
      cleanup,
      switchModel,
      subscribe,
      sessionUpdate,
    };
  }

  it.each([
    ['no model is selected', ''],
    ['the selected model has no credentials', 'openai/gpt-5'],
  ])('requires authentication when no provider is configured and %s', async (_case, currentModelId) => {
    const { created, createThread, cleanup } = newSession([{ id: 'openai/gpt-5', hasApiKey: false }], currentModelId);
    await expect(created).rejects.toMatchObject({ code: -32000 });
    expect(createThread).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    ['a provider has credentials', [{ id: 'openai/gpt-5', hasApiKey: true }], ''],
    [
      'the selected model is a custom model outside the catalog',
      [{ id: 'openai/gpt-5', hasApiKey: false }],
      'local/llama',
    ],
  ])('starts the session when %s', async (_case, models, currentModelId) => {
    const { created, createThread } = newSession(models, currentModelId);
    await expect(created).resolves.toMatchObject({ sessionId: 'thread-1' });
    expect(createThread).not.toHaveBeenCalled();
  });

  it('fails session creation when model discovery fails instead of hiding the catalog', async () => {
    const { created, createThread, cleanup, subscribe, sessionUpdate } = newSession(
      new Error('catalog unavailable'),
      'openai/gpt-5',
    );
    await expect(created).rejects.toThrow('catalog unavailable');
    expect(createThread).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it('moves a new session off a default model without credentials to a signed-in provider default', async () => {
    const { created, switchModel } = newSession(
      [
        { id: 'openai/gpt-5.5', hasApiKey: false },
        { id: 'groq/llama', hasApiKey: true },
        { id: 'anthropic/claude-haiku-4-5', hasApiKey: true },
        { id: 'xai/grok-4.5', hasApiKey: true },
      ],
      'openai/gpt-5.5',
    );
    await expect(created).resolves.toMatchObject({ models: { currentModelId: 'xai/grok-4.5' } });
    expect(switchModel).toHaveBeenCalledWith({ modelId: 'xai/grok-4.5' });
  });

  it.each([
    ['provider default', [{ id: 'xai/grok-4.5', hasApiKey: true }], 'xai/grok-4.5'],
    ['catalog fallback', [{ id: 'groq/llama', hasApiKey: true }], 'groq/llama'],
  ])('selects a credentialed %s when the new session has no model', async (_case, models, expected) => {
    const { created, switchModel } = newSession(models, '');
    await expect(created).resolves.toMatchObject({ models: { currentModelId: expected } });
    expect(switchModel).toHaveBeenCalledExactlyOnceWith({ modelId: expected });
  });

  it.each([
    [
      'the current model has credentials',
      [
        { id: 'openai/gpt-5.5', hasApiKey: true },
        { id: 'xai/grok-4.5', hasApiKey: true },
      ],
      'openai/gpt-5.5',
    ],
    [
      'the current model is a custom model outside the catalog',
      [{ id: 'xai/grok-4.5', hasApiKey: true }],
      'local/llama',
    ],
  ])('keeps the current model when %s', async (_case, models, currentModelId) => {
    const { created, switchModel } = newSession(models, currentModelId);
    await expect(created).resolves.toMatchObject({ models: { currentModelId } });
    expect(switchModel).not.toHaveBeenCalled();
  });

  it('falls back to the first credentialed native catalog model when no provider default qualifies', async () => {
    const { created, switchModel } = newSession(
      [
        { id: 'openai/gpt-5.5', hasApiKey: false },
        { id: 'groq/llama', hasApiKey: true },
        { id: 'anthropic/claude-haiku-4-5', hasApiKey: true },
      ],
      'openai/gpt-5.5',
    );
    await expect(created).resolves.toMatchObject({ models: { currentModelId: 'groq/llama' } });
    expect(switchModel).toHaveBeenCalledExactlyOnceWith({ modelId: 'groq/llama' });
  });

  it.each([false, true])('keeps a fallback switch private until it settles (reject: %s)', async reject => {
    const switching = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const harness = newSession(
      [
        { id: 'openai/gpt-5.5', hasApiKey: false },
        { id: 'groq/llama', hasApiKey: true },
      ],
      'openai/gpt-5.5',
    );
    const switchModel = harness.switchModel.getMockImplementation()!;
    harness.switchModel.mockImplementationOnce(async selection => {
      started.resolve();
      await switching.promise;
      await switchModel(selection);
    });
    const failure = new Error('model switch failed');
    const result = reject ? expect(harness.created).rejects.toBe(failure) : harness.created;
    await started.promise;
    expect(harness.subscribe).not.toHaveBeenCalled();
    expect(harness.sessionUpdate).not.toHaveBeenCalled();
    expect(harness.cleanup).not.toHaveBeenCalled();
    await expect(harness.agent.prompt({ sessionId: 'thread-1', prompt: [] })).rejects.toMatchObject({ code: -32602 });
    if (reject) switching.reject(failure);
    else switching.resolve();
    const response = await result;
    if (reject) {
      expect(harness.subscribe).not.toHaveBeenCalled();
      expect(harness.sessionUpdate).not.toHaveBeenCalled();
      expect(harness.cleanup).toHaveBeenCalledOnce();
    } else {
      expect(response).toMatchObject({ sessionId: 'thread-1', models: { currentModelId: 'groq/llama' } });
      expect(harness.subscribe).toHaveBeenCalledOnce();
      expect(harness.cleanup).not.toHaveBeenCalled();
    }
    await harness.agent.dispose();
    expect(harness.cleanup).toHaveBeenCalledOnce();
  });
});

describe('ACP Agent - Authentication capabilities', () => {
  it.each([
    [undefined, false],
    [{ auth: { terminal: true } }, true],
    [{ _meta: { 'terminal-auth': true } }, true],
  ] as const)('advertises terminal login only when supported: %j', async (clientCapabilities, terminal) => {
    const agent = new MastraCodeAcpAgent({} as AgentSideConnection, vi.fn());
    const response = await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities });
    expect(response.authMethods?.map(method => method.id)).toEqual(
      terminal
        ? ['openai-codex', 'kimi-for-coding', 'xai', 'anthropic', 'github-copilot', 'mastracode-login']
        : ['openai-codex', 'kimi-for-coding', 'xai'],
    );
    const login = response.authMethods?.find(method => method.id === 'mastracode-login');
    if (terminal) expect(login).toMatchObject({ type: 'terminal', args: ['login'] });
    expect(response.agentCapabilities?.loadSession).toBe(true);
  });
});

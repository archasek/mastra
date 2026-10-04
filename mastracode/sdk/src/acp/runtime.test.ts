import type { LoadSessionRequest, McpServer, NewSessionRequest } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { bootLocalAgentController } from '../index.js';
import { loadSettings, resolveDefaultThinkingLevel } from '../onboarding/settings.js';
import { createAcpSession, mapAcpMcpServers } from './runtime.js';

vi.mock('../onboarding/settings.js', () => ({
  loadSettings: vi.fn(() => ({})),
  resolveDefaultThinkingLevel: vi.fn(() => ({ level: 'medium' })),
}));

vi.mock('../index.js', () => ({ bootLocalAgentController: vi.fn() }));

function bootResult() {
  const session = {
    abort: vi.fn(),
    mode: { get: vi.fn(() => 'build') },
    state: { get: vi.fn(() => ({})) },
    thread: {
      getId: vi.fn(() => 'boot-thread'),
      detachFromCurrent: vi.fn().mockResolvedValue(undefined),
      clearAndReleaseLock: vi.fn().mockResolvedValue(undefined),
    },
  };
  const stopWorkers = vi.fn().mockResolvedValue(undefined);
  const shutdown = vi.fn().mockResolvedValue(undefined);
  const closeStorage = vi.fn().mockResolvedValue(undefined);
  const closePubSub = vi.fn().mockResolvedValue(undefined);
  const pubsub = { close: closePubSub };
  const mcpManager = {
    initInBackground: vi.fn().mockResolvedValue({ failed: [] }),
    getDisabledServers: vi.fn(() => []),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session,
    controller: {
      listModes: () => [{ id: 'build' }],
      getMastra: () => ({ stopWorkers, shutdown }),
      stopIntervals: vi.fn(),
    },
    mcpManager,
    githubSignals: { stopAllPolling: vi.fn() },
    stopPluginSignalProviders: vi.fn(),
    stopNotificationDispatch: vi.fn(async () => {}),
    signalsPubSub: pubsub,
    storageMaintenance: { closeStorage },
    stopWorkers,
    shutdown,
    closeStorage,
    closePubSub,
  };
}

function newRequest(mcpServers: McpServer[] = []): NewSessionRequest {
  return { cwd: '/project', mcpServers };
}

describe('ACP HTTP MCP mapping', () => {
  it('accepts HTTPS with caller-provided headers and local loopback HTTP', () => {
    expect(
      mapAcpMcpServers([
        {
          name: 'hq-tools',
          type: 'http',
          url: 'https://mcp.example.com/tools',
          headers: [{ name: 'Authorization', value: 'Bearer test-token' }],
        },
        { name: 'local-tools', type: 'http', url: 'http://127.0.0.1:4312/mcp', headers: [] },
      ]),
    ).toEqual({
      'hq-tools': {
        url: 'https://mcp.example.com/tools',
        headers: { Authorization: 'Bearer test-token' },
        allowedHosts: ['mcp.example.com'],
        fetch: expect.any(Function),
      },
      'local-tools': {
        url: 'http://127.0.0.1:4312/mcp',
        allowedHosts: ['127.0.0.1:4312'],
        fetch: expect.any(Function),
      },
    });
  });

  it('pins ACP transport to the validated origin and refuses redirect following', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok'));
    try {
      const config = mapAcpMcpServers([
        { name: 'guarded', type: 'http', url: 'https://mcp.example.com/tools', headers: [] },
      ]).guarded!;
      await config.fetch!('https://mcp.example.com/tools', { redirect: 'follow' });
      expect(fetch).toHaveBeenCalledWith(new URL('https://mcp.example.com/tools'), { redirect: 'error' });
      for (const target of [
        'https://other.example.com/tools',
        'http://mcp.example.com/tools',
        'http://127.0.0.1/tools',
        'https://mcp.example.com:444/tools',
      ]) {
        expect(() => config.fetch!(target)).toThrow('outside the validated origin');
      }
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([
    ...['__proto__', 'constructor', 'prototype'].map(name => [
      `reserved server name ${name}`,
      [{ name, type: 'http', url: 'https://mcp.example.com/tools', headers: [] }],
    ]),
    ['stdio', [{ name: 'local', command: '/tmp/should-not-run', args: [], env: [] }]],
    ['remote HTTP', [{ name: 'remote-http', type: 'http', url: 'http://mcp.example.com/tools', headers: [] }]],
    [
      'embedded credentials',
      [{ name: 'credentials', type: 'http', url: 'https://user:password@mcp.example.com/tools', headers: [] }],
    ],
    ['URL fragment', [{ name: 'fragment', type: 'http', url: 'https://mcp.example.com/tools#secret', headers: [] }]],
    [
      'header injection',
      [
        {
          name: 'bad-header',
          type: 'http',
          url: 'https://mcp.example.com/tools',
          headers: [{ name: 'Authorization', value: 'Bearer one\r\nX-Evil: yes' }],
        },
      ],
    ],
    [
      'duplicate headers',
      [
        {
          name: 'duplicate-header',
          type: 'http',
          url: 'https://mcp.example.com/tools',
          headers: [
            { name: 'X-Token', value: 'one' },
            { name: 'x-token', value: 'two' },
          ],
        },
      ],
    ],
  ] as unknown as Array<[string, McpServer[]]>)('rejects %s MCP entries before boot', (_label, servers) => {
    expect(() => mapAcpMcpServers(servers)).toThrow();
  });

  it('rejects a client stdio command before Mastra Code starts', async () => {
    vi.mocked(bootLocalAgentController).mockClear();
    await expect(
      createAcpSession(newRequest([{ name: 'local', command: '/tmp/should-not-run', args: [], env: [] }])),
    ).rejects.toMatchObject({
      code: -32602,
    });
    expect(bootLocalAgentController).not.toHaveBeenCalled();
  });
});

describe('ACP runtime factory', () => {
  it('creates an isolated runtime with only the request MCP servers and disables ambient execution/config', async () => {
    const boot = bootResult();
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
    const runtime = await createAcpSession(
      newRequest([
        {
          name: 'hq-tools',
          type: 'http',
          url: 'https://mcp.example.com/tools',
          headers: [{ name: 'Authorization', value: 'Bearer token' }],
        },
      ]),
      { coAuthor: { name: 'ACP Test', email: 'acp@example.com' } },
    );
    const [config] = vi.mocked(bootLocalAgentController).mock.lastCall!;
    expect(config).toMatchObject({
      cwd: '/project',
      initialThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      resourceId: expect.stringMatching(/^mastracode-acp-[a-f0-9]{24}$/),
      coAuthor: { name: 'ACP Test', email: 'acp@example.com' },
      mcpServers: { 'hq-tools': { url: 'https://mcp.example.com/tools', headers: { Authorization: 'Bearer token' } } },
      disableMcpConfigDiscovery: true,
      disableMcpOAuth: true,
      disableHooks: true,
      disablePlugins: true,
      disableEnvFile: true,
      disableGithubSignals: true,
      disableSettingsOmSeed: true,
      unixSocketPubSub: false,
      initialState: { projectPath: '/project', yolo: false, permissionRules: { categories: {}, tools: {} } },
    });
    expect(boot.mcpManager.initInBackground).toHaveBeenCalledOnce();
    expect(runtime.session).toBe(boot.session);
    expect(runtime.modes).toEqual([{ id: 'build' }]);
    expect(runtime.getThinkingLevel?.()).toBe('medium');
    expect(loadSettings).toHaveBeenCalled();
    expect(resolveDefaultThinkingLevel).toHaveBeenCalledWith({}, 'build');

    await runtime.cleanup?.();
    await runtime.cleanup?.();
    expect(boot.session.thread.detachFromCurrent).toHaveBeenCalledOnce();
    expect(boot.session.thread.clearAndReleaseLock).toHaveBeenCalledOnce();
    expect(boot.mcpManager.disconnect).toHaveBeenCalledOnce();
    expect(boot.stopWorkers).toHaveBeenCalledOnce();
    expect(boot.shutdown).toHaveBeenCalledOnce();
    expect(boot.stopPluginSignalProviders).toHaveBeenCalledOnce();
    expect(boot.stopNotificationDispatch).toHaveBeenCalledOnce();
    expect(boot.stopNotificationDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      boot.controller.getMastra().shutdown.mock.invocationCallOrder[0]!,
    );
    expect(boot.githubSignals.stopAllPolling).toHaveBeenCalledOnce();
    expect(boot.closePubSub).toHaveBeenCalledOnce();
    expect(boot.closeStorage).toHaveBeenCalledOnce();
    expect(boot.shutdown.mock.invocationCallOrder[0]).toBeLessThan(boot.stopWorkers.mock.invocationCallOrder[0]!);
    expect(boot.shutdown.mock.invocationCallOrder[0]).toBeLessThan(boot.closeStorage.mock.invocationCallOrder[0]!);
    expect(boot.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      boot.session.thread.clearAndReleaseLock.mock.invocationCallOrder[0]!,
    );
  });

  it('retains thread ownership through fallback cleanup after shutdown fails', async () => {
    const boot = bootResult();
    const shutdownError = new Error('shutdown failed');
    boot.shutdown.mockRejectedValueOnce(shutdownError);
    let finishStorage!: () => void;
    let storageStarted!: () => void;
    const started = new Promise<void>(resolve => {
      storageStarted = resolve;
    });
    const storage = new Promise<void>(resolve => {
      finishStorage = resolve;
    });
    boot.closeStorage.mockImplementationOnce(async () => {
      storageStarted();
      await storage;
    });
    boot.closePubSub.mockImplementationOnce(function (this: unknown) {
      expect(this).toBe(boot.signalsPubSub);
      return Promise.resolve();
    });
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
    const runtime = await createAcpSession(newRequest());
    const cleanup = runtime.cleanup!();
    const rejected = expect(cleanup).rejects.toMatchObject({ errors: [shutdownError] });
    try {
      await started;
      expect(boot.session.thread.clearAndReleaseLock).not.toHaveBeenCalled();
    } finally {
      finishStorage();
    }
    await rejected;
    expect(boot.closePubSub).toHaveBeenCalledOnce();
    expect(boot.session.thread.clearAndReleaseLock).toHaveBeenCalledOnce();
  });

  it('binds resume to the exact existing thread and refuses to create a replacement', async () => {
    const boot = bootResult();
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
    const request: LoadSessionRequest = { cwd: '/project', mcpServers: [], sessionId: 'existing-thread' };
    const runtime = await createAcpSession(request);
    expect(vi.mocked(bootLocalAgentController).mock.lastCall?.[0]).toMatchObject({
      initialThreadId: 'existing-thread',
      requireExistingThread: true,
    });
    await runtime.cleanup?.();
  });

  it('does not return MCP initialization details that may contain credentials or private URLs', async () => {
    const boot = bootResult();
    boot.mcpManager.initInBackground.mockResolvedValueOnce({
      failed: [{ name: 'hq-tools', error: 'Authorization: Bearer secret-token at https://private.example' }],
    } as never);
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
    await expect(
      createAcpSession(
        newRequest([{ name: 'hq-tools', type: 'http', url: 'https://mcp.example.com/tools', headers: [] }]),
      ),
    ).rejects.toMatchObject({
      code: -32603,
      message: 'Internal error: Mastra Code ACP HTTP MCP initialization failed',
    });
    expect(boot.mcpManager.disconnect).toHaveBeenCalledOnce();
    expect(boot.closeStorage).toHaveBeenCalledOnce();
  });

  it('maps a missing resumed thread to a generic not-found response', async () => {
    vi.mocked(bootLocalAgentController).mockRejectedValueOnce(new Error('Thread not found: private-id'));
    await expect(createAcpSession({ cwd: '/project', mcpServers: [], sessionId: 'private-id' })).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: ACP session not found',
    });
  });
});

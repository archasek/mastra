import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadSessionRequest, McpServer, NewSessionRequest } from '@agentclientprotocol/sdk';
import { Agent } from '@mastra/core/agent';
import { AgentController } from '@mastra/core/agent-controller';
import { InMemoryStore } from '@mastra/core/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastraCodeGateway } from '../agents/mastracode-gateway.js';
import { AuthStorage } from '../auth/storage.js';
import type { CredentialStore } from '../auth/types.js';
import { bootLocalAgentController } from '../index.js';
import { loadSettings, resolveDefaultThinkingLevel } from '../onboarding/settings.js';
import {
  CODEX_CATALOG_CLIENT_VERSION,
  CODEX_CATALOG_ENDPOINT,
  CODEX_CATALOG_FILENAME,
  CODEX_CATALOG_TTL_MS,
  readCodexCatalog,
} from '../providers/openai-codex-catalog.js';
import { createAcpSession, mapAcpMcpServers } from './runtime.js';

vi.mock('../onboarding/settings.js', () => ({
  loadSettings: vi.fn(() => ({})),
  resolveDefaultThinkingLevel: vi.fn(() => ({ level: 'medium' })),
}));

vi.mock('../index.js', () => ({ bootLocalAgentController: vi.fn() }));

function bootResult() {
  const session = {
    model: { get: vi.fn(() => 'openai/gpt-6-luna') },
    abort: vi.fn(),
    mode: { get: vi.fn(() => 'build') },
    state: {
      get: vi.fn<() => { openaiAuthRoute?: 'oauth' | 'api-key' }>(() => ({})),
      set: vi.fn().mockResolvedValue(undefined),
    },
    thread: {
      getId: vi.fn(() => 'boot-thread'),
      getSetting: vi.fn().mockResolvedValue(undefined),
      setSetting: vi.fn().mockResolvedValue(undefined),
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
    authStorage: { get: vi.fn<CredentialStore['get']>(() => undefined), reload: vi.fn() },
    controller: {
      listModes: () => [{ id: 'build' }],
      getMastra: () => ({ stopWorkers, shutdown }),
      stopIntervals: vi.fn(),
    },
    mcpManager,
    githubSignals: { stopAllPolling: vi.fn() },
    stopPluginSignalProviders: vi.fn(),
    threadScheduler: { stop: vi.fn() },
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

describe('ACP native OAuth catalog ownership', () => {
  it('persists ownership through native thread storage and a fresh controller after logout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-mc-native-route-'));
    const oldDir = process.env.MASTRA_APP_DATA_DIR;
    process.env.MASTRA_APP_DATA_DIR = dir;
    const storage = new InMemoryStore();
    const makeController = () =>
      new AgentController({
        id: 'native-route-controller',
        storage,
        modes: [
          {
            id: 'build',
            name: 'Build',
            default: true,
            agent: new Agent({
              id: 'native-route-agent',
              name: 'Native route',
              instructions: 'Test only; never invoked.',
              model: 'openai/gpt-6-luna',
            }),
          },
        ],
      });
    const credential = {
      type: 'oauth' as const,
      access: 'synthetic',
      refresh: 'synthetic',
      expires: Date.now() + 60_000,
      accountId: 'a',
    };
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ 'apikey:openai-codex': { type: 'api_key', key: 'synthetic-key' } }),
    );
    try {
      const first = makeController();
      await first.init();
      const firstSession = await first.createSession({ id: 'first', ownerId: 'owner' });
      const thread = await firstSession.thread.create();
      const firstBoot = bootResult();
      const nativeAuth = new AuthStorage(join(dir, 'auth.json'));
      vi.mocked(bootLocalAgentController).mockResolvedValueOnce({
        ...firstBoot,
        authStorage: nativeAuth,
        session: firstSession,
      } as never);
      const firstRuntime = await createAcpSession(newRequest());
      const memory = await storage.getStore('memory');
      expect((await memory!.getThreadById({ threadId: thread.id }))?.metadata?.openaiAuthRoute).toBeUndefined();
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': credential }));
      writeFileSync(
        join(dir, CODEX_CATALOG_FILENAME),
        JSON.stringify({
          schemaVersion: 1,
          provider: 'openai-codex',
          scope: { kind: 'legacy', accountId: 'a' },
          endpoint: CODEX_CATALOG_ENDPOINT,
          clientVersion: CODEX_CATALOG_CLIENT_VERSION,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + CODEX_CATALOG_TTL_MS,
          slugs: ['gpt-6-luna'],
        }),
      );
      await firstRuntime.modelCatalog!.admitModel!('openai/gpt-6-luna');
      expect((await memory!.getThreadById({ threadId: thread.id }))?.metadata?.openaiAuthRoute).toBe('oauth');
      await firstRuntime.cleanup?.();
      writeFileSync(
        join(dir, 'auth.json'),
        JSON.stringify({ 'apikey:openai-codex': { type: 'api_key', key: 'synthetic-key' } }),
      );
      const restarted = makeController();
      await restarted.init();
      const restoredSession = await restarted.createSession({ id: 'restored', ownerId: 'owner' });
      await restoredSession.thread.switch({ threadId: thread.id });
      const restoredBoot = bootResult();
      const restoredAuth = new AuthStorage(join(dir, 'auth.json'));
      expect(restoredAuth.getStoredApiKey('openai-codex')).toBe('synthetic-key');
      vi.mocked(bootLocalAgentController).mockResolvedValueOnce({
        ...restoredBoot,
        authStorage: restoredAuth,
        session: restoredSession,
      } as never);
      const restored = await createAcpSession({ ...newRequest(), sessionId: thread.id });
      expect(restored.modelCatalog!.isOAuthModel('openai/gpt-6-luna')).toBe(true);
      const gatewayKey = vi.spyOn(MastraCodeGateway, 'getMastraGatewayApiKey').mockReturnValue(undefined);
      try {
        expect(restored.modelCatalog!.isOAuthModel('mastra/openai/gpt-6-luna')).toBe(true);
        expect(() => restored.modelCatalog!.assertModel('mastra/openai/gpt-6-luna')).toThrow('Refresh');
        gatewayKey.mockReturnValue('synthetic-gateway-key');
        expect(restored.modelCatalog!.isOAuthModel('mastra/openai/gpt-6-luna')).toBe(false);
        expect(() => restored.modelCatalog!.assertModel('mastra/openai/gpt-6-luna')).not.toThrow();
      } finally {
        gatewayKey.mockRestore();
      }
      expect(() => restored.modelCatalog!.assertModel('openai/gpt-6-luna')).toThrow('Refresh');
      await restored.cleanup?.();
    } finally {
      if (oldDir === undefined) delete process.env.MASTRA_APP_DATA_DIR;
      else process.env.MASTRA_APP_DATA_DIR = oldDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the shared offline member set and rejects account change, expiry and sign-out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-mc-runtime-catalog-'));
    const oldDir = process.env.MASTRA_APP_DATA_DIR;
    process.env.MASTRA_APP_DATA_DIR = dir;
    const now = Date.now();
    const auth = {
      'openai-codex': {
        type: 'oauth' as const,
        access: 'synthetic',
        refresh: 'synthetic',
        expires: now + 60_000,
        accountId: 'account-a',
      },
    };
    const cache = {
      schemaVersion: 1,
      provider: 'openai-codex',
      scope: { kind: 'legacy', accountId: 'account-a' },
      endpoint: CODEX_CATALOG_ENDPOINT,
      clientVersion: CODEX_CATALOG_CLIENT_VERSION,
      fetchedAt: now,
      expiresAt: now + CODEX_CATALOG_TTL_MS,
      slugs: ['gpt-6.1-sol', 'gpt-6-luna'],
    };
    const publish = () => {
      writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
      writeFileSync(join(dir, CODEX_CATALOG_FILENAME), JSON.stringify(cache));
    };
    publish();
    const boot = bootResult();
    boot.authStorage.get.mockImplementation(provider =>
      provider === 'openai-codex' ? JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))[provider] : undefined,
    );
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
    try {
      const runtime = await createAcpSession(newRequest());
      expect(boot.session.state.set).toHaveBeenCalledWith({ openaiAuthRoute: 'oauth' });
      const catalog = runtime.modelCatalog!;
      const generic = [
        { id: 'openai/gpt-5.4-mini', hasApiKey: true },
        { id: 'other/model', hasApiKey: true },
      ];
      expect(catalog.filterModels(generic).map(model => model.id)).toEqual([
        'other/model',
        ...readCodexCatalog(dir).models,
      ]);
      expect(() => catalog.assertModel('openai/gpt-6-luna')).not.toThrow();
      expect(() => catalog.assertModel('openai/gpt-5.4-mini')).toThrow('Refresh');
      auth['openai-codex'].accountId = 'account-b';
      publish();
      expect(() => catalog.assertModel('openai/gpt-6-luna')).toThrow('Refresh');
      auth['openai-codex'].accountId = 'account-a';
      cache.fetchedAt = now - CODEX_CATALOG_TTL_MS;
      cache.expiresAt = now;
      publish();
      expect(catalog.filterModels(generic)).toEqual([{ id: 'other/model', hasApiKey: true }]);
      writeFileSync(join(dir, 'auth.json'), '{}');
      expect(catalog.isOAuthModel('openai/gpt-6-luna')).toBe(true);
      expect(() => catalog.assertModel('openai/gpt-6-luna')).toThrow('Refresh');
      expect(() => catalog.assertModel('other/model')).not.toThrow();
      await runtime.cleanup?.();
      // A fresh controller must hydrate persisted ownership, not decide its
      // route from the currently signed-out credential slot.
      const restored = bootResult();
      restored.session.thread.getSetting.mockResolvedValue('oauth');
      restored.authStorage.get.mockImplementation(provider =>
        provider === 'openai' ? { type: 'api_key', key: 'synthetic-key' } : undefined,
      );
      vi.mocked(bootLocalAgentController).mockResolvedValueOnce(restored as never);
      const restoredRuntime = await createAcpSession({ ...newRequest(), sessionId: 'boot-thread' });
      expect(() => restoredRuntime.modelCatalog!.assertModel('openai/gpt-6-luna')).toThrow('Refresh');
      expect(restored.session.state.set).toHaveBeenCalledWith({ openaiAuthRoute: 'oauth' });
      await restoredRuntime.cleanup?.();
    } finally {
      if (oldDir === undefined) delete process.env.MASTRA_APP_DATA_DIR;
      else process.env.MASTRA_APP_DATA_DIR = oldDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves non-OAuth OpenAI and other-provider inventory', async () => {
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(bootResult() as never);
    const runtime = await createAcpSession(newRequest());
    const models = [
      { id: 'openai/gpt-5.4-mini', hasApiKey: true },
      { id: 'other/custom', hasApiKey: true },
    ];
    expect(runtime.modelCatalog!.filterModels(models)).toEqual(models);
    expect(() => runtime.modelCatalog!.assertModel('openai/gpt-5.4-mini')).not.toThrow();
    await runtime.cleanup?.();
  });
});

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
  afterEach(() => vi.useRealTimers());
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
      disallowExperimentalAgent: true,
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
    expect(boot.threadScheduler.stop).toHaveBeenCalledOnce();
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

  it.each(['resolve', 'reject'] as const)(
    'retains ownership beyond the upstream dispatch grace when dispatch later %ss',
    async late => {
      vi.useFakeTimers();
      const boot = bootResult();
      let finish!: () => void;
      let fail!: (error: Error) => void;
      let dispatchStarted!: () => void;
      const started = new Promise<void>(resolve => {
        dispatchStarted = resolve;
      });
      const dispatch = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      boot.stopNotificationDispatch.mockImplementationOnce(() => {
        expect(boot.threadScheduler.stop).toHaveBeenCalledOnce();
        expect(boot.stopPluginSignalProviders).toHaveBeenCalledOnce();
        expect(boot.githubSignals.stopAllPolling).toHaveBeenCalledOnce();
        dispatchStarted();
        return dispatch;
      });
      vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
      const runtime = await createAcpSession(newRequest());
      const cleanup = runtime.cleanup!();
      expect(runtime.cleanup!()).toBe(cleanup);
      const completed =
        late === 'reject' ? expect(cleanup).rejects.toMatchObject({ errors: [expect.any(Error)] }) : cleanup;
      await started;
      await vi.advanceTimersByTimeAsync(2_001);
      expect(boot.shutdown).not.toHaveBeenCalled();
      expect(boot.closeStorage).not.toHaveBeenCalled();
      expect(boot.session.thread.clearAndReleaseLock).not.toHaveBeenCalled();
      if (late === 'resolve') finish();
      else fail(new Error('late dispatch failure'));
      await completed;
      expect(boot.shutdown).toHaveBeenCalledOnce();
      expect(boot.closeStorage).toHaveBeenCalledOnce();
      expect(boot.session.thread.clearAndReleaseLock).toHaveBeenCalledOnce();
    },
  );

  it('binds resume to the exact existing thread and refuses to create a replacement', async () => {
    const boot = bootResult();
    vi.mocked(bootLocalAgentController).mockResolvedValueOnce(boot as never);
    const request: LoadSessionRequest = { cwd: '/project', mcpServers: [], sessionId: 'existing-thread' };
    const runtime = await createAcpSession(request);
    expect(vi.mocked(bootLocalAgentController).mock.lastCall?.[0]).toMatchObject({
      initialThreadId: 'existing-thread',
      requireExistingThread: true,
      disallowExperimentalAgent: true,
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

  it.each([false, true])('explains unsupported experimental mode for ACP boot (resume: %s)', async isResume => {
    vi.mocked(bootLocalAgentController).mockRejectedValueOnce(
      new Error('Experimental agent mode is not supported by ACP; use the regular agent.'),
    );
    await expect(
      createAcpSession({ cwd: '/project', mcpServers: [], ...(isResume ? { sessionId: 'existing-thread' } : {}) }),
    ).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: Experimental agent mode is not supported by ACP; use the regular agent.',
    });
    expect(vi.mocked(bootLocalAgentController).mock.lastCall?.[0]).toMatchObject({
      disallowExperimentalAgent: true,
    });
  });

  it('maps a missing resumed thread to a generic not-found response', async () => {
    vi.mocked(bootLocalAgentController).mockRejectedValueOnce(new Error('Thread not found: private-id'));
    await expect(createAcpSession({ cwd: '/project', mcpServers: [], sessionId: 'private-id' })).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: ACP session not found',
    });
  });
});

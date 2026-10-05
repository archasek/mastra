import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  acpMain: vi.fn(),
  login: vi.fn(),
  runMCCli: vi.fn(),
  releaseLocks: vi.fn(),
  diagnostics: vi.fn(),
}));
vi.mock('@mastra/code-sdk', () => ({ createMastraCode: () => new Promise(() => {}) }));
vi.mock('@mastra/code-sdk/analytics', () => ({ createMastraCodeAnalytics: vi.fn() }));
vi.mock('@mastra/code-sdk/headless/index', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, runMCCli: state.runMCCli };
});
vi.mock('./login-command.js', () => ({ runLoginCommand: state.login }));
vi.mock('@mastra/code-sdk/acp/index', () => ({ acpMain: state.acpMain }));
vi.mock('@mastra/code-sdk/onboarding/settings', () => ({
  loadSettings: () => ({ browser: {}, preferences: {} }),
  createBrowserFromSettings: vi.fn(),
  resolveStagehandModel: vi.fn(),
  toActiveBrowserSettings: vi.fn(),
}));
vi.mock('@mastra/code-sdk/utils/thread-lock', () => ({
  releaseAllThreadLocks: state.releaseLocks,
  releaseAllThreadLocksSync: vi.fn(),
}));
vi.mock('./process-memory-diagnostics-lifecycle.js', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startTuiProcessMemoryDiagnostics: state.diagnostics,
}));
vi.mock('./tui/index.js', () => ({ MastraTUI: class {} }));
vi.mock('./tui/theme.js', () => ({ applyThemeMode: vi.fn(), restoreTerminalForeground: vi.fn() }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalPrompt = process.env.MASTRACODE_TUI_INITIAL_PROMPT;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalPrompt === undefined) delete process.env.MASTRACODE_TUI_INITIAL_PROMPT;
  else process.env.MASTRACODE_TUI_INITIAL_PROMPT = originalPrompt;
  vi.restoreAllMocks();
});

describe('main entrypoint cleanup ownership', () => {
  it.each([
    [['--prompt', '--acp'], 'headless'],
    [['-p', '--acp'], 'headless'],
    [['--acp', '--help'], 'headless'],
    [['--tui-prompt', '--acp'], 'tui'],
    [['--acp'], 'acp'],
    [['login'], 'command'],
    [['--acp', 'login'], 'command'],
    [['--dangerous-auto-approve', '--acp', 'login', '--help'], 'command'],
    [['--tui-prompt', 'hello', 'plugin'], 'headless'],
    [['--tui-prompt', 'hello', 'prune', '--acp'], 'headless'],
  ] as const)(
    'executes matching lifecycle ownership for %j',
    async (args, mode) => {
      vi.resetModules();
      state.login.mockReset().mockResolvedValue(0);
      state.acpMain.mockReset().mockResolvedValue(undefined);
      state.runMCCli.mockReset().mockResolvedValue(undefined);
      state.diagnostics.mockReset().mockResolvedValue(undefined);
      process.argv = ['node', 'mastracode', ...args];
      const on = vi.spyOn(process, 'on').mockReturnValue(process);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await import('./main.js');
      if (mode === 'acp') await vi.waitFor(() => expect(state.acpMain).toHaveBeenCalledOnce());
      if (mode === 'command') {
        await vi.waitFor(() => expect(state.login).toHaveBeenCalledOnce());
        expect(state.acpMain).not.toHaveBeenCalled();
        expect(state.runMCCli).not.toHaveBeenCalled();
      }
      if (mode === 'headless') expect(state.runMCCli).toHaveBeenCalledOnce();
      if (args[0] === '--tui-prompt' && args[1] === 'hello') {
        expect(exit).toHaveBeenCalledWith(1);
        expect(stderr).toHaveBeenCalledWith(
          '--tui-prompt starts the interactive TUI; use --prompt for headless runs\n',
        );
      }
      const events = on.mock.calls.map(([event]) => event);
      for (const event of ['SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) {
        expect(events.includes(event)).toBe(mode !== 'acp');
      }
    },
    15_000,
  );

  it('handles rejected ACP boot without TUI cleanup or crash writing', async () => {
    vi.resetModules();
    state.acpMain.mockReset().mockRejectedValue(new Error('private startup payload'));
    state.releaseLocks.mockReset();
    state.diagnostics.mockReset();
    process.argv = ['node', 'mastracode', '--acp'];
    vi.spyOn(process, 'on').mockReturnValue(process);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const crash = vi.spyOn(fs, 'appendFileSync');
    await import('./main.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(stderr).toHaveBeenCalledWith('[acp] Failed to start.\n');
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('private startup payload'));
    expect(crash).not.toHaveBeenCalled();
    expect(state.releaseLocks).not.toHaveBeenCalled();
    expect(state.diagnostics).not.toHaveBeenCalled();
  });
});

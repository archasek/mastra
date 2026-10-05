#!/usr/bin/env node
/**
 * Main entry point for Mastra Code TUI.
 */
import fs from 'node:fs';

import { createMastraCode } from '@mastra/code-sdk';
import { createMastraCodeAnalytics } from '@mastra/code-sdk/analytics';
import { isStreamDestroyedError } from '@mastra/code-sdk/error-classification';
import { hasHeadlessFlag, runMCCli } from '@mastra/code-sdk/headless/index';
import {
  createBrowserFromSettings,
  loadSettings,
  resolveStagehandModel,
  toActiveBrowserSettings,
} from '@mastra/code-sdk/onboarding/settings';
import { formatScaffoldSuccess, scaffoldPlugin } from '@mastra/code-sdk/plugins/scaffold';
import {
  stopProcessMemoryDiagnosticsWithTimeout,
  type ProcessMemoryDiagnostics,
} from '@mastra/code-sdk/process-memory-diagnostics';
import { setupDebugLogging, truncateLogFile } from '@mastra/code-sdk/utils/debug-log';
import { drainPipedStdin, reopenStdinFromTTY } from '@mastra/code-sdk/utils/stdin-pipe';
import { releaseAllThreadLocks, releaseAllThreadLocksSync } from '@mastra/code-sdk/utils/thread-lock';
import { TUI_CO_AUTHOR } from './commit-attribution.js';
import { initialMessageOptions, pipedInputConflict, takeInitialPrompt } from './initial-prompt.js';
import {
  createOneShotFatalErrorHandler,
  createShutdownCoordinator,
  startTuiProcessMemoryDiagnostics,
} from './process-memory-diagnostics-lifecycle.js';
import {
  formatResumeHint,
  parseResumeThreadId,
  resolveEntrypointMode,
  shouldRejectResumeWithoutTTY,
} from './resume-command.js';
import { resolveTuiSubagents } from './subagent-settings.js';
import { detectTerminalTheme } from './tui/detect-theme.js';
import { MastraTUI } from './tui/index.js';
import { applyThemeMode, restoreTerminalForeground } from './tui/theme.js';
import { getCurrentVersion } from './version.js';

let controller: Awaited<ReturnType<typeof createMastraCode>>['controller'];
let mcpManager: Awaited<ReturnType<typeof createMastraCode>>['mcpManager'];
let hookManager: Awaited<ReturnType<typeof createMastraCode>>['hookManager'];
let authStorage: Awaited<ReturnType<typeof createMastraCode>>['authStorage'];
let signalsPubSub: Awaited<ReturnType<typeof createMastraCode>>['signalsPubSub'];
let storageMaintenance: Awaited<ReturnType<typeof createMastraCode>>['storageMaintenance'];
let stopPluginSignalProviders: Awaited<ReturnType<typeof createMastraCode>>['stopPluginSignalProviders'] | undefined;
let threadScheduler: Awaited<ReturnType<typeof createMastraCode>>['threadScheduler'] | undefined;
let stopNotificationDispatch: Awaited<ReturnType<typeof createMastraCode>>['stopNotificationDispatch'] | undefined;
let analytics: ReturnType<typeof createMastraCodeAnalytics> | undefined;
let tui: MastraTUI | undefined;
let processMemoryDiagnostics: ProcessMemoryDiagnostics | undefined;
let storageClosed = false;
let cleanupPromise: Promise<void> | null = null;
let getResumeThreadId: (() => string | null) | undefined;

const CRASH_LOG_PATH = '/tmp/mastra-crash.log';

// Use the same prompt parser as main: a prompt value such as "--acp" is
// not a mode flag. A copy preserves main's environment-consumption behavior.
const startupArgv = takeInitialPrompt(process.argv, { ...process.env }).argv;
const entrypointMode = resolveEntrypointMode(startupArgv, hasHeadlessFlag(startupArgv), process.argv);
const acpMode = entrypointMode === 'acp';

function isTruthyEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(process.env[name]?.trim().toLowerCase() ?? '');
}

function resolveInitialStateFromEnv() {
  const currentModelId = process.env.MASTRACODE_MODEL_ID?.trim();
  const initialState: Record<string, unknown> = {};
  if (currentModelId) initialState.currentModelId = currentModelId;
  if (isTruthyEnv('MASTRACODE_YOLO')) initialState.yolo = true;
  return Object.keys(initialState).length > 0 ? initialState : undefined;
}

// Global safety nets — catch any uncaught errors from storage init, etc.
if (!acpMode) {
  process.on('uncaughtException', error => {
    // ERR_STREAM_DESTROYED is non-fatal — happens routinely when streams close
    // during shutdown, cancelled LLM requests, or LSP/subprocess exits (#13548, #13549)
    if (isStreamDestroyedError(error)) return;
    handleFatalError(error);
  });
  process.on('unhandledRejection', reason => {
    if (isStreamDestroyedError(reason)) return;
    handleFatalError(reason instanceof Error ? reason : new Error(String(reason)));
  });
}

async function tuiMain(startupMessage: ReturnType<typeof initialMessageOptions> = {}, resumeThreadId?: string) {
  const settings = loadSettings();
  processMemoryDiagnostics = await startTuiProcessMemoryDiagnostics(process.env, warning => {
    console.info(`⚠ ${warning}`);
  });
  let browserPromise: ReturnType<typeof createBrowserFromSettings> | undefined;
  const loadBrowser = (chatModelId: string | undefined) => {
    browserPromise ??= createBrowserFromSettings(settings.browser, { chatModelId });
    return browserPromise;
  };

  const initialState = resolveInitialStateFromEnv();
  const result = await createMastraCode({
    createInitialThread: false,
    coAuthor: TUI_CO_AUTHOR,
    unixSocketPubSub: !isTruthyEnv('MASTRACODE_DISABLE_UNIX_SOCKET_PUBSUB'),
    disableMcp: isTruthyEnv('MASTRACODE_DISABLE_MCP'),
    disableHooks: isTruthyEnv('MASTRACODE_DISABLE_HOOKS'),
    subagents: resolveTuiSubagents(settings.preferences.subagentsEnabled),
    ...(isTruthyEnv('MASTRACODE_DISABLE_MEMORY') ? { memory: false as never } : {}),
    ...(initialState ? { initialState: initialState as never } : {}),
  });
  controller = result.controller;
  mcpManager = result.mcpManager;
  hookManager = result.hookManager;
  authStorage = result.authStorage;
  signalsPubSub = result.signalsPubSub;
  storageMaintenance = result.storageMaintenance;
  stopPluginSignalProviders = result.stopPluginSignalProviders;
  threadScheduler = result.threadScheduler;
  stopNotificationDispatch = result.stopNotificationDispatch;

  if (result.storageWarning) {
    console.info(`⚠ ${result.storageWarning}`);
  }
  if (result.observabilityWarning) {
    console.info(`⚠ ${result.observabilityWarning}`);
  }

  // MCP connection is deferred to TUI.init() (after ui.start()) so that
  // status messages use showInfo() instead of console.info(), which would
  // corrupt the terminal.  Headless mode still inits from headless/cli.ts.

  setupDebugLogging();

  // Detect and apply terminal theme
  // MASTRA_THEME env var is the highest-priority override
  const envTheme = process.env.MASTRA_THEME?.toLowerCase();
  let themeMode: 'dark' | 'light';
  let detectedBgHex: string | undefined;
  if (envTheme === 'dark' || envTheme === 'light') {
    themeMode = envTheme;
  } else {
    const settings = loadSettings();
    const themePref = settings.preferences.theme;
    if (themePref === 'dark' || themePref === 'light') {
      themeMode = themePref;
    } else {
      const detection = await detectTerminalTheme();
      themeMode = detection.mode;
      detectedBgHex = detection.detectedBgHex;
    }
  }
  applyThemeMode(themeMode, detectedBgHex);

  // createMastraCode() brought up shared resources and minted the single
  // session that all work runs through. The AgentController owns no session of its own.
  const session = result.session;
  getResumeThreadId = () => (tui ? tui.getResumeThreadId() : session.thread.getId());

  analytics = createMastraCodeAnalytics({ version: getCurrentVersion() });
  analytics.capture('mastracode_session_started', {
    mode: session.mode.get(),
    resourceId: session.identity.getResourceId(),
    hasAuthStorage: Boolean(authStorage),
    hasMcp: Boolean(mcpManager),
    theme: themeMode,
  });

  tui = new MastraTUI({
    controller: controller,
    session,
    hookManager,
    analytics,
    authStorage,
    mcpManager,
    pluginManager: result.pluginManager,
    storageMaintenance: result.storageMaintenance,
    processMemoryDiagnostics,
    knowledgeInspector: result.knowledgeInspector,
    threadScheduler: result.threadScheduler,
    appName: 'Mastra Code',
    version: getCurrentVersion(),
    inlineQuestions: true,
    ...(resumeThreadId ? { resumeThreadId } : {}),
    githubSignals: result.githubSignals,
    backgroundToolsEnabled: result.backgroundToolsEnabled,
    backgroundCompletionEvents: result.backgroundCompletionEvents,
    exit: exitCode => void shutdownAndExit(exitCode),
    ...startupMessage,
  });
  tui.run().catch(error => {
    handleFatalError(error);
  });

  if (settings.browser.enabled) {
    // Captured once: the Stagehand instance is fixed at launch and shared by every thread.
    const chatModelId = session.model.get();
    void loadBrowser(chatModelId)
      .then(browser => {
        if (!browser) return;
        controller.setBrowser(browser);
        void session.state
          .set({
            activeBrowserSettings: toActiveBrowserSettings(settings.browser),
            activeBrowserModel: resolveStagehandModel(settings.browser, { chatModelId }),
          } as any)
          .catch(() => {});
      })
      .catch(() => {});
  }
}

const asyncCleanup = (): Promise<void> => {
  cleanupPromise ??= (async () => {
    // Stop plugin-contributed signal providers (and the plugin reload listener)
    // before quiescing workers: a provider that keeps polling past this point
    // could dispatch into a controller that is shutting down.
    try {
      stopPluginSignalProviders?.();
    } catch {
      // Best-effort — the process is exiting.
    }
    const diagnosticsShutdown = processMemoryDiagnostics
      ? stopProcessMemoryDiagnosticsWithTimeout(processMemoryDiagnostics, message => console.warn(message))
      : undefined;
    // Schedules live only in this process; stop their timers so none fires mid-shutdown.
    threadScheduler?.stop();
    // Release this process's notification dispatch leases before the pubsub that holds them closes.
    await stopNotificationDispatch?.().catch(() => {});
    await Promise.allSettled([mcpManager?.disconnect(), controller?.stopIntervals()]);
    // Mastra owns the workspaces and must destroy them to stop retained language
    // servers before storage is closed.
    await Promise.allSettled([controller?.getMastra()?.shutdown(), analytics?.shutdown()]);
    // The signals pubsub is Mastra's event bus: in-flight runs and background
    // tasks drain through it during shutdown, so close it only afterwards. Call
    // close() on the object; a detached method loses `this` and rejects silently.
    const pubsubToClose = signalsPubSub as { close?: () => Promise<void> | void } | undefined;
    await Promise.allSettled([pubsubToClose?.close?.()]);
    // Checkpoint WAL and close the local storage connection after all producers
    // and timers are quiesced. Idempotent — repeated signals (SIGINT then SIGHUP)
    // close only once. LibSQLStore.close()/LibSQLVector.close() truncate the WAL
    // and switch back to DELETE journal mode for a clean shutdown.
    if (!storageClosed) {
      storageClosed = true;
      await storageMaintenance?.closeStorage?.().catch(() => {
        // Swallow — best-effort cleanup during shutdown. The process is exiting.
      });
    }
    await diagnosticsShutdown;
    // Retain thread ownership until all producers and storage have drained.
    // The synchronous exit handler remains the fallback for forced exits.
    await releaseAllThreadLocks();
  })();
  return cleanupPromise;
};

const shutdownAndExit = createShutdownCoordinator(asyncCleanup, exitCode => process.exit(exitCode));

process.on('beforeExit', () => {
  if (!acpMode) void asyncCleanup();
});
process.on('exit', () => {
  if (!acpMode) {
    // ACP stdout is the NDJSON protocol stream, never a terminal channel.
    // Keep terminal reset bytes off stdout even when the ACP child exits.
    try {
      tui?.stop();
    } catch {
      // Failsafe: the raw reset below still restores the interactive terminal.
    }
    try {
      process.stdout.write(
        '\x1b[?2004l' + // disable bracketed paste
          '\x1b[<u' + // pop kitty keyboard protocol
          '\x1b[>4;0m' + // disable modifyOtherKeys
          '\x1b[?25h', // show cursor
      );
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // stdout may already be closed during exit
    }
    restoreTerminalForeground();
    try {
      const threadId = getResumeThreadId?.();
      if (threadId) process.stdout.write(`\n${formatResumeHint(threadId)}\n`);
    } catch {
      // session state or stdout may already be closed during exit
    }
  }
  releaseAllThreadLocksSync();
});

// Start durable diagnostics shutdown before synchronous TUI teardown so a stalled
// terminal cleanup cannot prevent the final profile capture. The exit handler still
// provides a failsafe terminal reset if teardown throws.
const handleTermSignal = () => {
  void asyncCleanup();
  try {
    tui?.stop();
  } catch {
    // ignored — exit handler has failsafe reset
  }
  void shutdownAndExit(0);
};
// ACP owns its runtime and signal-driven drain. TUI cleanup has no references
// to that runtime and must not release its leases or exit ahead of its disposer.
if (!acpMode) {
  process.on('SIGINT', handleTermSignal);
  process.on('SIGTERM', handleTermSignal);
  process.on('SIGHUP', handleTermSignal);
}

function hasEconnrefused(err: unknown, depth = 0): boolean {
  if (!err || depth > 5) return false;
  const e = err as any;
  if (e.code === 'ECONNREFUSED') return true;
  if (e.cause) return hasEconnrefused(e.cause, depth + 1);
  // AggregateError has .errors array
  if (Array.isArray(e.errors)) return e.errors.some((inner: unknown) => hasEconnrefused(inner, depth + 1));
  return false;
}

function pluginMain(args: string[]): void {
  if (args[0] !== 'scaffold') {
    process.stderr.write('Usage: mastracode plugin scaffold <dir> [--id acme.foo] [--name "Foo Tools"]\n');
    process.exit(1);
  }

  const dir = args[1];
  if (!dir) {
    process.stderr.write('Usage: mastracode plugin scaffold <dir> [--id acme.foo] [--name "Foo Tools"]\n');
    process.exit(1);
  }

  const id = readFlag(args, '--id');
  const name = readFlag(args, '--name');
  const targetDir = scaffoldPlugin(dir, { ...(id ? { id } : {}), ...(name ? { name } : {}) });
  process.stdout.write(`${formatScaffoldSuccess(targetDir)}\n`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

const handleFatalError = createOneShotFatalErrorHandler((error: unknown): void => {
  // Always write to real stderr, even if console.error was overridden
  const write = (msg: string) => {
    try {
      process.stderr.write(msg + '\n');
    } catch {}
  };

  if (hasEconnrefused(error)) {
    const settings = loadSettings();
    const connStr = settings.storage?.pg?.connectionString;
    const target = connStr ?? 'localhost:5432';
    write(
      `\nFailed to connect to PostgreSQL at ${target}.` +
        `\nMake sure the database is running and accessible.` +
        `\n\nTo switch back to LibSQL:` +
        `\n  Set MASTRA_STORAGE_BACKEND=libsql or change the backend in /settings\n`,
    );
    void asyncCleanup();
    try {
      tui?.stop();
    } catch {}
    void shutdownAndExit(1);
    return;
  }

  const msg = `Fatal error: ${error instanceof Error ? error.message : String(error)}`;
  write(msg);
  // Write crash log to file so it persists even if terminal closes
  try {
    const crashLog = `[${new Date().toISOString()}] ${msg}\n${error instanceof Error && error.stack ? error.stack + '\n' : ''}`;
    truncateLogFile(CRASH_LOG_PATH);
    fs.appendFileSync(CRASH_LOG_PATH, crashLog);
    truncateLogFile(CRASH_LOG_PATH);
  } catch {}
  if (error instanceof Error && error.stack) {
    write(error.stack);
  }
  void asyncCleanup();
  try {
    tui?.stop();
  } catch {}
  void shutdownAndExit(1);
});

async function main() {
  if (process.argv[2] === 'plugin') {
    return pluginMain(process.argv.slice(3));
  }

  // Storage maintenance without the TUI, so a database can still be pruned and
  // compacted when the interactive session won't start. Checked before the
  // headless branch below, which would otherwise claim `prune --help`.
  if (process.argv[2] === 'prune') {
    const { runPruneCommand } = await import('@mastra/code-sdk/utils/prune-cli');
    return process.exit(await runPruneCommand(process.argv.slice(3)));
  }

  const loginIndex = process.argv.findIndex(
    (arg, index) => index >= 2 && arg !== '--acp' && arg !== '--dangerous-auto-approve',
  );
  if (process.argv[loginIndex] === 'login') {
    const { runLoginCommand } = await import('./login-command.js');
    const code = await runLoginCommand({ args: process.argv.slice(loginIndex + 1) });
    await new Promise(resolve => process.stdout.write('', resolve));
    return process.exit(code);
  }

  const initialPrompt = takeInitialPrompt(process.argv, process.env);
  if (initialPrompt.error) {
    process.stderr.write(`${initialPrompt.error}\n`);
    process.exit(1);
  }
  if (initialPrompt.flag) process.argv = initialPrompt.argv;
  // The flag only means something to the interactive TUI. Paths that can't run
  // it reject the flag instead of dropping the prompt; an env var prompt is
  // just ignored there.
  const rejectInitialPromptFlag = (reason: string) => {
    if (!initialPrompt.flag) return;
    process.stderr.write(`${initialPrompt.flag} starts the interactive TUI; ${reason}\n`);
    process.exit(1);
  };

  let resumeThreadId: string | undefined;
  try {
    resumeThreadId = parseResumeThreadId(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const headless = hasHeadlessFlag(process.argv);
  if (entrypointMode === 'headless') {
    if (headless) rejectInitialPromptFlag('use --prompt for headless runs');
    return runMCCli(undefined, { coAuthor: TUI_CO_AUTHOR });
  }

  if (acpMode) {
    rejectInitialPromptFlag('it cannot be combined with --acp');
    if (process.argv.includes('--dangerous-auto-approve')) {
      process.stderr.write('--dangerous-auto-approve is not supported in ACP mode.\n');
      process.exit(1);
    }
    const { acpMain } = await import('@mastra/code-sdk/acp/index');
    return acpMain({
      version: getCurrentVersion(),
      coAuthor: TUI_CO_AUTHOR,
    });
  }

  if (shouldRejectResumeWithoutTTY(resumeThreadId, Boolean(process.stdin.isTTY))) {
    process.stderr.write('mastracode resume requires an interactive terminal.\n');
    process.exitCode = 1;
    return;
  }

  // When stdin is piped (e.g. `cat foo | mastracode`), drain the pipe fully
  // before starting the TUI.  The drain blocks until the sender process exits
  // and closes its stdout, so we never see partial output.
  let pipedInput: string | null = null;
  if (!process.stdin.isTTY) {
    process.stderr.write('Reading piped input...\n');
    pipedInput = await drainPipedStdin();

    // Always reopen a real TTY — even if the pipe was empty, the original
    // stdin is consumed/closed and the TUI needs a live TTY for keyboard input.
    const reopenedStdin = reopenStdinFromTTY();
    if (!reopenedStdin) {
      rejectInitialPromptFlag('no TTY is available, so use --prompt for headless runs');
      process.stderr.write('No TTY available — falling back to headless mode.\n');
      return runMCCli(pipedInput, { coAuthor: TUI_CO_AUTHOR });
    }
  }

  const conflict = pipedInputConflict(initialPrompt, pipedInput);
  if (conflict) {
    process.stderr.write(`${conflict}\n`);
    process.exit(1);
  }

  return tuiMain(initialMessageOptions(initialPrompt, pipedInput), resumeThreadId);
}

main().catch(error => {
  if (acpMode) {
    // runAcpServer owns any created runtime's cleanup. Pre-server import/boot
    // errors have no TUI resources, and must not invoke its crash writer.
    process.stderr.write('[acp] Failed to start.\n');
    process.exitCode = 1;
    return;
  }
  handleFatalError(error);
});

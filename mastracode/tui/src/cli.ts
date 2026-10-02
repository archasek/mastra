#!/usr/bin/env node
/** Lightweight command router; machine commands must not initialize TUI hooks. */
import { runAuthCli } from './auth-cli.js';
import { runInfoCli } from './info-cli.js';
import { getCurrentVersion } from './version.js';

async function runCli(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${getCurrentVersion()}\n`);
    return;
  }

  if (command === 'auth') {
    const controller = new AbortController();
    const cancelLogin = () => controller.abort();
    process.once('SIGINT', cancelLogin);
    process.once('SIGTERM', cancelLogin);
    try {
      const exitCode = await runAuthCli(args, { signal: controller.signal });
      if (exitCode !== 0) process.exitCode = exitCode;
    } finally {
      process.removeListener('SIGINT', cancelLogin);
      process.removeListener('SIGTERM', cancelLogin);
    }
    return;
  }

  if (command === 'info') {
    const exitCode = runInfoCli(args);
    if (exitCode !== 0) process.exitCode = exitCode;
    return;
  }

  // Keep the existing TUI and plugin routes in their original entrypoint.
  await import('./main.js');
}

runCli().catch(() => {
  const command = process.argv[2];
  if (command === 'auth' || command === 'info') {
    process.stdout.write(`${JSON.stringify({ type: 'error', code: 'COMMAND_FAILED' })}\n`);
  } else {
    process.stderr.write('Mastra Code CLI failed to start.\n');
  }
  process.exitCode = 1;
});

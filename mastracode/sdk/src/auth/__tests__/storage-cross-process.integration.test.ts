import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const tsxBin = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const childScript = fileURLToPath(new URL('./fixtures/auth-storage-child.mts', import.meta.url));
const activeChildren = new Set<ReturnType<typeof spawn>>();
const CHILD_EVENT_TIMEOUT_MS = 20_000;

type ChildEvent = {
  event: string;
  role: string;
  id?: string;
};

function startChild(authPath: string, role: string) {
  const child = spawn(tsxBin, [childScript, authPath, role], { stdio: ['pipe', 'pipe', 'pipe'] });
  activeChildren.add(child);
  child.once('close', () => activeChildren.delete(child));
  const events: ChildEvent[] = [];
  const waiters = new Map<string, Array<(event: ChildEvent) => void>>();
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const lines = stdout.split('\n');
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const event = JSON.parse(line) as ChildEvent;
      events.push(event);
      for (const resolve of waiters.get(event.event) ?? []) resolve(event);
      waiters.delete(event.event);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  return {
    child,
    get stderr() {
      return stderr;
    },
    waitFor(eventName: string) {
      const existing = events.find(event => event.event === eventName);
      if (existing) return Promise.resolve(existing);
      return new Promise<ChildEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${role}:${eventName}; stderr: ${stderr}`));
        }, CHILD_EVENT_TIMEOUT_MS);
        const resolveWithCleanup = (event: ChildEvent) => {
          clearTimeout(timeout);
          resolve(event);
        };
        waiters.set(eventName, [...(waiters.get(eventName) ?? []), resolveWithCleanup]);
      });
    },
    result: new Promise<number | null>(resolve => child.once('close', resolve)),
  };
}

describe.skipIf(process.platform === 'win32')('OAuth storage across processes', () => {
  let root: string | undefined;

  afterEach(async () => {
    await Promise.all(
      [...activeChildren].map(
        child =>
          new Promise<void>((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const timeout = setTimeout(
              () => reject(new Error(`Child process ${child.pid ?? 'unknown'} did not exit after SIGKILL`)),
              1_000,
            );
            child.once('close', () => {
              clearTimeout(timeout);
              resolve();
            });
            child.kill('SIGKILL');
          }),
      ),
    );
    activeChildren.clear();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('keeps a legacy-only account ID stable when separate processes persist the same account concurrently', async () => {
    root = mkdtempSync(join(tmpdir(), 'mastracode-auth-cross-process-'));
    const authPath = join(root, 'auth.json');
    writeFileSync(
      authPath,
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          refresh: 'cross-process-refresh',
          access: 'cross-process-access',
          expires: Date.now() + 60 * 60 * 1000,
          accountId: 'cross-process-account',
        },
      }),
    );

    const first = startChild(authPath, 'first');
    const second = startChild(authPath, 'second');
    const [firstReady, secondReady] = await Promise.all([first.waitFor('ready'), second.waitFor('ready')]);

    expect(firstReady.id).toBeDefined();
    expect(secondReady.id).toBe(firstReady.id);

    first.child.stdin.end('persist\n');
    second.child.stdin.end('persist\n');
    const [firstPersisted, secondPersisted] = await Promise.all([
      first.waitFor('persisted'),
      second.waitFor('persisted'),
    ]);
    const [firstExit, secondExit] = await Promise.all([first.result, second.result]);

    expect(firstPersisted.id).toBe(firstReady.id);
    expect(secondPersisted.id).toBe(firstReady.id);
    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(first.stderr).toBe('');
    expect(second.stderr).toBe('');

    const persisted = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, unknown>;
    const accounts = Object.entries(persisted).filter(([key]) => key.startsWith('accounts:openai-codex:'));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.[1]).toMatchObject({
      id: firstReady.id,
      identity: 'cross-process-account',
      refresh: 'cross-process-refresh',
      active: true,
    });
  }, 30_000);
});

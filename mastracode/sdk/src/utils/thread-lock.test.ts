import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { acquireThreadLock, releaseAllThreadLocks, releaseThreadLock, ThreadLockError } from './thread-lock.js';

let root: string | undefined;

afterEach(async () => {
  await releaseAllThreadLocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('does not create app data when there are no locks', async () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-thread-lock-'));
  const appDataDir = join(root, 'app-data');
  vi.stubEnv('MASTRA_APP_DATA_DIR', appDataDir);

  await releaseAllThreadLocks();
  expect(existsSync(appDataDir)).toBe(false);
});

it('atomically admits one owner and releases only locks held by this process', async () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-thread-lock-'));
  const appDataDir = join(root, 'app-data');
  vi.stubEnv('MASTRA_APP_DATA_DIR', appDataDir);

  const attempts = await Promise.allSettled([acquireThreadLock('shared-thread'), acquireThreadLock('shared-thread')]);
  expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
  const rejected = attempts.find(attempt => attempt.status === 'rejected');
  expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ThreadLockError);

  const locksDir = join(appDataDir, 'locks');
  const foreignLock = join(locksDir, 'foreign-thread.lock');
  writeFileSync(foreignLock, String(process.pid), { mode: 0o600 });
  await expect(acquireThreadLock('foreign-thread')).rejects.toBeInstanceOf(ThreadLockError);

  await releaseAllThreadLocks();
  expect(existsSync(join(locksDir, 'shared-thread.lock'))).toBe(false);
  expect(readFileSync(foreignLock, 'utf-8')).toBe(String(process.pid));

  await acquireThreadLock('shared-thread');
  await releaseThreadLock('shared-thread');
  expect(existsSync(join(locksDir, 'shared-thread.lock'))).toBe(false);
});

it('fails closed on stale and live legacy lock files without deleting either', async () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-thread-lock-'));
  const appDataDir = join(root, 'app-data');
  const locksDir = join(appDataDir, 'locks');
  mkdirSync(locksDir, { recursive: true });
  vi.stubEnv('MASTRA_APP_DATA_DIR', appDataDir);

  const staleLegacyLock = join(locksDir, 'stale-thread.lock');
  writeFileSync(staleLegacyLock, '999999999', { mode: 0o600 });
  await expect(acquireThreadLock('stale-thread')).rejects.toMatchObject({
    ownerPid: 999999999,
    legacyLock: true,
  });
  expect(readFileSync(staleLegacyLock, 'utf-8')).toBe('999999999');

  const liveLegacyLock = join(locksDir, 'live-thread.lock');
  writeFileSync(liveLegacyLock, String(process.pid), { mode: 0o600 });
  await expect(acquireThreadLock('live-thread')).rejects.toMatchObject({
    ownerPid: process.pid,
    legacyLock: true,
  });
  expect(readFileSync(liveLegacyLock, 'utf-8')).toBe(String(process.pid));
});

it('does not follow a symlink at the PID target or modify its destination', async () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-thread-lock-'));
  const appDataDir = join(root, 'app-data');
  const locksDir = join(appDataDir, 'locks');
  mkdirSync(locksDir, { recursive: true });
  vi.stubEnv('MASTRA_APP_DATA_DIR', appDataDir);

  const victim = join(root, 'outside.txt');
  const target = join(locksDir, 'symlink-thread');
  writeFileSync(victim, 'leave this file unchanged');
  symlinkSync(victim, target);

  await expect(acquireThreadLock('symlink-thread')).rejects.toThrow();
  expect(readFileSync(victim, 'utf-8')).toBe('leave this file unchanged');
  expect(existsSync(`${target}.lock`)).toBe(false);
});

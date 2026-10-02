/**
 * Thread lock — ensures only one process writes to a thread at a time.
 *
 * Uses proper-lockfile's atomic directory creation and heartbeat lease under
 * <appDataDir>/locks. The target file stores the owning PID for diagnostics;
 * the lock itself is the sibling `<target>.lock` directory.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { getAppDataDir } from './project.js';

type ProperLockfile = {
  lock: (targetPath: string, options: Record<string, unknown>) => Promise<() => Promise<void>>;
};

const require = createRequire(import.meta.url);
const properLockfile = require('proper-lockfile') as ProperLockfile;
const ownedLocks = new Map<string, { threadId: string; release: () => Promise<void> }>();

export class ThreadLockError extends Error {
  constructor(
    public readonly threadId: string,
    public readonly ownerPid: number | null,
    public readonly legacyLock = false,
  ) {
    super(
      legacyLock
        ? `Thread ${threadId} has a legacy lock file that requires safe recovery`
        : ownerPid === null
          ? `Thread ${threadId} is locked by another process`
          : `Thread ${threadId} is locked by another process (PID ${ownerPid})`,
    );
    this.name = 'ThreadLockError';
  }
}

function getLocksDir(create: boolean): string {
  const appDataDir = getAppDataDir({ create });
  const dir = path.join(appDataDir, 'locks');
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function getLockTargetPath(threadId: string, create = false): string {
  // Sanitize thread ID for filesystem safety.
  const safeId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getLocksDir(create), safeId);
}

function getLockDirectoryPath(targetPath: string): string {
  return `${targetPath}.lock`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readOwnerPid(targetPath: string): number | null {
  try {
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile()) return null;
    const pid = Number.parseInt(fs.readFileSync(targetPath, 'utf-8').trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Open and replace the diagnostic PID without following a hostile symlink. */
function writeOwnerPid(targetPath: string): void {
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(targetPath);
    if (!existing.isFile()) throw new Error('Thread lock PID target is not a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags = fs.constants.O_WRONLY | noFollow | (existing ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(targetPath, flags, 0o600);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))) {
      throw new Error('Thread lock PID target changed during acquisition');
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, String(process.pid), 0, 'utf-8');
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Fail closed on a v1 lock file left by an older runtime. The v1 protocol
 * overwrites and unlinks a shared path without an atomic lease, so checking a
 * PID and then deleting that path can race a live v1 acquisition/release.
 * Preserve the file for operator recovery rather than risk two writers.
 */
function clearStaleLegacyLock(lockPath: string, threadId: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isDirectory()) return;
  const ownerPid = stat.isFile() ? readOwnerPid(lockPath) : null;
  throw new ThreadLockError(threadId, ownerPid, true);
}

/**
 * Attempt to acquire a process-safe lock for the given thread. Acquisition is
 * asynchronous because directory creation is the atomic cross-process claim.
 * Stale leases are reclaimed by proper-lockfile after their heartbeat expires.
 */
export async function acquireThreadLock(threadId: string): Promise<void> {
  const targetPath = getLockTargetPath(threadId, true);
  const lockPath = getLockDirectoryPath(targetPath);
  clearStaleLegacyLock(lockPath, threadId);

  let release: () => Promise<void>;
  try {
    release = await properLockfile.lock(targetPath, {
      realpath: false,
      stale: 120_000,
      update: 30_000,
      retries: 0,
    });
  } catch {
    throw new ThreadLockError(threadId, readOwnerPid(targetPath));
  }

  try {
    writeOwnerPid(targetPath);
    ownedLocks.set(targetPath, { threadId, release });
  } catch (error) {
    await release();
    throw error;
  }
}

/** Release the lock for the given thread, but only when acquired by this process. */
export async function releaseThreadLock(threadId: string): Promise<void> {
  const targetPath = getLockTargetPath(threadId);
  const owned = ownedLocks.get(targetPath);
  if (!owned) return;
  await owned.release();
  if (ownedLocks.get(targetPath) === owned) ownedLocks.delete(targetPath);
}

/** Check a thread lock's owner PID; return null when unlocked or owned here. */
export function getThreadLockOwner(threadId: string): number | null {
  const targetPath = getLockTargetPath(threadId);
  try {
    if (!fs.lstatSync(getLockDirectoryPath(targetPath)).isDirectory()) return null;
  } catch {
    return null;
  }
  const ownerPid = readOwnerPid(targetPath);
  if (ownerPid === null || ownerPid === process.pid || !isProcessAlive(ownerPid)) return null;
  return ownerPid;
}

/** Release every lock acquired by this process. Safe to call when none exist. */
export async function releaseAllThreadLocks(): Promise<void> {
  for (const [targetPath, owned] of [...ownedLocks]) {
    try {
      await owned.release();
      if (ownedLocks.get(targetPath) === owned) ownedLocks.delete(targetPath);
    } catch {
      // Best-effort cleanup; a crashed holder's lease expires automatically.
    }
  }
}

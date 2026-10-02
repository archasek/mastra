import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { detectProject, getAppDataDir, getStorageConfig, getVectorDatabasePath } from './project.js';

let root: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

it('can resolve the app-data path without creating it, while preserving the default create behavior', () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-app-data-'));
  const appDataDir = join(root, 'app-data');
  vi.stubEnv('MASTRA_APP_DATA_DIR', appDataDir);

  expect(getAppDataDir({ create: false })).toBe(appDataDir);
  expect(existsSync(appDataDir)).toBe(false);
  expect(getAppDataDir()).toBe(appDataDir);
  expect(existsSync(appDataDir)).toBe(true);
});

it('uses an explicit local storage URL instead of project database configuration', () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-thread-storage-'));
  const projectDir = join(root, 'project');
  const projectConfigDir = join(projectDir, '.mastracode');
  const databasePath = join(root, 'thread.db');
  mkdirSync(projectConfigDir, { recursive: true });
  writeFileSync(
    join(projectConfigDir, 'database.json'),
    JSON.stringify({ url: 'libsql://project-owned.example', authToken: 'project-token' }),
  );
  vi.stubEnv('MASTRA_STORAGE_BACKEND', 'libsql');
  vi.stubEnv('MASTRA_DB_URL', `file:${databasePath}`);
  vi.stubEnv('MASTRA_DB_AUTH_TOKEN', '');

  expect(getStorageConfig(projectDir)).toMatchObject({
    backend: 'libsql',
    url: `file:${databasePath}`,
    isRemote: false,
  });
});

it('uses the explicit vector database path for an isolated ACP process', () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-vector-storage-'));
  const vectorDatabasePath = join(root, 'thread-vectors.db');
  vi.stubEnv('MASTRA_VECTOR_DB_PATH', vectorDatabasePath);

  expect(getVectorDatabasePath()).toBe(vectorDatabasePath);
});

it('treats a repository remote name as data, not shell syntax', () => {
  root = mkdtempSync(join(tmpdir(), 'mastracode-project-remote-'));
  const projectDir = join(root, 'project');
  mkdirSync(projectDir);
  execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
  const remoteName = 'evil;touch${IFS}pwned';
  execFileSync('git', ['config', `remote.${remoteName}.url`, 'https://example.com/evil.git'], {
    cwd: projectDir,
  });

  expect(detectProject(projectDir).gitUrl).toBe('https://example.com/evil.git');
  expect(existsSync(join(projectDir, 'pwned'))).toBe(false);
});

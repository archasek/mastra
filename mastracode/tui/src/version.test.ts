import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';

import { getCurrentVersion } from './version.js';

const routes = vi.hoisted(() => ({ auth: vi.fn(), info: vi.fn(), main: vi.fn() }));
vi.mock('./auth-cli.js', () => ({ runAuthCli: routes.auth }));
vi.mock('./info-cli.js', () => ({ runInfoCli: routes.info }));
vi.mock('./main.js', () => {
  routes.main();
  return {};
});
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

it('reads the Mastra Code package version when running from source', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

  expect(getCurrentVersion()).toBe(pkg.version);
});

it.each(['--version', '-v'])('prints the version for %s without entering another CLI route', async flag => {
  process.argv = [process.execPath, 'mastracode', flag];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  await import('./cli.js');

  expect(stdout).toHaveBeenCalledExactlyOnceWith(`${getCurrentVersion()}\n`);
  expect(stderr).not.toHaveBeenCalled();
  expect(routes.main).not.toHaveBeenCalled();
  expect(routes.auth).not.toHaveBeenCalled();
  expect(routes.info).not.toHaveBeenCalled();
});

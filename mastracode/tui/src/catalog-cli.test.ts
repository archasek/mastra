import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCatalogCli } from './catalog-cli.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mastracode catalog refresh machine command', () => {
  it('rejects every noncanonical grammar before constructing storage', async () => {
    const createAuthStorage = vi.fn();
    const lines: string[] = [];
    expect(
      await runCatalogCli(['refresh', '--provider', 'openai', '--json'], {
        createAuthStorage,
        writeStdout: line => lines.push(line),
      }),
    ).toBe(2);
    expect(createAuthStorage).not.toHaveBeenCalled();
    expect(lines.map(line => JSON.parse(line))).toEqual([{ type: 'error', code: 'INVALID_ARGUMENTS' }]);
  });

  it('reports safe publication metadata without exposing credential or account fields', async () => {
    const appDataDir = mkdtempSync(join(tmpdir(), 'mc-catalog-cli-'));
    dirs.push(appDataDir);
    writeFileSync(
      join(appDataDir, 'auth.json'),
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          refresh: 'synthetic-refresh',
          access: 'synthetic-access',
          accountId: 'synthetic-account',
          expires: Date.now() + 60_000,
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] })),
    );
    const lines: string[] = [];
    expect(
      await runCatalogCli(['refresh', '--provider', 'openai-codex', '--json'], {
        appDataDir,
        writeStdout: line => lines.push(line),
      }),
    ).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'success',
      provider: 'openai-codex',
      modelCount: 1,
      catalog: { source: 'account-cache', status: 'ready' },
    });
    expect(lines.join('')).not.toContain('synthetic-');
    expect(existsSync(join(appDataDir, 'openai-codex-model-catalog.json'))).toBe(true);
  });

  it('sanitizes owner construction failure and returns nonzero', async () => {
    const lines: string[] = [];
    expect(
      await runCatalogCli(['refresh', '--provider', 'openai-codex', '--json'], {
        createAuthStorage: () => {
          throw new Error('secret-bearing internal error');
        },
        writeStdout: line => lines.push(line),
      }),
    ).toBe(1);
    expect(lines.map(line => JSON.parse(line))).toEqual([{ type: 'error', code: 'CATALOG_REQUEST_FAILED' }]);
  });
});

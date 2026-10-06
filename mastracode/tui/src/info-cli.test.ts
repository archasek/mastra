import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROTOCOL_VERSION } from '@mastra/code-sdk/acp/protocol';
import { getAvailableModePacks } from '@mastra/code-sdk/onboarding/packs';
import {
  CODEX_CATALOG_CLIENT_VERSION,
  CODEX_CATALOG_ENDPOINT,
  CODEX_CATALOG_FILENAME,
  CODEX_CATALOG_TTL_MS,
  readCodexCatalog,
} from '@mastra/code-sdk/providers/openai-codex-catalog';
import { getAvailableThinkingLevelsForModel, THINKING_LEVEL_DESCRIPTION } from '@mastra/code-sdk/thinking';

import { afterEach, describe, expect, it } from 'vitest';
import { runInfoCli } from './info-cli.js';

const directories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mastracode-info-cli-'));
  directories.push(directory);
  return directory;
}

function writeCatalog(
  appDataDir: string,
  scope: { kind: 'legacy' | 'registered'; accountId: string; accountInstanceId?: string },
) {
  const fetchedAt = Date.now();
  writeFileSync(
    join(appDataDir, CODEX_CATALOG_FILENAME),
    JSON.stringify({
      schemaVersion: 1,
      provider: 'openai-codex',
      scope,
      endpoint: CODEX_CATALOG_ENDPOINT,
      clientVersion: CODEX_CATALOG_CLIENT_VERSION,
      fetchedAt,
      expiresAt: fetchedAt + CODEX_CATALOG_TTL_MS,
      slugs: ['gpt-6.1-sol', 'gpt-6-luna'],
    }),
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('mastracode info --json', () => {
  it('omits a model-wide default when native mode defaults disagree', () => {
    const appDataDir = makeTempDirectory();
    writeFileSync(
      join(appDataDir, 'auth.json'),
      JSON.stringify({
        'openai-codex': { type: 'oauth', refresh: 'test', access: 'test', expires: 1, accountId: 'account-a' },
      }),
    );
    writeCatalog(appDataDir, { kind: 'legacy', accountId: 'account-a' });
    const settings = JSON.stringify({
      preferences: { thinkingLevel: 'low' },
      models: { modeThinkingDefaults: { build: 'high' } },
    });
    writeFileSync(join(appDataDir, 'settings.json'), settings);
    const output: string[] = [];
    expect(runInfoCli(['--json'], { appDataDir, version: 'test', writeStdout: line => output.push(line) })).toBe(0);
    const info = JSON.parse(output.join(''));
    expect(info.models.length).toBeGreaterThan(0);
    for (const model of info.models) expect(model).not.toHaveProperty('defaultThinkingLevel');
    expect(readFileSync(join(appDataDir, 'settings.json'), 'utf8')).toBe(settings);
  });
  it('returns unauthenticated metadata without creating data or starting the harness', () => {
    const root = makeTempDirectory();
    const appDataDir = join(root, 'not-created');
    const output: string[] = [];

    const exitCode = runInfoCli(['--json'], {
      appDataDir,
      version: '1.2.3-test',
      writeStdout: line => output.push(line),
    });

    const info = JSON.parse(output.join(''));
    expect(exitCode).toBe(0);
    expect(info.thinkingLevelDescription).toBe(THINKING_LEVEL_DESCRIPTION);
    expect(info).toEqual({
      schemaVersion: 1,
      thinkingLevelDescription: THINKING_LEVEL_DESCRIPTION,
      version: '1.2.3-test',
      acpProtocolVersion: ACP_PROTOCOL_VERSION,
      capabilities: { loadSession: true, permissions: true, elicitation: true, images: true },
      models: [],
      catalog: { source: 'account-cache', status: 'unbound', clientVersion: CODEX_CATALOG_CLIENT_VERSION },
      auth: { provider: 'openai-codex', status: 'unauthenticated' },
    });
    expect(existsSync(appDataDir)).toBe(false);
  });

  it('includes only dated account members, in backend order, without emitting credentials', () => {
    const appDataDir = makeTempDirectory();
    const settingsPath = join(appDataDir, 'settings.json');
    const settingsText = JSON.stringify({
      preferences: { thinkingLevel: 'high' },
      models: { modeThinkingDefaults: { build: 'high' } },
    });
    writeFileSync(settingsPath, settingsText);
    const account = {
      type: 'oauth-account',
      id: 'openai-codex:account-123',
      label: 'codex@example.test',
      addedAt: new Date(0).toISOString(),
      active: true,
      refresh: 'refresh-secret-marker',
      access: 'access-secret-marker',
      expires: 1,
      accountId: 'account-a',
    };
    writeFileSync(
      join(appDataDir, 'auth.json'),
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          refresh: account.refresh,
          access: account.access,
          expires: account.expires,
          accountId: account.accountId,
        },
        'accounts:openai-codex:account-123': account,
      }),
    );
    writeCatalog(appDataDir, { kind: 'registered', accountId: account.accountId, accountInstanceId: account.id });
    const authBefore = readFileSync(join(appDataDir, 'auth.json'), 'utf8');
    const cacheBefore = readFileSync(join(appDataDir, CODEX_CATALOG_FILENAME), 'utf8');
    const output: string[] = [];

    const exitCode = runInfoCli(['--json'], {
      appDataDir,
      version: '1.2.3-test',
      writeStdout: line => output.push(line),
    });

    const info = JSON.parse(output.join(''));
    const pack = getAvailableModePacks({
      anthropic: false,
      openai: 'oauth',
      cerebras: false,
      google: false,
      deepseek: false,
      'github-copilot': false,
    }).find(item => item.id === 'openai');
    const expectedModels = new Map<string, string[]>();
    for (const [mode, id] of Object.entries(pack?.models ?? {})) {
      if (!readCodexCatalog(appDataDir).models.includes(id)) continue;
      expectedModels.set(id, [...(expectedModels.get(id) ?? []), mode]);
    }
    for (const id of readCodexCatalog(appDataDir).models) {
      if (!expectedModels.has(id)) expectedModels.set(id, ['build', 'plan', 'fast']);
    }

    expect(exitCode).toBe(0);
    expect(info.models).toEqual(
      readCodexCatalog(appDataDir).models.map(id => ({
        id,
        modes: expectedModels.get(id),
        thinkingLevels: getAvailableThinkingLevelsForModel(id),
        defaultThinkingLevel: 'high',
      })),
    );
    expect(info.models).toContainEqual({
      id: 'openai/gpt-6.1-sol',
      modes: ['build', 'plan', 'fast'],
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultThinkingLevel: 'high',
    });
    expect(info.models.some((model: { id: string }) => model.id === 'openai/gpt-5.4-mini')).toBe(false);
    expect(info.models.map((model: { id: string }) => model.id)).toEqual(readCodexCatalog(appDataDir).models);
    expect(info.models.some((model: { id: string }) => /image|audio|realtime/.test(model.id))).toBe(false);
    expect(info.auth).toEqual({ provider: 'openai-codex', status: 'authenticated' });
    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsText);
    expect(readFileSync(join(appDataDir, 'auth.json'), 'utf8')).toBe(authBefore);
    expect(readFileSync(join(appDataDir, CODEX_CATALOG_FILENAME), 'utf8')).toBe(cacheBefore);
    expect(output.join('')).not.toContain('refresh-secret-marker');
    expect(output.join('')).not.toContain('access-secret-marker');
    expect(output.join('')).not.toContain('codex@example.test');
    // Fresh module evaluation must stay offline even with runtime refresh enabled.
    const childOutput = execFileSync(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '-e',
        `let fetches = 0;
         globalThis.fetch = async () => { fetches++; throw new Error('Unexpected registry network request'); };
         const { runInfoCli } = await import(${JSON.stringify(new URL('./info-cli.ts', import.meta.url).href)});
         runInfoCli(['--json'], { appDataDir: ${JSON.stringify(appDataDir)}, version: 'test' });
         await new Promise(resolve => setTimeout(resolve, 100));
         if (fetches) throw new Error('Machine info initialized network refresh');`,
      ],
      {
        env: { ...process.env, MASTRA_DEV: 'true', MASTRA_AUTO_REFRESH_PROVIDERS: 'true', MASTRA_OFFLINE: 'false' },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    expect(JSON.parse(childOutput).models).toContainEqual({
      id: 'openai/gpt-6.1-sol',
      modes: ['build', 'plan', 'fast'],
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultThinkingLevel: 'high',
    });
    expect(readFileSync(settingsPath, 'utf8')).toBe(settingsText);
    expect(readFileSync(join(appDataDir, 'auth.json'), 'utf8')).toBe(authBefore);
    expect(readFileSync(join(appDataDir, CODEX_CATALOG_FILENAME), 'utf8')).toBe(cacheBefore);
  });

  it('reports authenticated without inventing models when the catalog is missing', () => {
    const appDataDir = makeTempDirectory();
    writeFileSync(
      join(appDataDir, 'auth.json'),
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          refresh: 'test',
          access: 'test',
          expires: 1,
          accountId: 'account-a',
        },
      }),
    );
    const output: string[] = [];
    expect(runInfoCli(['--json'], { appDataDir, writeStdout: line => output.push(line) })).toBe(0);
    const info = JSON.parse(output.join(''));
    expect(info.auth.status).toBe('authenticated');
    expect(info.catalog.status).toBe('missing');
    expect(info.models).toEqual([]);
    expect(existsSync(join(appDataDir, CODEX_CATALOG_FILENAME))).toBe(false);
  });

  it('reports malformed auth state as unknown without rewriting it', () => {
    const appDataDir = makeTempDirectory();
    const authPath = join(appDataDir, 'auth.json');
    writeFileSync(authPath, '{ malformed');
    const output: string[] = [];

    const exitCode = runInfoCli(['--json'], { appDataDir, writeStdout: line => output.push(line) });

    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join('')).auth.status).toBe('unknown');
    expect(readFileSync(authPath, 'utf8')).toBe('{ malformed');
  });
});

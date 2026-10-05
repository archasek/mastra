import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_PROTOCOL_VERSION } from '@mastra/code-sdk/acp/protocol';
import { getAvailableModePacks } from '@mastra/code-sdk/onboarding/packs';
import { getProviderConfig } from '@mastra/core/llm';

import { afterEach, describe, expect, it } from 'vitest';
import { runInfoCli } from './info-cli.js';

const directories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mastracode-info-cli-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('mastracode info --json', () => {
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
    expect(info).toEqual({
      schemaVersion: 1,
      version: '1.2.3-test',
      acpProtocolVersion: ACP_PROTOCOL_VERSION,
      capabilities: { loadSession: true, permissions: true, elicitation: true, images: true },
      models: [],
      auth: { provider: 'openai-codex', status: 'unauthenticated' },
    });
    expect(existsSync(appDataDir)).toBe(false);
  });

  it('includes native registry models beyond mode-pack defaults without emitting credentials', () => {
    const appDataDir = makeTempDirectory();
    const account = {
      type: 'oauth-account',
      id: 'openai-codex:account-123',
      label: 'codex@example.test',
      addedAt: new Date(0).toISOString(),
      active: true,
      refresh: 'refresh-secret-marker',
      access: 'access-secret-marker',
      expires: 1,
    };
    writeFileSync(
      join(appDataDir, 'auth.json'),
      JSON.stringify({
        'openai-codex': { type: 'oauth', refresh: account.refresh, access: account.access, expires: account.expires },
        'accounts:openai-codex:account-123': account,
      }),
    );
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
      expectedModels.set(id, [...(expectedModels.get(id) ?? []), mode]);
    }
    for (const name of getProviderConfig('openai')?.models ?? []) {
      if (!/^gpt-\d/.test(name) || /(?:image|audio|realtime)/i.test(name)) continue;
      const id = `openai/${name}`;
      if (!expectedModels.has(id)) expectedModels.set(id, ['build', 'plan', 'fast']);
    }

    expect(exitCode).toBe(0);
    expect(info.models).toEqual([...expectedModels].map(([id, modes]) => ({ id, modes })));
    expect(info.models).toContainEqual({ id: 'openai/gpt-6.1-sol', modes: ['build', 'plan', 'fast'] });
    expect(info.models).toContainEqual({ id: 'openai/gpt-5.4-mini', modes: ['fast'] });
    expect(info.models.some((model: { id: string }) => /image|audio|realtime/.test(model.id))).toBe(false);
    expect(info.auth).toEqual({ provider: 'openai-codex', status: 'authenticated' });
    expect(output.join('')).not.toContain('refresh-secret-marker');
    expect(output.join('')).not.toContain('access-secret-marker');
    expect(output.join('')).not.toContain('codex@example.test');
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

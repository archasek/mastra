import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthLoginCallbacks } from '@mastra/code-sdk/auth/types';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthCliOptions } from './auth-cli.js';
import { runAuthCli } from './auth-cli.js';

const directories: string[] = [];

function makeAppDataPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'mastracode-auth-cli-'));
  directories.push(root);
  return join(root, 'app-data');
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('mastracode auth machine commands', () => {
  it('reports unauthenticated status without creating the app-data directory', async () => {
    const appDataDir = makeAppDataPath();
    const output: string[] = [];

    const exitCode = await runAuthCli(['status', '--provider', 'openai-codex', '--json'], {
      appDataDir,
      writeStdout: line => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual({
      type: 'status',
      provider: 'openai-codex',
      status: 'unauthenticated',
    });
    expect(existsSync(appDataDir)).toBe(false);
  });

  it('emits structured device login events and only safe account metadata', async () => {
    const appDataDir = makeAppDataPath();
    const output: string[] = [];
    const account = {
      type: 'oauth-account' as const,
      id: 'openai-codex:account-id',
      label: 'codex@example.test',
      addedAt: new Date(0).toISOString(),
      active: true,
      refresh: 'secret-refresh-token',
      access: 'secret-access-token',
      expires: 1,
    };
    const login = vi.fn(async (_provider: string, callbacks: OAuthLoginCallbacks) => {
      expect(callbacks.authMode).toBe('device');
      callbacks.onAuth({
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAt: '2026-09-27T12:00:00.000Z',
      });
      callbacks.onProgress?.('ignored provider progress');
      return account;
    });
    const storage = { login, logout: vi.fn() } as unknown as ReturnType<
      NonNullable<AuthCliOptions['createAuthStorage']>
    >;

    const exitCode = await runAuthCli(['login', '--provider', 'openai-codex', '--device', '--jsonl'], {
      appDataDir,
      createAuthStorage: () => storage,
      writeStdout: line => output.push(line),
    });

    const events = output.map(line => JSON.parse(line));
    expect(exitCode).toBe(0);
    expect(events).toEqual([
      {
        type: 'device_code',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAt: '2026-09-27T12:00:00.000Z',
      },
      { type: 'progress', phase: 'waiting_for_authorization' },
      {
        type: 'success',
        provider: 'openai-codex',
        account: { id: 'openai-codex:account-id', label: 'codex@example.test' },
      },
    ]);
    expect(output.join('')).not.toContain('secret-access-token');
    expect(output.join('')).not.toContain('secret-refresh-token');
    expect(output.join('')).not.toContain('ignored provider progress');
    expect(login).toHaveBeenCalledWith('openai-codex', expect.objectContaining({ authMode: 'device' }));
  });

  it('turns cancellation into a terminal JSONL event without exposing the error', async () => {
    const controller = new AbortController();
    const output: string[] = [];
    const login = vi.fn((_provider: string, callbacks: OAuthLoginCallbacks) => {
      callbacks.onAuth({
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        expiresAt: '2026-09-27T12:00:00.000Z',
      });
      return new Promise<never>((_resolve, reject) => {
        callbacks.signal?.addEventListener('abort', () => reject(new Error('secret-bearing internal error')), {
          once: true,
        });
      });
    });
    const storage = { login, logout: vi.fn() } as unknown as ReturnType<
      NonNullable<AuthCliOptions['createAuthStorage']>
    >;

    const pending = runAuthCli(['login', '--provider', 'openai-codex', '--device', '--jsonl'], {
      appDataDir: makeAppDataPath(),
      createAuthStorage: () => storage,
      signal: controller.signal,
      writeStdout: line => output.push(line),
    });
    controller.abort();
    const exitCode = await pending;

    expect(exitCode).toBe(130);
    expect(output.map(line => JSON.parse(line).code ?? JSON.parse(line).type)).toEqual([
      'device_code',
      'LOGIN_CANCELLED',
    ]);
    expect(output.join('')).not.toContain('secret-bearing internal error');
  });

  it('logs out only the OpenAI Codex provider and returns a typed status', async () => {
    const output: string[] = [];
    const logout = vi.fn();
    const storage = { login: vi.fn(), logout } as unknown as ReturnType<
      NonNullable<AuthCliOptions['createAuthStorage']>
    >;

    const exitCode = await runAuthCli(['logout', '--provider', 'openai-codex', '--json'], {
      appDataDir: makeAppDataPath(),
      createAuthStorage: () => storage,
      writeStdout: line => output.push(line),
    });

    expect(exitCode).toBe(0);
    expect(logout).toHaveBeenCalledExactlyOnceWith('openai-codex');
    expect(JSON.parse(output.join(''))).toEqual({
      type: 'status',
      provider: 'openai-codex',
      status: 'unauthenticated',
    });
  });

  it('rejects commands outside the explicit machine contract', async () => {
    const output: string[] = [];
    const exitCode = await runAuthCli(['login', '--provider', 'openai-codex', '--json'], {
      writeStdout: line => output.push(line),
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(output.join(''))).toEqual({ type: 'error', code: 'INVALID_ARGUMENTS' });
  });
});

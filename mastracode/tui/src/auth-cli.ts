import { join } from 'node:path';

import { AuthStorage, readOAuthStatusFile } from '@mastra/code-sdk/auth/storage';
import type { OAuthAccountRecord, OAuthAuthInfo } from '@mastra/code-sdk/auth/types';
import { getAppDataDir } from '@mastra/code-sdk/utils/project';

const CODEX_PROVIDER = 'openai-codex';

type AuthStorageCommands = Pick<AuthStorage, 'login' | 'logout'>;

export interface AuthCliOptions {
  appDataDir?: string;
  createAuthStorage?: (authPath: string) => AuthStorageCommands;
  signal?: AbortSignal;
  writeStdout?: (line: string) => void;
}

function emit(options: AuthCliOptions, value: unknown): void {
  (options.writeStdout ?? (line => process.stdout.write(line)))(`${JSON.stringify(value)}\n`);
}

function parseCommand(args: string[]): { command: 'status' | 'login' | 'logout' } | undefined {
  if (args.join(' ') === `status --provider ${CODEX_PROVIDER} --json`) return { command: 'status' };
  if (args.join(' ') === `login --provider ${CODEX_PROVIDER} --device --jsonl`) return { command: 'login' };
  if (args.join(' ') === `logout --provider ${CODEX_PROVIDER} --json`) return { command: 'logout' };
  return undefined;
}

function authPath(options: AuthCliOptions, create: boolean): string {
  const appDataDir = options.appDataDir ?? getAppDataDir({ create });
  return join(appDataDir, 'auth.json');
}

function accountSummary(account: OAuthAccountRecord | undefined): { id: string; label: string } | undefined {
  return account ? { id: account.id, label: account.label } : undefined;
}

/** Run the strictly machine-readable subset of `mastracode auth`. */
export async function runAuthCli(args: string[], options: AuthCliOptions = {}): Promise<number> {
  const parsed = parseCommand(args);
  if (!parsed) {
    emit(options, { type: 'error', code: 'INVALID_ARGUMENTS' });
    return 2;
  }

  const path = authPath(options, parsed.command !== 'status');
  if (parsed.command === 'status') {
    const status = readOAuthStatusFile(path, CODEX_PROVIDER);
    if (status.status === 'unknown') {
      emit(options, { type: 'error', code: 'AUTH_STORE_UNREADABLE' });
      return 1;
    }
    emit(options, { type: 'status', ...status });
    return 0;
  }

  const storage = (options.createAuthStorage ?? (authPath => new AuthStorage(authPath)))(path);
  if (parsed.command === 'logout') {
    try {
      await storage.logout(CODEX_PROVIDER);
    } catch {
      emit(options, { type: 'error', code: 'LOGOUT_FAILED' });
      return 1;
    }
    emit(options, { type: 'status', provider: CODEX_PROVIDER, status: 'unauthenticated' });
    return 0;
  }

  try {
    const account = await storage.login(CODEX_PROVIDER, {
      authMode: 'device',
      signal: options.signal,
      onAuth: (info: OAuthAuthInfo) => {
        if (!info.userCode || !info.expiresAt || !/^https:\/\//i.test(info.url)) {
          throw new Error('Device login returned incomplete metadata.');
        }
        emit(options, {
          type: 'device_code',
          verificationUrl: info.url,
          userCode: info.userCode,
          expiresAt: info.expiresAt,
        });
      },
      onPrompt: async () => {
        throw new Error('Interactive prompts are unavailable in device login.');
      },
      onProgress: () => emit(options, { type: 'progress', phase: 'waiting_for_authorization' }),
    });
    const summary = accountSummary(account);
    emit(options, {
      type: 'success',
      provider: CODEX_PROVIDER,
      ...(summary ? { account: summary } : {}),
    });
    return 0;
  } catch {
    emit(options, { type: 'error', code: options.signal?.aborted ? 'LOGIN_CANCELLED' : 'LOGIN_FAILED' });
    return options.signal?.aborted ? 130 : 1;
  }
}

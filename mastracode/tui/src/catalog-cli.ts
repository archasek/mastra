import { join } from 'node:path';
import { AuthStorage } from '@mastra/code-sdk/auth/storage';
import { CodexCatalogRefreshError, refreshCodexCatalog } from '@mastra/code-sdk/providers/openai-codex-catalog-refresh';
import { getAppDataDir } from '@mastra/code-sdk/utils/project';

export interface CatalogCliOptions {
  appDataDir?: string;
  signal?: AbortSignal;
  createAuthStorage?: (authPath: string) => Pick<AuthStorage, 'getOAuthCredential'>;
  writeStdout?: (line: string) => void;
}

export async function runCatalogCli(args: string[], options: CatalogCliOptions = {}): Promise<number> {
  const emit = (value: unknown) =>
    (options.writeStdout ?? (line => process.stdout.write(line)))(`${JSON.stringify(value)}\n`);
  if (
    args.length !== 4 ||
    args[0] !== 'refresh' ||
    args[1] !== '--provider' ||
    args[2] !== 'openai-codex' ||
    args[3] !== '--json'
  ) {
    emit({ type: 'error', code: 'INVALID_ARGUMENTS' });
    return 2;
  }
  try {
    const appDataDir = options.appDataDir ?? getAppDataDir({ create: false });
    const authStorage = (options.createAuthStorage ?? (path => new AuthStorage(path)))(join(appDataDir, 'auth.json'));
    const cache = await refreshCodexCatalog({ appDataDir, authStorage, signal: options.signal });
    emit({
      type: 'success',
      provider: 'openai-codex',
      catalog: {
        status: 'ready',
        source: 'account-cache',
        clientVersion: cache.clientVersion,
        fetchedAt: cache.fetchedAt,
        expiresAt: cache.expiresAt,
      },
      modelCount: cache.slugs.length,
    });
    return 0;
  } catch (error) {
    emit({ type: 'error', code: error instanceof CodexCatalogRefreshError ? error.code : 'CATALOG_REQUEST_FAILED' });
    return 1;
  }
}

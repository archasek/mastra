import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readOpenAICodexCatalogScope } from '../auth/read-only.js';
import type { OpenAICodexCatalogScope } from '../auth/read-only.js';
import type { CredentialStore, OAuthCredentialSnapshot } from '../auth/types.js';
import {
  CODEX_CATALOG_CLIENT_VERSION,
  CODEX_CATALOG_ENDPOINT,
  CODEX_CATALOG_FILENAME,
  CODEX_CATALOG_MAX_BYTES,
  CODEX_CATALOG_TTL_MS,
  codexCatalogCacheSchema,
  codexCatalogPath,
  decodeCodexCatalogResponse,
  sameCodexCatalogScope,
} from './openai-codex-catalog.js';
import type { CodexCatalogCache } from './openai-codex-catalog.js';
import { buildOpenAICodexOAuthFetch } from './openai-codex.js';

export class CodexCatalogRefreshError extends Error {
  constructor(
    readonly code:
      | 'ACCOUNT_CHANGED'
      | 'AUTH_REFRESH_REQUIRED'
      | 'CREDENTIAL_REJECTED'
      | 'CATALOG_REQUEST_FAILED'
      | 'CATALOG_INVALID'
      | 'CATALOG_CANCELLED'
      | 'AUTH_REQUIRED',
  ) {
    super(code);
    this.name = 'CodexCatalogRefreshError';
  }
}

const lockfile = createRequire(import.meta.url)('proper-lockfile') as {
  lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

function scopeForCredential(authPath: string, credential: OAuthCredentialSnapshot): OpenAICodexCatalogScope {
  const scope = readOpenAICodexCatalogScope(authPath);
  if (
    !scope ||
    scope.accountId !== credential.accountId ||
    (scope.kind === 'registered' && scope.accountInstanceId !== credential.accountInstanceId)
  ) {
    throw new CodexCatalogRefreshError('ACCOUNT_CHANGED');
  }
  // Native storage can have an in-memory adoption ID for a legacy-only file.
  // Only a persisted registry binds that ID; do not guess or force migration here.
  return scope;
}

/** One native writer across processes and accounts, bounded by the command signal. */
async function acquireCatalogLock(appDataDir: string, signal: AbortSignal): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
  for (;;) {
    signal.throwIfAborted();
    try {
      return await lockfile.lock(join(appDataDir, `${CODEX_CATALOG_FILENAME}.refresh`), {
        realpath: false,
        stale: 120_000,
        update: 30_000,
        retries: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
      await delay(50, undefined, { signal });
    }
  }
}

/** Explicit online operation only. The injected native owner retains all token persistence. */
export async function refreshCodexCatalog(options: {
  appDataDir: string;
  authStorage: Pick<CredentialStore, 'getOAuthCredential'>;
  signal?: AbortSignal;
}): Promise<CodexCatalogCache> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let release: (() => Promise<void>) | undefined;
  let tempPath: string | undefined;
  try {
    release = await acquireCatalogLock(options.appDataDir, signal);
    // Reserve time for native persistence and the subsequent bounded GET.
    const acquisitionSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const credential = await options.authStorage.getOAuthCredential?.('openai-codex', undefined, {
      signal: acquisitionSignal,
    });
    acquisitionSignal.throwIfAborted();
    if (!credential) throw new CodexCatalogRefreshError('AUTH_REQUIRED');
    const requestScope = scopeForCredential(join(options.appDataDir, 'auth.json'), credential);
    let cache: CodexCatalogCache;
    try {
      cache = await fetchCodexCatalogSnapshot({ appDataDir: options.appDataDir, credential, signal });
    } catch (error) {
      if (error instanceof CodexCatalogRefreshError && error.code === 'CREDENTIAL_REJECTED') {
        // Never let a delayed rejection remove a different account's cache.
        const current = readOpenAICodexCatalogScope(
          join(options.appDataDir, 'auth.json'),
          requestScope.kind === 'registered' ? requestScope.accountInstanceId : undefined,
          credential,
        );
        if (current && sameCodexCatalogScope(current, requestScope)) {
          // Keep an invalid scoped marker so compatibility fallback cannot
          // resurrect older single-file inventory after definite rejection.
          const path = codexCatalogPath(options.appDataDir, current);
          tempPath = `${path}.${randomUUID()}.tmp`;
          writeFileSync(tempPath, JSON.stringify({ invalidated: true }), { flag: 'wx', mode: 0o600 });
          renameSync(tempPath, path);
          tempPath = undefined;
        }
      }
      throw error;
    }
    const assertPublishable = () => {
      signal.throwIfAborted();
      const current = readOpenAICodexCatalogScope(join(options.appDataDir, 'auth.json'));
      if (!current || !sameCodexCatalogScope(current, cache.scope))
        throw new CodexCatalogRefreshError('ACCOUNT_CHANGED');
    };
    assertPublishable();
    const path = codexCatalogPath(options.appDataDir, cache.scope);
    tempPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(cache), { flag: 'wx', mode: 0o600 });
    assertPublishable();
    renameSync(tempPath, path);
    tempPath = undefined;
    assertPublishable();
    return cache;
  } catch (error) {
    if (signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))) {
      throw new CodexCatalogRefreshError('CATALOG_CANCELLED');
    }
    if (error instanceof CodexCatalogRefreshError) throw error;
    throw new CodexCatalogRefreshError('CATALOG_REQUEST_FAILED');
  } finally {
    if (tempPath) rmSync(tempPath, { force: true });
    await release?.();
  }
}

/** The native owner acquires this snapshot before calling; this facade never rotates credentials. */
function pinnedStore(snapshot: OAuthCredentialSnapshot): CredentialStore {
  const credential = Object.freeze({ ...snapshot });
  return {
    allowEnvironmentFallback: false,
    reload() {},
    get: provider => (provider === 'openai-codex' ? credential : undefined),
    getStoredApiKey: () => undefined,
    getApiKey: async provider => (provider === 'openai-codex' ? credential.access : undefined),
    getOAuthCredential: async provider => (provider === 'openai-codex' ? credential : undefined),
  };
}

/** Consume incrementally; both body size and body consumption are covered by the GET deadline. */
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new CodexCatalogRefreshError('CATALOG_INVALID');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > CODEX_CATALOG_MAX_BYTES) throw new CodexCatalogRefreshError('CATALOG_INVALID');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      throw new CodexCatalogRefreshError('CATALOG_INVALID');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fetch only. Publication must separately recheck scope under its writer lock. */
export async function fetchCodexCatalogSnapshot(options: {
  appDataDir: string;
  credential: OAuthCredentialSnapshot;
  signal?: AbortSignal;
}): Promise<CodexCatalogCache> {
  const credential = { ...options.credential };
  const authPath = join(options.appDataDir, 'auth.json');
  const scope = scopeForCredential(authPath, credential);
  const assertScope = () => {
    const current = readOpenAICodexCatalogScope(authPath);
    if (!current || !sameCodexCatalogScope(current, scope)) throw new CodexCatalogRefreshError('ACCOUNT_CHANGED');
  };
  assertScope();
  if (credential.expires <= Date.now()) throw new CodexCatalogRefreshError('AUTH_REFRESH_REQUIRED');
  const deadline = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  try {
    signal.throwIfAborted();
    const nativeFetch = buildOpenAICodexOAuthFetch({ authStorage: pinnedStore(credential), rewriteUrl: false });
    const response = await nativeFetch(`${CODEX_CATALOG_ENDPOINT}?client_version=${CODEX_CATALOG_CLIENT_VERSION}`, {
      method: 'GET',
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CodexCatalogRefreshError(
        response.status === 401 || response.status === 403 ? 'CREDENTIAL_REJECTED' : 'CATALOG_REQUEST_FAILED',
      );
    }
    const body = await readResponse(response, signal);
    let slugs: string[];
    try {
      slugs = decodeCodexCatalogResponse(body);
    } catch {
      throw new CodexCatalogRefreshError('CATALOG_INVALID');
    }
    signal.throwIfAborted();
    assertScope();
    const fetchedAt = Date.now();
    return codexCatalogCacheSchema.parse({
      schemaVersion: 1,
      provider: 'openai-codex',
      scope,
      endpoint: CODEX_CATALOG_ENDPOINT,
      clientVersion: CODEX_CATALOG_CLIENT_VERSION,
      fetchedAt,
      expiresAt: fetchedAt + CODEX_CATALOG_TTL_MS,
      slugs,
    });
  } catch (error) {
    if (signal.aborted) throw new CodexCatalogRefreshError('CATALOG_CANCELLED');
    if (error instanceof CodexCatalogRefreshError) throw error;
    throw new CodexCatalogRefreshError('CATALOG_REQUEST_FAILED');
  }
}

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openaiCodexOAuthProvider } from '../../auth/providers/openai-codex.js';
import { AuthStorage } from '../../auth/storage.js';
import { fetchCodexCatalogSnapshot, refreshCodexCatalog } from '../openai-codex-catalog-refresh.js';
import {
  CODEX_CATALOG_CLIENT_VERSION,
  CODEX_CATALOG_ENDPOINT,
  CODEX_CATALOG_FILENAME,
  CODEX_CATALOG_MAX_BYTES,
  readCodexCatalog,
  codexCatalogPath,
} from '../openai-codex-catalog.js';

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-catalog-refresh-'));
  dirs.push(dir);
  const credential = {
    type: 'oauth' as const,
    access: 'synthetic-access',
    refresh: 'synthetic-refresh',
    accountId: 'synthetic-account',
    expires: Date.now() + 60_000,
  };
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': credential }));
  return { dir, credential };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('native catalog publication', () => {
  it('invalidates rejected pinned A after activating B without changing B evidence', async () => {
    const { dir, credential } = fixture();
    const record = (suffix: string, active: boolean) => ({
      ...credential,
      type: 'oauth-account',
      id: `openai-codex:${suffix}`,
      label: suffix,
      addedAt: '2026-10-07T00:00:00Z',
      active,
      accountId: `account-${suffix}`,
      access: `access-${suffix}`,
      refresh: `refresh-${suffix}`,
    });
    const a = record('a', true),
      b = record('b', false);
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        'openai-codex': { ...credential, accountId: a.accountId, access: a.access, refresh: a.refresh },
        [`accounts:${a.id}`]: a,
        [`accounts:${b.id}`]: b,
      }),
    );
    const owner = new AuthStorage(join(dir, 'auth.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] })),
    );
    await refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    await owner.activateAccount('openai-codex', b.id);
    await refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    const bPath = codexCatalogPath(dir, { kind: 'registered', accountInstanceId: b.id, accountId: b.accountId });
    const beforeB = readFileSync(bPath, 'utf8');
    await owner.activateAccount('openai-codex', a.id);
    let answer!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(resolve => {
            answer = resolve;
          }),
      ),
    );
    const pending = refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    await owner.activateAccount('openai-codex', b.id);
    answer(new Response('rejected', { status: 401 }));
    await rejected;
    expect(readCodexCatalog(dir, Date.now(), a.id).status).toBe('invalid');
    expect(readCodexCatalog(dir).status).toBe('ready');
    expect(readFileSync(bPath, 'utf8')).toBe(beforeB);
    await owner.activateAccount('openai-codex', a.id);
    expect(readCodexCatalog(dir).status).toBe('invalid');
  });
  it('retains separate dated catalogs across native account activation without fetching during reads', async () => {
    const { dir, credential } = fixture();
    const record = (suffix: string, active: boolean) => ({
      ...credential,
      type: 'oauth-account',
      id: `openai-codex:${suffix}`,
      label: suffix,
      addedAt: '2026-10-06T00:00:00Z',
      active,
      accountId: `account-${suffix}`,
      refresh: `refresh-${suffix}`,
      access: `access-${suffix}`,
    });
    const a = record('a', true);
    const b = record('b', false);
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        'openai-codex': { ...credential, accountId: a.accountId, refresh: a.refresh, access: a.access },
        [`accounts:${a.id}`]: a,
        [`accounts:${b.id}`]: b,
      }),
    );
    const owner = new AuthStorage(join(dir, 'auth.json'));
    const fetch = vi.fn(async (request: Request) =>
      Response.json({
        models: [
          {
            slug: request.headers.get('chatgpt-account-id') === 'account-a' ? 'model-a' : 'model-b',
            visibility: 'list',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    await owner.activateAccount('openai-codex', b.id);
    await refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    await owner.activateAccount('openai-codex', a.id);
    expect(readCodexCatalog(dir).models).toEqual(['openai/model-a']);
    expect(readCodexCatalog(dir, Date.now(), b.id).models).toEqual(['openai/model-b']);
    expect(fetch).toHaveBeenCalledTimes(2);
    const current = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'));
    delete current[`accounts:${b.id}`];
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(current));
    expect(readCodexCatalog(dir, Date.now(), b.id)).toEqual({ status: 'unbound', models: [] });
  });

  it.each(['not-json', JSON.stringify({ models: 'invalid' })])(
    'reports malformed successful responses as invalid catalog without retry: %s',
    async body => {
      const { dir, credential } = fixture();
      const fetch = vi.fn(async () => new Response(body));
      vi.stubGlobal('fetch', fetch);
      await expect(fetchCodexCatalogSnapshot({ appDataDir: dir, credential })).rejects.toMatchObject({
        code: 'CATALOG_INVALID',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dir, CODEX_CATALOG_FILENAME))).toBe(false);
    },
  );

  it('serializes writers and cancels a waiting command without a second GET', async () => {
    const { dir } = fixture();
    const owner = new AuthStorage(join(dir, 'auth.json'));
    let answer!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          answer = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const first = refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    const controller = new AbortController();
    const second = refreshCodexCatalog({ appDataDir: dir, authStorage: owner, signal: controller.signal });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'CATALOG_CANCELLED' });
    expect(fetch).toHaveBeenCalledTimes(1);
    answer(Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] }));
    await first;
    expect(readCodexCatalog(dir).models).toEqual(['openai/gpt-6-luna']);
    expect(readdirSync(dir).sort()).toEqual(['auth.json', CODEX_CATALOG_FILENAME].sort());
  });

  it('atomically publishes the legacy account inventory without migrating fresh auth', async () => {
    const { dir } = fixture();
    const before = readFileSync(join(dir, 'auth.json'), 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] })),
    );
    await refreshCodexCatalog({ appDataDir: dir, authStorage: new AuthStorage(join(dir, 'auth.json')) });
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(before);
    expect(readCodexCatalog(dir).models).toEqual(['openai/gpt-6-luna']);
    expect(readdirSync(dir).sort()).toEqual(['auth.json', CODEX_CATALOG_FILENAME].sort());
  });

  it('refreshes expired credentials through the native owner before fetching once', async () => {
    const { dir, credential } = fixture();
    credential.expires = 1;
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'openai-codex': credential }));
    const rotation = vi.spyOn(openaiCodexOAuthProvider, 'refreshToken').mockResolvedValue({
      ...credential,
      access: 'native-rotated',
      refresh: 'native-rotated-refresh',
      expires: Date.now() + 60_000,
    });
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('authorization')).toBe('Bearer native-rotated');
      return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
    });
    vi.stubGlobal('fetch', fetch);
    await refreshCodexCatalog({ appDataDir: dir, authStorage: new AuthStorage(join(dir, 'auth.json')) });
    expect(rotation).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readCodexCatalog(dir).status).toBe('ready');
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8'))['openai-codex'].access).toBe('native-rotated');
  });

  it('does not publish after signout during the request', async () => {
    const { dir } = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        writeFileSync(join(dir, 'auth.json'), '{}');
        return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
      }),
    );
    await expect(
      refreshCodexCatalog({ appDataDir: dir, authStorage: new AuthStorage(join(dir, 'auth.json')) }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(existsSync(join(dir, CODEX_CATALOG_FILENAME))).toBe(false);
    expect(readdirSync(dir)).toEqual(['auth.json']);
  });

  it('retains fresh last-success evidence on 5xx, but invalidates it on credential rejection', async () => {
    const { dir } = fixture();
    const owner = new AuthStorage(join(dir, 'auth.json'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] })),
    );
    await refreshCodexCatalog({ appDataDir: dir, authStorage: owner });
    const before = readFileSync(join(dir, CODEX_CATALOG_FILENAME), 'utf8');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 500 })),
    );
    await expect(refreshCodexCatalog({ appDataDir: dir, authStorage: owner })).rejects.toMatchObject({
      code: 'CATALOG_REQUEST_FAILED',
    });
    expect(readFileSync(join(dir, CODEX_CATALOG_FILENAME), 'utf8')).toBe(before);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rejected', { status: 401 })),
    );
    await expect(refreshCodexCatalog({ appDataDir: dir, authStorage: owner })).rejects.toMatchObject({
      code: 'CREDENTIAL_REJECTED',
    });
    expect(readCodexCatalog(dir)).toEqual({ status: 'invalid', models: [] });
  });
});

describe('explicit native Codex catalog fetch', () => {
  it('uses one pinned native bearer/account request without changing auth', async () => {
    const { dir, credential } = fixture();
    const before = readFileSync(join(dir, 'auth.json'), 'utf8');
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`${CODEX_CATALOG_ENDPOINT}?client_version=${CODEX_CATALOG_CLIENT_VERSION}`);
      expect(request.method).toBe('GET');
      expect(request.redirect).toBe('error');
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-access');
      expect(request.headers.get('chatgpt-account-id')).toBe('synthetic-account');
      credential.access = 'changed-after-pinning';
      return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await fetchCodexCatalogSnapshot({ appDataDir: dir, credential });
    expect(result.slugs).toEqual(['gpt-6-luna']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(before);
  });

  it('discards a delayed response after signout', async () => {
    const { dir, credential } = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        writeFileSync(join(dir, 'auth.json'), '{}');
        return Response.json({ models: [{ slug: 'gpt-6-luna', visibility: 'list' }] });
      }),
    );
    await expect(fetchCodexCatalogSnapshot({ appDataDir: dir, credential })).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });
  });

  it('requires native owner refresh for an expired snapshot without fetching', async () => {
    const { dir, credential } = fixture();
    credential.expires = 1;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchCodexCatalogSnapshot({ appDataDir: dir, credential })).rejects.toMatchObject({
      code: 'AUTH_REFRESH_REQUIRED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a stalled response body and returns no catalog', async () => {
    const { dir, credential } = fixture();
    const controller = new AbortController();
    const cancelled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start() {
                queueMicrotask(() => controller.abort());
              },
              cancel: cancelled,
            }),
          ),
      ),
    );
    await expect(
      fetchCodexCatalogSnapshot({ appDataDir: dir, credential, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CATALOG_CANCELLED' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized bodies without exposing response text', async () => {
    const { dir, credential } = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(CODEX_CATALOG_MAX_BYTES + 1))),
    );
    await expect(fetchCodexCatalogSnapshot({ appDataDir: dir, credential })).rejects.toMatchObject({
      code: 'CATALOG_INVALID',
      message: 'CATALOG_INVALID',
    });
  });

  it.each([401, 403, 500])('returns a sanitized status error for HTTP %s', async status => {
    const { dir, credential } = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('do not expose backend text', { status })),
    );
    await expect(fetchCodexCatalogSnapshot({ appDataDir: dir, credential })).rejects.toMatchObject({
      code: status === 500 ? 'CATALOG_REQUEST_FAILED' : 'CREDENTIAL_REJECTED',
    });
  });
});

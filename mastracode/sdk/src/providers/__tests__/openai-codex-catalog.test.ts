import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_CATALOG_CLIENT_VERSION,
  CODEX_CATALOG_ENDPOINT,
  CODEX_CATALOG_FILENAME,
  CODEX_CATALOG_MAX_BYTES,
  CODEX_CATALOG_TTL_MS,
  decodeCodexCatalogResponse,
  readCodexCatalog,
} from '../openai-codex-catalog.js';

const dirs: string[] = [];
const now = 10000000;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mc-account-catalog-'));
  dirs.push(dir);
  const auth = { 'openai-codex': { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'account-a' } };
  const cache = {
    schemaVersion: 1,
    provider: 'openai-codex',
    scope: { kind: 'legacy', accountId: 'account-a' },
    endpoint: CODEX_CATALOG_ENDPOINT,
    clientVersion: CODEX_CATALOG_CLIENT_VERSION,
    fetchedAt: now,
    expiresAt: now + CODEX_CATALOG_TTL_MS,
    slugs: ['gpt-6.1-sol', 'gpt-6-luna'],
  };
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
  writeFileSync(join(dir, CODEX_CATALOG_FILENAME), JSON.stringify(cache));
  return { dir, auth, cache };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('native OAuth account catalog', () => {
  it('keeps visible backend order and deduplicates without version filtering', () => {
    expect(
      decodeCodexCatalogResponse({
        models: [
          { slug: 'gpt-6.1-sol', visibility: 'list' },
          { slug: 'gpt-reserve', visibility: 'hide' },
          { slug: 'gpt-6-luna', visibility: 'list' },
          { slug: 'gpt-6.1-sol', visibility: 'list' },
          { slug: 'future-model', visibility: 'list' },
        ],
      }),
    ).toEqual(['gpt-6.1-sol', 'gpt-6-luna', 'future-model']);
  });
  it('rejects malformed and oversized inventories', () => {
    expect(() => decodeCodexCatalogResponse({ models: [{ slug: '../secret', visibility: 'list' }] })).toThrow();
    expect(() =>
      decodeCodexCatalogResponse({ models: Array.from({ length: 201 }, () => ({ slug: 'x', visibility: 'list' })) }),
    ).toThrow();
  });
  it('reads offline repeatedly without extending TTL or modifying files', () => {
    const { dir } = fixture();
    const authBefore = readFileSync(join(dir, 'auth.json'), 'utf8');
    const cacheBefore = readFileSync(join(dir, CODEX_CATALOG_FILENAME), 'utf8');
    expect(readCodexCatalog(dir, now).models).toEqual(['openai/gpt-6.1-sol', 'openai/gpt-6-luna']);
    expect(readCodexCatalog(dir, now + CODEX_CATALOG_TTL_MS)).toEqual({ status: 'expired', models: [] });
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(authBefore);
    expect(readFileSync(join(dir, CODEX_CATALOG_FILENAME), 'utf8')).toBe(cacheBefore);
  });
  it('rejects another account and signout even when cache remains', () => {
    const { dir, auth } = fixture();
    auth['openai-codex'].accountId = 'account-b';
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(auth));
    expect(readCodexCatalog(dir, now)).toEqual({ status: 'foreign', models: [] });
    writeFileSync(join(dir, 'auth.json'), '{}');
    expect(readCodexCatalog(dir, now)).toEqual({ status: 'unbound', models: [] });
  });
  it.each(['schemaVersion', 'clientVersion', 'endpoint', 'future', 'duplicate', 'oversized'])(
    'rejects incompatible cache: %s',
    scenario => {
      const { dir, cache } = fixture();
      const changed: Record<string, unknown> = { ...cache };
      if (scenario === 'schemaVersion') changed.schemaVersion = 2;
      if (scenario === 'clientVersion') changed.clientVersion = 'other';
      if (scenario === 'endpoint') changed.endpoint = 'https://other.example/models';
      if (scenario === 'future') {
        changed.fetchedAt = now + 1;
        changed.expiresAt = now + 1 + CODEX_CATALOG_TTL_MS;
      }
      if (scenario === 'duplicate') changed.slugs = ['same', 'same'];
      writeFileSync(
        join(dir, CODEX_CATALOG_FILENAME),
        scenario === 'oversized' ? 'x'.repeat(CODEX_CATALOG_MAX_BYTES + 1) : JSON.stringify(changed),
      );
      expect(readCodexCatalog(dir, now)).toEqual({ status: 'invalid', models: [] });
    },
  );
});

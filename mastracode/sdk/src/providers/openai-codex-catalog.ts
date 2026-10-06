import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readOpenAICodexCatalogScope } from '../auth/read-only.js';
import type { OpenAICodexCatalogScope } from '../auth/read-only.js';

export const CODEX_CATALOG_ENDPOINT = 'https://chatgpt.com/backend-api/codex/models';
export const CODEX_CATALOG_CLIENT_VERSION = '0.160.0';
export const CODEX_CATALOG_TTL_MS = 60 * 60 * 1000;
export const CODEX_CATALOG_MAX_BYTES = 1024 * 1024;
export const CODEX_CATALOG_MAX_MODELS = 200;
export const CODEX_CATALOG_FILENAME = 'openai-codex-model-catalog.json';

const identifier = z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/);
const stableId = z
  .string()
  .min(1)
  .max(512)
  .refine(value => value === value.trim());
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy'), accountId: stableId }).strict(),
  z
    .object({
      kind: z.literal('registered'),
      accountId: stableId,
      accountInstanceId: stableId.refine(value => value.startsWith('openai-codex:')),
    })
    .strict(),
]);
const slugsSchema = z
  .array(identifier)
  .max(CODEX_CATALOG_MAX_MODELS)
  .refine(slugs => new Set(slugs).size === slugs.length);
export const codexCatalogCacheSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.literal('openai-codex'),
    scope: scopeSchema,
    endpoint: z.literal(CODEX_CATALOG_ENDPOINT),
    clientVersion: z.literal(CODEX_CATALOG_CLIENT_VERSION),
    fetchedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    slugs: slugsSchema,
  })
  .strict()
  .refine(value => value.expiresAt - value.fetchedAt === CODEX_CATALOG_TTL_MS);
export type CodexCatalogCache = z.infer<typeof codexCatalogCacheSchema>;

export function sameCodexCatalogScope(a: OpenAICodexCatalogScope, b: OpenAICodexCatalogScope): boolean {
  return a.kind === b.kind && a.accountId === b.accountId && a.accountInstanceId === b.accountInstanceId;
}

/** Backend order is authoritative. Ignore hidden records, never invent model aliases. */
export function decodeCodexCatalogResponse(value: unknown): string[] {
  const response = z
    .object({ models: z.array(z.object({ slug: identifier, visibility: z.string() })).max(CODEX_CATALOG_MAX_MODELS) })
    .parse(value);
  return [...new Set(response.models.filter(model => model.visibility === 'list').map(model => model.slug))];
}

export type CodexCatalogRead =
  | { status: 'ready'; models: string[]; scope: OpenAICodexCatalogScope; fetchedAt: number; expiresAt: number }
  | { status: 'unbound' | 'missing' | 'invalid' | 'foreign' | 'expired'; models: [] };

/** Bound allocation even if a file grows while being read; no writes or network imports. */
function readBoundedCache(path: string): unknown {
  const descriptor = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(CODEX_CATALOG_MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(descriptor, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > CODEX_CATALOG_MAX_BYTES) throw new Error('Codex catalog exceeds size limit');
    return JSON.parse(bytes.subarray(0, used).toString('utf8'));
  } finally {
    closeSync(descriptor);
  }
}

export function readCodexCatalog(appDataDir: string, now = Date.now()): CodexCatalogRead {
  const authPath = join(appDataDir, 'auth.json');
  const scope = readOpenAICodexCatalogScope(authPath);
  if (!scope) return { status: 'unbound', models: [] };
  let cache: CodexCatalogCache;
  try {
    cache = codexCatalogCacheSchema.parse(readBoundedCache(join(appDataDir, CODEX_CATALOG_FILENAME)));
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid', models: [] };
  }
  const currentScope = readOpenAICodexCatalogScope(authPath);
  if (!currentScope || !sameCodexCatalogScope(scope, currentScope) || !sameCodexCatalogScope(scope, cache.scope)) {
    return { status: 'foreign', models: [] };
  }
  if (!Number.isFinite(now) || now < cache.fetchedAt) return { status: 'invalid', models: [] };
  if (now >= cache.expiresAt) return { status: 'expired', models: [] };
  return {
    status: 'ready',
    models: cache.slugs.map(slug => `openai/${slug}`),
    scope: cache.scope,
    fetchedAt: cache.fetchedAt,
    expiresAt: cache.expiresAt,
  };
}

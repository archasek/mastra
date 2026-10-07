import { readFileSync } from 'node:fs';
import type { OAuthAccountRecord, OAuthCredentials } from './types.js';

export function hasOAuthCredentialFields(value: unknown): value is OAuthCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const credentials = value as Partial<OAuthCredentials>;
  return (
    typeof credentials.refresh === 'string' &&
    credentials.refresh.trim().length > 0 &&
    typeof credentials.access === 'string' &&
    credentials.access.trim().length > 0 &&
    typeof credentials.expires === 'number' &&
    Number.isFinite(credentials.expires)
  );
}

export function isOAuthAccountRecord(value: unknown): value is OAuthAccountRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<OAuthAccountRecord>;
  return (
    record.type === 'oauth-account' &&
    typeof record.id === 'string' &&
    typeof record.label === 'string' &&
    typeof record.addedAt === 'string' &&
    typeof record.active === 'boolean' &&
    hasOAuthCredentialFields(value)
  );
}

export interface ReadonlyOAuthStatus {
  provider: string;
  status: 'authenticated' | 'unauthenticated' | 'unknown';
  account?: { id: string; label: string };
}

function readAuth(authPath: string): Record<string, unknown> | 'missing' | 'invalid' {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

/** Status only; never constructs storage, migrates or refreshes credentials. */
export function readOAuthStatusFile(authPath: string, providerId: string): ReadonlyOAuthStatus {
  const data = readAuth(authPath);
  if (data === 'missing') return { provider: providerId, status: 'unauthenticated' };
  if (data === 'invalid') return { provider: providerId, status: 'unknown' };
  const accounts = Object.entries(data).filter(([key]) => key.startsWith(`accounts:${providerId}:`));
  const active = accounts
    .map(([, value]) => value)
    .find((value): value is OAuthAccountRecord => isOAuthAccountRecord(value) && value.active);
  const malformed = accounts.some(([, value]) => !isOAuthAccountRecord(value));
  const slot = data[providerId];
  const oauthSlot = !!slot && typeof slot === 'object' && (slot as { type?: unknown }).type === 'oauth';
  if (!(oauthSlot && hasOAuthCredentialFields(slot)) && !active) {
    return { provider: providerId, status: malformed || oauthSlot ? 'unknown' : 'unauthenticated' };
  }
  return {
    provider: providerId,
    status: 'authenticated',
    ...(active ? { account: { id: active.id, label: active.label } } : {}),
  };
}

export interface OpenAICodexCatalogScope {
  kind: 'registered' | 'legacy';
  accountInstanceId?: string;
  accountId: string;
}

/** Strict stable scope for a catalog; ambiguity never grants model availability. */
export function readOpenAICodexCatalogScope(
  authPath: string,
  accountInstanceId?: string,
  expectedCredential?: OAuthCredentials,
): OpenAICodexCatalogScope | undefined {
  const data = readAuth(authPath);
  if (typeof data === 'string') return undefined;
  if (accountInstanceId !== undefined) {
    if (
      Object.entries(data).some(
        ([key, value]) =>
          key.startsWith('accounts:openai-codex:') && (!isOAuthAccountRecord(value) || key !== `accounts:${value.id}`),
      )
    )
      return undefined;
    const record = data[`accounts:${accountInstanceId}`];
    if (!isOAuthAccountRecord(record) || record.id !== accountInstanceId || !record.id.startsWith('openai-codex:')) {
      return undefined;
    }
    if (
      typeof record.accountId !== 'string' ||
      !record.accountId.trim() ||
      record.accountId !== record.accountId.trim()
    ) {
      return undefined;
    }
    if (
      expectedCredential &&
      (record.refresh !== expectedCredential.refresh || record.access !== expectedCredential.access)
    )
      return undefined;
    return { kind: 'registered', accountInstanceId, accountId: record.accountId };
  }
  const slot = data['openai-codex'];
  if (!hasOAuthCredentialFields(slot) || (slot as { type?: unknown }).type !== 'oauth') return undefined;
  if (expectedCredential && (slot.refresh !== expectedCredential.refresh || slot.access !== expectedCredential.access))
    return undefined;
  const accountId = slot.accountId;
  if (typeof accountId !== 'string' || !accountId.trim() || accountId !== accountId.trim()) return undefined;
  const entries = Object.entries(data).filter(([key]) => key.startsWith('accounts:openai-codex:'));
  if (!entries.length) return { kind: 'legacy', accountId };
  if (entries.some(([key, value]) => !isOAuthAccountRecord(value) || key !== `accounts:${value.id}`)) return undefined;
  const active = entries.map(([, value]) => value as OAuthAccountRecord).filter(value => value.active);
  if (
    active.length !== 1 ||
    !active[0]!.id.startsWith('openai-codex:') ||
    active[0]!.accountId !== accountId ||
    active[0]!.refresh !== slot.refresh
  )
    return undefined;
  return { kind: 'registered', accountInstanceId: active[0]!.id, accountId };
}

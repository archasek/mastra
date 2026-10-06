/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getAppDataDir } from '../utils/project.js';
import { anthropicOAuthProvider } from './providers/anthropic.js';
import { githubCopilotOAuthProvider } from './providers/github-copilot.js';
import { kimiCodingOAuthProvider } from './providers/kimi-coding.js';
import { openaiCodexOAuthProvider } from './providers/openai-codex.js';
import { xaiOAuthProvider } from './providers/xai.js';
import { hasOAuthCredentialFields, isOAuthAccountRecord } from './read-only.js';
export { readOAuthStatusFile } from './read-only.js';
export type { ReadonlyOAuthStatus } from './read-only.js';
import type {
  AuthCredential,
  AuthStorageData,
  OAuthAccountRecord,
  OAuthCredential,
  OAuthCredentialSnapshot,
  OAuthCredentialAcquisitionOptions,
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
  OAuthProviderInterface,
} from './types.js';

type ProperLockfile = {
  lock: (path: string, options: Record<string, unknown>) => Promise<() => Promise<void>>;
};

interface OAuthRefreshResult {
  credentials: OAuthCredentials;
  accountInstanceId?: string;
}

const require = createRequire(import.meta.url);
const properLockfile = require('proper-lockfile') as ProperLockfile;
const authFileQueues = new Map<string, Promise<void>>();

/** Cancels this waiter, never the producer it may have joined. */
function waitForAcquisition<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolveWait, rejectWait) => {
    const abort = () => rejectWait(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolveWait, rejectWait).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Serialize same-process callers, then hold an OS-visible lock across refresh and save. */
async function withAuthFileLock<T>(authPath: string, action: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  const lockKey = resolve(authPath);
  const previous = authFileQueues.get(lockKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>(resolveQueue => {
    releaseQueue = resolveQueue;
  });
  authFileQueues.set(lockKey, queued);
  let precedingFinished = false;
  try {
    await waitForAcquisition(previous, signal);
    precedingFinished = true;
    signal?.throwIfAborted();
    mkdirSync(dirname(lockKey), { recursive: true, mode: 0o700 });
    const lockOptions = {
      realpath: false,
      stale: 120_000,
      update: 30_000,
      retries: signal ? 0 : { retries: 200, factor: 1, minTimeout: 50, maxTimeout: 250, randomize: true },
    };
    let releaseFileLock: () => Promise<void>;
    for (;;) {
      signal?.throwIfAborted();
      try {
        releaseFileLock = await properLockfile.lock(lockKey, lockOptions);
        break;
      } catch (error) {
        if (!signal || (error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
        await delay(50, undefined, { signal });
      }
    }
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      await releaseFileLock();
    }
  } finally {
    const finishQueue = () => {
      releaseQueue();
      if (authFileQueues.get(lockKey) === queued) authFileQueues.delete(lockKey);
    };
    // An abandoned waiter must not let a later writer bypass its predecessor.
    if (precedingFinished) finishQueue();
    else void previous.then(finishQueue);
  }
}

/**
 * Best/default models for each OAuth provider.
 * Used when auto-selecting a model after login.
 */
export const PROVIDER_DEFAULT_MODELS: Record<OAuthProviderId, string> = {
  anthropic: 'anthropic/claude-fable-5',
  'openai-codex': 'openai/gpt-5.6-sol',
  // gpt-4.1 routes through `/chat/completions` (which our OpenAI-compatible
  // adapter handles); Anthropic-shaped Copilot models (Claude on `/v1/messages`)
  // are not yet wired up, so picking one as the post-login default would error.
  'github-copilot': 'github-copilot/gpt-4.1',
  'kimi-for-coding': 'kimi-for-coding/kimi-for-coding',
  xai: 'xai/grok-4.5',
};

// Provider registry
const oauthProviderRegistry = new Map<string, OAuthProviderInterface>([
  [anthropicOAuthProvider.id, anthropicOAuthProvider],
  [openaiCodexOAuthProvider.id, openaiCodexOAuthProvider],
  [githubCopilotOAuthProvider.id, githubCopilotOAuthProvider],
  [kimiCodingOAuthProvider.id, kimiCodingOAuthProvider],
  [xaiOAuthProvider.id, xaiOAuthProvider],
]);

/**
 * Get an OAuth provider by ID
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
  return oauthProviderRegistry.get(id);
}

/**
 * Get all registered OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInterface[] {
  return Array.from(oauthProviderRegistry.values());
}

/**
 * Mint an opaque account instance id for a newly registered account.
 *
 * Legacy-only files have no persisted account ID, so `adoptSlot` uses a
 * deterministic migration ID until that entry is first written. Ordinary
 * account creation uses a random ID and keeps it across refreshes. The old
 * pre-A13 refresh-hash scheme was different: re-authorization could derive a
 * second ID for the same subscription and register a duplicate account.
 */
function mintAccountId(providerId: string): string {
  return `${providerId}:${globalThis.crypto.randomUUID()}`;
}

/**
 * The pre-A13 id scheme: `${providerId}:${sha256(refresh).slice(0,8)}`.
 *
 * No longer used to assign ids, but still needed to recognize registries
 * written before A13 — both to match a re-authorized account onto its existing
 * entry, and to recognize entries whose fields the A13 migration must backfill.
 */
function legacyAccountIdFor(providerId: string, refreshToken: string): string {
  return `${providerId}:${createHash('sha256').update(refreshToken).digest('hex').slice(0, 8)}`;
}

function sameOAuthCredentials(left: OAuthCredentials, right: OAuthCredentials): boolean {
  return left.refresh === right.refresh && left.access === right.access && left.expires === right.expires;
}

/**
 * Stable identity for the *subscription* behind an account, when the provider
 * exposes one (an account id, an email — anything that survives a refresh and
 * a re-authorization). Used to decide whether an added account is one we
 * already have. Providers whose credentials carry no such identifier return
 * undefined; for those, a re-authorization is indistinguishable from a new
 * account without spending a request.
 */
function providerIdentity(provider: OAuthProviderInterface | undefined, creds: OAuthCredentials): string | undefined {
  try {
    const identity = provider?.getAccountIdentity?.(creds);
    return typeof identity === 'string' && identity.length > 0 ? identity : undefined;
  } catch {
    return undefined;
  }
}

/** The credential fields of an account record — everything but registry identity. */
function credentialFieldsOf(record: OAuthAccountRecord): OAuthCredentials {
  const {
    type: _type,
    id: _id,
    label: _label,
    addedAt: _addedAt,
    active: _active,
    identity: _identity,
    ...creds
  } = record;
  return creds;
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
  private data: AuthStorageData = {};
  private refreshPromises = new Map<string, Promise<OAuthRefreshResult | undefined>>();

  constructor(private authPath: string = join(getAppDataDir(), 'auth.json')) {
    this.reload();
  }

  /**
   * Reload credentials from disk.
   */
  reload(): void {
    let serialized: string;
    try {
      serialized = readFileSync(this.authPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = {};
      return;
    }
    this.data = JSON.parse(serialized) as AuthStorageData;
    this.migrate();
  }

  /**
   * Bring auth.json up to the multi-account registry format. Runs on every
   * load; saves only when something actually changed.
   *
   * 1. A legacy OAuth slot with no registry gets one adopted active entry
   *    (the slot's tokens stay put — the entry mirrors them).
   * 2. When the slot's refresh token differs from the active entry's, an
   *    external writer (older build, another worktree) owns the slot — the
   *    slot wins and its tokens are adopted onto the active entry.
   * 3. A registry with no active entry (hand-edited) self-heals to its first
   *    entry; malformed `accounts:` values are skipped, never fatal.
   * 4. A registry whose legacy slot disappeared (partial write, an external
   *    hand-edit) self-heals by mirroring the active entry's tokens back into
   *    the slot, so `isLoggedIn()`/`getOAuthCredential()` keep agreeing with
   *    `listAccounts()`. `remove()`/`logout()` clear the registry with the
   *    slot, so they never leave the shape this heals.
   */
  private migrate(): boolean {
    let changed = false;
    for (const key of Object.keys(this.data)) {
      const slot = this.data[key];
      if (!slot || slot.type !== 'oauth') continue;
      const providerId = key;
      const entries = this.accountEntries(providerId);
      if (entries.length === 0) {
        this.adoptSlot(providerId, slot);
        changed = true;
        continue;
      }
      const active = entries.find(entry => entry.active);
      if (!active) {
        this.data[this.accountKeyFor(entries[0]!.id)] = { ...entries[0]!, active: true };
        changed = true;
        continue;
      }
      if (active.refresh !== slot.refresh) {
        // An external writer (older build, another worktree) owns the slot.
        // Reconcile it only when a stable provider identity or the unchanged
        // refresh token proves which registered account owns those tokens.
        // Never copy an unknown/different account's credentials onto `active`:
        // requests pinned to active.id would then silently cross accounts.
        const provider = getOAuthProvider(providerId as OAuthProviderId);
        const slotIdentity = providerIdentity(provider, slot);
        const identityOf = (entry: OAuthAccountRecord) =>
          entry.identity ?? providerIdentity(provider, credentialFieldsOf(entry));
        const activeIdentityMatchesSlot = Boolean(slotIdentity && identityOf(active) === slotIdentity);
        const matching = activeIdentityMatchesSlot
          ? undefined
          : ((slotIdentity
              ? entries.find(entry => entry.id !== active.id && identityOf(entry) === slotIdentity)
              : undefined) ??
            entries.find(entry => {
              if (entry.id === active.id || entry.refresh !== slot.refresh) return false;
              const entryIdentity = identityOf(entry);
              return !slotIdentity || !entryIdentity || entryIdentity === slotIdentity;
            }));
        if (matching) {
          const { type: _t, ...slotCreds } = slot;
          this.data[this.accountKeyFor(matching.id)] = {
            ...matching,
            ...slotCreds,
            type: 'oauth-account',
            ...(slotIdentity ? { identity: slotIdentity } : {}),
            active: true,
          };
          this.data[this.accountKeyFor(active.id)] = { ...active, active: false };
          changed = true;
        } else if (activeIdentityMatchesSlot) {
          // A known, stable identity proves this is the same account even if
          // an older writer rotated its refresh token.
          const { type: _type, ...slotCreds } = slot;
          this.data[this.accountKeyFor(active.id)] = {
            ...active,
            ...slotCreds,
            type: 'oauth-account',
            identity: slotIdentity,
          };
          changed = true;
        } else {
          // The old slot may now belong to an unregistered account, or this
          // provider may not expose enough identity to prove continuity. Keep
          // the registry's selected account authoritative and fail closed.
          this.data[providerId] = { type: 'oauth', ...credentialFieldsOf(active) };
          changed = true;
        }
      }
    }

    // Case 4: registry entries without a legacy slot (the slot loop above
    // only ever sees providers that still have one).
    const registeredProviders = new Set<string>();
    for (const key of Object.keys(this.data)) {
      if (!key.startsWith('accounts:')) continue;
      const providerId = key.slice('accounts:'.length).split(':')[0];
      if (providerId) registeredProviders.add(providerId);
    }
    for (const providerId of registeredProviders) {
      if (this.data[providerId]?.type === 'oauth') continue;
      const entries = this.accountEntries(providerId);
      if (entries.length === 0) continue;
      let active = entries.find(entry => entry.active);
      if (!active) {
        active = entries[0]!;
        this.data[this.accountKeyFor(active.id)] = { ...active, active: true };
      }
      this.data[providerId] = { type: 'oauth', ...credentialFieldsOf(active) };
      changed = true;
    }

    // Case 5 (A13): backfill the stable account identity on entries that
    // predate it, so adding a subscription we already hold updates its entry
    // instead of registering a second one for it.
    //
    // Ids are deliberately left exactly as they are. Ids are minted once and
    // derive from nothing (A13), so there is nothing to repair — and re-keying
    // a live registry would invalidate every id persisted outside this file
    // (settings routing preferences, per-thread routing state) for no gain.
    for (const providerId of registeredProviders) {
      const provider = getOAuthProvider(providerId as OAuthProviderId);
      if (!provider?.getAccountIdentity) continue;
      for (const entry of this.accountEntries(providerId)) {
        if (entry.identity) continue;
        const identity = providerIdentity(provider, entry);
        if (!identity) continue;
        this.data[this.accountKeyFor(entry.id)] = { ...entry, identity };
        changed = true;
      }
    }

    // Migration is in-memory only here. Persisting from reload() would let a
    // constructor/read race with another process's locked credential update.
    // The next serialized mutation writes the migrated snapshot atomically.
    return changed;
  }

  /**
   * Save credentials to disk.
   */
  private save(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Write to a sibling file, then atomically replace auth.json. Provider
    // fetch wrappers reload this file on every request, including in older
    // Mastra Code processes; writing in place lets them observe truncated JSON
    // and temporarily treat every provider as logged out.
    const tempPath = `${this.authPath}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(this.data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, this.authPath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  /**
   * Get credential for a provider. Registry entries (type 'oauth-account')
   * live under `accounts:` keys and never surface here.
   */
  get(provider: string): AuthCredential | undefined {
    const cred = this.data[provider];
    return cred !== undefined && cred.type !== 'oauth-account' ? cred : undefined;
  }

  /**
   * Set credential for a provider.
   */
  async set(provider: string, credential: AuthCredential): Promise<void> {
    await withAuthFileLock(this.authPath, async () => {
      this.reload();
      this.data[provider] = credential;
      this.save();
    });
  }

  /**
   * Remove credential for a provider, including its account registry.
   * Clearing only the slot would leave the registry behind, and the next
   * load's migration would heal the slot back from it — resurrecting the
   * provider the caller just signed out.
   */
  async remove(provider: string): Promise<void> {
    await withAuthFileLock(this.authPath, async () => {
      this.reload();
      delete this.data[provider];
      const prefix = this.accountPrefixFor(provider);
      for (const key of Object.keys(this.data)) {
        if (key.startsWith(prefix)) delete this.data[key];
      }
      this.save();
    });
  }

  /**
   * List all providers with credentials.
   */
  list(): string[] {
    return Object.keys(this.data);
  }

  /**
   * Check if credentials exist for a provider.
   */
  has(provider: string): boolean {
    return provider in this.data;
  }

  /**
   * Check if logged in via OAuth for a provider.
   */
  isLoggedIn(provider: string): boolean {
    const cred = this.data[provider];
    return cred?.type === 'oauth';
  }

  /**
   * Check if a stored API key exists for a provider.
   * Keys are stored under `apikey:<provider>` in auth.json.
   */
  hasStoredApiKey(provider: string): boolean {
    const cred = this.data[`apikey:${provider}`];
    return cred?.type === 'api_key' && cred.key.length > 0;
  }

  /**
   * Get a stored API key for a provider, if any.
   */
  getStoredApiKey(provider: string): string | undefined {
    const cred = this.data[`apikey:${provider}`];
    return cred?.type === 'api_key' && cred.key.length > 0 ? cred.key : undefined;
  }

  /**
   * Store an API key for a provider.
   * Also sets the corresponding environment variable so model resolution can find it.
   */
  async setStoredApiKey(provider: string, key: string, envVar?: string): Promise<void> {
    await this.set(`apikey:${provider}`, { type: 'api_key', key });
    if (envVar) {
      process.env[envVar] = key;
    }
  }

  /**
   * Load all stored API keys into process.env.
   * Called at startup so model resolution can find stored keys.
   * Only sets env vars that aren't already set (env vars take precedence).
   */
  loadStoredApiKeysIntoEnv(providerEnvVars: Record<string, string | undefined>): void {
    for (const [key, cred] of Object.entries(this.data)) {
      if (!key.startsWith('apikey:') || cred.type !== 'api_key' || !cred.key) continue;
      const provider = key.substring('apikey:'.length);
      const envVar = providerEnvVars[provider];
      if (envVar && !process.env[envVar]) {
        process.env[envVar] = cred.key;
      }
    }
  }

  /**
   * Login to an OAuth provider. Resolves to the registered account record.
   * Pass `activate: false` to add the account without making it active (the
   * first account for a provider is always activated — a provider with
   * accounts must have an active one).
   */
  async login(
    providerId: OAuthProviderId,
    callbacks: OAuthLoginCallbacks,
    opts?: { replaceAccountId?: string; activate?: boolean },
  ): Promise<OAuthAccountRecord> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const credentials = await provider.login(callbacks);
    if (callbacks.signal?.aborted) {
      throw new Error('Login cancelled');
    }
    // Route through the account registry: the new account is appended (or
    // updated in place — by id collision or an explicit replaceAccountId for
    // re-authentication) and becomes the active account unless activate:false.
    return this.addAccount(providerId, credentials, { ...opts, signal: callbacks.signal });
  }

  /**
   * Logout from a provider: remove the legacy slot and every registered account.
   */
  async logout(provider: string): Promise<void> {
    await this.remove(provider);
  }

  // ---------------------------------------------------------------------------
  // Multi-account registry
  // ---------------------------------------------------------------------------

  private accountPrefixFor(providerId: string): string {
    return `accounts:${providerId}:`;
  }

  private accountKeyFor(id: string): string {
    return `accounts:${id}`;
  }

  /** Registry entries for a provider in JSON insertion order (malformed values skipped). */
  private accountEntries(providerId: string): OAuthAccountRecord[] {
    const prefix = this.accountPrefixFor(providerId);
    const out: OAuthAccountRecord[] = [];
    for (const [key, value] of Object.entries(this.data)) {
      if (key.startsWith(prefix) && isOAuthAccountRecord(value)) out.push(value);
    }
    return out;
  }

  /** Adopt a legacy slot credential as the registry's first active entry. */
  private adoptSlot(providerId: string, slot: OAuthCredential): OAuthAccountRecord {
    const provider = getOAuthProvider(providerId);
    const identity = providerIdentity(provider, slot);
    // Until the first locked write persists the adopted entry, independent
    // AuthStorage instances must derive the same provisional ID from the same
    // legacy slot. Prefer provider identity (stable across refreshes); use the
    // refresh token only for providers that expose no stable identity. Once
    // written, the ID remains a normal opaque, persistent registry ID.
    const adoptionKey = identity ? `identity:${identity}` : `refresh:${slot.refresh}`;
    const id = `${providerId}:${createHash('sha256').update(adoptionKey).digest('hex')}`;
    const record: OAuthAccountRecord = {
      ...slot,
      type: 'oauth-account',
      id,
      ...(identity ? { identity } : {}),
      label: `${provider?.name ?? providerId} account 1`,
      addedAt: new Date().toISOString(),
      active: true,
    };
    this.data[this.accountKeyFor(id)] = record;
    return record;
  }

  /**
   * Registered OAuth accounts for a provider, in insertion order. Copies —
   * callers cannot corrupt unsaved storage state by mutating a record.
   */
  listAccounts(providerId: string): OAuthAccountRecord[] {
    return this.accountEntries(providerId).map(entry => ({ ...entry }));
  }

  /**
   * The provider's active registry entry, if a registry exists. A copy.
   */
  getActiveAccount(providerId: string): OAuthAccountRecord | undefined {
    const active = this.accountEntries(providerId).find(entry => entry.active);
    return active ? { ...active } : undefined;
  }

  /**
   * Register OAuth credentials as an account for a provider, making it active
   * unless `activate: false` is passed.
   *
   * With `replaceAccountId` (re-authentication of a picked account), the
   * target entry's tokens are replaced in place — id re-keyed to the new
   * refresh-token hash, label/position/addedAt preserved — because providers
   * rotate refresh tokens per authorization, so the picked account's old id
   * never matches the new token hash. Re-authentication keeps the target's
   * active state: an inactive account stays inactive and the currently active
   * account keeps the legacy slot. Otherwise, when the new credentials
   * hash to an existing entry's id (same refresh token), that entry is
   * updated in place; a genuinely new account is appended and activated.
   *
   * `activate: false` only applies to the plain add path: the new/updated entry
   * keeps the active state it had, and the previously active account stays
   * active. The first account of a provider is activated regardless.
   */
  async addAccount(
    providerId: string,
    creds: OAuthCredentials,
    opts?: { label?: string; replaceAccountId?: string; activate?: boolean; signal?: AbortSignal },
  ): Promise<OAuthAccountRecord> {
    const provider = getOAuthProvider(providerId);
    const identity = providerIdentity(provider, creds);
    // Keep provider/network work outside the auth-file lock. The critical
    // section reloads the latest file before applying this login transaction.
    const label = opts?.label ?? (opts?.replaceAccountId ? null : await provider?.getAccountLabel?.(creds)) ?? null;
    return withAuthFileLock(this.authPath, async () => {
      if (opts?.signal?.aborted) throw new Error('Login cancelled');
      this.reload();
      const entries = this.accountEntries(providerId);

      if (opts?.replaceAccountId) {
        const target = entries.find(entry => entry.id === opts.replaceAccountId);
        if (!target) {
          throw new Error(`No account ${opts.replaceAccountId} for provider ${providerId}`);
        }
        const accountIdentity = identity ?? target.identity;
        // Re-authentication updates the account in place and **keeps its id**:
        // ids are minted once and never derived from credentials (A13), so the
        // entry's insertion position, the settings routing preference and any
        // thread routing state that name this id all stay valid.
        //
        // A stale entry for the *same* subscription is dropped in favor of the
        // picked account. Same-subscription is a matching stable identity, or —
        // for a registry written before A13, whose ids were the refresh-token
        // hash — the credentials' own legacy id, or an entry already holding
        // exactly these credentials (a re-authorization that returns the same
        // tokens, the only signal an identity-less provider gives). The survivor
        // inherits the collided entry's active state, so re-authenticating an
        // inactive account onto the active account's credentials cannot leave the
        // registry with no active entry.
        const legacyId = legacyAccountIdFor(providerId, creds.refresh);
        const collided = entries.find(
          entry =>
            entry.id !== target.id &&
            ((accountIdentity !== undefined && entry.identity === accountIdentity) ||
              entry.id === legacyId ||
              entry.refresh === creds.refresh),
        );
        // Credential metadata (device id, enterprise URL, …) follows the tokens:
        // when the fresh response omits a field, the collided entry's value is the
        // coherent fallback, not the target's — pairing fresh tokens with another
        // subscription's stale endpoint would misroute requests. Fresh `creds`
        // win last; only the target's registry metadata (id, label, addedAt)
        // carries over.
        const replacement: OAuthAccountRecord = {
          ...target,
          ...(collided ? credentialFieldsOf(collided) : {}),
          ...creds,
          type: 'oauth-account',
          ...(accountIdentity ? { identity: accountIdentity } : {}),
          label: opts.label ?? target.label,
        };
        const rebuilt: AuthStorageData = {};
        for (const [key, value] of Object.entries(this.data)) {
          if (key === this.accountKeyFor(target.id)) {
            rebuilt[key] = collided?.active ? { ...replacement, active: true } : replacement;
          } else if (collided && key === this.accountKeyFor(collided.id)) {
            continue;
          } else {
            rebuilt[key] = value;
          }
        }
        this.data = rebuilt;
        // Re-authentication preserves the account's active state: fixing a
        // secondary account's tokens must not hijack the active slot. The target
        // is activated when it was already active, when the entry it collided
        // with was active, or when the provider has no active account at all
        // (first account, or a self-healed gap).
        const wasActive =
          target.active === true ||
          collided?.active === true ||
          entries.some(entry => entry.active && entry.id !== target.id) === false;
        if (wasActive) {
          const activated = this.activateInMemory(providerId, target.id);
          if (!activated) {
            throw new Error(`Failed to activate account ${target.id} for provider ${providerId}`);
          }
          this.save();
          return activated;
        }
        // Inactive target: tokens stay on the registry entry, the legacy slot
        // keeps the currently active account's credential untouched.
        const replacementEntry = this.accountEntries(providerId).find(entry => entry.id === target.id);
        if (!replacementEntry) {
          throw new Error(`Failed to store account ${target.id} for provider ${providerId}`);
        }
        this.save();
        return replacementEntry;
      }

      const freshEntries = this.accountEntries(providerId);

      // Is this a subscription we already hold? Match the provider's stable
      // account identity where it exposes one, then the pre-A13 id (the
      // refresh-token hash) so a pre-A13 registry still updates its entry rather
      // than gaining a second one for the same subscription, and finally an
      // entry already holding these exact credentials (a re-add of the same
      // account as returned, which is the only signal an identity-less provider
      // such as Anthropic gives us — a provider that cannot name its accounts
      // cannot say "this is the same subscription, re-authorized").
      //
      // Crucially this must not re-derive the id of a *minted* entry: after a
      // refresh such an entry's id no longer hashes its current token, and
      // treating that miss as "new account" is exactly how re-adding a
      // subscription used to create a duplicate entry for it.
      const legacyId = legacyAccountIdFor(providerId, creds.refresh);
      const existing =
        (identity ? freshEntries.find(entry => entry.identity === identity) : undefined) ??
        freshEntries.find(entry => entry.id === legacyId) ??
        freshEntries.find(entry => entry.refresh === creds.refresh);
      const id = existing?.id ?? mintAccountId(providerId);
      if (existing) {
        this.data[this.accountKeyFor(id)] = {
          ...existing,
          ...creds,
          type: 'oauth-account',
          id,
          ...(identity ? { identity } : {}),
          active: existing.active,
        };
      } else {
        const resolvedLabel = label ?? `${provider?.name ?? providerId} account ${freshEntries.length + 1}`;
        this.data[this.accountKeyFor(id)] = {
          type: 'oauth-account',
          id,
          ...(identity ? { identity } : {}),
          label: resolvedLabel,
          addedAt: new Date().toISOString(),
          active: false,
          ...creds,
        };
      }

      // activate:false (add-another): keep the current active account. The
      // first account of a provider always activates — a non-empty registry
      // must have an active entry. An id collision with the already-active
      // entry also falls through to activateInMemory so its fresh tokens move
      // into the legacy slot (tokens are single-homed).
      if (opts?.activate === false && freshEntries.length > 0 && !existing?.active) {
        this.save();
        return { ...(this.data[this.accountKeyFor(id)] as OAuthAccountRecord) };
      }

      const activated = this.activateInMemory(providerId, id);
      if (!activated) {
        throw new Error(`Failed to activate account ${id} for provider ${providerId}`);
      }
      this.save();
      return activated;
    });
  }

  /**
   * Activate an account: move the active tokens out of the legacy slot back
   * into the previously active entry, and the target's tokens into the slot
   * (never copy — one home per token set). With no `instanceId`, rotate to
   * the next entry in insertion order, wrapping once to the front; returns
   * undefined when there is no other entry to rotate to.
   */
  async activateAccount(providerId: string, instanceId?: string): Promise<OAuthAccountRecord | undefined> {
    return withAuthFileLock(this.authPath, async () => {
      this.reload();
      const activated = this.activateInMemory(providerId, instanceId);
      if (activated) this.save();
      return activated;
    });
  }

  /**
   * Activate an account in memory only — the caller owns reload/save. Move the
   * active tokens out of the legacy slot back into the previously active
   * entry, and the target's tokens into the slot (never copy — one home per
   * token set). With no `instanceId`, rotate to the next entry in insertion
   * order, wrapping once to the front; returns undefined when there is no
   * other entry to rotate to.
   */
  private activateInMemory(providerId: string, instanceId?: string): OAuthAccountRecord | undefined {
    const entries = this.accountEntries(providerId);
    if (entries.length === 0) return undefined;

    let target: OAuthAccountRecord | undefined;
    if (instanceId !== undefined) {
      target = entries.find(entry => entry.id === instanceId);
      if (!target) return undefined;
    } else {
      if (entries.length <= 1) return undefined;
      const currentIdx = entries.findIndex(entry => entry.active);
      const candidates =
        currentIdx >= 0 ? [...entries.slice(currentIdx + 1), ...entries.slice(0, currentIdx)] : [...entries];
      target = candidates[0]!;
    }
    if (!target) return undefined;

    const slot = this.data[providerId];
    const current = entries.find(entry => entry.active && entry.id !== target.id);

    // Move the slot's tokens back onto the previously active entry. Skipped
    // when the target is already active — its (possibly re-authenticated)
    // entry already holds the freshest tokens.
    if (current && slot?.type === 'oauth') {
      const { type: _type, ...slotCreds } = slot;
      this.data[this.accountKeyFor(current.id)] = { ...current, ...slotCreds, type: 'oauth-account', active: false };
    }

    // Move the target's tokens into the legacy slot. The slot is rebuilt from
    // the target's own credentials only: carrying fields over from the
    // previously active account would pair this account's tokens with that
    // account's metadata (`deviceId`, `enterpriseUrl`, account id), and the
    // providers read those fields off the slot.
    this.data[providerId] = { ...credentialFieldsOf(target), type: 'oauth' };

    // Exactly the target stays active (self-heals multi-active states).
    this.data[this.accountKeyFor(target.id)] = { ...target, active: true };
    for (const entry of entries) {
      if (entry.id === target.id || entry.id === current?.id) continue;
      if (entry.active) {
        this.data[this.accountKeyFor(entry.id)] = { ...entry, active: false };
      }
    }

    return { ...target, active: true };
  }

  /**
   * Remove an account from the registry. If it was active, the next entry in
   * insertion order is activated; when it was the last one, the legacy slot
   * is removed too (full sign-out for that provider).
   */
  async removeAccount(providerId: string, instanceId: string): Promise<void> {
    await withAuthFileLock(this.authPath, async () => {
      this.reload();
      const entries = this.accountEntries(providerId);
      const target = entries.find(entry => entry.id === instanceId);
      if (!target) return;

      const wasActive = target.active;
      delete this.data[this.accountKeyFor(instanceId)];

      if (wasActive) {
        const idx = entries.indexOf(target);
        const next = entries[idx + 1] ?? entries.find(entry => entry.id !== instanceId);
        if (next) {
          // The removed account's tokens die with it — only move tokens in.
          this.data[providerId] = { type: 'oauth', ...credentialFieldsOf(next) };
          this.data[this.accountKeyFor(next.id)] = { ...next, active: true };
          for (const entry of entries) {
            if (entry.id === next.id || entry.id === instanceId) continue;
            if (entry.active) {
              this.data[this.accountKeyFor(entry.id)] = { ...entry, active: false };
            }
          }
        } else {
          delete this.data[providerId];
        }
      }

      this.save();
    });
  }

  /**
   * Rename an account's label.
   */
  async renameAccount(providerId: string, instanceId: string, label: string): Promise<void> {
    await withAuthFileLock(this.authPath, async () => {
      this.reload();
      const key = this.accountKeyFor(instanceId);
      const entry = this.data[key];
      if (!isOAuthAccountRecord(entry)) return;
      this.data[key] = { ...entry, label };
      this.save();
    });
  }

  /**
   * Persist refreshed credentials for the account that initiated the refresh.
   * The legacy slot is updated only if that account is still active when the
   * refresh completes; otherwise a delayed refresh could overwrite a newer
   * activation.
   */
  private persistRefreshedCredential(
    providerId: string,
    instanceId: string | undefined,
    creds: OAuthCredentials,
  ): void {
    // Every caller reloads the latest snapshot after acquiring withAuthFileLock.
    // Do not reload again here: writing must use the exact account selected
    // from that locked snapshot, not a newly migrated in-memory snapshot.
    if (instanceId) {
      const key = this.accountKeyFor(instanceId);
      const entry = this.data[key];
      if (!isOAuthAccountRecord(entry)) return;
      this.data[key] = { ...entry, ...creds, type: 'oauth-account' };
      if (entry.active) {
        const slot = this.data[providerId];
        this.data[providerId] =
          slot?.type === 'oauth' ? { ...slot, ...creds, type: 'oauth' } : { type: 'oauth', ...creds };
      }
    } else {
      const slot = this.data[providerId];
      this.data[providerId] =
        slot?.type === 'oauth' ? { ...slot, ...creds, type: 'oauth' } : { type: 'oauth', ...creds };
    }
    this.save();
  }

  /** Read the selected account without substituting the current active account. */
  private selectedCredential(providerId: string, instanceId?: string): OAuthRefreshResult | undefined {
    const entry = instanceId
      ? this.accountEntries(providerId).find(account => account.id === instanceId)
      : this.getActiveAccount(providerId);
    const slot = this.get(providerId);
    if (!entry) {
      if (instanceId || slot?.type !== 'oauth') return undefined;
      const { type: _type, ...credentials } = slot;
      return { credentials };
    }
    let credentials = credentialFieldsOf(entry);
    if (entry.active && slot?.type === 'oauth' && slot.refresh === entry.refresh) {
      const { type: _type, ...slotCredentials } = slot;
      credentials = { ...credentials, ...slotCredentials };
    }
    return { credentials, accountInstanceId: entry.id };
  }

  /** Bounded owners reserve commit exclusion before spending a refresh token. */
  private async refreshCredential(
    providerId: string,
    instanceId?: string,
    forceBaseline?: OAuthCredentials,
    signal?: AbortSignal,
  ): Promise<OAuthRefreshResult | undefined> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return undefined;
    const lockId = createHash('sha256')
      .update(JSON.stringify([providerId, instanceId ?? null]))
      .digest('hex');
    return withAuthFileLock(
      `${this.authPath}.refresh-${lockId}`,
      async () => {
        const commit = (selected: OAuthRefreshResult, fresh: OAuthCredentials) => {
          this.reload();
          const current = this.selectedCredential(providerId, selected.accountInstanceId);
          if (!current) return undefined;
          if (!sameOAuthCredentials(current.credentials, selected.credentials)) return current;
          this.persistRefreshedCredential(providerId, selected.accountInstanceId, fresh);
          return { credentials: fresh, accountInstanceId: selected.accountInstanceId };
        };
        if (signal) {
          return withAuthFileLock(
            this.authPath,
            async () => {
              this.reload();
              const selected = this.selectedCredential(providerId, instanceId);
              if (!selected) return undefined;
              if (
                forceBaseline
                  ? !sameOAuthCredentials(selected.credentials, forceBaseline)
                  : Date.now() < selected.credentials.expires
              )
                return selected;
              signal.throwIfAborted();
              const fresh = await provider.refreshToken(selected.credentials, { signal });
              // Once a single-use grant succeeds, commit under the reservation
              // before observing cancellation or releasing either owned lock.
              return commit(selected, fresh);
            },
            signal,
          );
        }
        const selected = await withAuthFileLock(
          this.authPath,
          () => {
            this.reload();
            return this.selectedCredential(providerId, instanceId);
          },
          signal,
        );
        if (!selected) return undefined;
        if (
          forceBaseline
            ? !sameOAuthCredentials(selected.credentials, forceBaseline)
            : Date.now() < selected.credentials.expires
        )
          return selected;

        const fresh = await provider.refreshToken(selected.credentials);
        // A successful single-use token rotation must be persisted even if its
        // requesting command was cancelled immediately after the HTTP response.
        return withAuthFileLock(this.authPath, () => commit(selected, fresh));
      },
      signal,
    );
  }

  /**
   * Refresh one account instance through the per-instance dedupe map. Used
   * for sibling refreshes during the rotation walk, so a concurrent
   * `getApiKey` that reloads storage mid-walk (after the candidate was
   * activated but before its refresh resolves) joins the same refresh
   * instead of double-spending a single-use refresh token.
   */
  private async refreshInstance(
    providerId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<OAuthRefreshResult | undefined> {
    const provider = getOAuthProvider(providerId);
    if (!provider) return undefined;
    const refreshKey = `${providerId}:${instanceId}`;
    const pending = this.refreshPromises.get(refreshKey);
    if (pending) return waitForAcquisition(pending, signal);
    const refresh = (async () => {
      try {
        return await this.refreshCredential(providerId, instanceId, undefined, signal);
      } catch {
        // The shared producer keeps the native undefined-on-failure contract.
        // Its owner observes cancellation only after settlement and unlock.
        return undefined;
      }
    })();
    this.refreshPromises.set(refreshKey, refresh);
    const cleanup = () => {
      this.refreshPromises.delete(refreshKey);
    };
    void refresh.then(cleanup, cleanup);
    const result = await refresh;
    signal?.throwIfAborted();
    return result;
  }

  /**
   * Get a ready-to-use OAuth credential snapshot, auto-refreshing if needed.
   * A failed refresh leaves the active account unchanged and returns undefined;
   * the account-rotation processor owns switching so it can persist a visible
   * account-switch notice with the request that triggered the change.
   */
  async getOAuthCredential(
    providerId: string,
    accountInstanceId?: string,
    options?: OAuthCredentialAcquisitionOptions,
  ): Promise<OAuthCredentialSnapshot | undefined> {
    // Only OpenAI's native refresh supports command-owned cancellation here.
    const signal = providerId === 'openai-codex' ? options?.signal : undefined;
    signal?.throwIfAborted();
    this.reload();
    const activeEntry = this.getActiveAccount(providerId);
    const selectedEntry = accountInstanceId
      ? this.accountEntries(providerId).find(entry => entry.id === accountInstanceId)
      : activeEntry;
    const slot = this.data[providerId];
    let credential: OAuthCredentials | undefined;
    if (selectedEntry) {
      const {
        type: _type,
        id: _id,
        label: _label,
        addedAt: _addedAt,
        active: _active,
        ...accountCredential
      } = selectedEntry;
      credential = accountCredential;
      // The active account's credentials live in both the legacy slot and its
      // registry entry, and a legacy writer (older build, another worktree) can
      // refresh the slot without rotating the refresh token. `migrate()` only
      // reconciles those when the refresh token changes, so the registry entry
      // can hold stale access/expiry. Prefer the slot for the active account
      // and keep the registry entry as the account identity.
      if (selectedEntry.active && slot?.type === 'oauth' && slot.refresh === selectedEntry.refresh) {
        const { type: _slotType, ...slotCredential } = slot;
        credential = { ...credential, ...slotCredential };
      }
    } else if (!accountInstanceId && slot?.type === 'oauth') {
      credential = slot;
    }
    if (!credential) return undefined;

    const provider = getOAuthProvider(providerId);
    if (!provider) return undefined;
    const selectedInstanceId = selectedEntry?.id;
    const toSnapshot = (
      credentials: OAuthCredentials,
      instanceId: string | undefined = selectedInstanceId,
    ): OAuthCredentialSnapshot => ({
      type: 'oauth',
      ...credentials,
      accountInstanceId: instanceId,
    });

    if (Date.now() < credential.expires) return toSnapshot(credential);

    if (selectedInstanceId) {
      const refreshed = await this.refreshInstance(providerId, selectedInstanceId, signal);
      return refreshed ? toSnapshot(refreshed.credentials, refreshed.accountInstanceId) : undefined;
    }

    const pendingRefresh = this.refreshPromises.get(providerId);
    const refresh =
      pendingRefresh ??
      (async (): Promise<OAuthRefreshResult | undefined> => {
        try {
          return await this.refreshCredential(providerId, undefined, undefined, signal);
        } catch {
          // Joined ordinary callers must not inherit the owner's abort reason.
          return undefined;
        }
      })();
    if (!pendingRefresh) {
      this.refreshPromises.set(providerId, refresh);
      const cleanup = () => this.refreshPromises.delete(providerId);
      void refresh.then(cleanup, cleanup);
    }
    const refreshed = pendingRefresh ? await waitForAcquisition(refresh, signal) : await refresh;
    signal?.throwIfAborted();
    return refreshed ? toSnapshot(refreshed.credentials, refreshed.accountInstanceId ?? selectedInstanceId) : undefined;
  }

  /** Get API key for a provider, refreshing OAuth tokens if needed. */
  async getApiKey(providerId: string, accountInstanceId?: string): Promise<string | undefined> {
    this.reload();
    const cred = this.data[providerId];
    // A provider slot holding an API key belongs to the provider, not to any one
    // subscription, so it is only the right credential for a request that did
    // not select an account. A routed request must resolve the account it asked
    // for — or nothing — rather than be served this key.
    if (accountInstanceId === undefined && cred?.type === 'api_key') return cred.key;

    const oauth = await this.getOAuthCredential(providerId, accountInstanceId);
    const provider = oauth ? getOAuthProvider(providerId) : undefined;
    return oauth && provider ? provider.getApiKey(oauth) : undefined;
  }

  /**
   * Force one refresh of the active OAuth account's tokens, regardless of
   * expiry. The account-rotation error processor calls this when a provider
   * rejects a not-yet-expired token (401/403) — server-side clock skew and
   * refresh-token races surface that way. Returns the fresh access token, or
   * undefined when the refresh fails or there is no OAuth credential.
   * Shares the per-instance refresh dedupe with `getApiKey`.
   */
  async forceRefreshActiveAccount(providerId: string, accountInstanceId?: string): Promise<string | undefined> {
    this.reload();
    const activeEntry = this.getActiveAccount(providerId);
    const selectedEntry = accountInstanceId
      ? this.accountEntries(providerId).find(entry => entry.id === accountInstanceId)
      : activeEntry;
    const slot = this.get(providerId);
    let cred: OAuthCredentials | undefined;
    if (selectedEntry) {
      const {
        type: _type,
        id: _id,
        label: _label,
        addedAt: _addedAt,
        active: _active,
        ...accountCredential
      } = selectedEntry;
      cred = accountCredential;
      // Match getOAuthCredential: a legacy writer can refresh the active slot
      // without rotating its refresh token, so the slot is the newest snapshot
      // for this same registered account.
      if (selectedEntry.active && slot?.type === 'oauth' && slot.refresh === selectedEntry.refresh) {
        const { type: _slotType, ...slotCredential } = slot;
        cred = { ...cred, ...slotCredential };
      }
    } else if (!accountInstanceId && slot?.type === 'oauth') {
      cred = slot;
    }
    if (!cred) return undefined;
    const provider = getOAuthProvider(providerId);
    if (!provider) return undefined;

    const refreshKey = selectedEntry ? `${providerId}:${selectedEntry.id}` : providerId;
    const pending = this.refreshPromises.get(refreshKey);
    const refresh =
      pending ??
      (async (): Promise<OAuthRefreshResult | undefined> => {
        try {
          return await this.refreshCredential(providerId, accountInstanceId ?? selectedEntry?.id, cred);
        } catch {
          return undefined;
        }
      })();
    if (!pending) this.refreshPromises.set(refreshKey, refresh);
    try {
      const result = await refresh;
      return result ? provider.getApiKey(result.credentials) : undefined;
    } finally {
      if (!pending) this.refreshPromises.delete(refreshKey);
    }
  }
}

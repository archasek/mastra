import type { ModelWithRetries } from '@mastra/core/agent';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { GatewayLanguageModel, MastraModelGatewayInterface } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import { getRequestAccountSelection, isRequestAccountRoutingExhausted } from '../auth/account-routing-context.js';
import { ProviderAuthRequiredError } from '../auth/provider-auth-error.js';
import type { CredentialStore, OAuthAccountRecord } from '../auth/types.js';
import { listBuiltinModePacks, resolveModePackFallbackChain } from '../onboarding/packs.js';
import type { ProviderAccess } from '../onboarding/packs.js';
import {
  findModePackForModel,
  loadSettings,
  resolveDefaultThinkingLevel,
  resolveModePackModels,
  stripMastraCodeCustomProviderPrefix,
} from '../onboarding/settings.js';
import { AMAZON_BEDROCK_GATEWAY_ID, createAmazonBedrockGateway } from '../providers/amazon-bedrock-gateway.js';
import type { AnthropicPromptCacheScope } from '../providers/anthropic-prompt-cache.js';
import { remapOpenAIModelForCodexOAuth } from '../providers/model-ids.js';
import { readCodexCatalog } from '../providers/openai-codex-catalog.js';
import { isThinkingLevelSetting } from '../thinking.js';
import type { ThinkingLevelSetting } from '../thinking.js';
import { getAppDataDir } from '../utils/project.js';
import { resolveCredentialStore } from './credential-resolver.js';
import { resolveCustomProviders } from './custom-provider-source.js';
import {
  MASTRA_GATEWAY_PREFIX,
  MASTRACODE_GATEWAY_ID,
  MastraCodeGateway,
  getGlobalAuthStorage,
  reloadAuthStorage,
  stripMastraGatewayPrefix,
} from './mastracode-gateway.js';
import type { MastraCodeGatewayOptions } from './mastracode-gateway.js';

export {
  getAnthropicApiKey,
  getOpenAIApiKey,
  MASTRACODE_GATEWAY_ID,
  MastraCodeGateway,
  remapOpenAIModelForCodexOAuth,
  resolveAuth,
} from './mastracode-gateway.js';
export type { MastraCodeCustomProvider, MastraCodeGatewayOptions } from './mastracode-gateway.js';
export {
  setCredentialStoreProvider,
  hasCredentialStoreProvider,
  resolveTenantFromRequestContext,
} from './credential-resolver.js';
export type { CredentialTenant, CredentialStoreProvider } from './credential-resolver.js';
export {
  setCustomProvidersSource,
  hasCustomProvidersSource,
  resolveCustomProviders,
} from './custom-provider-source.js';
export type { CustomProvidersSource } from './custom-provider-source.js';

type ResolvedModel = GatewayLanguageModel;
type ModelRequestHeaders = Record<string, string>;
const admittedNativeOAuth = new WeakSet<RequestContext>();

/** Restore native route authority for every request, including background wakes. */
export function withNativeOAuthRoute<T>(requestContext: RequestContext, resolve: () => T): T | Promise<T> {
  const controller = requestContext.get('controller') as AgentControllerRequestContext<any> | undefined;
  if (!controller?.getThreadSetting) return resolve();
  return (async () => {
    const savedRoute = await controller.getThreadSetting!('openaiAuthRoute');
    if (savedRoute === 'oauth' && controller.getState().openaiAuthRoute !== 'oauth') {
      await controller.setState({ openaiAuthRoute: 'oauth' });
    }
    admittedNativeOAuth.delete(requestContext);
    let result: T;
    let admitted = false;
    try {
      result = await resolve();
      admitted = admittedNativeOAuth.has(requestContext);
    } finally {
      admittedNativeOAuth.delete(requestContext);
    }
    // resolveModel records only successful local OAuth admission, not merely
    // global login presence or a gateway/tenant model selection.
    if (admitted && savedRoute !== 'oauth') {
      if (!controller.setThreadSetting)
        throw new ProviderAuthRequiredError('Native OAuth requires durable thread ownership.');
      await controller.setThreadSetting({ key: 'openaiAuthRoute', value: 'oauth' });
      await controller.setState({ openaiAuthRoute: 'oauth' });
    }
    return result;
  })();
}

function getAgentControllerHeaders(requestContext?: RequestContext): ModelRequestHeaders | undefined {
  const agentControllerContext = requestContext?.get('controller') as AgentControllerRequestContext<any> | undefined;
  const headers = {
    ...(agentControllerContext?.threadId ? { 'x-thread-id': agentControllerContext.threadId } : {}),
    ...(agentControllerContext?.resourceId ? { 'x-resource-id': agentControllerContext.resourceId } : {}),
  };

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function accountCredential(account: OAuthAccountRecord) {
  const { type: _type, id: _id, label: _label, addedAt: _addedAt, active: _active, ...credential } = account;
  return { type: 'oauth' as const, ...credential };
}

export function createRequestScopedCredentialStore(
  base: CredentialStore,
  requestContext?: RequestContext,
): CredentialStore {
  const selectedId = (providerId: string) => getRequestAccountSelection(requestContext, providerId);
  const selectedAccount = (providerId: string) => {
    const accountInstanceId = selectedId(providerId);
    return accountInstanceId
      ? base.listAccounts?.(providerId).find(account => account.id === accountInstanceId)
      : undefined;
  };
  // Routing rejected every account for this provider on this request. Fail
  // closed on every credential read: falling through to `base` would use the
  // provider's active account — the exhausted one routing just refused.
  const rejectAll = (providerId: string) => isRequestAccountRoutingExhausted(requestContext, providerId);

  return {
    allowEnvironmentFallback: base.allowEnvironmentFallback,
    reload: () => base.reload(),
    get: providerId => {
      if (rejectAll(providerId)) return undefined;
      // A selection that no longer resolves (the account was removed between
      // routing and the credential read) must not fall through to the active
      // account — that is the account routing deliberately passed over.
      const accountInstanceId = selectedId(providerId);
      if (accountInstanceId === undefined) return base.get(providerId);
      const selected = selectedAccount(providerId);
      return selected ? accountCredential(selected) : undefined;
    },
    getStoredApiKey: providerId => {
      if (rejectAll(providerId)) return undefined;
      // The provider-wide `apikey:` slot is never the credential routing
      // selected, so serving it to a routed request is an OAuth -> API-key
      // fallback of the same provider — the one combination this feature
      // forbids. Unlike `get`, this read has no account argument to pass
      // through, so a selection fails it closed instead.
      if (selectedId(providerId) !== undefined) return undefined;
      return base.getStoredApiKey(providerId);
    },
    getApiKey: providerId =>
      rejectAll(providerId) ? Promise.resolve(undefined) : base.getApiKey(providerId, selectedId(providerId)),
    getOAuthCredential: base.getOAuthCredential
      ? providerId =>
          rejectAll(providerId)
            ? Promise.resolve(undefined)
            : base.getOAuthCredential!(providerId, selectedId(providerId))
      : undefined,
    listAccounts: base.listAccounts ? providerId => base.listAccounts!(providerId) : undefined,
    getActiveAccount: base.getActiveAccount ? providerId => base.getActiveAccount!(providerId) : undefined,
    activateAccount: base.activateAccount
      ? (providerId, accountInstanceId) => base.activateAccount!(providerId, accountInstanceId)
      : undefined,
    removeAccount: base.removeAccount
      ? (providerId, accountInstanceId) => base.removeAccount!(providerId, accountInstanceId)
      : undefined,
  };
}

export function createMastraCodeGateway(options: MastraCodeGatewayOptions): MastraCodeGateway {
  return new MastraCodeGateway(options);
}

export function createMastraCodeModelCatalogProvider(gateway: MastraModelGatewayInterface) {
  return gateway instanceof MastraCodeGateway
    ? gateway.createModelCatalogProvider()
    : MastraCodeGateway.createModelCatalogProvider(gateway);
}

/**
 * Placeholder for future model ID normalization.
 * Currently returns the input unchanged, but exists as a seam
 * for aliasing, casing fixes, or validation in the future.
 */
export function resolveModelId(modelId: string): string {
  return modelId;
}

/**
 * Resolve a model ID to the correct provider instance.
 * Shared by the main agent, observer, and reflector.
 *
 * - For anthropic/* models: Uses stored OAuth credentials when present, otherwise direct API key
 * - For openai/* models: Uses OAuth when configured, otherwise direct API key from AuthStorage
 * - For moonshotai/* models: Uses Moonshot AI Anthropic-compatible endpoint
 * - For all other providers: Uses Mastra's model router (models.dev gateway)
 */
export function resolveModel(
  modelId: string,
  options?: {
    thinkingLevel?: ThinkingLevelSetting;
    remapForCodexOAuth?: boolean;
    requestContext?: RequestContext;
    anthropicPromptCacheScope?: AnthropicPromptCacheScope;
  },
): GatewayLanguageModel {
  reloadAuthStorage();
  const headers = getAgentControllerHeaders(options?.requestContext);
  const settings = loadSettings();
  // Bedrock was previously cataloged under the MastraCode gateway namespace
  // (`mastracode/amazon-bedrock/<model>`). Normalize any legacy saved ids to the
  // standalone `amazon-bedrock/<model>` form so they resolve through the
  // dedicated Bedrock gateway.
  const bedrockLegacyPrefix = `${MASTRACODE_GATEWAY_ID}/amazon-bedrock/`;
  const bedrockNormalizedInput = modelId.startsWith(bedrockLegacyPrefix)
    ? modelId.slice(MASTRACODE_GATEWAY_ID.length + 1)
    : modelId;
  // Deployed web registers a custom providers source (DB-backed, tenant
  // scoped); when registered it is authoritative and settings.json custom
  // providers are ignored. Undefined = local settings-based behavior.
  const customProviders = resolveCustomProviders(options?.requestContext) ?? settings.customProviders;
  // Ids selected from the shared /models catalog were previously persisted in
  // the gateway-qualified `mastracode/<customProviderId>/<model>` form, which
  // parses the provider as `mastracode` and breaks provider config lookup.
  // Normalize at resolution time (in addition to stripping at selection time)
  // so already-saved ids and any surface that persists the raw catalog id
  // still resolve to the custom provider.
  const normalizedInput = stripMastraCodeCustomProviderPrefix(bedrockNormalizedInput, customProviders);
  const isMastraGatewayModel = normalizedInput.startsWith(MASTRA_GATEWAY_PREFIX);
  const normalizedModelId = stripMastraGatewayPrefix(normalizedInput);
  const [providerId, ...modelParts] = normalizedModelId.split('/');
  const bareModelId = modelParts.join('/');
  if (!providerId || !bareModelId) {
    throw new Error(`Invalid model id: ${modelId}`);
  }

  if (providerId === AMAZON_BEDROCK_GATEWAY_ID) {
    const bedrockGateway = createAmazonBedrockGateway();
    const routerId = `${AMAZON_BEDROCK_GATEWAY_ID}/${bareModelId}`;
    const auth = bedrockGateway.resolveAuth({
      gatewayId: AMAZON_BEDROCK_GATEWAY_ID,
      providerId: AMAZON_BEDROCK_GATEWAY_ID,
      modelId: bareModelId,
      routerId,
    });
    return bedrockGateway.resolveLanguageModel({
      providerId: AMAZON_BEDROCK_GATEWAY_ID,
      modelId: bareModelId,
      apiKey: auth?.apiKey ?? '',
      headers,
    });
  }

  const routerId = `${MASTRACODE_GATEWAY_ID}/${normalizedModelId}`;

  const mgApiKey = MastraCodeGateway.getMastraGatewayApiKey();
  const rawGatewayBase =
    settings.memoryGateway?.baseUrl ?? process.env['MASTRA_GATEWAY_URL'] ?? 'https://gateway-api.mastra.ai';
  // Deployed web registers a per-tenant credential store provider; when the
  // request carries an authenticated tenant, resolve credentials through the
  // caller's own store (user > org > env). Undefined = global AuthStorage.
  const tenantCredentialStore = resolveCredentialStore(options?.requestContext);
  const baseCredentialStore = tenantCredentialStore ?? getGlobalAuthStorage();
  let credentialStore = createRequestScopedCredentialStore(baseCredentialStore, options?.requestContext);
  const controllerContext = options?.requestContext?.get('controller') as
    | AgentControllerRequestContext<any>
    | undefined;
  const ownsOAuthRoute =
    controllerContext?.getState?.().openaiAuthRoute === 'oauth' ||
    getRequestAccountSelection(options?.requestContext, 'openai-codex') !== undefined ||
    isRequestAccountRoutingExhausted(options?.requestContext, 'openai-codex');
  if (
    !tenantCredentialStore &&
    providerId === 'openai' &&
    !(mgApiKey && isMastraGatewayModel) &&
    ownsOAuthRoute &&
    credentialStore.get('openai-codex')?.type !== 'oauth'
  ) {
    // A missing selected account is not permission to spend an environment key.
    throw new ProviderAuthRequiredError('OpenAI Codex OAuth is required for the selected account.');
  }
  // Only the local native OAuth route owns this account-scoped cache. Tenant
  // stores and an explicitly selected gateway retain their existing contract.
  if (
    !tenantCredentialStore &&
    providerId === 'openai' &&
    !(mgApiKey && isMastraGatewayModel) &&
    credentialStore.get('openai-codex')?.type === 'oauth'
  ) {
    const scoped = credentialStore;
    const assertAdmission = (accountId: unknown, accountInstanceId: string | undefined) => {
      const appDataDir = getAppDataDir({ create: false });
      let catalog = readCodexCatalog(appDataDir, Date.now(), accountInstanceId);
      // Native storage adopts legacy auth in memory without persisting its
      // provisional ID. Only an unrouted active legacy request may use that
      // verified legacy scope; a deleted explicit selection never falls back.
      if (
        catalog.status !== 'ready' &&
        getRequestAccountSelection(options?.requestContext, 'openai-codex') === undefined &&
        baseCredentialStore.getActiveAccount?.('openai-codex')?.id === accountInstanceId
      ) {
        const legacy = readCodexCatalog(appDataDir, Date.now());
        if (legacy.status === 'ready' && legacy.scope.kind === 'legacy') catalog = legacy;
      }
      const nativeId = stripMastraGatewayPrefix(remapOpenAIModelForCodexOAuth(normalizedModelId));
      if (
        catalog.status !== 'ready' ||
        !catalog.models.includes(nativeId) ||
        catalog.scope.accountId !== accountId ||
        (catalog.scope.kind === 'registered' && catalog.scope.accountInstanceId !== accountInstanceId)
      ) {
        throw new ProviderAuthRequiredError(
          'OpenAI Codex model is unavailable for the selected account. Refresh the Mastra Code model catalog.',
        );
      }
    };
    const selected =
      getRequestAccountSelection(options?.requestContext, 'openai-codex') ??
      baseCredentialStore.getActiveAccount?.('openai-codex')?.id;
    const credential = scoped.get('openai-codex');
    if (credential?.type === 'oauth') assertAdmission(credential.accountId, selected);
    if (options?.requestContext) admittedNativeOAuth.add(options.requestContext);
    credentialStore = {
      ...scoped,
      getOAuthCredential: async provider => {
        const snapshot = await scoped.getOAuthCredential?.(provider);
        if (provider === 'openai-codex') {
          if (!snapshot) throw new ProviderAuthRequiredError('OpenAI Codex OAuth is required for this request.');
          assertAdmission(snapshot.accountId, snapshot.accountInstanceId);
        }
        return snapshot;
      },
    };
  }
  const gateway = createMastraCodeGateway({
    mastraGatewayBaseUrl: rawGatewayBase.replace(/\/+$/, '').replace(/\/v1$/, ''),
    mastraGatewayApiKey: mgApiKey,
    routeThroughMastraGateway: Boolean(mgApiKey && isMastraGatewayModel),
    thinkingLevel: options?.thinkingLevel,
    anthropicPromptCacheScope: options?.anthropicPromptCacheScope,
    customProviders,
    credentialStore,
  });

  const auth = gateway.resolveAuth({
    gatewayId: MASTRACODE_GATEWAY_ID,
    providerId,
    modelId: bareModelId,
    routerId,
  });

  if (!auth && credentialStore?.allowEnvironmentFallback === false) {
    throw new ProviderAuthRequiredError(
      `No usable ${providerId} credential is configured for this signed-in Factory account. Connect the provider or add an organization credential, then try again.`,
    );
  }

  return gateway.resolveLanguageModel({
    providerId,
    modelId: bareModelId,
    apiKey: auth?.apiKey ?? '',
    headers,
  });
}

export interface ThinkingRequestContext {
  state?: { thinkingLevel?: unknown };
  session?: { modeId?: string };
}
/**
 * Resolve the effective thinking level for the current request.
 *
 * Precedence:
 *   1. Session override (`state.thinkingLevel`, set via /think or the session
 *      settings panel).
 *   2. Per-mode default from settings (`models.modeThinkingDefaults[mode]`).
 *   3. Global default (`preferences.thinkingLevel`).
 *
 * Resolved per-request (not seeded at session start) so configuration changes
 * apply to the next request of every session — including automated
 * (rule-driven) Factory runs that nobody ever opens interactively.
 */

export function resolveRequestThinkingLevel(
  agentControllerContext: ThinkingRequestContext | undefined,
  settingsPath?: string,
): ThinkingLevelSetting {
  const override = agentControllerContext?.state?.thinkingLevel;
  if (isThinkingLevelSetting(override)) return override;
  const modeId = agentControllerContext?.session?.modeId;
  return resolveDefaultThinkingLevel(loadSettings(settingsPath), modeId).level;
}

/** Structural pack shape for fallback resolution (custom pack models are partial by nature). */
export interface ResolvableModePack {
  id: string;
  name: string;
  models: Record<string, string>;
}

/** All packs a fallback chain may reference: every builtin plus saved customs. */
export function listResolvableModePacks(
  settings: ReturnType<typeof loadSettings>,
  access: Partial<ProviderAccess> = {},
): ResolvableModePack[] {
  return [
    ...listBuiltinModePacks(access),
    ...settings.customModelPacks.map(pack => ({
      id: `custom:${pack.name}`,
      name: pack.name,
      models: { ...pack.models },
    })),
  ];
}

export function requestPackAccess(
  requestContext?: RequestContext,
  fallbackStore?: CredentialStore,
): Partial<ProviderAccess> {
  const base = resolveCredentialStore(requestContext) ?? fallbackStore ?? getGlobalAuthStorage();
  base.reload();
  const credentials = createRequestScopedCredentialStore(base, requestContext);
  // Exhaustion/removal denies credentials, not the request's declared route.
  // Otherwise a fallback built after exhaustion could switch back to API-key
  // pack defaults even though this request still belongs to OAuth.
  const routedOAuth =
    getRequestAccountSelection(requestContext, 'openai-codex') !== undefined ||
    isRequestAccountRoutingExhausted(requestContext, 'openai-codex');
  return { openai: routedOAuth || credentials.get('openai-codex')?.type === 'oauth' ? 'oauth' : 'apikey' };
}

/**
 * Dynamic model function that reads the current model from controller state.
 * This allows runtime model switching via the /models picker.
 *
 * When the session's model came from a pack with a fallback chain configured
 * (`settings.models.packFallbacks`), returns core's `ModelWithRetries[]`
 * fallback array instead of a bare model: the active pack's model first, then
 * each fallback pack's model for the same mode. Core advances the array when
 * the error processors decline to retry (pool exhausted / persistent outage —
 * see AccountRotationProcessor). Entry ids are unique per occurrence — the
 * one allowed revisit of a pack gets `<packId>#2` — because core re-resolves
 * the active fallback index by id across agentic steps.
 */
export function getDynamicModel(
  { requestContext }: { requestContext: RequestContext },
  settingsPath?: string,
): ResolvedModel | ModelWithRetries[] {
  const agentControllerContext = requestContext.get('controller') as AgentControllerRequestContext<any> | undefined;

  const controllerState = agentControllerContext?.getState?.() as
    | {
        activeModelPackId?: unknown;
        mastracodePendingPackFallback?: { toPackId?: unknown; toModelId?: unknown; threadId?: unknown } | null;
      }
    | undefined;
  const pendingState = controllerState?.mastracodePendingPackFallback;
  const pendingFallback =
    pendingState &&
    (pendingState.threadId === undefined ||
      (typeof pendingState.threadId === 'string' && pendingState.threadId === agentControllerContext?.threadId))
      ? pendingState
      : undefined;
  const pendingModelId =
    pendingFallback && typeof pendingFallback.toModelId === 'string' && pendingFallback.toModelId.length > 0
      ? pendingFallback.toModelId
      : undefined;
  const modelId = pendingModelId ?? agentControllerContext?.session?.modelId;
  if (!modelId) {
    // A missing controller context means the run was started without session
    // request context at all (e.g. a signal delivered to an idle thread) —
    // "use /models" would mislead there, the user's selection was never the
    // problem.
    if (!agentControllerContext) {
      throw new Error(
        'No model available: this run started without a controller session context, so no model selection could be resolved.',
      );
    }
    throw new Error('No model selected. Use /models to select a model first.');
  }

  const thinkingLevel = resolveRequestThinkingLevel(agentControllerContext, settingsPath);
  const resolveOptions = { thinkingLevel, remapForCodexOAuth: true, requestContext } as const;
  const primary = resolveModel(modelId, resolveOptions);

  const settings = loadSettings(settingsPath);
  // `models?` tolerates partial settings mocks; loaded settings always carry it.
  const fallbacks = settings.models?.packFallbacks ?? {};
  if (Object.keys(fallbacks).length === 0) return primary;

  const modeId = agentControllerContext?.session?.modeId ?? 'build';
  const packs = listResolvableModePacks(settings, requestPackAccess(requestContext));
  const pendingPackId =
    pendingFallback && typeof pendingFallback.toPackId === 'string' && pendingFallback.toPackId.length > 0
      ? pendingFallback.toPackId
      : undefined;
  const statePackId = pendingPackId ?? controllerState?.activeModelPackId ?? settings.models.activeModelPackId;
  const activePack = findModePackForModel(
    settings,
    packs,
    modelId,
    modeId,
    typeof statePackId === 'string' ? statePackId : undefined,
  );
  if (!activePack) return primary;

  const chain = resolveModePackFallbackChain(fallbacks, activePack.id, settings.customModelPacks);
  if (chain.length < 2) return primary;

  const entries: ModelWithRetries[] = [{ id: activePack.id, model: primary }];
  const appearances = new Map<string, number>([[activePack.id, 1]]);
  for (const packId of chain.slice(1)) {
    const pack = packs.find(candidate => candidate.id === packId);
    if (!pack) break;
    const entryModelId = resolveModePackModels(settings, pack)[modeId];
    if (!entryModelId) break;
    // Best-effort resolution: an unresolvable fallback (e.g. unconnected
    // provider in deployed fail-closed mode) truncates the chain here rather
    // than failing the request before the primary is ever tried.
    let entryModel: ResolvedModel;
    try {
      entryModel = resolveModel(entryModelId, resolveOptions);
    } catch {
      break;
    }
    const occurrence = (appearances.get(packId) ?? 0) + 1;
    appearances.set(packId, occurrence);
    entries.push({
      id: occurrence === 1 ? packId : `${packId}#${occurrence}`,
      model: entryModel,
    });
  }
  // A chain that truncated to the primary alone is indistinguishable from no
  // chain — return the bare model so core never sees a one-entry array.
  if (entries.length < 2) return primary;
  return entries;
}

/** OM fallback-chain entry: a pack's OM model resolved through the gateway. Assignable to `ModelWithRetries`. */
export type PackMemoryModelChainEntry = { id: string; model: GatewayLanguageModel };

/**
 * Resolve the observational-memory model for the active mode pack, walking the
 * pack's fallback chain (`settings.models.packFallbacks`) and collecting each
 * pack's optional `models.memory` entry. Packs without an OM model are skipped
 * (the field is optional, so absence must not truncate the chain); duplicate
 * model ids collapse so an A⇄B cycle never retries an identical OM model.
 *
 * Returns a bare model for a single entry, a fallback array for multiple
 * entries (OM's internal agents run the same agentic loop, so the array gives
 * OM its own cross-pack failover), or `undefined` when no pack in the chain
 * defines an OM model — callers then fall back to the standalone OM
 * configuration.
 */
export function resolvePackMemoryModelChain(
  settings: ReturnType<typeof loadSettings>,
  startPackId: string,
  resolveOptions: Parameters<typeof resolveModel>[1],
): GatewayLanguageModel | PackMemoryModelChainEntry[] | undefined {
  const packs = listResolvableModePacks(settings, requestPackAccess(resolveOptions?.requestContext));
  if (!packs.some(pack => pack.id === startPackId)) return undefined;

  const chain = resolveModePackFallbackChain(
    settings.models?.packFallbacks ?? {},
    startPackId,
    settings.customModelPacks,
  );
  const seenModelIds = new Set<string>();
  const entries: PackMemoryModelChainEntry[] = [];
  for (const packId of chain) {
    const pack = packs.find(candidate => candidate.id === packId);
    if (!pack) break;
    const memoryModelId = resolveModePackModels(settings, pack).memory;
    if (!memoryModelId || seenModelIds.has(memoryModelId)) continue;
    seenModelIds.add(memoryModelId);
    // Best-effort resolution: an unresolvable OM entry (e.g. unconnected
    // provider in deployed fail-closed mode) truncates the chain here rather
    // than failing observation before the pack's own OM model is tried.
    let entryModel: ResolvedModel;
    try {
      entryModel = resolveModel(memoryModelId, resolveOptions);
    } catch {
      break;
    }
    entries.push({ id: `${packId}:memory`, model: entryModel });
  }

  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0]!.model;
  return entries;
}

/**
 * Goal judge model resolver for the agent's `goal.judge` config. Resolves the
 * configured goal judge model through mastracode's gateway so provider
 * credentials (stored in auth storage, not just env) are injected — a bare model
 * id handed to core's default model router would fail to find the API key.
 *
 * Returns `undefined` when no judge model is configured, which keeps the goal
 * step a complete no-op (the goal mechanism requires a judge to do anything).
 *
 * `settingsPath` must be the same source `createMastraCode()` reads from so the
 * judge model and the goal budget (`goalMaxTurns`) come from one config — with a
 * custom `settingsPath` a bare `loadSettings()` here could read a different file
 * and silently turn the goal step into a no-op.
 */
export function getGoalJudgeModel(
  { requestContext }: { requestContext: RequestContext },
  settingsPath?: string,
): ResolvedModel | undefined {
  const judgeModelId = loadSettings(settingsPath).models.goalJudgeModel;
  if (!judgeModelId) return undefined;
  return resolveModel(judgeModelId, { remapForCodexOAuth: true, requestContext });
}

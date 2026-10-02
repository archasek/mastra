import { join } from 'node:path';

import { ACP_PROTOCOL_VERSION } from '@mastra/code-sdk/acp/protocol';
import { readOAuthStatusFile } from '@mastra/code-sdk/auth/storage';
import { getAvailableModePacks } from '@mastra/code-sdk/onboarding/packs';
import { getAppDataDir } from '@mastra/code-sdk/utils/project';
import { getCurrentVersion } from './version.js';

export interface InfoCliOptions {
  appDataDir?: string;
  version?: string;
  writeStdout?: (line: string) => void;
}

function emit(options: InfoCliOptions, value: unknown): void {
  (options.writeStdout ?? (line => process.stdout.write(line)))(`${JSON.stringify(value)}\n`);
}

/** Print stable runtime metadata without starting Mastra Code or creating data. */
export function runInfoCli(args: string[], options: InfoCliOptions = {}): number {
  if (args.length !== 1 || args[0] !== '--json') {
    emit(options, { type: 'error', code: 'INVALID_ARGUMENTS' });
    return 2;
  }

  const appDataDir = options.appDataDir ?? getAppDataDir({ create: false });
  const auth = readOAuthStatusFile(join(appDataDir, 'auth.json'), 'openai-codex');
  const openaiAccess = auth.status === 'authenticated' ? 'oauth' : false;
  const openaiPack = getAvailableModePacks({
    anthropic: false,
    openai: openaiAccess,
    cerebras: false,
    google: false,
    deepseek: false,
    'github-copilot': false,
  }).find(pack => pack.id === 'openai');
  const modelModes = new Map<string, string[]>();
  for (const [mode, modelId] of Object.entries(openaiPack?.models ?? {})) {
    if (!modelId) continue;
    modelModes.set(modelId, [...(modelModes.get(modelId) ?? []), mode]);
  }

  emit(options, {
    schemaVersion: 1,
    version: options.version ?? getCurrentVersion(),
    acpProtocolVersion: ACP_PROTOCOL_VERSION,
    capabilities: {
      loadSession: true,
      permissions: true,
      elicitation: true,
      images: true,
    },
    models: [...modelModes].map(([id, modes]) => ({ id, modes })),
    auth: { provider: 'openai-codex', status: auth.status },
  });
  return auth.status === 'unknown' ? 1 : 0;
}

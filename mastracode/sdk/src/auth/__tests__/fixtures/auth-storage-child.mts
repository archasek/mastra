import { createInterface } from 'node:readline';

import { AuthStorage } from '../../storage.js';

const [authPath, role] = process.argv.slice(2);
if (!authPath || !role) throw new Error('Expected auth file path and child role');

const storage = new AuthStorage(authPath);
const account = storage.listAccounts('openai-codex')[0];
if (!account) throw new Error('Expected legacy Codex account to be adopted');

function emit(event: string, id: string) {
  process.stdout.write(`${JSON.stringify({ event, role, id })}\n`);
}

emit('ready', account.id);

const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const command of commands) {
  if (command !== 'persist') continue;
  const persisted = await storage.addAccount('openai-codex', {
    refresh: 'cross-process-refresh',
    access: 'cross-process-access',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: 'cross-process-account',
  });
  emit('persisted', persisted.id);
}

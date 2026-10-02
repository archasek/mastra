import { setAutoApprove } from './event-mapper.js';
import { createAcpSession } from './runtime.js';
import { runAcpServer } from './server.js';

/** Entry point for Mastra Code's ACP server over stdio. */
export async function acpMain(options?: {
  version?: string;
  dangerousAutoApprove?: boolean;
  coAuthor?: { name?: string; email?: string };
}): Promise<void> {
  setAutoApprove(options?.dangerousAutoApprove === true);
  // stdout is reserved for the JSON-RPC stream.
  // eslint-disable-next-line no-console
  const originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(' ') + '\n');
  };
  try {
    await runAcpServer(request => createAcpSession(request, { coAuthor: options?.coAuthor }), options?.version);
  } catch {
    process.stderr.write('[acp] Fatal server error.\n');
    process.exit(1);
  } finally {
    // eslint-disable-next-line no-console
    console.log = originalConsoleLog;
  }
}

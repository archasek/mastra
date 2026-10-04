import { Readable, Writable } from 'node:stream';

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { isStreamDestroyedError } from '../error-classification.js';
import { MastraCodeAcpAgent } from './agent.js';
import type { AcpSessionFactory } from './agent.js';

/** Run the ACP server over stdio and release its sessions on disconnect. */
export async function runAcpServer(createSession: AcpSessionFactory, version?: string): Promise<void> {
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  let agent: MastraCodeAcpAgent | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let exitCode = 0;
  const dispose = () => (cleanupPromise ??= Promise.resolve().then(() => agent?.dispose()));
  const handleSignal = () => {
    shutdownPromise ??= dispose().then(
      () => process.exit(exitCode),
      () => {
        process.stderr.write('[acp] Shutdown failed.\n');
        process.exit(1);
      },
    );
  };
  const handleFatal = (error: unknown) => {
    if (isStreamDestroyedError(error)) return;
    exitCode = 1;
    // Do not print arbitrary error payloads or write to protocol stdout.
    process.stderr.write('[acp] Fatal runtime error; draining sessions.\n');
    handleSignal();
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.on('SIGHUP', handleSignal);
  process.on('uncaughtException', handleFatal);
  process.on('unhandledRejection', handleFatal);
  try {
    const connection = new AgentSideConnection(
      conn => {
        agent = new MastraCodeAcpAgent(conn, createSession, version);
        return agent;
      },
      ndJsonStream(output, input),
    );
    await connection.closed;
  } finally {
    try {
      await dispose();
    } finally {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.off('SIGHUP', handleSignal);
      process.off('uncaughtException', handleFatal);
      process.off('unhandledRejection', handleFatal);
    }
  }
}

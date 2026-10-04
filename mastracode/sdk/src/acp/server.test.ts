import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAcpServer } from './server.js';

const state = vi.hoisted(() => ({
  dispose: vi.fn(),
  closed: Promise.resolve(),
  onConstruct: () => {},
}));
vi.mock('./agent.js', () => ({
  MastraCodeAcpAgent: class {
    dispose = state.dispose;
  },
}));
vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(),
  AgentSideConnection: class {
    closed = state.closed;
    constructor(factory: (connection: unknown) => unknown) {
      state.onConstruct();
      factory({});
    }
  },
}));

beforeEach(() => {
  state.dispose.mockReset();
  state.onConstruct = () => {};
  vi.spyOn(Readable, 'toWeb').mockReturnValue(new ReadableStream());
  vi.spyOn(Writable, 'toWeb').mockReturnValue(new WritableStream());
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe('ACP server shutdown', () => {
  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'drains once before exiting on %s, including repeated signals',
    async event => {
      const closed = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      state.closed = closed.promise;
      state.dispose.mockReturnValue(cleanup.promise);
      const on = vi.spyOn(process, 'on');
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const initialListeners = process.listenerCount(event);
      const server = runAcpServer(vi.fn());
      // Invoke only our handler: emitting fatal process events would also
      // trigger Vitest's own error reporting and unrelated global listeners.
      const handleFatal = on.mock.calls.find(([name]) => name === event)![1] as (error: unknown) => void;
      try {
        handleFatal({ code: 'ERR_STREAM_DESTROYED' });
        await Promise.resolve();
        expect(state.dispose).not.toHaveBeenCalled();
        process.emit('SIGTERM', 'SIGTERM');
        handleFatal(new Error('private payload'));
        handleFatal(new Error('repeated'));
        process.emit('SIGHUP', 'SIGHUP');
        await Promise.resolve();
        expect(state.dispose).toHaveBeenCalledTimes(1);
        expect(process.exit).not.toHaveBeenCalled();
        cleanup.resolve();
        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledExactlyOnceWith(1));
        closed.resolve();
        await server;
        expect(process.listenerCount(event)).toBe(initialListeners);
        expect(process.stderr.write).not.toHaveBeenCalledWith(expect.stringContaining('private payload'));
      } finally {
        cleanup.resolve();
        closed.resolve();
        await server;
      }
    },
  );

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('waits for cleanup once when %s arrives first', async signal => {
    const closed = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    state.closed = closed.promise;
    state.dispose.mockReturnValue(cleanup.promise);
    const server = runAcpServer(vi.fn());
    try {
      process.emit(signal, signal);
      process.emit('SIGINT', 'SIGINT');
      process.emit('SIGTERM', 'SIGTERM');
      process.emit('SIGHUP', 'SIGHUP');
      await Promise.resolve();
      expect(state.dispose).toHaveBeenCalledTimes(1);
      expect(process.exit).not.toHaveBeenCalled();
      cleanup.resolve();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledExactlyOnceWith(0));
    } finally {
      cleanup.resolve();
      closed.resolve();
      await server;
    }
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'keeps %s handling installed while EOF cleanup is pending',
    async signal => {
      const closed = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      state.closed = closed.promise;
      state.dispose.mockReturnValue(cleanup.promise);
      const initialListeners = process.listenerCount(signal);
      const server = runAcpServer(vi.fn());
      try {
        closed.resolve();
        await vi.waitFor(() => expect(state.dispose).toHaveBeenCalledOnce());
        expect(process.listenerCount(signal)).toBe(initialListeners + 1);
        process.emit(signal, signal);
        expect(process.exit).not.toHaveBeenCalled();
        cleanup.resolve();
        await server;
        await vi.waitFor(() => expect(process.exit).toHaveBeenCalledExactlyOnceWith(0));
        expect(process.listenerCount(signal)).toBe(initialListeners);
      } finally {
        cleanup.resolve();
        await server;
      }
    },
  );

  it('exits when a signal arrives before the agent is assigned', async () => {
    state.closed = Promise.resolve();
    state.dispose.mockResolvedValue(undefined);
    state.onConstruct = () => {
      process.emit('SIGTERM', 'SIGTERM');
    };
    await runAcpServer(vi.fn());
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  });
});

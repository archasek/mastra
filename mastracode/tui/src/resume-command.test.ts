import { hasHeadlessFlag } from '@mastra/code-sdk/headless/index';
import { describe, expect, it } from 'vitest';
import { takeInitialPrompt } from './initial-prompt.js';

import {
  formatResumeHint,
  parseResumeThreadId,
  resolveEntrypointMode,
  shouldRejectResumeWithoutTTY,
  shouldRunHeadless,
} from './resume-command.js';

describe('resume command', () => {
  it.each([
    [['--prompt', '--acp'], 'headless'],
    [['-p', '--acp'], 'headless'],
    [['--tui-prompt', '--acp'], 'tui'],
    [['--tui-initial-prompt', '--acp'], 'tui'],
    [['--acp', '--help'], 'headless'],
    [['--acp'], 'acp'],
    [['login'], 'command'],
    [['--acp', 'login'], 'command'],
    [['--dangerous-auto-approve', '--acp', 'login', '--help'], 'command'],
    [['--tui-prompt', 'login', '--acp'], 'acp'],
    [['plugin', '--acp'], 'command'],
    [['prune', '--acp'], 'command'],
    [['--tui-prompt', 'hello', 'plugin'], 'headless'],
    [['--tui-prompt', 'hello', 'prune', '--acp'], 'headless'],
  ] as const)('selects matching dispatch and cleanup ownership for %j', (args, expected) => {
    const original = ['node', 'mastracode', ...args];
    const argv = takeInitialPrompt(original, {}).argv;
    expect(resolveEntrypointMode(argv, hasHeadlessFlag(argv), original)).toBe(expected);
  });

  it('reads an explicit thread ID', () => {
    expect(parseResumeThreadId(['resume', 'thread-123'])).toBe('thread-123');
  });

  it('rejects an incomplete command', () => {
    expect(() => parseResumeThreadId(['resume'])).toThrow('Usage: mastracode resume <thread-id>');
  });

  it('keeps resume commands out of headless mode', () => {
    const argv = ['node', 'mastracode', 'resume', 'thread-123'];
    expect(shouldRunHeadless(argv, 'thread-123', true)).toBe(false);
    expect(shouldRunHeadless(['node', 'mastracode', '--prompt', 'hello'], undefined, true)).toBe(true);
  });

  it('rejects resume commands without an interactive terminal', () => {
    expect(shouldRejectResumeWithoutTTY('thread-123', false)).toBe(true);
    expect(shouldRejectResumeWithoutTTY('thread-123', true)).toBe(false);
    expect(shouldRejectResumeWithoutTTY(undefined, false)).toBe(false);
  });

  it('formats the exit hint', () => {
    expect(formatResumeHint('thread-123')).toBe('To continue this session, run mastracode resume thread-123');
    expect(formatResumeHint("thread 'quoted'")).toBe(
      "To continue this session, run mastracode resume 'thread '\\''quoted'\\'''",
    );
  });

  it('escapes terminal control characters in the exit hint', () => {
    const hint = formatResumeHint("thread-\u001b[31m'\\name");

    expect(hint).toBe("To continue this session, run mastracode resume $'thread-\\x1b[31m\\'\\\\name'");
    expect(hint).not.toContain('\u001b');
  });
});

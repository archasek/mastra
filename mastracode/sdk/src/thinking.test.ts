import { describe, expect, it } from 'vitest';

import {
  getAvailableThinkingLevelsForModel,
  normalizeThinkingLevelForModel,
  parseThinkCommand,
  parseThinkingLevel,
  parseModeThinkingDefaults,
  resolveDefaultThinkingLevel,
  supportsMaxReasoningEffort,
} from './thinking.js';

describe('thinking settings parsing', () => {
  it('shares native default and filters invalid mode defaults', () => {
    expect(parseThinkingLevel(undefined)).toBe('off');
    expect(parseThinkingLevel('invalid')).toBe('off');
    expect(parseThinkingLevel('low')).toBe('low');
    expect(parseModeThinkingDefaults({ build: 'high', plan: 'invalid', fast: 2 })).toEqual({ build: 'high' });
    expect(
      resolveDefaultThinkingLevel(
        {
          globalDefault: parseThinkingLevel('low'),
          modeDefaults: parseModeThinkingDefaults({ build: 'high' }),
        },
        'build',
      ).level,
    ).toBe('high');
  });
});

describe('parseThinkCommand', () => {
  it.each(['', 'status'])('parses %j as a status request', input => {
    expect(parseThinkCommand(input)).toEqual({ kind: 'status' });
  });

  it.each(['default', 'clear'])('parses %s as a clear request', input => {
    expect(parseThinkCommand(input)).toEqual({ kind: 'clear' });
  });

  it('parses a supported level', () => {
    expect(parseThinkCommand(' HIGH ')).toEqual({ kind: 'set', level: 'high' });
  });

  it('rejects trailing arguments instead of silently ignoring them', () => {
    expect(parseThinkCommand('high extra')).toMatchObject({ kind: 'invalid', value: 'high extra' });
  });

  it('rejects levels unavailable for the active model', () => {
    const levels = getAvailableThinkingLevelsForModel('openai/gpt-5.5');

    expect(parseThinkCommand('max', levels)).toEqual({ kind: 'invalid', value: 'max', levels });
  });
});

describe('thinking model capabilities', () => {
  it('normalizes defaults using the same available levels as ACP', () => {
    expect(normalizeThinkingLevelForModel('max', 'openai/gpt-5.4-mini')).toBe('xhigh');
    expect(normalizeThinkingLevelForModel('max', 'openai/gpt-6.1-sol')).toBe('max');
    expect(normalizeThinkingLevelForModel('low', 'openai/gpt-5.4-mini')).toBe('low');
  });
  it('supports max reasoning from GPT-5.6 onward', () => {
    expect(supportsMaxReasoningEffort('gpt-5.6')).toBe(true);
    expect(supportsMaxReasoningEffort('openai/gpt-6')).toBe(true);
    expect(supportsMaxReasoningEffort('openai/gpt-5.5')).toBe(false);
  });

  it('keeps max for non-OpenAI models', () => {
    expect(getAvailableThinkingLevelsForModel('anthropic/claude-opus-4-6')).toContain('max');
  });
});

describe('resolveDefaultThinkingLevel', () => {
  const defaults = {
    globalDefault: 'low',
    modeDefaults: { plan: 'high' },
  } satisfies Parameters<typeof resolveDefaultThinkingLevel>[0];

  it('uses the active mode default when present', () => {
    expect(resolveDefaultThinkingLevel(defaults, 'plan')).toEqual({ level: 'high', source: 'mode-default' });
  });

  it('falls back to the global default', () => {
    expect(resolveDefaultThinkingLevel(defaults, 'build')).toEqual({ level: 'low', source: 'global' });
  });
});

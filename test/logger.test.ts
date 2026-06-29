import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
    }),
  },
}));

const { formatLogLine } = await import('../src/logger.js');

describe('formatLogLine', () => {
  it('prefixes log messages with an ISO timestamp and level', () => {
    const line = formatLogLine('debug', 'Claude request body bytes=127119', new Date('2026-06-29T12:34:56.789Z'));

    expect(line).toBe('[2026-06-29T12:34:56.789Z] [debug] Claude request body bytes=127119');
  });
});

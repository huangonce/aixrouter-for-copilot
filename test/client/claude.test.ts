import { describe, expect, it } from 'vitest';
import { toClaudeMessageRequest, toClaudeThinking } from '../../src/client/claude.js';

describe('toClaudeThinking', () => {
  it('maps xhigh reasoning effort between high and max budgets', () => {
    expect(toClaudeThinking('high', 20000)).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(toClaudeThinking('xhigh', 20000)).toEqual({ type: 'enabled', budget_tokens: 12000 });
    expect(toClaudeThinking('max', 20000)).toEqual({ type: 'enabled', budget_tokens: 16000 });
  });
});

describe('toClaudeMessageRequest', () => {
  it('maps chat completion fields to the Claude Messages API shape', () => {
    const result = toClaudeMessageRequest({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
      stream: true,
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup a value',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      }],
      tool_choice: 'auto',
      max_tokens: 12000,
      temperature: 0.7,
      context_window: 200000,
      reasoning_effort: 'high',
    }, true);

    expect(result).toEqual({
      model: 'claude-sonnet-4.5',
      system: 'be concise',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      stream: true,
      tools: [{
        name: 'lookup',
        description: 'Lookup a value',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      tool_choice: { type: 'auto' },
      max_tokens: 12000,
      temperature: undefined,
      thinking: { type: 'enabled', budget_tokens: 8192 },
    });
    expect(result).not.toHaveProperty('context_window');
    expect(result).not.toHaveProperty('reasoning_effort');
  });
});

import type { ChatCompletionRequest, StreamHandlers } from '../types.js';
import type { ToolCallAccumulator } from './openai.js';
import { flushToolCalls } from './openai.js';

export interface StreamState {
  emitted: boolean;
}

export interface ClaudeMessageRequest {
  readonly model: string;
  readonly messages: ClaudeMessage[];
  readonly system?: string;
  readonly stream: boolean;
  readonly tools?: ClaudeTool[];
  readonly tool_choice?: ClaudeToolChoice;
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly thinking?: ClaudeThinking;
}

export interface ClaudeToolChoice {
  readonly type: 'auto';
}

export interface ClaudeThinking {
  readonly type: 'enabled';
  readonly budget_tokens: number;
}

export interface ClaudeMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ClaudeContentBlock[];
}

export type ClaudeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string } }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

export interface ClaudeTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: Record<string, unknown>;
}

export function processClaudeData(
  data: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  handlers: StreamHandlers,
  state: StreamState,
): void {
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }

  if (json.usage) {
    handlers.onUsage({
      prompt_tokens: json.usage.input_tokens,
      completion_tokens: json.usage.output_tokens,
    });
  }

  const fullContent = extractClaudeFullContent(json.content);
  if (fullContent.text) {
    handlers.onText(fullContent.text);
    state.emitted = true;
  }
  if (fullContent.thinking) {
    handlers.onThinking(fullContent.thinking);
    state.emitted = true;
  }
  appendClaudeFullToolUses(json.content, toolCalls, state);

  const delta = json.delta;
  const deltaUsage = delta?.usage;
  if (json.type === 'message_delta' && deltaUsage) {
    handlers.onUsage({
      prompt_tokens: deltaUsage.input_tokens,
      completion_tokens: deltaUsage.output_tokens,
    });
  }

  if (json.type === 'content_block_delta') {
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      handlers.onText(delta.text);
      state.emitted = true;
      return;
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      handlers.onThinking(delta.thinking);
      state.emitted = true;
      return;
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const index = json.index ?? toolCalls.size;
      const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      if (current.argumentsFallback !== undefined) {
        current.arguments = '';
        current.argumentsFallback = undefined;
      }
      current.arguments += delta.partial_json;
      toolCalls.set(index, current);
      state.emitted = true;
      return;
    }
  }

  if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
    const index = json.index ?? toolCalls.size;
    toolCalls.set(index, {
      id: json.content_block.id || `call_${index}`,
      name: json.content_block.name || '',
      arguments: '',
      argumentsFallback: JSON.stringify(json.content_block.input ?? {}),
    });
    state.emitted = true;
  }
}

export function appendClaudeFullToolUses(
  content: unknown,
  toolCalls: Map<number, ToolCallAccumulator>,
  state: StreamState,
): void {
  if (!Array.isArray(content)) {
    return;
  }

  for (const block of content) {
    if (block?.type !== 'tool_use') {
      continue;
    }

    const index = toolCalls.size;
    toolCalls.set(index, {
      id: block.id || 'call_' + index,
      name: block.name || '',
      arguments: '',
      argumentsFallback: JSON.stringify(block.input ?? {}),
    });
    state.emitted = true;
  }
}

export function extractClaudeFullContent(content: unknown): { text?: string; thinking?: string } {
  if (!Array.isArray(content)) {
    return {};
  }

  const text = content
    .map((part) => typeof part?.text === 'string' ? part.text : '')
    .join('');
  const thinking = content
    .map((part) => typeof part?.thinking === 'string' ? part.thinking : '')
    .join('');

  return {
    text: text.length > 0 ? text : undefined,
    thinking: thinking.length > 0 ? thinking : undefined,
  };
}

export async function processClaudeFullResponse(
  response: Response,
  handlers: StreamHandlers,
): Promise<void> {
  const body = await response.text();
  const toolCalls = new Map<number, ToolCallAccumulator>();
  const state: StreamState = { emitted: false };

  processClaudeData(body.trim(), toolCalls, handlers, state);
  flushToolCalls(toolCalls, handlers);

  if (!state.emitted) {
    throw emptyResponseError('Claude response', body);
  }
}

function emptyResponseError(source: string, preview: string): Error {
  const normalized = preview.replace(/\s+/g, ' ').trim().slice(0, 800);
  const suffix = normalized ? ` Response preview: ${normalized}` : '';
  return new Error(`AIXRouter ${source} did not contain any assistant text or tool call.${suffix}`);
}

export function appendPreview(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(0, 2000);
}

export function summarizeClaudeRequest(endpoint: string, request: ClaudeMessageRequest): string {
  const roles = request.messages.map((message) => message.role).join(',');
  const blockTypes = request.messages
    .map((message) => `${message.role}:${message.content.map((block) => block.type).join('+')}`)
    .join('|');
  return JSON.stringify({
    endpoint,
    stream: request.stream,
    model: request.model,
    messageCount: request.messages.length,
    roles,
    blockTypes,
    hasSystem: Boolean(request.system),
    tools: request.tools?.length ?? 0,
    maxTokens: request.max_tokens,
    hasTemperature: request.temperature !== undefined,
    thinkingBudget: request.thinking?.budget_tokens,
  });
}

export function toClaudeMessageRequest(request: ChatCompletionRequest, stream: boolean): ClaudeMessageRequest {
  const messages: ClaudeMessage[] = [];
  const systemParts: string[] = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(textFromContent(message.content));
      continue;
    }

    if (message.role === 'tool') {
      appendClaudeMessage(messages, {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }],
      });
      continue;
    }

    const content = toClaudeContent(message.content);
    for (const toolCall of message.tool_calls ?? []) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseToolArguments(toolCall.function.arguments),
      });
    }

    if (content.length > 0) {
      appendClaudeMessage(messages, { role: message.role, content });
    }
  }

  const maxTokens = request.max_tokens ?? 4096;
  const thinking = toClaudeThinking(request.reasoning_effort, maxTokens);
  return {
    model: request.model,
    messages,
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    stream,
    tools: toClaudeTools(request.tools),
    tool_choice: toClaudeToolChoice(request.tool_choice, request.tools),
    max_tokens: maxTokens,
    temperature: thinking ? undefined : clampClaudeTemperature(request.temperature),
    thinking,
  };
}

export function clampClaudeTemperature(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

export function toClaudeThinking(
  effort: ChatCompletionRequest['reasoning_effort'],
  maxTokens: number,
): ClaudeThinking | undefined {
  if (!effort) {
    return undefined;
  }

  const targetBudget = {
    low: 1024,
    medium: 4096,
    high: 8192,
    xhigh: 12000,
    max: 16000,
  }[effort];
  const availableBudget = Math.max(0, maxTokens - 1024);
  const budgetTokens = Math.min(targetBudget, availableBudget);
  if (budgetTokens < 1024) {
    return undefined;
  }
  return { type: 'enabled', budget_tokens: budgetTokens };
}

export function appendClaudeMessage(messages: ClaudeMessage[], message: ClaudeMessage): void {
  const previous = messages.at(-1);
  if (previous?.role === message.role) {
    previous.content.push(...message.content);
    return;
  }

  messages.push(message);
}

export function toClaudeContent(content: ChatCompletionRequest['messages'][number]['content']): ClaudeContentBlock[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }

  return content.flatMap((part): ClaudeContentBlock[] => {
    if (part.type === 'text') {
      return part.text ? [{ type: 'text', text: part.text }] : [];
    }

    const dataUrlMatch = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
    if (!dataUrlMatch) {
      return [];
    }

    return [{
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrlMatch[1],
        data: dataUrlMatch[2],
      },
    }];
  });
}

export function toClaudeTools(tools: ChatCompletionRequest['tools']): ClaudeTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

export function toClaudeToolChoice(
  toolChoice: ChatCompletionRequest['tool_choice'],
  tools: ChatCompletionRequest['tools'],
): ClaudeToolChoice | undefined {
  if (toolChoice !== 'auto' || !tools?.length) {
    return undefined;
  }
  return { type: 'auto' };
}

function textFromContent(content: ChatCompletionRequest['messages'][number]['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => part.type === 'text' ? part.text : '')
    .join('');
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

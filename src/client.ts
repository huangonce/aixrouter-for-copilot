import type {
  AIXRouterModelConfig,
  ChatCompletionRequest,
  ChatToolCall,
  StreamHandlers,
} from './types';
import { loadPublicModelEnrichment, mergePublicModelEnrichment } from './pricing';

interface RawModel {
  readonly id?: string;
  readonly name?: string;
  readonly owned_by?: string;
  readonly context_length?: number;
  readonly max_context_length?: number;
  readonly max_output_tokens?: number;
  readonly inputPer1M?: number;
  readonly outputPer1M?: number;
  readonly cacheHitPer1M?: number;
  readonly cacheCreationPer1M?: number;
  readonly currencyCode?: string;
  readonly capabilities?: Record<string, unknown>;
  readonly type?: string;
  readonly vendor?: string;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  argumentsFallback?: string;
}

interface StreamState {
  emitted: boolean;
}

interface ClaudeMessageRequest {
  readonly model: string;
  readonly messages: ClaudeMessage[];
  readonly system?: string;
  readonly stream: boolean;
  readonly tools?: ClaudeTool[];
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly thinking?: ClaudeThinking;
}

interface ClaudeThinking {
  readonly type: 'enabled';
  readonly budget_tokens: number;
}

interface ClaudeMessage {
  readonly role: 'user' | 'assistant';
  readonly content: ClaudeContentBlock[];
}

type ClaudeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string } }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string };

interface ClaudeTool {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: Record<string, unknown>;
}

type AIXRouterApiKind = 'openai' | 'claude';

export class AIXRouterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly enrichPublicModelMetadata = true,
    private readonly debug?: (message: string) => void,
  ) {}

  async listModels(signal?: AbortSignal): Promise<AIXRouterModelConfig[]> {
    const response = await fetch(buildEndpointUrl(this.baseUrl, 'openai', 'models'), {
      method: 'GET',
      headers: this.headers(),
      signal,
    });

    if (!response.ok) {
      throw await createHttpError('Failed to load AIXRouter models', response);
    }

    const json = await response.json() as { data?: RawModel[] };
    const models = (json.data ?? [])
      .map(toModelConfig)
      .filter((model): model is AIXRouterModelConfig => Boolean(model?.id));

    const enrichment = this.enrichPublicModelMetadata
      ? await loadPublicModelEnrichment(this.baseUrl, signal).catch(() => new Map())
      : new Map();
    return mergePublicModelEnrichment(models, enrichment);
  }

  async streamChatCompletion(
    request: ChatCompletionRequest,
    routeHint: string | undefined,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const apiKind = getChatApiKind(routeHint ?? request.model);
    if (apiKind === 'claude') {
      await this.streamClaudeMessage(request, handlers, signal);
      return;
    }

    const response = await this.fetchChatCompletion(request, 'openai', signal);

    if (!response.ok) {
      throw await createHttpError('AIXRouter chat completion failed', response);
    }

    if (!response.body) {
      throw new Error('AIXRouter response body is empty.');
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      await processOpenAIFullResponse(response, handlers);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) {
          continue;
        }

        const data = trimmed.slice('data:'.length).trim();
        if (data === '[DONE]') {
          flushToolCalls(toolCalls, handlers);
          return;
        }

        processSseData(data, toolCalls, handlers);
      }
    }

    flushToolCalls(toolCalls, handlers);
  }

  private async fetchChatCompletion(
    request: ChatCompletionRequest,
    apiKind: AIXRouterApiKind,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(buildEndpointUrl(this.baseUrl, apiKind, 'chat/completions'), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
  }

  private async streamClaudeMessage(
    request: ChatCompletionRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const endpoint = buildEndpointUrl(this.baseUrl, 'claude', 'messages');
    const claudeRequest = toClaudeMessageRequest(request, true);
    this.debug?.(`Claude request ${summarizeClaudeRequest(endpoint, claudeRequest)}`);

    const response = await this.fetchClaudeMessageWithRetry(endpoint, claudeRequest, signal);

    this.debug?.(`Claude response stream=true status=${response.status} contentType=${response.headers.get('content-type') ?? 'unknown'}`);

    if (!response.ok) {
      throw await createHttpError('AIXRouter Claude message failed', response);
    }

    if (!response.body) {
      throw new Error('AIXRouter Claude response body is empty.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCalls = new Map<number, ToolCallAccumulator>();
    let buffer = '';
    let preview = '';
    const state: StreamState = { emitted: false };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
          continue;
        }

        const data = trimmed.slice('data:'.length).trim();
        if (data === '[DONE]') {
          flushToolCalls(toolCalls, handlers);
          if (!state.emitted) {
            this.debug?.('Claude stream was empty; retrying once with stream=false.');
            await this.completeClaudeMessage(request, handlers, signal);
          }
          return;
        }

        preview = appendPreview(preview, data);
        processClaudeData(data, toolCalls, handlers, state);
      }
    }

    flushToolCalls(toolCalls, handlers);
    if (!state.emitted) {
      this.debug?.('Claude stream ended without content; retrying once with stream=false.');
      await this.completeClaudeMessage(request, handlers, signal);
    }
  }

  private async fetchClaudeMessageWithRetry(
    endpoint: string,
    request: ClaudeMessageRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await this.fetchClaudeMessage(endpoint, request, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      this.debug?.(`Claude request failed before HTTP response; retrying once. ${error instanceof Error ? error.message : String(error)}`);
      try {
        return await this.fetchClaudeMessage(endpoint, request, signal);
      } catch (retryError) {
        throw fetchFailedError(endpoint, retryError);
      }
    }
  }

  private async fetchClaudeMessage(
    endpoint: string,
    request: ClaudeMessageRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        ...this.headers(),
        Accept: request.stream ? 'text/event-stream' : 'application/json',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    });
  }

  private async completeClaudeMessage(
    request: ChatCompletionRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const endpoint = buildEndpointUrl(this.baseUrl, 'claude', 'messages');
    let response: Response;
    try {
      response = await this.fetchClaudeMessage(endpoint, toClaudeMessageRequest(request, false), signal);
    } catch (error) {
      throw fetchFailedError(endpoint, error);
    }

    if (!response.ok) {
      throw await createHttpError('AIXRouter Claude message failed', response);
    }

    await processClaudeFullResponse(response, handlers);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}

async function processClaudeFullResponse(
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

async function processOpenAIFullResponse(
  response: Response,
  handlers: StreamHandlers,
): Promise<void> {
  const body = await response.text();
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let emitted = false;

  try {
    const json = JSON.parse(body) as any;
    if (json.usage) {
      handlers.onUsage(json.usage);
    }

    const choice = json.choices?.[0];
    const message = choice?.message ?? choice?.delta ?? json.message ?? json;
    const text = extractText(message?.content ?? message?.text ?? json.text ?? json.response);
    if (text) {
      handlers.onText(text);
      emitted = true;
    }

    const thinking = extractText(message?.reasoning_content ?? message?.reasoning ?? message?.thinking);
    if (thinking) {
      handlers.onThinking(thinking);
      emitted = true;
    }

    for (const rawToolCall of message?.tool_calls ?? []) {
      const index = rawToolCall.index ?? toolCalls.size;
      const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
      applyToolCallDelta(current, rawToolCall);
      toolCalls.set(index, current);
    }
  } catch {
    // Fall through to the empty response error below with a body preview.
  }

  const emittedTools = [...toolCalls.values()].some((toolCall) => Boolean(toolCall.name));
  flushToolCalls(toolCalls, handlers);
  if (!emitted && !emittedTools) {
    throw emptyResponseError('OpenAI response', body);
  }
}

function appendPreview(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(0, 2000);
}

function emptyResponseError(source: string, preview: string): Error {
  const normalized = preview.replace(/\s+/g, ' ').trim().slice(0, 800);
  const suffix = normalized ? ` Response preview: ${normalized}` : '';
  return new Error(`AIXRouter ${source} did not contain any assistant text or tool call.${suffix}`);
}

function fetchFailedError(endpoint: string, error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error);
  return new Error(`AIXRouter request to ${endpoint} failed before receiving an HTTP response. ${cause}`);
}

function summarizeClaudeRequest(endpoint: string, request: ClaudeMessageRequest): string {
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

function toClaudeMessageRequest(request: ChatCompletionRequest, stream: boolean): ClaudeMessageRequest {
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
  return {
    model: request.model,
    messages,
    ...(systemParts.length ? { system: systemParts.join('\n\n') } : {}),
    stream,
    tools: toClaudeTools(request.tools),
    max_tokens: maxTokens,
    temperature: clampClaudeTemperature(request.temperature),
    thinking: toClaudeThinking(request.reasoning_effort, maxTokens),
  };
}

function clampClaudeTemperature(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

function toClaudeThinking(
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
    max: 16000,
  }[effort];
  const availableBudget = Math.max(0, maxTokens - 1024);
  const budgetTokens = Math.min(targetBudget, availableBudget);
  if (budgetTokens < 1024) {
    return undefined;
  }
  return { type: 'enabled', budget_tokens: budgetTokens };
}

function appendClaudeMessage(messages: ClaudeMessage[], message: ClaudeMessage): void {
  const previous = messages.at(-1);
  if (previous?.role === message.role) {
    previous.content.push(...message.content);
    return;
  }

  messages.push(message);
}

function toClaudeContent(content: ChatCompletionRequest['messages'][number]['content']): ClaudeContentBlock[] {
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

function toClaudeTools(tools: ChatCompletionRequest['tools']): ClaudeTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
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

function processClaudeData(
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

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (typeof part?.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
  return text.length > 0 ? text : undefined;
}

function extractClaudeFullContent(content: unknown): { text?: string; thinking?: string } {
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

function processSseData(
  data: string,
  toolCalls: Map<number, ToolCallAccumulator>,
  handlers: StreamHandlers,
): void {
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return;
  }

  if (json.usage) {
    handlers.onUsage(json.usage);
  }

  const delta = json.choices?.[0]?.delta;
  if (!delta) {
    return;
  }

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    handlers.onText(delta.content);
  }

  const thinking = delta.reasoning_content ?? delta.reasoning;
  if (typeof thinking === 'string' && thinking.length > 0) {
    handlers.onThinking(thinking);
  }

  for (const rawToolCall of delta.tool_calls ?? []) {
    const index = rawToolCall.index ?? toolCalls.size;
    const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
    applyToolCallDelta(current, rawToolCall);
    toolCalls.set(index, current);
  }
}

function applyToolCallDelta(current: ToolCallAccumulator, rawToolCall: any): void {
  if (rawToolCall.id) {
    current.id = rawToolCall.id;
  }
  if (rawToolCall.function?.name) {
    current.name = rawToolCall.function.name;
  }
  const rawArguments = rawToolCall.function?.arguments;
  if (typeof rawArguments === 'string') {
    current.arguments += rawArguments;
  } else if (rawArguments !== undefined) {
    current.arguments += JSON.stringify(rawArguments);
  }
}

function flushToolCalls(
  toolCalls: Map<number, ToolCallAccumulator>,
  handlers: StreamHandlers,
): void {
  for (const [index, toolCall] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    if (!toolCall.name) {
      continue;
    }
    handlers.onToolCall({
      id: toolCall.id || `call_${index}`,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments || toolCall.argumentsFallback || '{}',
      },
    });
  }
  toolCalls.clear();
}

function toModelConfig(model: RawModel): AIXRouterModelConfig | undefined {
  if (!model.id) {
    return undefined;
  }

  const capabilities = model.capabilities ?? {};
  const modelText = normalizeModelText(model);

  return {
    id: model.id,
    name: model.name || model.id,
    family: isPlaceholderOwner(model.owned_by) ? model.vendor || inferFamily(model.id) : model.owned_by,
    version: 'aixrouter',
    maxInputTokens: numberFrom(model.context_length, model.max_context_length) ?? 128000,
    maxOutputTokens: numberFrom(model.max_output_tokens) ?? 8192,
    toolCalling: booleanFrom(capabilities.tool_calling, capabilities.tools, capabilities.function_calling) ?? true,
    vision: looksVisionCapable(modelText) || (booleanFrom(
      capabilities.vision,
      capabilities.image_input,
      capabilities.imageInput,
      capabilities.multimodal,
      capabilities.multi_modal,
    ) ?? false),
    thinking: booleanFrom(capabilities.reasoning, capabilities.thinking) ?? looksThinkingCapable(modelText),
    contextWindows: getContextWindows(modelText, numberFrom(model.context_length, model.max_context_length)),
    sourceType: model.type,
    pricing: toApiPricing(model),
  };
}

function toApiPricing(model: RawModel): AIXRouterModelConfig['pricing'] {
  const inputPer1M = numberFrom(model.inputPer1M);
  const outputPer1M = numberFrom(model.outputPer1M);
  const cacheHitPer1M = numberFrom(model.cacheHitPer1M);
  const cacheCreationPer1M = numberFrom(model.cacheCreationPer1M);

  if (
    inputPer1M === undefined &&
    outputPer1M === undefined &&
    cacheHitPer1M === undefined &&
    cacheCreationPer1M === undefined
  ) {
    return undefined;
  }

  return {
    currencyCode: model.currencyCode || 'USD',
    inputPer1M,
    outputPer1M,
    cacheHitPer1M,
    cacheCreationPer1M,
  };
}

function inferFamily(id: string): string {
  const [family] = id.split(/[/:.-]/);
  return family || 'aixrouter';
}

function getChatApiKind(modelText: string): AIXRouterApiKind {
  const normalized = modelText.toLowerCase();
  if (normalized.startsWith('claude-') || normalized.includes('/claude-') || normalized.includes('anthropic')) {
    return 'claude';
  }
  return 'openai';
}

function buildEndpointUrl(baseUrl: string, kind: AIXRouterApiKind, resourcePath: string): string {
  return `${getGatewayRoot(baseUrl)}/${getApiPath(kind)}/${resourcePath}`;
}

function getGatewayRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+((openai|claude)\/v1)$/i, '');
}

function getApiPath(kind: AIXRouterApiKind): string {
  switch (kind) {
    case 'claude':
      return 'claude/v1';
    case 'openai':
      return 'openai/v1';
  }
}

function isPlaceholderOwner(value: string | undefined): boolean {
  return !value || value === 'kredo' || value === 'aixrouter';
}

function normalizeModelText(model: RawModel): string {
  return [
    model.id,
    model.name,
    model.owned_by,
    model.vendor,
    model.type,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function looksVisionCapable(modelText: string): boolean {
  if (
    modelText.includes('multimodal') ||
    modelText.includes('multi-modal') ||
    modelText.includes('vision') ||
    /\bvl\b/.test(modelText)
  ) {
    return true;
  }

  return [
    /^claude-(haiku|sonnet|opus)-/,
    /^gemini-/,
    /^gpt-4o\b/,
    /^gpt-4\.1\b/,
    /^gpt-5(\b|-)/,
    /^gpt-5\./,
    /^glm-5\.1\b/,
    /^kimi-k2\.5\b/,
  ].some((pattern) => pattern.test(modelText));
}

function looksThinkingCapable(modelText: string): boolean {
  if (modelText.includes('reason') || modelText.includes('thinking')) {
    return true;
  }

  return [
    /^claude-(haiku|sonnet|opus)-/,
    /^gpt-4o\b/,
    /^gpt-4\.1\b/,
    /^gpt-5(\b|-)/,
    /^gpt-5\./,
    /^gemini-/,
    /\bo[134]\b/,
    /\bo[134]-/,
    /\br1\b/,
    /\bqwen3\b/,
  ].some((pattern) => pattern.test(modelText));
}

function getContextWindows(modelText: string, apiContextWindow: number | undefined): number[] {
  const maxWindow = Math.max(apiContextWindow ?? 0, inferMaxContextWindow(modelText));
  return [200000, 400000, 1000000].filter((value) => value <= maxWindow);
}

function inferMaxContextWindow(modelText: string): number {
  if (
    /^gemini-/.test(modelText) ||
    /^gpt-5(\b|[.-])/.test(modelText) ||
    /^claude-(haiku|sonnet|opus)-/.test(modelText)
  ) {
    return 1000000;
  }
  return 200000;
}

function numberFrom(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function booleanFrom(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

async function createHttpError(prefix: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  const details = [
    friendlyStatusMessage(response.status),
    extractErrorDetail(body),
  ].filter(Boolean).join(' ');

  return new Error(`${prefix}: ${response.status} ${response.statusText}.${details ? ` ${details}` : ''}`);
}

function friendlyStatusMessage(status: number): string | undefined {
  if (status === 400) {
    return 'The request was rejected. Check the selected model and request options.';
  }
  if (status === 401) {
    return 'The API key is missing or invalid. Run "AIXRouter: Set API Key".';
  }
  if (status === 402) {
    return 'The account has insufficient balance or quota.';
  }
  if (status === 403) {
    return 'The API key does not have permission to access this endpoint or model.';
  }
  if (status === 404) {
    return 'The Base URL or model endpoint was not found. Check "AIXRouter: Set Base URL".';
  }
  if (status === 408) {
    return 'The request timed out. Try again or check your network/proxy.';
  }
  if (status === 429) {
    return 'The provider rate limit was reached. Try again later or choose another model.';
  }
  if (status >= 500) {
    return 'The upstream provider returned a server error. Try again later.';
  }
  return undefined;
}

function extractErrorDetail(body: string): string | undefined {
  if (!body.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
      code?: unknown;
    };
    const message = stringFrom(parsed.error?.message) ?? stringFrom(parsed.message);
    const code = stringFrom(parsed.error?.code) ?? stringFrom(parsed.code);
    if (message && code) {
      return `Provider says: ${message} (${code}).`;
    }
    if (message) {
      return `Provider says: ${message}.`;
    }
  } catch {
    // Fall back to a compact body preview below.
  }

  return `Provider response: ${body.replace(/\s+/g, ' ').slice(0, 500)}.`;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

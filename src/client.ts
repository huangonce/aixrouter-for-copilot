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
}

export class AIXRouterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly enrichPublicModelMetadata = true,
  ) {}

  async listModels(signal?: AbortSignal): Promise<AIXRouterModelConfig[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(),
      signal,
    });

    if (!response.ok) {
      throw await createHttpError('Failed to load Magic Router models', response);
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
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw await createHttpError('Magic Router chat completion failed', response);
    }

    if (!response.body) {
      throw new Error('Magic Router response body is empty.');
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

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
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
    current.id += rawToolCall.id ?? '';
    current.name += rawToolCall.function?.name ?? '';
    current.arguments += rawToolCall.function?.arguments ?? '';
    toolCalls.set(index, current);
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
        arguments: toolCall.arguments || '{}',
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
    version: 'magicrouter',
    maxInputTokens: numberFrom(model.context_length, model.max_context_length) ?? 128000,
    maxOutputTokens: numberFrom(model.max_output_tokens) ?? 8192,
    toolCalling: booleanFrom(capabilities.tool_calling, capabilities.tools, capabilities.function_calling) ?? true,
    vision: booleanFrom(
      capabilities.vision,
      capabilities.image_input,
      capabilities.imageInput,
      capabilities.multimodal,
      capabilities.multi_modal,
    ) ?? looksVisionCapable(modelText),
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
  return family || 'magicrouter';
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
  const candidates = [200000, 400000, 1000000].filter((value) => value <= maxWindow);

  if (maxWindow >= 900000 && !candidates.includes(1000000)) {
    candidates.push(1000000);
  }

  return candidates;
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
    return 'The API key is missing or invalid. Run "Magic Router: Set API Key".';
  }
  if (status === 402) {
    return 'The account has insufficient balance or quota.';
  }
  if (status === 403) {
    return 'The API key does not have permission to access this endpoint or model.';
  }
  if (status === 404) {
    return 'The Base URL or model endpoint was not found. Check "Magic Router: Set Base URL".';
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

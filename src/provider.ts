import * as vscode from 'vscode';
import { AuthStore } from './auth';
import {
  getBaseUrl,
  hasBaseUrl,
  getMaxTokens,
  getPinnedModels,
  getPublicModelMetadataEnabled,
  getReasoningEffort,
  getTemperature,
  onConfigChanged,
} from './config';
import { AIXRouterClient } from './client';
import { convertMessages, convertTools, estimateTokenCount, summarizeMessageParts } from './convert';
import { Logger } from './logger';
import { toModelCostInfo } from './pricing';
import type { AIXRouterModelConfig, ChatCompletionRequest, ChatToolCall } from './types';

type ModelPickerInfo = vscode.LanguageModelChatInformation & {
  readonly isBYOK?: true;
  readonly isUserSelectable?: boolean;
  readonly statusIcon?: vscode.ThemeIcon;
  readonly configurationSchema?: object;
  readonly inputCost?: string;
  readonly outputCost?: string;
  readonly cacheCost?: string;
  readonly priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
};

type ModelOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max';

export class AIXRouterChatProvider implements vscode.LanguageModelChatProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  private cachedModels: AIXRouterModelConfig[] = [];
  private lastModelLoadError?: string;

  constructor(
    private readonly auth: AuthStore,
    private readonly logger: Logger,
  ) {}

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  registerConfigWatcher(context: vscode.ExtensionContext): void {
    context.subscriptions.push(onConfigChanged(() => this.refreshModelPicker()));
  }

  refreshModelPicker(): void {
    this.cachedModels = [];
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasKey = await this.auth.hasApiKey();
    const hasUrl = hasBaseUrl();
    const pinned = getPinnedModels();

    if (pinned.length > 0) {
      return pinned.map((model) => toChatInfo(model, hasKey, hasUrl));
    }

    if (!hasUrl || !hasKey) {
      return [toSetupChatInfo(hasUrl, hasKey)];
    }

    if (this.cachedModels.length === 0) {
      this.cachedModels = await this.loadModels(token);
    }

    return this.cachedModels.map((model) => toChatInfo(model, hasKey, hasUrl));
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey = await this.auth.getApiKey();
    const baseUrl = getBaseUrl();
    if (!baseUrl) {
      throw new Error('Magic Router Base URL is not configured. Run "Magic Router: Set Base URL" first.');
    }
    if (!apiKey) {
      throw new Error('Magic Router API Key is not configured. Run "Magic Router: Set API Key" first.');
    }

    const model = this.resolveModel(modelInfo.id);
    const abort = new AbortController();
    const disposable = token.onCancellationRequested(() => abort.abort());

    try {
      const request = this.createRequest(model, messages, options as ModelOptions);
      const selectedContext = getConfiguredContextWindow(model, options as ModelOptions);
      this.logger.debug(`Model capabilities id=${model.id} vision=${model.vision === true} thinking=${model.thinking === true} toolCalling=${model.toolCalling !== false}`);
      this.logger.debug(`VS Code modelInfo capabilities imageInput=${modelInfo.capabilities.imageInput === true} toolCalling=${modelInfo.capabilities.toolCalling ?? false}`);
      this.logger.debug(`POST model=${request.model} messages=${request.messages.length} images=${countImageParts(request)} tools=${request.tools?.length ?? 0} context=${selectedContext ?? 'default'}`);
      this.logger.debug(`Input parts ${summarizeMessageParts(messages)}`);

      await new AIXRouterClient(baseUrl, apiKey, true, (message) => this.logger.debug(message)).streamChatCompletion(
        request,
        getModelRouteHint(model),
        {
          onText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
          onThinking: (text) => reportThinking(progress, text),
          onToolCall: (toolCall) => reportToolCall(progress, toolCall),
          onUsage: (usage) => reportUsage(progress, usage),
        },
        abort.signal,
      );
    } catch (error) {
      this.logger.error('Chat completion failed', error);
      throw error;
    } finally {
      disposable.dispose();
    }
  }

  async provideTokenCount(
    _modelInfo: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    return estimateTokenCount(text);
  }

  private async loadModels(token: vscode.CancellationToken): Promise<AIXRouterModelConfig[]> {
    const apiKey = await this.auth.getApiKey();
    const baseUrl = getBaseUrl();
    if (!apiKey || !baseUrl) {
      return [];
    }

    const abort = new AbortController();
    const disposable = token.onCancellationRequested(() => abort.abort());

    try {
      const models = await new AIXRouterClient(baseUrl, apiKey, getPublicModelMetadataEnabled()).listModels(abort.signal);
      this.logger.info(`Loaded ${models.length} Magic Router model(s).`);
      this.lastModelLoadError = undefined;
      return models;
    } catch (error) {
      this.logger.error('Failed to load models from Magic Router', error);
      this.notifyModelLoadError(error);
      return [];
    } finally {
      disposable.dispose();
    }
  }

  private notifyModelLoadError(error: unknown): void {
    const message = getErrorMessage(error);
    if (this.lastModelLoadError === message) {
      return;
    }

    this.lastModelLoadError = message;
    void vscode.window.showWarningMessage(
      `Could not load Magic Router models. ${message}`,
      'Set API Key',
      'Set Base URL',
      'Open Settings',
    ).then(async (action) => {
      if (action === 'Set API Key') {
        await vscode.commands.executeCommand('magicrouter.setApiKey');
      } else if (action === 'Set Base URL') {
        await vscode.commands.executeCommand('magicrouter.setBaseUrl');
      } else if (action === 'Open Settings') {
        await vscode.commands.executeCommand('magicrouter.openSettings');
      }
    });
  }

  private resolveModel(modelId: string): AIXRouterModelConfig {
    return [...getPinnedModels(), ...this.cachedModels].find((model) => model.id === modelId) ?? {
      id: modelId,
      name: modelId,
      toolCalling: true,
      vision: true,
      thinking: false,
    };
  }

  private createRequest(
    model: AIXRouterModelConfig,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: ModelOptions,
  ): ChatCompletionRequest {
    const tools = model.toolCalling === false ? undefined : convertTools(options.tools);
    const maxTokens = getMaxTokens() ?? model.maxOutputTokens;
    const contextWindow = getConfiguredContextWindow(model, options);
    const temperature = getTemperature();
    const reasoningEffort = getConfiguredReasoningEffort(model, options);

    return {
      model: model.id,
      messages: convertMessages(messages),
      stream: true,
      tools,
      tool_choice: tools?.length ? 'auto' : undefined,
      max_tokens: maxTokens,
      context_window: contextWindow,
      temperature,
      reasoning_effort: reasoningEffort,
    };
  }
}

function toChatInfo(model: AIXRouterModelConfig, hasKey: boolean, hasUrl: boolean): ModelPickerInfo {
  const configured = hasKey && hasUrl;
  return {
    id: model.id,
    name: model.name || model.id,
    family: model.family || 'magicrouter',
    version: model.version || 'magicrouter',
    maxInputTokens: model.maxInputTokens ?? 128000,
    maxOutputTokens: model.maxOutputTokens ?? 8192,
    detail: configured ? 'Magic Router BYOK' : getSetupDetail(hasUrl, hasKey),
    tooltip: configured ? `${model.id} via Magic Router` : getSetupDetail(hasUrl, hasKey),
    isBYOK: true,
    isUserSelectable: configured,
    statusIcon: configured ? undefined : new vscode.ThemeIcon('warning'),
    capabilities: {
      toolCalling: model.toolCalling !== false,
      imageInput: model.vision === true,
    },
    ...toModelCostInfo(model),
    ...toConfigurationSchema(model),
  } as ModelPickerInfo;
}

function countImageParts(request: ChatCompletionRequest): number {
  return request.messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) {
      return count;
    }
    return count + message.content.filter((part) => part.type === 'image_url').length;
  }, 0);
}

function toSetupChatInfo(hasUrl: boolean, hasKey: boolean): ModelPickerInfo {
  return {
    id: 'setup-required',
    name: 'Configure Magic Router',
    family: 'magicrouter',
    version: 'setup',
    maxInputTokens: 1,
    maxOutputTokens: 1,
    detail: getSetupDetail(hasUrl, hasKey),
    tooltip: getSetupDetail(hasUrl, hasKey),
    isBYOK: true,
    isUserSelectable: false,
    statusIcon: new vscode.ThemeIcon('warning'),
    capabilities: {
      toolCalling: false,
      imageInput: false,
    },
  } as ModelPickerInfo;
}

function getSetupDetail(hasUrl: boolean, hasKey: boolean): string {
  if (!hasUrl && !hasKey) {
    return 'Run Magic Router: Set Base URL, then Magic Router: Set API Key';
  }
  if (!hasUrl) {
    return 'Run Magic Router: Set Base URL';
  }
  return 'Run Magic Router: Set API Key';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getModelRouteHint(model: AIXRouterModelConfig): string {
  return [model.id, model.name, model.family, model.sourceType]
    .filter(Boolean)
    .join(' ');
}

function toConfigurationSchema(model: AIXRouterModelConfig): { configurationSchema?: object } {
  const properties: Record<string, object> = {};

  const contextWindows = getContextWindowOptions(model);
  if (contextWindows.length > 0) {
    properties.contextWindow = buildContextWindowProperty(contextWindows);
  }

  if (model.thinking) {
    properties.reasoningEffort = buildReasoningEffortProperty();
  }

  return Object.keys(properties).length > 0
    ? { configurationSchema: { properties } }
    : {};
}

function buildReasoningEffortProperty(): object {
  return {
    type: 'string',
    title: '思考工作量',
    enum: ['low', 'medium', 'high', 'max'],
    enumItemLabels: ['Low', 'Medium', 'High', 'Max'],
    enumDescriptions: [
      'Faster responses with less reasoning',
      'Balanced reasoning and speed',
      'Greater reasoning depth but slower',
      'Absolute maximum capability with no constraints',
    ],
    default: getReasoningEffort(),
    group: 'navigation',
  };
}

function buildContextWindowProperty(contextWindows: number[]): object {
  const enumValues = ['default', ...contextWindows.map(String)];
  return {
    type: 'string',
    title: '上下文大小',
    enum: enumValues,
    enumItemLabels: ['Default', ...contextWindows.map(formatContextWindow)],
    enumDescriptions: [
      'Use the provider default context budget',
      ...contextWindows.map((value) => `${formatContextWindow(value)} context budget`),
    ],
    default: contextWindows.at(-1)?.toString() ?? 'default',
    group: 'navigation',
  };
}

function getContextWindowOptions(model: AIXRouterModelConfig): number[] {
  const configured = model.contextWindows ?? [];
  const maxInputTokens = model.maxInputTokens ?? 0;
  const inferred = configured.length > 0
    ? configured
    : [200000, 400000, 1000000].filter((value) => value <= maxInputTokens);

  return [...new Set(inferred)].sort((a, b) => a - b);
}

function formatContextWindow(value: number): string {
  if (value >= 1000000) {
    return `${value / 1000000}M`;
  }
  return `${Math.round(value / 1000)}K`;
}

function buildThinkingSchema(): object {
  return {
    properties: {
      reasoningEffort: buildReasoningEffortProperty(),
    },
  };
}

function getConfiguredReasoningEffort(
  model: AIXRouterModelConfig,
  options: ModelOptions,
): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (!model.thinking) {
    return undefined;
  }

  const configured =
    options.modelConfiguration?.reasoningEffort ??
    options.configuration?.reasoningEffort ??
    getReasoningEffort();

  if (configured === 'none') {
    return undefined;
  }
  if (
    configured === 'low' ||
    configured === 'medium' ||
    configured === 'high' ||
    configured === 'max'
  ) {
    return configured;
  }
  return 'medium';
}

function getConfiguredContextWindow(
  model: AIXRouterModelConfig,
  options: ModelOptions,
): number | undefined {
  const configured =
    options.modelConfiguration?.contextWindow ??
    options.configuration?.contextWindow;

  if (typeof configured !== 'string' || configured === 'default') {
    return undefined;
  }

  const value = Number(configured);
  return getContextWindowOptions(model).includes(value) ? value : undefined;
}

function reportThinking(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  text: string,
): void {
  const ThinkingPart = (vscode as any).LanguageModelThinkingPart;
  if (typeof ThinkingPart === 'function') {
    progress.report(new ThinkingPart(text) as vscode.LanguageModelResponsePart);
  }
}

function reportToolCall(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  toolCall: ChatToolCall,
): void {
  let input: object = {};
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    input = {};
  }

  progress.report(
    new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, input),
  );
}

function reportUsage(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
): void {
  const DataPart = (vscode as any).LanguageModelDataPart;
  if (typeof DataPart !== 'function') {
    return;
  }

  progress.report(
    new DataPart(
      new TextEncoder().encode(JSON.stringify(usage)),
      'usage',
    ) as vscode.LanguageModelResponsePart,
  );
}

import type { AIXRouterModelConfig, AIXRouterPricing } from './types';

interface PublicModelMetadata {
  readonly name?: string;
  readonly localModelName?: string;
  readonly code?: string;
  readonly type?: string;
  readonly modelVendorName?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportedModalities?: unknown;
  readonly capabilityTags?: unknown;
  readonly currencyCode?: string;
  readonly inputPer1M?: number;
  readonly outputPer1M?: number;
  readonly cacheHitPer1M?: number;
  readonly cacheCreationPer1M?: number;
}

export interface PublicModelEnrichment {
  readonly name?: string;
  readonly family?: string;
  readonly sourceType?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly vision?: boolean;
  readonly pricing?: AIXRouterPricing;
}

export async function loadPublicModelEnrichment(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<Map<string, PublicModelEnrichment>> {
  const publicModelsUrl = getPublicModelsUrl(baseUrl);
  if (!publicModelsUrl) {
    return new Map();
  }

  const response = await fetch(publicModelsUrl, { signal });
  if (!response.ok) {
    return new Map();
  }

  const html = await response.text();
  const jsonText = extractClientModelsJson(html);
  if (!jsonText) {
    return new Map();
  }

  let models: PublicModelMetadata[];
  try {
    models = JSON.parse(jsonText) as PublicModelMetadata[];
  } catch {
    return new Map();
  }

  const map = new Map<string, PublicModelEnrichment>();
  for (const model of models) {
    const enrichment = toEnrichment(model);
    if (!enrichment) {
      continue;
    }

    for (const key of getPricingKeys(model)) {
      map.set(key, enrichment);
    }
  }

  return map;
}

function getPublicModelsUrl(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === 'aixrouter.com' || host.endsWith('.aixrouter.com')) {
      return 'https://www.aixrouter.com/models';
    }
    if (host === 'agilerouter.com' || host.endsWith('.agilerouter.com')) {
      return 'https://www.agilerouter.com/models';
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function mergePublicModelEnrichment(
  models: AIXRouterModelConfig[],
  enrichmentByModel: Map<string, PublicModelEnrichment>,
): AIXRouterModelConfig[] {
  return models.map((model) => {
    const enrichment = enrichmentByModel.get(normalizeKey(model.id));
    if (!enrichment) {
      return model;
    }

    const pricing = model.pricing ?? enrichment.pricing;
    const modelText = [
      model.id,
      model.name,
      enrichment.name,
      enrichment.family,
      enrichment.sourceType,
    ].filter(Boolean).join(' ').toLowerCase();

    return {
      ...model,
      name: model.name ?? enrichment.name,
      family: isPlaceholderFamily(model.family) ? enrichment.family ?? model.family : model.family,
      sourceType: model.sourceType ?? enrichment.sourceType,
      maxInputTokens: Math.max(model.maxInputTokens ?? 0, enrichment.maxInputTokens ?? 0) || model.maxInputTokens,
      maxOutputTokens: Math.max(model.maxOutputTokens ?? 0, enrichment.maxOutputTokens ?? 0) || model.maxOutputTokens,
      vision: model.vision === true || enrichment.vision === true ? true : model.vision ?? enrichment.vision,
      contextWindows: model.contextWindows?.length ? model.contextWindows : getContextWindowsFromEnrichment(enrichment, modelText),
      pricing,
      priceCategory: model.priceCategory ?? getPriceCategory(pricing?.outputPer1M),
    };
  });
}

export interface ModelCostInformation {
  readonly inputCost?: string;
  readonly outputCost?: string;
  readonly cacheCost?: string;
  readonly priceCategory?: 'low' | 'medium' | 'high' | 'very_high';
}

export function toModelCostInfo(model: AIXRouterModelConfig): ModelCostInformation {
  const pricing = model.pricing;
  if (!pricing) {
    return {};
  }

  return {
    inputCost: formatPriceValue(pricing.inputPer1M, pricing.currencyCode),
    outputCost: formatPriceValue(pricing.outputPer1M, pricing.currencyCode),
    cacheCost: formatPriceValue(pricing.cacheHitPer1M, pricing.currencyCode),
    ...(model.priceCategory ? { priceCategory: model.priceCategory } : {}),
  };
}

function extractClientModelsJson(html: string): string | undefined {
  const marker = 'const clientModelsJson = "';
  const start = html.indexOf(marker);
  if (start === -1) {
    return undefined;
  }

  const valueStart = start + marker.length;
  const valueEnd = findStringLiteralEnd(html, valueStart);
  if (valueEnd === -1) {
    return undefined;
  }

  const encoded = html.slice(valueStart, valueEnd);
  try {
    return JSON.parse(`"${encoded}"`) as string;
  } catch {
    return undefined;
  }
}

function findStringLiteralEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return index;
    }
  }
  return -1;
}

function toEnrichment(model: PublicModelMetadata): PublicModelEnrichment | undefined {
  const pricing = toPricing(model);
  const sourceType = model.type;
  const maxInputTokens = numberFrom(model.contextWindow);
  const maxOutputTokens = numberFrom(model.maxOutputTokens);
  const vision = sourceType?.toLowerCase() === 'multimodal' ? true : undefined;

  if (
    !model.name &&
    !model.modelVendorName &&
    !sourceType &&
    maxInputTokens === undefined &&
    maxOutputTokens === undefined &&
    vision === undefined &&
    !pricing
  ) {
    return undefined;
  }

  return {
    name: model.name,
    family: model.modelVendorName,
    sourceType,
    maxInputTokens,
    maxOutputTokens,
    vision,
    pricing,
  };
}

function toPricing(model: PublicModelMetadata): AIXRouterPricing | undefined {
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

function getPricingKeys(model: PublicModelMetadata): string[] {
  return [
    model.name,
    model.localModelName,
    model.code?.replace(/^dispatch:/i, ''),
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeKey);
}

function isPlaceholderFamily(value: string | undefined): boolean {
  return !value || value === 'kredo' || value === 'aixrouter';
}

function getContextWindowsFromEnrichment(
  enrichment: PublicModelEnrichment,
  modelText: string,
): number[] | undefined {
  const maxWindow = Math.max(enrichment.maxInputTokens ?? 0, inferMaxContextWindow(modelText));
  const windows = [200000, 400000, 1000000].filter((value) => value <= maxWindow);
  return windows.length ? windows : undefined;
}

function inferMaxContextWindow(modelText: string): number {
  if (
    /^claude-(haiku|sonnet|opus)-/.test(modelText) ||
    /^gemini-/.test(modelText) ||
    /^gpt-5(\b|[.-])/.test(modelText)
  ) {
    return 1000000;
  }
  return 200000;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function formatPriceValue(value: number | undefined, currencyCode: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const currency = currencyCode === 'CNY' ? '¥' : '$';
  const formatted = value === 0 ? '0.00' : value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return `${currency}${formatted}`;
}

function getPriceCategory(outputPer1M: number | undefined): 'low' | 'medium' | 'high' | 'very_high' | undefined {
  if (outputPer1M === undefined) {
    return undefined;
  }
  if (outputPer1M <= 2) {
    return 'low';
  }
  if (outputPer1M <= 10) {
    return 'medium';
  }
  if (outputPer1M <= 30) {
    return 'high';
  }
  return 'very_high';
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

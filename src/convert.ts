import * as vscode from 'vscode';
import { Buffer } from 'node:buffer';
import type { ChatMessage, ChatTool, ChatToolCall, OpenAIContentPart } from './types';

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
    const textParts: string[] = [];
    const contentParts: OpenAIContentPart[] = [];
    const toolCalls: ChatToolCall[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
        contentParts.push({ type: 'text', text: part.value });
        continue;
      }

      const imagePart = getImageDataPart(part);
      if (imagePart) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imagePart.mimeType};base64,${Buffer.from(imagePart.data).toString('base64')}`,
          },
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          callId: part.callId,
          content: part.content.map(partToText).join('') || JSON.stringify(part.content),
        });
      }
    }

    if (role === 'assistant') {
      if (textParts.length > 0 || toolCalls.length > 0) {
        result.push({
          role,
          content: textParts.join(''),
          tool_calls: toolCalls.length ? toolCalls : undefined,
        });
      }
    } else if (contentParts.some((part) => part.type === 'image_url')) {
      result.push({ role, content: contentParts });
    } else if (textParts.length > 0) {
      result.push({ role, content: textParts.join('') });
    }

    for (const toolResult of toolResults) {
      result.push({
        role: 'tool',
        content: toolResult.content,
        tool_call_id: toolResult.callId,
      });
    }
  }

  return result;
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ChatTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined,
    },
  }));
}

export function estimateTokenCount(text: string | vscode.LanguageModelChatRequestMessage): number {
  const value =
    typeof text === 'string'
      ? text
      : text.content.map(partToText).join('');
  return estimateTextTokens(value);
}

function estimateTextTokens(value: string): number {
  const cjkMatches = value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? [];
  const nonCjkLength = value.length - cjkMatches.length;
  return Math.max(1, cjkMatches.length + Math.ceil(nonCjkLength / 4));
}

function partToText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  const imagePart = getImageDataPart(part);
  if (imagePart) {
    return `[${imagePart.mimeType}; ${imagePart.data.byteLength} bytes]`;
  }
  return '';
}

export function summarizeMessageParts(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
  return messages
    .map((message, messageIndex) => `${messageIndex}:${message.content.map(summarizePart).join('+')}`)
    .join('|');
}

function summarizePart(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return 'text';
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return 'tool_call';
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return 'tool_result';
  }

  const dataPart = getDataPart(part);
  if (dataPart) {
    return `${dataPart.mimeType || 'data'}:${dataPart.data.byteLength}`;
  }

  if (!part || typeof part !== 'object') {
    return typeof part;
  }

  const objectPart = part as Record<string, unknown>;
  const ctor = (part as { constructor?: { name?: string } }).constructor?.name ?? 'object';
  const keys = Object.keys(objectPart).slice(0, 8).join(',');
  const value = objectPart.value;
  if (value && typeof value === 'object') {
    const valueKeys = Object.keys(value as Record<string, unknown>).slice(0, 8).join(',');
    return `${ctor}{${keys}}.value{${valueKeys}}`;
  }
  return `${ctor}{${keys}}`;
}

function getImageDataPart(part: unknown): { mimeType: string; data: Uint8Array } | undefined {
  const dataPart = getDataPart(part);
  if (dataPart?.mimeType.startsWith('image/')) {
    return dataPart;
  }

  return undefined;
}

function getDataPart(part: unknown): { mimeType: string; data: Uint8Array } | undefined {
  if (part instanceof vscode.LanguageModelDataPart) {
    return { mimeType: part.mimeType, data: part.data };
  }

  if (!part || typeof part !== 'object') {
    return undefined;
  }

  const candidate = part as Record<string, unknown>;
  const mimeType = stringValue(candidate.mimeType) ?? stringValue(candidate.mime_type) ?? stringValue(candidate.mediaType) ?? '';
  if (mimeType) {
    const data = bytesValue(candidate.data) ?? bytesValue(candidate.value) ?? bytesValue(candidate.bytes);
    if (data) {
      return { mimeType, data };
    }

    const dataUrl = stringValue(candidate.data) ?? stringValue(candidate.value) ?? stringValue(candidate.url);
    const fromDataUrl = dataUrl ? dataPartFromDataUrl(dataUrl, mimeType) : undefined;
    if (fromDataUrl) {
      return fromDataUrl;
    }
  }

  const nested = candidate.value ?? candidate.part ?? candidate.content;
  if (nested && nested !== part) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const dataPart = getDataPart(item);
        if (dataPart) {
          return dataPart;
        }
      }
      return undefined;
    }

    return getDataPart(nested);
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bytesValue(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function dataPartFromDataUrl(value: string, fallbackMimeType: string): { mimeType: string; data: Uint8Array } | undefined {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return undefined;
  }

  return {
    mimeType: match[1] || fallbackMimeType,
    data: Buffer.from(match[2], 'base64'),
  };
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  const SystemRole = (vscode.LanguageModelChatMessageRole as unknown as { System?: vscode.LanguageModelChatMessageRole }).System;
  if (SystemRole !== undefined && role === SystemRole) {
    return 'system';
  }
  return 'user';
}

import * as vscode from 'vscode';
import { getDebugEnabled } from './config';

export class Logger {
  private readonly channel = vscode.window.createOutputChannel('AIXRouter for Copilot');

  dispose(): void {
    this.channel.dispose();
  }

  info(message: string): void {
    this.channel.appendLine(formatLogLine('info', message));
  }

  debug(message: string): void {
    if (getDebugEnabled()) {
      this.channel.appendLine(formatLogLine('debug', message));
    }
  }

  error(message: string, error?: unknown): void {
    this.channel.appendLine(formatLogLine('error', message));
    if (error) {
      this.channel.appendLine(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }

  show(): void {
    this.channel.show();
  }
}

export function formatLogLine(level: 'info' | 'debug' | 'error', message: string, date = new Date()): string {
  return `[${date.toISOString()}] [${level}] ${message}`;
}

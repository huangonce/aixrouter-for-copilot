import * as vscode from 'vscode';
import { AuthStore } from './auth';
import { hasBaseUrl, openSettings, setBaseUrl } from './config';
import { Logger } from './logger';
import { AIXRouterChatProvider } from './provider';

const INITIAL_SETUP_PROMPT_KEY = 'magicrouter.initialSetupPromptShown';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  const auth = new AuthStore(context.secrets);
  const provider = new AIXRouterChatProvider(auth, logger);

  provider.registerConfigWatcher(context);

  context.subscriptions.push(
    logger,
    provider,
    vscode.commands.registerCommand('magicrouter.setBaseUrl', async () => {
      await setBaseUrl();
      provider.refreshModelPicker();
    }),
    vscode.commands.registerCommand('magicrouter.setApiKey', async () => {
      await auth.setApiKey();
      provider.refreshModelPicker();
    }),
    vscode.commands.registerCommand('magicrouter.clearApiKey', async () => {
      await auth.clearApiKey();
      provider.refreshModelPicker();
    }),
    vscode.commands.registerCommand('magicrouter.refreshModels', () => {
      provider.refreshModelPicker();
      vscode.window.showInformationMessage('Magic Router model list refreshed.');
    }),
    vscode.commands.registerCommand('magicrouter.openSettings', () => openSettings()),
    vscode.lm.registerLanguageModelChatProvider('magicrouter', provider),
  );

  await activateCopilotChat(logger);
  provider.refreshModelPicker();
  void promptForInitialConfiguration(context, auth, provider);
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered in activate.
}

async function activateCopilotChat(logger: Logger): Promise<void> {
  try {
    await vscode.extensions.getExtension('github.copilot-chat')?.activate();
  } catch (error) {
    logger.error('Could not activate GitHub Copilot Chat. The model picker may refresh later.', error);
  }
}

async function promptForInitialConfiguration(
  context: vscode.ExtensionContext,
  auth: AuthStore,
  provider: AIXRouterChatProvider,
): Promise<void> {
  if (hasBaseUrl() && await auth.hasApiKey()) {
    return;
  }
  if (context.globalState.get<boolean>(INITIAL_SETUP_PROMPT_KEY, false)) {
    return;
  }

  await context.globalState.update(INITIAL_SETUP_PROMPT_KEY, true);

  const action = await vscode.window.showInformationMessage(
    'Configure Magic Router for Copilot to add models to Copilot Chat.',
    'Configure',
    'Open Settings',
    'Later',
  );

  if (action === 'Open Settings') {
    await openSettings();
    return;
  }

  if (action !== 'Configure') {
    return;
  }

  if (!hasBaseUrl() && !await setBaseUrl()) {
    return;
  }

  if (!await auth.hasApiKey()) {
    await auth.setApiKey();
  }

  provider.refreshModelPicker();
}

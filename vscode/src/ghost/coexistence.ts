import * as vscode from 'vscode';

/** Extensions known to show their own inline suggestions. */
const OTHER_PROVIDERS = ['github.copilot', 'github.copilot-chat'];
const DISMISSED_KEY = 'slipstream.otherProvidersNoticeDismissed';

let shownThisSession = false;

/**
 * VS Code has no API for one inline-suggestion provider to silence another,
 * so when you start practising with Copilot installed, say so once. Tab and
 * Shift+Tab still type Slipstream's ghost (they're bound to our own context
 * key), but Copilot's grey text can show up next to or instead of ours.
 */
export async function noticeOtherProviders(context: vscode.ExtensionContext) {
  if (shownThisSession || context.globalState.get<boolean>(DISMISSED_KEY)) return;
  const other = OTHER_PROVIDERS.map((id) => vscode.extensions.getExtension(id)).find((e) => e?.isActive);
  if (!other) return;
  shownThisSession = true;

  const name = (other.packageJSON as { displayName?: string }).displayName ?? 'Copilot';
  const choice = await vscode.window.showInformationMessage(
    `${name} may show its own suggestions while you practise. Tab still types Slipstream's ghost; to see only ours, turn off ${name}'s inline suggestions for now.`,
    'Open Copilot Settings',
    "Don't Show Again",
  );
  if (choice === 'Open Copilot Settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'github.copilot.enable');
  if (choice === "Don't Show Again") await context.globalState.update(DISMISSED_KEY, true);
}

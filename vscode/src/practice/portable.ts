import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { log } from '../log';
import { Sessions } from '../steps/Sessions';
import { LOCAL_LINK_FILE, readLink, writeLocalOverride } from '../target/links';
import { TargetStore } from '../target/TargetStore';
import { ignoreLocalLink } from './git';
import { remember } from './practice';

const run = promisify(execFile);

/**
 * Practice repositories that travel: clone one onto this machine and make sure
 * it finds its project — a local checkout, the committed path, or the remote.
 */
export async function clonePracticeRepo(context: vscode.ExtensionContext, store: TargetStore, args?: { url?: string; parent?: string; show?: boolean }) {
  const url =
    args?.url ??
    (await vscode.window.showInputBox({
      title: 'Slipstream: clone a practice repository',
      prompt: 'Git URL (or local path) of the practice repository',
      placeHolder: 'https://github.com/you/practice-myproject.git',
    }));
  if (!url) return undefined;
  const parent =
    args?.parent ??
    (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Clone into this folder' }))?.[0]?.fsPath;
  if (!parent) return undefined;

  const name = url.replace(/\.git\/?$/, '').split(/[/:\\]/).filter(Boolean).pop() ?? 'practice';
  const dest = path.join(parent, name);
  if (fs.existsSync(dest)) {
    void vscode.window.showErrorMessage(`${dest} already exists.`);
    return undefined;
  }
  try {
    await run('git', ['clone', '--quiet', url, dest], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    log.error(`Cloning practice repository ${url} failed`, e);
    void vscode.window.showErrorMessage(`Could not clone ${url}: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }

  const link = readLink(dest);
  if (!link) {
    void vscode.window.showWarningMessage(`${name} was cloned, but it is not a Slipstream practice folder (no .slipstream/link.json).`);
    return dest;
  }
  if (link.source === 'path' && !fs.existsSync(link.targetRoot) && args?.show !== false) {
    // No remote to fall back on, and the committed path isn't on this machine.
    await pickLocalCheckout(store, dest);
  }
  await ensureIgnored(dest);
  await remember(context, dest);
  store.invalidate();
  if (args?.show === false) return dest;

  const where = readLink(dest);
  const via =
    where?.source === 'remote' ? `the remote ${where.remote!.url}` : where?.source === 'override' ? 'your local checkout' : 'its project folder';
  const choice = await vscode.window.showInformationMessage(
    `Cloned ${name}. It practises against ${via}.`,
    'Open in New Window',
    'Add to Workspace',
    ...(where?.source === 'remote' ? ['Use a Local Checkout Instead…'] : []),
  );
  const uri = vscode.Uri.file(dest);
  if (choice === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  if (choice === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
  if (choice === 'Use a Local Checkout Instead…') await pickLocalCheckout(store, dest);
  return dest;
}

/** Point this machine at a local checkout of a practice folder's project (link.local.json). */
export async function pickLocalCheckout(store: TargetStore, practiceRoot?: string, checkout?: string) {
  const root = practiceRoot ?? (await pickPracticeFolder());
  if (!root) return;
  const link = readLink(root);
  const folder =
    checkout ??
    (await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'This is the project',
      title: `Where is the project for ${path.basename(root)} on this machine?${link?.remote ? ` (${link.remote.url}${link.remote.path ? `, folder ${link.remote.path}` : ''})` : ''}`,
    }))?.[0]?.fsPath;
  if (!folder) return;
  writeLocalOverride(root, folder);
  await ensureIgnored(root);
  store.invalidate();
  await vscode.commands.executeCommand('slipstream.steps.refresh');
}

/** Stop using a local checkout: go back to the committed path or the remote. */
export async function clearLocalCheckout(store: TargetStore, practiceRoot?: string) {
  const root = practiceRoot ?? (await pickPracticeFolder());
  if (!root) return;
  fs.rmSync(path.join(root, LOCAL_LINK_FILE), { force: true });
  store.invalidate();
  await vscode.commands.executeCommand('slipstream.steps.refresh');
}

export async function storeProgress(sessions: Sessions, practiceRoot?: string) {
  const root = practiceRoot ?? (await pickPracticeFolder());
  if (!root) return;
  await sessions.storeProgressInFolder(root);
  void vscode.window.showInformationMessage(
    'Progress is now stored in .slipstream/progress.json in the practice folder. Commit it to take it to other machines.',
  );
}

/** link.local.json is per machine: keep it out of the practice repository if it is one. */
async function ensureIgnored(practiceRoot: string) {
  if (fs.existsSync(path.join(practiceRoot, '.git'))) ignoreLocalLink(practiceRoot);
}

async function pickPracticeFolder(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    for (let dir = path.dirname(editor.document.uri.fsPath); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
      if (readLink(dir)) return dir;
    }
  }
  return (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Practice folder' }))?.[0]?.fsPath;
}

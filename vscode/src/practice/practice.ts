import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readLink, writeLink } from '../target/links';
import { TargetStore } from '../target/TargetStore';
import { excludeFromGit, initPracticeRepo } from './git';
import { hideFromSearch } from './search';

/** Practice folders this machine knows about, so "Open Practice Folder" can find external ones. */
export const KNOWN_KEY = 'slipstream.practiceFolders';

/** Turn an existing folder into a practice folder for a project. */
export async function linkPracticeFolder(context: vscode.ExtensionContext, store: TargetStore) {
  const practice = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Practise in this folder' }))?.[0];
  if (!practice) return;
  const target = (await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: 'Type towards this folder',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  }))?.[0];
  if (!target) return;
  if (practice.fsPath === target.fsPath) {
    void vscode.window.showErrorMessage('Pick two different folders.');
    return;
  }
  writeLink(practice.fsPath, target.fsPath);
  const hidden = { git: await excludeFromGit(target.fsPath, practice.fsPath), search: await hideFromSearch(practice.fsPath) };
  await remember(context, practice.fsPath);
  store.invalidate();
  await announce(practice.fsPath, hidden);
}

/** Open one of the known practice folders for the current project in a new window. */
export async function openPracticeFolder(context: vscode.ExtensionContext) {
  const projects = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const known = context.globalState
    .get<string[]>(KNOWN_KEY, [])
    .map((p) => readLink(p))
    .filter((l) => !!l && fs.existsSync(l.practiceRoot) && (projects.length === 0 || projects.includes(l.targetRoot)));
  if (known.length === 0) {
    void vscode.window.showInformationMessage('No practice folders yet. Run "Slipstream: Start Practice".');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    known.map((l) => ({ label: path.basename(l!.practiceRoot), description: l!.practiceRoot, detail: `→ ${l!.targetRoot}` })),
    { title: 'Open practice folder in a new window' },
  );
  if (pick) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(pick.description), { forceNewWindow: true });
}

export async function pickProject(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Open the project you want to practise first.');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which project do you want to practise?' });
}


export async function remember(context: vscode.ExtensionContext, practiceRoot: string) {
  const known = context.globalState.get<string[]>(KNOWN_KEY, []);
  if (!known.includes(practiceRoot)) await context.globalState.update(KNOWN_KEY, [...known, practiceRoot]);
}

export async function announce(practiceRoot: string, hidden: { git: boolean; search: boolean }) {
  const inWorkspace = !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(practiceRoot));
  const from = [hidden.git && 'git', hidden.search && 'search'].filter(Boolean).join(' and ');
  const note = from ? ` (hidden from ${from})` : '';
  const actions = [...(inWorkspace ? ['Reveal in Explorer'] : ['Open in New Window', 'Add to Workspace']), 'Set Up Agent…'];
  const choice = await vscode.window.showInformationMessage(
    `Practice folder ready: ${practiceRoot}${note}. Open files there and type.`,
    ...actions,
  );
  const uri = vscode.Uri.file(practiceRoot);
  if (choice === 'Reveal in Explorer') await vscode.commands.executeCommand('revealInExplorer', uri);
  if (choice === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  if (choice === 'Set Up Agent…') await vscode.commands.executeCommand('slipstream.setUpAgent');
  if (choice === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
}

/** Offer to make a new practice folder its own git repository, so it can be pushed and cloned elsewhere. */
export async function offerGitInit(practiceRoot: string, message: string) {
  if (fs.existsSync(path.join(practiceRoot, '.git'))) return;
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(repo) Make it a git repository', description: 'recommended', detail: 'Commit your practice as you go, push it, and clone it onto another machine.', yes: true },
      { label: 'Not now', detail: 'You can run `git init` in it any time.', yes: false },
    ],
    { title: 'Slipstream: make the practice folder its own git repository?' },
  );
  if (!pick?.yes) return;
  try {
    const { committed } = await initPracticeRepo(practiceRoot, message);
    if (!committed) {
      void vscode.window.showInformationMessage(
        'Practice folder is a git repository now. Nothing was committed: set git user.name and user.email, then commit.',
      );
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`git init failed: ${(e as Error).message}`);
  }
}

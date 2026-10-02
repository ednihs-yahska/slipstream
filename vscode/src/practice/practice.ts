import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside, META_DIR, readLink, writeLink } from '../target/links';
import { TargetStore } from '../target/TargetStore';
import { excludeFromGit, gitArchive, gitInfo, recentCommits } from './git';
import { pickCommit } from './pickers';
import { hideFromSearch } from './search';

/** Practice folders this machine knows about, so "Open Practice Folder" can find external ones. */
export const KNOWN_KEY = 'slipstream.practiceFolders';

/**
 * Create a practice folder linked to a project: where it lives (inside the
 * project by default, or anywhere) and what it starts from (a commit, or empty).
 */
export async function startPractice(context: vscode.ExtensionContext, store: TargetStore) {
  const project = await pickProject();
  if (!project) return;
  const targetRoot = project.uri.fsPath;

  const defaultDir = vscode.workspace.getConfiguration('slipstream', project.uri).get<string>('defaultPracticeDir', '.slipstream/practice');
  const inside = path.resolve(targetRoot, defaultDir);
  const where = await vscode.window.showQuickPick(
    [
      { label: '$(folder) Inside this project', description: path.relative(targetRoot, inside), dir: inside },
      { label: '$(folder-opened) Somewhere else…', description: 'pick or create any folder', dir: undefined },
    ],
    { title: 'Slipstream: where do you want to practise?' },
  );
  if (!where) return;
  const practiceRoot =
    where.dir ??
    (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Practise here' }))?.[0]?.fsPath;
  if (!practiceRoot) return;
  if (practiceRoot === targetRoot || isInside(targetRoot, practiceRoot)) {
    void vscode.window.showErrorMessage('The practice folder must not be the project or contain it.');
    return;
  }

  if (!hasUserFiles(practiceRoot)) {
    const seeded = await seed(targetRoot, practiceRoot);
    if (seeded === undefined) return;
  }

  writeLink(practiceRoot, targetRoot);
  const hidden = { git: await excludeFromGit(targetRoot, practiceRoot), search: await hideFromSearch(practiceRoot) };
  await remember(context, practiceRoot);
  store.invalidate();
  await announce(practiceRoot, hidden);
}

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

function hasUserFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name !== META_DIR);
  } catch {
    return false;
  }
}

/** Fill a new practice folder. Returns undefined if cancelled. */
async function seed(targetRoot: string, practiceRoot: string): Promise<string | undefined> {
  const git = await gitInfo(targetRoot);
  type Item = vscode.QuickPickItem & { ref?: string; custom?: boolean };
  const items: Item[] = [];
  if (git) {
    items.push(
      { label: '$(git-commit) Last commit (HEAD)', description: git.dirty ? 'without the uncommitted changes' : undefined, detail: 'Use this when the agent’s changes are not committed yet: you retype exactly those changes.', ref: 'HEAD' },
      { label: '$(history) An earlier commit…', detail: 'Pick from the history: you retype everything since then, up to your current files.', custom: true },
    );
  }
  items.push({ label: '$(new-folder) Empty', detail: 'Create every file yourself.', ref: '' });

  const pick = await vscode.window.showQuickPick(items, { title: 'Slipstream: what should the practice folder start from?' });
  if (!pick) return undefined;
  let ref = pick.ref;
  if (pick.custom) {
    const commits = await recentCommits(targetRoot).catch(() => []);
    const commit = await pickCommit(targetRoot, commits, 'Slipstream: start from which commit?', { allowRevision: true });
    if (!commit) return undefined;
    ref = commit.hash;
  }

  fs.mkdirSync(practiceRoot, { recursive: true });
  if (ref && git) {
    try {
      await gitArchive(targetRoot, `${ref}:${git.prefix}`, practiceRoot);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not copy ${ref}: ${(e as Error).message}`);
      return undefined;
    }
  }
  return ref;
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

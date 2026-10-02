import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside, Link, META_DIR, readLink, updateLink, writeLink } from '../target/links';
import { TargetStore } from '../target/TargetStore';
import { changedBetween, changedSince, commitsInRange, excludeFromGit, gitArchive, originOf, parentOf, repoPaths } from './git';
import { history, pickCommit } from './pickers';
import { log } from '../log';
import { pickProject, remember } from './practice';
import { hideFromSearch } from './search';

/**
 * Replay git history: retype a commit (or a run of commits) from an existing
 * repo. The practice folder starts at the commit's parent; the target is the
 * commit itself, read from git, so your checkout is never touched.
 */

/** Create a replay practice folder (no UI; the commands below wrap it). */
export async function createReplay(opts: { targetRoot: string; practiceRoot: string; commits: string[] }) {
  const { targetRoot, practiceRoot, commits } = opts;
  if (commits.length === 0) throw new Error('No commits to replay.');
  fs.mkdirSync(practiceRoot, { recursive: true });
  if (hasUserFiles(practiceRoot)) throw new Error(`${practiceRoot} is not empty.`);
  const parent = await parentOf(targetRoot, commits[0]);
  if (parent) {
    const { prefix } = await repoPaths(targetRoot);
    await gitArchive(targetRoot, `${parent}:${prefix}`, practiceRoot);
  }
  // Record the project's origin too, so a practice repo cloned elsewhere can still find it.
  const remote = await originOf(targetRoot);
  writeLink(practiceRoot, targetRoot, {
    ref: commits[0],
    replay: commits.length > 1 ? { commits, index: 0 } : undefined,
    ...(remote ? { remote } : {}),
  });
}

/**
 * Move a range replay on to its next commit. The practice folder now matches
 * the current commit, which is the next one's parent, so it just keeps going.
 * Returns false if there is no next commit.
 */
export function advanceReplay(practiceRoot: string): boolean {
  const link = readLink(practiceRoot);
  const replay = link?.replay;
  if (!link || !replay || replay.index + 1 >= replay.commits.length) return false;
  const index = replay.index + 1;
  updateLink(practiceRoot, { ref: replay.commits[index], replay: { ...replay, index } });
  return true;
}

/**
 * After the last commit of a replay: switch the target from that commit to the
 * project's current files, so you go on to type everything since (later
 * commits outside the range and uncommitted work). Returns false if this
 * isn't a replay.
 */
export function continueToWorkingTree(practiceRoot: string): boolean {
  // Only a link that pins a commit can continue. (A remote link always *reads* a
  // commit, but following a branch pins nothing.)
  if (!pinnedRef(practiceRoot)) return false;
  // Dropping the pinned commit leaves the working tree, or a remote's branch, as the target.
  updateLink(practiceRoot, { ref: undefined, replay: undefined });
  return true;
}

/** Whether a replay at its last commit has anything left to type in the current files. */
export async function moreAfterReplay(practiceRoot: string): Promise<boolean> {
  const link = readLink(practiceRoot);
  if (!link?.ref || !pinnedRef(practiceRoot)) return false;
  if (link.replay && link.replay.index + 1 < link.replay.commits.length) return false;
  return moreAfter(link);
}

/**
 * Whether the project has moved on since the link's pinned commit: for a
 * local project, later commits or uncommitted work; for a remote one, the
 * tracked branch having moved past it.
 */
export function moreAfter(link: Link): Promise<boolean> {
  if (!link.ref) return Promise.resolve(false);
  if (link.source === 'remote') return changedBetween(link.targetRoot, link.ref, link.remote?.ref ?? 'HEAD').catch(() => false);
  return changedSince(link.targetRoot, link.ref).catch(() => false);
}

/** The commit link.json pins, if any — not the one a remote branch currently resolves to. */
export function pinnedRef(practiceRoot: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(practiceRoot, META_DIR, 'link.json'), 'utf8'));
    return typeof raw.ref === 'string' && raw.ref ? raw.ref : undefined;
  } catch {
    return undefined;
  }
}

export async function replayContinue(store: TargetStore, practiceRoot?: string, pendingSteps = 0) {
  practiceRoot ??= findReplayRoot();
  if (!practiceRoot) {
    void vscode.window.showInformationMessage('No commit replay in progress.');
    return;
  }
  if (pendingSteps > 0) {
    const ok = await vscode.window.showWarningMessage(
      `${pendingSteps} step${pendingSteps === 1 ? '' : 's'} left in this commit. Continue to your current files anyway? What's left carries over.`,
      { modal: true },
      'Continue',
    );
    if (ok !== 'Continue') return;
  }
  if (!continueToWorkingTree(practiceRoot)) return;
  store.invalidate();
  await vscode.commands.executeCommand('slipstream.steps.refresh');
  void vscode.window.showInformationMessage('Now typing towards your current files: everything since the replayed commits.');
}

export async function replayCommit(context: vscode.ExtensionContext, store: TargetStore) {
  const project = await pickProject();
  if (!project) return;
  const targetRoot = project.uri.fsPath;
  const commits = await history(targetRoot);
  if (!commits) return;
  const pick = await pickCommit(targetRoot, commits, 'Slipstream: which commit do you want to retype?', { allowRevision: true });
  if (!pick) return;
  await start(context, store, targetRoot, [pick.hash], `commit ${pick.short} "${pick.subject}"`);
}

export async function replayRange(context: vscode.ExtensionContext, store: TargetStore) {
  const project = await pickProject();
  if (!project) return;
  const targetRoot = project.uri.fsPath;
  const commits = await history(targetRoot);
  if (!commits) return;
  const from = await pickCommit(targetRoot, commits, 'Slipstream: replay from which commit? (the oldest one you want to type)', {
    allowRevision: true,
  });
  if (!from) return;
  const at = commits.findIndex((c) => c.hash === from.hash);
  const newer = at >= 0 ? commits.slice(0, at + 1) : commits;
  const to = await pickCommit(targetRoot, newer, 'Slipstream: …up to which commit?', { newestIsHead: true });
  if (!to) return;
  let range: string[];
  try {
    range = await commitsInRange(targetRoot, from.hash, to.hash);
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return;
  }
  await start(context, store, targetRoot, range, `${range.length} commit${range.length === 1 ? '' : 's'}, ${from.short}..${to.short}`);
}

/** "Next Commit": from the Steps view, the completion notice, or the command palette. */
export async function replayNextCommit(store: TargetStore, practiceRoot?: string, pendingSteps = 0) {
  practiceRoot ??= findReplayRoot();
  if (!practiceRoot) {
    void vscode.window.showInformationMessage('No commit replay in progress.');
    return;
  }
  if (pendingSteps > 0) {
    const ok = await vscode.window.showWarningMessage(
      `${pendingSteps} step${pendingSteps === 1 ? '' : 's'} left in this commit. Move on anyway? What's left carries over into the next commit's steps.`,
      { modal: true },
      'Next Commit',
    );
    if (ok !== 'Next Commit') return;
  }
  if (!advanceReplay(practiceRoot)) {
    if (await moreAfterReplay(practiceRoot)) {
      const choice = await vscode.window.showInformationMessage(
        'That was the last commit of the replay. Continue to your current files (later commits and uncommitted changes)?',
        'Continue to Current Files',
      );
      if (choice) await replayContinue(store, practiceRoot);
    } else {
      void vscode.window.showInformationMessage('That was the last commit of the replay.');
    }
    return;
  }
  store.invalidate();
  await vscode.commands.executeCommand('slipstream.steps.refresh');
}

function findReplayRoot(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor ? findUp(editor.document.uri.fsPath) : undefined;
}

function findUp(file: string): string | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (readLink(dir)?.ref) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

async function start(context: vscode.ExtensionContext, store: TargetStore, targetRoot: string, commits: string[], what: string) {
  const practiceRoot = await pickLocation(targetRoot);
  if (!practiceRoot) return;
  try {
    await createReplay({ targetRoot, practiceRoot, commits });
  } catch (e) {
    log.error(`Could not start the replay in ${practiceRoot}`, e);
    void vscode.window.showErrorMessage(`Could not start the replay: ${(e as Error).message}`);
    return;
  }
  await excludeFromGit(targetRoot, practiceRoot);
  await hideFromSearch(practiceRoot);
  await remember(context, practiceRoot);
  store.invalidate();
  await vscode.commands.executeCommand('slipstream.steps.focus');
  void vscode.window.showInformationMessage(`Replaying ${what} in ${practiceRoot}. Work through the Steps view.`);
}

/** `.slipstream/replay` inside the project, or anywhere; offers to clear a folder that's in use. */
async function pickLocation(targetRoot: string): Promise<string | undefined> {
  const inside = path.join(targetRoot, META_DIR, 'replay');
  const where = await vscode.window.showQuickPick(
    [
      { label: '$(folder) Inside this project', description: path.relative(targetRoot, inside), dir: inside },
      { label: '$(folder-opened) Somewhere else…', description: 'pick or create any folder', dir: undefined },
    ],
    { title: 'Slipstream: where do you want to type the replay?' },
  );
  if (!where) return undefined;
  const dir =
    where.dir ??
    (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Replay here' }))?.[0]?.fsPath;
  if (!dir) return undefined;
  if (dir === targetRoot || isInside(targetRoot, dir)) {
    void vscode.window.showErrorMessage('The replay folder must not be the project or contain it.');
    return undefined;
  }
  if (fs.existsSync(dir) && hasUserFiles(dir)) {
    const ok = await vscode.window.showWarningMessage(
      `${dir} already has files (an earlier replay?). Move them to the trash and start over?`,
      { modal: true },
      'Move to Trash',
    );
    if (ok !== 'Move to Trash') return undefined;
    for (const name of fs.readdirSync(dir)) {
      await vscode.workspace.fs.delete(vscode.Uri.file(path.join(dir, name)), { recursive: true, useTrash: true });
    }
  }
  return dir;
}

function hasUserFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name !== META_DIR);
  } catch {
    return false;
  }
}

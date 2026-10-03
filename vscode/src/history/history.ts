import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';
import { branches, Commit, extractAt, neighbours, parentOf, recentCommits, resettableEntries, saveIfRepo } from '../practice/git';
import { pickBranch } from '../practice/pickers';
import { pinnedRef } from '../practice/replay';
import { Session, Sessions } from '../steps/Sessions';
import { clearLinkCache, readLink, updateLink } from '../target/links';
import { fetchRemote } from '../target/remotes';
import { TargetStore } from '../target/TargetStore';

/**
 * The History view: the source's commits, newest first, under "Latest". The
 * commit you're typing towards is marked. Click one (or Older / Newer) to move
 * there; each move asks whether to *type that commit* (the practice folder is
 * reset to its parent) or *keep my files* (only the target changes).
 */
export type Node = { type: 'latest'; session: Session } | { type: 'commit'; session: Session; commit: Commit };

export class HistoryView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private cache = new Map<string, { key: string; commits: Commit[] }>();

  constructor(private readonly sessions: Sessions) {
    sessions.onDidChange(() => this.emitter.fire());
    vscode.window.onDidChangeActiveTextEditor(() => this.emitter.fire());
  }

  refresh() {
    this.cache.clear();
    this.emitter.fire();
  }

  /** The practice folder the view shows: the one you're typing in, else the first. */
  current(): Session | undefined {
    const editor = vscode.window.activeTextEditor;
    return (editor && this.sessions.sessionFor(editor.document.uri.fsPath)) ?? this.sessions.list()[0];
  }

  async commits(session: Session): Promise<Commit[]> {
    const link = session.link;
    const branch = link.branch ?? 'HEAD';
    // The resolved commit is in the key whenever a branch is read from git, so a moved branch is re-read.
    const key = `${link.targetRoot}|${branch}|${link.pinned ? '' : (link.ref ?? '')}`;
    const hit = this.cache.get(link.practiceRoot);
    if (hit?.key === key) return hit.commits;
    const commits = await recentCommits(link.targetRoot, 200, branch).catch(() => [] as Commit[]);
    this.cache.set(link.practiceRoot, { key, commits });
    return commits;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return [];
    const session = this.current();
    if (!session) return [];
    return [{ type: 'latest', session }, ...(await this.commits(session)).map((commit): Node => ({ type: 'commit', session, commit }))];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const pinned = pinnedRef(node.session.link.practiceRoot);
    const root = node.session.link.practiceRoot;
    if (node.type === 'latest') {
      const here = !pinned;
      const item = new vscode.TreeItem(here ? 'Latest  (typing towards this)' : 'Latest');
      const { link } = node.session;
      item.description =
        link.source === 'remote'
          ? `${link.branch ?? 'default branch'} on the remote`
          : link.branch && !link.pinned && link.ref
            ? `${link.branch}, as last committed`
            : link.branch
              ? `${link.branch}, the project as it is now`
              : 'the project as it is now';
      item.iconPath = new vscode.ThemeIcon(here ? 'circle-filled' : 'circle-outline');
      item.command = { title: 'Go here', command: 'slipstream.goToCommit', arguments: [root, 'latest'] };
      item.contextValue = 'latest';
      return item;
    }
    const { commit } = node;
    const here = pinned === commit.hash;
    const item = new vscode.TreeItem(commit.subject);
    item.description = `${commit.short} · ${commit.when}${here ? ' · typing this' : ''}`;
    item.tooltip = `${commit.subject}\n${commit.short} by ${commit.author}, ${commit.when}\n\nClick to go to this commit.`;
    item.iconPath = new vscode.ThemeIcon(here ? 'circle-filled' : 'git-commit');
    item.command = { title: 'Go to commit', command: 'slipstream.goToCommit', arguments: [root, commit.hash] };
    item.contextValue = 'commit';
    return item;
  }
}

export type Mode = 'reset' | 'keep';

/**
 * Move a practice folder to a commit (or 'latest'). `mode` answers the "type
 * that commit or keep my files" question; asked if not given.
 */
export async function goToCommit(store: TargetStore, sessions: Sessions, practiceRoot: string, target: string, mode?: Mode): Promise<boolean> {
  const link = readLink(practiceRoot);
  if (!link) return false;
  const gitDir = link.targetRoot;

  if (target === 'latest') {
    // Your files are already whatever you've typed; only the target changes.
    updateLink(practiceRoot, { ref: undefined, replay: undefined });
    return finish(store, sessions);
  }

  const short = target.slice(0, 7);
  mode ??= await askMode(short);
  if (!mode) return false;

  if (mode === 'reset') {
    const saved = await saveIfRepo(practiceRoot, `Practice, before moving to ${short}`);
    if (saved === 'not-a-repo' || saved === 'failed') {
      const ok = await vscode.window.showWarningMessage(
        `Move the files in ${path.basename(practiceRoot)} to the trash, and start again at the parent of ${short}?` +
          (saved === 'failed' ? ' (Committing them to the practice repository failed.)' : ''),
        { modal: true },
        'Move to Trash',
      );
      if (ok !== 'Move to Trash') return false;
    }
    try {
      for (const entry of resettableEntries(practiceRoot)) {
        await vscode.workspace.fs.delete(vscode.Uri.file(entry), { recursive: true, useTrash: saved !== 'committed' && saved !== 'clean' });
      }
      const parent = await parentOf(gitDir, target);
      if (parent) await extractAt(gitDir, parent, practiceRoot);
    } catch (e) {
      log.error(`Resetting ${practiceRoot} to the parent of ${short} failed`, e);
      void vscode.window.showErrorMessage(`Could not reset the practice folder: ${(e as Error).message.split('\n')[0]}`);
      return false;
    }
  }
  updateLink(practiceRoot, { ref: target, replay: undefined });
  return finish(store, sessions);
}

/**
 * Practise another branch: a git-URL source is fetched first, so branches
 * pushed since are offered too. Your files stay as they are; the target moves
 * to the branch's Latest, and the History view lists its commits.
 */
export async function switchBranch(store: TargetStore, sessions: Sessions, practiceRoot: string, branch?: string): Promise<boolean> {
  let link = readLink(practiceRoot);
  if (!link) return false;
  if (link.source === 'remote' && link.remote) {
    const remote = link.remote;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Fetching ${remote.url}` }, () => fetchRemote(remote));
    } catch (e) {
      log.warn(`Fetching ${remote.url} failed; offering the cached branches (${(e as Error).message.split('\n')[0]})`);
    }
    clearLinkCache();
    link = readLink(practiceRoot)!;
  }
  const known = await branches(link.targetRoot).catch(() => []);
  if (branch === undefined) {
    const pick = await pickBranch(known, link.source === 'remote' ? 'default' : 'checked out', {
      always: true,
      selected: link.branch ?? known.find((b) => b.current)?.name,
    });
    if (!pick) {
      if (pick === undefined) void vscode.window.showInformationMessage('No branches found for this practice folder.');
      return false;
    }
    branch = pick.name;
  } else if (!known.some((b) => b.name === branch)) {
    void vscode.window.showErrorMessage(`There's no branch "${branch}" here.`);
    return false;
  }

  // The remote's ref names the branch on any machine (origin/x is x there); a local link also records it as `branch`.
  const onRemote = link.remote ? { ...link.remote, ref: branch.replace(/^origin\//, '') } : undefined;
  updateLink(practiceRoot, {
    ...(link.source === 'remote' ? { remote: { ...link.remote!, ref: branch } } : { branch, ...(onRemote ? { remote: onRemote } : {}) }),
    ref: undefined,
    replay: undefined,
  });
  return finish(store, sessions);
}

/** Older / newer than the commit you're on, in the History view's order. */
export async function stepHistory(store: TargetStore, sessions: Sessions, view: HistoryView, direction: 'older' | 'newer', mode?: Mode) {
  const session = view.current();
  if (!session) return;
  const commits = await view.commits(session);
  const { older, newer } = neighbours(commits, pinnedRef(session.link.practiceRoot));
  const to = direction === 'older' ? older?.hash : (newer?.hash ?? (pinnedRef(session.link.practiceRoot) ? 'latest' : undefined));
  if (!to) {
    void vscode.window.showInformationMessage(direction === 'older' ? 'This is the oldest commit in the history.' : 'Already at the latest.');
    return;
  }
  await goToCommit(store, sessions, session.link.practiceRoot, to, mode);
}

async function askMode(short: string): Promise<Mode | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: `$(git-commit) Type commit ${short}`, detail: 'Reset the practice folder to its parent, then retype exactly what it changed (uncommitted practice is committed first if the folder is a git repo, else moved to the trash)', mode: 'reset' as const },
      { label: '$(files) Keep my files', detail: `Only the target changes to ${short}; the steps show what's left from where you are`, mode: 'keep' as const },
    ],
    { title: `Slipstream: go to ${short}` },
  );
  return pick?.mode;
}

async function finish(store: TargetStore, sessions: Sessions): Promise<boolean> {
  store.invalidate();
  await sessions.refresh();
  return true;
}

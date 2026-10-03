import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from '../log';
import { isInside, writeLink } from '../target/links';
import { cacheDirFor, ensureClone, fetchRemote, isCloned, Remote } from '../target/remotes';
import { TargetStore } from '../target/TargetStore';
import { Branch, branches, Commit, extractAt, originOf, parentOf, recentCommits } from './git';
import { pickBranch, pickCommit } from './pickers';
import { offerGitInit, remember } from './practice';

/**
 * New Practice: a practice folder of its own, outside any project, typed
 * towards a source — a local folder or a git URL — from a starting point:
 *   - one commit (the folder starts at its parent; you type exactly that commit);
 *   - a commit to the latest (the folder starts at the commit; you type everything since);
 *   - empty (you type the whole project).
 * When the source has more than one branch, you pick the branch first: its
 * commits are the ones offered, and its tip is "Latest".
 * Works from any window; no project needs to be open.
 */
export type SourceChoice = { kind: 'local'; root: string } | { kind: 'remote'; remote: Remote };
export type StartChoice = { kind: 'commit'; commit: string } | { kind: 'since'; commit: string } | { kind: 'empty' };

export interface NewPracticeArgs {
  source?: SourceChoice;
  /** The branch to practise; asked if the source has more than one. Undefined = the current/default branch. */
  branch?: string;
  start?: StartChoice;
  location?: string;
  /** false: no prompts after creation (tests). */
  show?: boolean;
}

export async function newPractice(context: vscode.ExtensionContext, store: TargetStore, args: NewPracticeArgs = {}): Promise<string | undefined> {
  const source = args.source ?? (await pickSource());
  if (!source) return undefined;

  // Where git reads history from: the local folder, or the remote's cached clone.
  let gitDir: string | undefined;
  try {
    gitDir = source.kind === 'local' ? source.root : await withProgress(`Fetching ${source.remote.url}`, () => cloneOrFetch(source.remote));
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not fetch ${source.kind === 'remote' ? source.remote.url : ''}: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }
  const known = await branches(gitDir).catch(() => [] as Branch[]);
  const branch = args.branch !== undefined ? known.find((b) => b.name === args.branch) ?? { name: args.branch, current: false } : await pickBranch(known, source.kind === 'remote' ? 'default' : 'checked out');
  if (branch === null) return undefined;
  // Only a branch other than the current/default one is written down: without one, links follow HEAD as before.
  const chosen = branch && !branch.current ? branch.name : undefined;
  const history = await recentCommits(gitDir, 200, chosen ?? (source.kind === 'remote' ? (source.remote.ref ?? 'HEAD') : 'HEAD')).catch(() => [] as Commit[]);

  const start = args.start ?? (await pickStart(gitDir, history));
  if (!start) return undefined;

  const name = sourceName(source);
  const location = args.location ?? (await pickLocation(name, source));
  if (!location) return undefined;

  fs.mkdirSync(location, { recursive: true });
  if (fs.readdirSync(location).some((n) => n !== '.slipstream')) {
    void vscode.window.showErrorMessage(`${location} isn't empty. Pick an empty or new folder.`);
    return undefined;
  }
  try {
    if (start.kind === 'commit') {
      const parent = await parentOf(gitDir, start.commit);
      if (parent) await extractAt(gitDir, parent, location);
    } else if (start.kind === 'since') {
      await extractAt(gitDir, start.commit, location);
    }
  } catch (e) {
    log.error(`Seeding ${location} failed`, e);
    void vscode.window.showErrorMessage(`Could not copy the starting commit: ${(e as Error).message.split('\n')[0]}`);
    return undefined;
  }

  const ref = start.kind === 'commit' ? start.commit : undefined;
  if (source.kind === 'local') {
    const origin = await originOf(source.root);
    // A remote-tracking branch (origin/x) is x on the remote, for a clone of the practice folder elsewhere.
    const onRemote = chosen && origin ? { ...origin, ref: chosen.replace(/^origin\//, '') } : origin;
    writeLink(location, source.root, { ...(ref ? { ref } : {}), ...(chosen ? { branch: chosen } : {}), ...(onRemote ? { remote: onRemote } : {}) });
  } else {
    // No local project: the link carries only the remote. A path can be added per machine later.
    const remote = chosen ? { ...source.remote, ref: chosen } : source.remote;
    fs.mkdirSync(path.join(location, '.slipstream'), { recursive: true });
    fs.writeFileSync(path.join(location, '.slipstream', 'link.json'), JSON.stringify({ remote, ...(ref ? { ref } : {}) }, null, 2) + '\n');
  }
  await remember(context, location);
  store.invalidate();
  if (args.show === false) return location;

  await offerGitInit(location, `Start practising ${name}${chosen ? ` on ${chosen}` : ''}${ref ? ` (commit ${ref.slice(0, 7)})` : ''}`);
  const uri = vscode.Uri.file(location);
  // An empty window has nothing to lose: the practice folder simply opens in it.
  if (!vscode.workspace.workspaceFolders?.length) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
    return location;
  }
  const choice = await vscode.window.showInformationMessage(
    `Practice folder ready: ${location}. Open it and work through the Steps view; the History view moves between commits.`,
    'Open Here',
    'Open in New Window',
    'Add to Workspace',
  );
  if (choice === 'Open Here') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
  if (choice === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  if (choice === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
  return location;
}

async function pickSource(): Promise<SourceChoice | undefined> {
  type Item = vscode.QuickPickItem & { root?: string; browse?: boolean; url?: boolean };
  const open = (vscode.workspace.workspaceFolders ?? []).map(
    (f): Item => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, detail: 'This window’s project', root: f.uri.fsPath }),
  );
  const pick = await vscode.window.showQuickPick<Item>(
    [
      ...open,
      { label: '$(folder-opened) Another local folder…', detail: 'Any project on disk; a git repository gives you its history', browse: true },
      { label: '$(cloud) A git URL…', detail: 'Fetched into a cache; nothing to clone by hand', url: true },
    ],
    { title: 'Slipstream: what do you want to practise?' },
  );
  if (!pick) return undefined;
  if (pick.root) return { kind: 'local', root: pick.root };
  if (pick.browse) {
    const folder = (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Practise this project' }))?.[0];
    return folder ? { kind: 'local', root: folder.fsPath } : undefined;
  }
  const url = await vscode.window.showInputBox({
    title: 'Slipstream: git URL to practise',
    placeHolder: 'https://github.com/owner/project.git',
    prompt: 'Any URL git can fetch (your git credentials are used for private repositories)',
  });
  if (!url) return undefined;
  const sub = await vscode.window.showInputBox({
    title: 'Slipstream: the project’s folder inside that repository',
    prompt: 'Leave empty for the whole repository, or e.g. "packages/app"',
  });
  if (sub === undefined) return undefined;
  return { kind: 'remote', remote: { url: url.trim(), ...(sub.trim() ? { path: sub.trim().replace(/^\/+|\/+$/g, '') } : {}) } };
}

async function pickStart(gitDir: string, history: Commit[]): Promise<StartChoice | undefined> {
  // (`start`, not `kind`: QuickPickItem already has a `kind` of its own.)
  type Item = vscode.QuickPickItem & { start: StartChoice['kind'] };
  const items: Item[] = [
    ...(history.length
      ? [
          { label: '$(git-commit) Type one commit…', detail: 'Start at its parent and retype exactly what it changed', start: 'commit' as const },
          { label: '$(history) From a commit to the latest…', detail: 'Start at that commit and retype everything since', start: 'since' as const },
        ]
      : []),
    { label: '$(new-folder) Empty', detail: 'Retype the whole project', start: 'empty' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Slipstream: where do you want to start?' });
  if (!pick) return undefined;
  if (pick.start === 'empty') return { kind: 'empty' };
  const commit = await pickCommit(gitDir, history, pick.start === 'commit' ? 'Slipstream: which commit do you want to type?' : 'Slipstream: start from which commit?', {
    allowRevision: true,
    newestIsHead: true,
  });
  return commit ? { kind: pick.start, commit: commit.hash } : undefined;
}

/** Default: ~/Slipstream/<name> (slipstream.practiceHome), never inside the source. */
async function pickLocation(name: string, source: SourceChoice): Promise<string | undefined> {
  const home = expandHome(vscode.workspace.getConfiguration('slipstream').get<string>('practiceHome', '~/Slipstream'));
  let dflt = path.join(home, name);
  for (let i = 2; fs.existsSync(dflt) && fs.readdirSync(dflt).length; i++) dflt = path.join(home, `${name}-${i}`);
  const pick = await vscode.window.showQuickPick(
    [
      { label: `$(folder) ${dflt}`, detail: 'A practice folder of its own, outside the project', dir: dflt },
      { label: '$(folder-opened) Somewhere else…', dir: undefined },
    ],
    { title: 'Slipstream: where should the practice folder go?' },
  );
  if (!pick) return undefined;
  const dir = pick.dir ?? (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Practise here' }))?.[0]?.fsPath;
  if (!dir) return undefined;
  if (source.kind === 'local' && (isInside(dir, source.root) || isInside(source.root, dir))) {
    void vscode.window.showErrorMessage('Pick a folder outside the project: practice folders are kept separate from it.');
    return undefined;
  }
  return dir;
}

function sourceName(source: SourceChoice): string {
  const raw = source.kind === 'local' ? path.basename(source.root) : (source.remote.path?.split('/').pop() ?? source.remote.url.replace(/\.git\/?$/, '').split(/[/:]/).pop() ?? 'project');
  return raw.replace(/[^\w.-]/g, '_') || 'project';
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** A fresh clone, or the cached one brought up to date: branches pushed since it was cloned are listed too. */
async function cloneOrFetch(remote: Remote): Promise<string> {
  if (!isCloned(cacheDirFor(remote))) return ensureClone(remote);
  try {
    return await fetchRemote(remote);
  } catch (e) {
    log.warn(`Fetching ${remote.url} failed; using the cached copy (${(e as Error).message.split('\n')[0]})`);
    return cacheDirFor(remote);
  }
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
}

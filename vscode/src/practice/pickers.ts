import * as vscode from 'vscode';
import { Commit, recentCommits, resolveRev } from './git';

/** Recent commits touching `dir`, or undefined (with an error shown) if there's no git history. */
export async function history(dir: string): Promise<Commit[] | undefined> {
  try {
    const commits = await recentCommits(dir);
    if (commits.length) return commits;
    void vscode.window.showErrorMessage('This folder has no commits yet.');
  } catch {
    void vscode.window.showErrorMessage('This needs a git repository.');
  }
  return undefined;
}

/**
 * Pick a commit from a list. With `allowRevision`, a first entry lets you type
 * any revision instead (a branch, a tag, `HEAD~5`, a hash older than the list).
 */
export async function pickCommit(
  dir: string,
  commits: Commit[],
  title: string,
  opts: { newestIsHead?: boolean; allowRevision?: boolean } = {},
): Promise<Commit | undefined> {
  type Item = vscode.QuickPickItem & { commit?: Commit; typeIt?: boolean };
  const items: Item[] = [
    ...(opts.allowRevision
      ? [{ label: '$(edit) Enter a revision…', detail: 'A branch, tag, HEAD~5, or any commit hash', typeIt: true }]
      : []),
    ...commits.map((c, i) => ({
      label: `$(git-commit) ${c.subject}`,
      description: `${c.short}${opts.newestIsHead && i === 0 ? ' (latest)' : ''}`,
      detail: `${c.author}, ${c.when}`,
      commit: c,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
  if (!pick?.typeIt) return pick?.commit;

  const rev = await vscode.window.showInputBox({ title, prompt: 'Any git revision', value: 'HEAD~1' });
  if (!rev) return undefined;
  try {
    const hash = await resolveRev(dir, rev);
    return commits.find((c) => c.hash === hash) ?? { hash, short: hash.slice(0, 7), subject: rev, author: '', when: '' };
  } catch {
    void vscode.window.showErrorMessage(`"${rev}" is not a commit in this repository.`);
    return undefined;
  }
}

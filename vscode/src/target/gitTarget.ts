import * as path from 'path';
import * as vscode from 'vscode';
import { readContentAtRef, toKey } from '../steps/scan';
import { Link } from './links';

/**
 * A target file as of a commit: `slipstream-git:/abs/path/file.ts?root=…&ref=…`.
 * Opens read-only in VS Code (Open Project File, Show Diff) and is what the
 * ghost text and steps are computed against during a replay.
 */
export const GIT_SCHEME = 'slipstream-git';

export function gitTargetUri(targetRoot: string, file: string, ref: string): vscode.Uri {
  return vscode.Uri.file(file).with({ scheme: GIT_SCHEME, query: new URLSearchParams({ root: targetRoot, ref }).toString() });
}

/** The project-side URI for a practice-relative path: a working-tree file, or a file as of the link's commit. */
export function targetUriFor(link: Link, rel: string): vscode.Uri {
  const file = path.join(link.targetRoot, rel);
  return link.ref ? gitTargetUri(link.targetRoot, file, link.ref) : vscode.Uri.file(file);
}

export function parseGitTargetUri(uri: vscode.Uri): { root: string; ref: string; rel: string } | undefined {
  if (uri.scheme !== GIT_SCHEME) return undefined;
  const q = new URLSearchParams(uri.query);
  const root = q.get('root');
  const ref = q.get('ref');
  if (!root || !ref) return undefined;
  return { root, ref, rel: toKey(path.relative(root, uri.fsPath)) };
}

/** Text of a git target; undefined if the file didn't exist in that commit. */
export async function readGitTarget(uri: vscode.Uri): Promise<string | undefined> {
  const p = parseGitTargetUri(uri);
  if (!p) return undefined;
  const content = await readContentAtRef(p.root, p.ref, p.rel);
  if (!content) return undefined;
  return content.text ?? '';
}

export class GitTargetProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = parseGitTargetUri(uri);
    const text = await readGitTarget(uri);
    if (text !== undefined) return text;
    return p ? `(${p.rel} does not exist in commit ${p.ref.slice(0, 8)})` : '';
  }
}

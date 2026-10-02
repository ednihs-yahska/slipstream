import * as path from 'path';
import * as vscode from 'vscode';
import { META_DIR } from '../target/links';

export const SEARCH_PATTERN = `**/${META_DIR}/**`;

/**
 * Hide in-project practice folders from Find in Files and Quick Open (both use
 * `search.exclude`), so you don't land on the project's copy of a file — or the
 * practice copy when you meant the project. The Explorer still shows them.
 *
 * Written to user settings, not the project's `.vscode/settings.json`, so it
 * never shows up in the repo (or as a difference between practice and project).
 * The pattern only matches Slipstream folders, so it is safe everywhere.
 * Returns whether the folder is now hidden.
 */
export async function hideFromSearch(practiceRoot: string): Promise<boolean> {
  if (!vscode.workspace.getConfiguration('slipstream').get<boolean>('hideFromSearch', true)) return false;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(practiceRoot));
  if (!folder) return false; // its own window: there you want search
  const rel = path.relative(folder.uri.fsPath, practiceRoot).split(path.sep);
  if (!rel.includes(META_DIR)) return false; // custom location: not covered by the pattern

  const search = vscode.workspace.getConfiguration('search');
  const user = search.inspect<Record<string, boolean>>('exclude')?.globalValue ?? {};
  if (user[SEARCH_PATTERN] !== true) {
    await search.update('exclude', { ...user, [SEARCH_PATTERN]: true }, vscode.ConfigurationTarget.Global);
  }
  return true;
}

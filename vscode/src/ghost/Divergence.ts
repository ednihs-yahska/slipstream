import * as vscode from 'vscode';
import { Hunk } from '../diff/hunks';
import { lineCol, targetRange } from '../diff/tolerance';
import { GIT_SCHEME } from '../target/gitTarget';
import { TargetStore } from '../target/TargetStore';

/**
 * When you write something different on purpose, make the project follow you:
 * a quick fix in the practice file writes your version of that change into
 * the project (the target), or opens the project file at that spot so you can
 * change it by hand.
 */
export class DivergenceActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(private readonly store: TargetStore) {}

  async provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> {
    const diff = await this.store.getDiff(doc);
    if (!diff) return [];
    const h = hunkAtOffset(diff.hunks, doc.offsetAt(range.start));
    if (!h) return [];

    const open = new vscode.CodeAction('Slipstream: Open in project to edit by hand', vscode.CodeActionKind.QuickFix);
    open.command = { title: open.title, command: 'slipstream.openInTarget', arguments: [doc.uri, h.start] };
    // A commit can't be edited: during a replay, only offer to look at it.
    if (diff.targetUri.scheme === GIT_SCHEME) {
      open.title = open.command.title = "Slipstream: Show the commit's version";
      return [open];
    }

    const mine = doc.getText().slice(h.start, h.end);
    const title = !mine
      ? 'Slipstream: Remove this from the project (I won’t write it)'
      : !h.insert
        ? 'Slipstream: Add my text to the project'
        : 'Slipstream: Use my version in the project';
    const apply = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
    apply.command = { title, command: 'slipstream.applyMine', arguments: [doc.uri, h.start] };
    return [apply, open];
  }
}

/** The hunk touching `offset` (including its edges). */
export function hunkAtOffset(hunks: readonly Hunk[], offset: number): Hunk | undefined {
  return hunks.find((h) => h.start <= offset && offset <= Math.max(h.end, h.start));
}

async function locate(store: TargetStore, uri: vscode.Uri | undefined, offset: number | undefined) {
  const editor = vscode.window.activeTextEditor;
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
  if (!doc) return undefined;
  const at = offset ?? (editor && editor.document === doc ? doc.offsetAt(editor.selection.active) : 0);
  const diff = await store.getDiff(doc);
  const h = diff && hunkAtOffset(diff.hunks, at);
  if (!diff || !h) return undefined;
  const r = targetRange(diff.all, h);
  const toPos = (o: number) => {
    const { line, character } = lineCol(diff.target, o);
    return new vscode.Position(line, character);
  };
  return { doc, diff, h, range: new vscode.Range(toPos(r.start), toPos(r.end)) };
}

/** Write my version of the change at the cursor into the project file, and save it. */
export async function applyMine(store: TargetStore, uri?: vscode.Uri, offset?: number) {
  const found = await locate(store, uri, offset);
  if (!found) {
    void vscode.window.showInformationMessage('No difference from the project here.');
    return;
  }
  const { doc, diff, h, range } = found;
  if (diff.targetUri.scheme === GIT_SCHEME) {
    void vscode.window.showInformationMessage("You're replaying a commit, which can't be changed. Keep your version, or match the commit.");
    return;
  }
  const mine = doc.getText().slice(h.start, h.end);

  if (diff.fromDirtyEditor) {
    // The diff came from your unsaved edits in the project file: edit that buffer, then save.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(diff.targetUri, range, mine.replace(/\r?\n/g, diff.targetEol));
    const target = await vscode.workspace.openTextDocument(diff.targetUri);
    if (!(await vscode.workspace.applyEdit(edit)) || !(await target.save())) {
      void vscode.window.showErrorMessage('Could not update the project file.');
      return;
    }
  } else {
    // Disk is the truth (an open editor may not have reloaded the agent's latest
    // write yet). Write the file; VS Code reloads any open editor for it.
    const r = targetRange(diff.all, h);
    const next = diff.target.slice(0, r.start) + mine + diff.target.slice(r.end);
    const out = next.replace(/\r?\n/g, diff.targetEol);
    await vscode.workspace.fs.writeFile(diff.targetUri, new TextEncoder().encode(out));
  }
  store.invalidate();
}

/** Open the project file beside the practice file, at the change under the cursor. */
export async function openInTarget(store: TargetStore, uri?: vscode.Uri, offset?: number) {
  const found = await locate(store, uri, offset);
  const editor = vscode.window.activeTextEditor;
  const targetUri = found?.diff.targetUri ?? (editor && store.resolveTargetUri(editor.document));
  if (!targetUri) return;
  const shown = await vscode.window.showTextDocument(targetUri, { viewColumn: vscode.ViewColumn.Beside });
  // If the file changed on disk and the editor hasn't caught up, reload it first.
  if (found && !found.diff.fromDirtyEditor && targetUri.scheme === 'file' && normalize(shown.document.getText()) !== normalize(found.diff.target)) {
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  if (found) {
    shown.selection = new vscode.Selection(found.range.start, found.range.end);
    shown.revealRange(found.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

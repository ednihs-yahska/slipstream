import * as vscode from 'vscode';
import { Hunk } from '../diff/hunks';

/**
 * Ghost text can only appear at the cursor. Everything else — text to delete,
 * places that still need typing — is shown with decorations.
 */
export class Decorations implements vscode.Disposable {
  private readonly remove = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  private readonly pending = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      margin: '0 2px 0 0',
    },
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  /** `ghosted` is the hunk currently shown as ghost text at the cursor. */
  /** In hint and (not yet revealed) delayed mode: a nudge right after the cursor instead of the code. */
  private readonly cursorHint = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 1ch',
    },
  });

  update(editor: vscode.TextEditor, hunks: readonly Hunk[], ghosted?: Hunk, hint?: string) {
    editor.setDecorations(
      this.cursorHint,
      hint ? [{ range: new vscode.Range(editor.selection.active, editor.selection.active), renderOptions: { after: { contentText: hint } } }] : [],
    );
    const doc = editor.document;

    const removes: vscode.Range[] = [];
    const pendings: vscode.DecorationOptions[] = [];
    for (const h of hunks) {
      if (h.end > h.start) {
        removes.push(new vscode.Range(doc.positionAt(h.start), doc.positionAt(h.end)));
      }
      // The hunk under the cursor is already showing as ghost text.
      if (h.insert && h !== ghosted) {
        const pos = doc.positionAt(h.start);
        const lines = h.insert.split('\n').length;
        pendings.push({
          range: new vscode.Range(pos, pos),
          renderOptions: { before: { contentText: lines > 1 ? `▸+${lines} lines` : '▸' } },
          hoverMessage: new vscode.MarkdownString()
            .appendCodeblock(h.insert, doc.languageId)
            .appendMarkdown('Wrote something different on purpose? `Cmd/Ctrl+.` on it to use your version in the project.'),
        });
      }
    }
    editor.setDecorations(this.remove, removes);
    editor.setDecorations(this.pending, pendings);
  }

  clear(editor: vscode.TextEditor) {
    editor.setDecorations(this.cursorHint, []);
    editor.setDecorations(this.remove, []);
    editor.setDecorations(this.pending, []);
  }

  dispose() {
    this.cursorHint.dispose();
    this.remove.dispose();
    this.pending.dispose();
  }
}

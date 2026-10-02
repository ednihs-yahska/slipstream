import * as vscode from 'vscode';
import { ghostAt, Ghost } from '../diff/tolerance';
import { TargetStore } from '../target/TargetStore';
import { truncateLines } from './acceptance';
import { currentMode, Reveal } from './modes';

/** The ghost at the cursor, or undefined if there is none. */
export async function ghostAtCursor(store: TargetStore, editor: vscode.TextEditor): Promise<Ghost | undefined> {
  if (!editor.selection.isEmpty) return undefined;
  const hunks = await store.getHunks(editor.document);
  if (!hunks) return undefined;
  const ghost = ghostAt(editor.document.getText(), hunks, editor.document.offsetAt(editor.selection.active));
  if (!ghost) return undefined;
  const maxLines = vscode.workspace.getConfiguration('slipstream').get<number>('maxGhostLines', 30);
  return { ...ghost, text: truncateLines(ghost.text, maxLines) };
}

/** Identifies the spot a ghost is at; typing a correct character moves it. */
export function ghostKey(doc: vscode.TextDocument, ghost: Ghost): string {
  return `${doc.uri.toString()}#${ghost.hunk.start}`;
}

export class GhostTextProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly store: TargetStore,
    private readonly reveal: Reveal,
  ) {}

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc) return undefined;
    const ghost = await ghostAtCursor(this.store, editor);
    if (!ghost) return undefined;
    const mode = currentMode();
    if (mode === 'hint' || (mode === 'delayed' && !this.reveal.revealed(ghostKey(doc, ghost)))) return undefined;
    return [new vscode.InlineCompletionItem(ghost.text, new vscode.Range(position, position))];
  }
}

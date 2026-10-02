import * as path from 'path';
import * as vscode from 'vscode';
import { computeHunks, Hunk, normalizeEol } from '../diff/hunks';
import { filterWhitespace } from '../diff/tolerance';
import { GIT_SCHEME, gitTargetUri, readGitTarget } from './gitTarget';
import { clearLinkCache, findLink, isInside, LINK_FILE, targetPathFor } from './links';

export interface Diff {
  targetUri: vscode.Uri;
  /** Target text, with the practice document's line endings. */
  target: string;
  /** Line ending the target file itself uses. */
  targetEol: '\n' | '\r\n';
  /** True if `target` came from an open editor with unsaved edits rather than disk. */
  fromDirtyEditor: boolean;
  /** Every hunk, in order (needed to map hunks onto the target). */
  all: Hunk[];
  /** The hunks to show. */
  hunks: Hunk[];
}

/**
 * Finds the target (the version you're working towards) for a practice
 * document and keeps the practice↔target hunks up to date.
 *
 * Targets come from, in order:
 *   1. an explicit mapping set with "Set Target File…"
 *   2. the practice folder's link (`.slipstream/link.json`, see links.ts)
 *
 * Later sources (e.g. a git commit) slot in by adding another lookup to
 * `resolveTargetUri`/`readTarget`.
 */
export class TargetStore implements vscode.Disposable {
  private readonly explicit = new Map<string, vscode.Uri>();
  private readonly targetText = new Map<string, { mtime: number; size: number; text: string }>();
  private readonly diffCache = new Map<string, { key: string; diff: Diff }>();
  private readonly targetWatchers = new Map<string, vscode.Disposable>();
  private readonly knownTargets = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires when any target's contents (or any link) change. */
  readonly onDidChangeTargets = this.emitter.event;

  constructor() {
    const links = vscode.workspace.createFileSystemWatcher(`**/${LINK_FILE.split(path.sep).join('/')}`);
    const onLinkChange = () => this.invalidate();
    links.onDidChange(onLinkChange);
    links.onDidCreate(onLinkChange);
    links.onDidDelete(onLinkChange);
    this.disposables.push(
      links,
      // Unsaved edits in an open target count too.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.knownTargets.has(e.document.uri.toString())) this.invalidate();
      }),
    );
  }

  setExplicitTarget(real: vscode.Uri, target: vscode.Uri) {
    this.explicit.set(real.toString(), target);
    this.watchTarget(path.dirname(target.fsPath), path.basename(target.fsPath));
    this.invalidate();
  }

  clearExplicitTarget(real: vscode.Uri) {
    this.explicit.delete(real.toString());
    this.invalidate();
  }

  resolveTargetUri(doc: vscode.TextDocument): vscode.Uri | undefined {
    const explicit = this.explicit.get(doc.uri.toString());
    if (explicit) return explicit;
    if (doc.uri.scheme !== 'file') return undefined;

    const target = targetPathFor(doc.uri.fsPath);
    if (!target) return undefined;
    const link = findLink(doc.uri.fsPath)!;
    // A commit never changes: nothing to watch.
    if (link.ref) return gitTargetUri(link.targetRoot, target, link.ref);
    this.watchTarget(link.targetRoot, '**/*', link.practiceRoot);
    return vscode.Uri.file(target);
  }

  /** Hunks between the document and its target (whitespace-only ones dropped in lenient mode). */
  async getHunks(doc: vscode.TextDocument): Promise<Hunk[] | undefined> {
    return (await this.getDiff(doc))?.hunks;
  }

  async getDiff(doc: vscode.TextDocument): Promise<Diff | undefined> {
    const targetUri = this.resolveTargetUri(doc);
    if (!targetUri) return undefined;
    const raw = await this.readTarget(targetUri);
    if (raw === undefined) return undefined;

    const lenient = vscode.workspace.getConfiguration('slipstream').get<string>('whitespace', 'lenient') === 'lenient';
    const key = `${doc.version}|${targetUri.toString()}|${raw.length}|${hash(raw)}|${lenient}`;
    const cached = this.diffCache.get(doc.uri.toString());
    if (cached?.key === key) return cached.diff;

    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const target = normalizeEol(raw, eol);
    const real = doc.getText();
    const all = computeHunks(real, target);
    const diff: Diff = {
      targetUri,
      target,
      targetEol: raw.includes('\r\n') ? '\r\n' : '\n',
      fromDirtyEditor: !!this.dirtyTarget(targetUri),
      all,
      hunks: lenient ? filterWhitespace(real, all) : all,
    };
    this.diffCache.set(doc.uri.toString(), { key, diff });
    return diff;
  }

  private async readTarget(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme === GIT_SCHEME) return readGitTarget(uri);
    // The target may be open with unsaved edits. If it isn't dirty, disk is the
    // truth: the agent may have just rewritten it and the editor not reloaded yet.
    const k = uri.toString();
    this.knownTargets.add(k);
    const dirty = this.dirtyTarget(uri);
    if (dirty) return dirty.getText();

    // Validate against mtime/size rather than trusting the watcher alone: the
    // agent may write a file moments before you act on it.
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      this.targetText.delete(k);
      return undefined;
    }
    const cached = this.targetText.get(k);
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) return cached.text;
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      this.targetText.set(k, { mtime: stat.mtime, size: stat.size, text });
      return text;
    } catch {
      return undefined;
    }
  }

  private dirtyTarget(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.toString() === uri.toString());
  }

  /** Watch a target folder (once). Changes under `ignoreRoot` are your own typing, not the target's. */
  private watchTarget(root: string, glob: string, ignoreRoot?: string) {
    const key = `${root}|${glob}`;
    if (this.targetWatchers.has(key)) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), glob));
    const onChange = (uri: vscode.Uri) => {
      if (!ignoreRoot || !isInside(uri.fsPath, ignoreRoot)) this.invalidate();
    };
    w.onDidChange(onChange);
    w.onDidCreate(onChange);
    w.onDidDelete(onChange);
    this.targetWatchers.set(key, w);
  }

  invalidate() {
    clearLinkCache();
    this.targetText.clear();
    this.diffCache.clear();
    this.emitter.fire();
  }

  dispose() {
    for (const d of [...this.disposables, ...this.targetWatchers.values()]) d.dispose();
    this.emitter.dispose();
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

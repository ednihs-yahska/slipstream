import { Step } from '../steps/StepModel';

/**
 * What to show in the ghost text's place when there is nothing to type at the
 * cursor: the next change in this file, else the next step — which may be an
 * action rather than typing (create a file and its folder, move, delete,
 * copy) — else "done". A hint, never insertable text: Tab can't type it.
 */
export interface GuidanceInput {
  /** Lines (0-based) where this file still has changes, in order. */
  changeLines: number[];
  cursorLine: number;
  /** The session's pending steps, in order. */
  pending: Step[];
  /** This file's practice-relative path. */
  currentPath?: string;
  /** Whether the folder a create step needs doesn't exist yet. */
  folderMissing?: (step: Step) => boolean;
  /** Use macOS key symbols. */
  mac?: boolean;
}

export function guidanceText(g: GuidanceInput): string | undefined {
  const k = (mac: string, other: string) => (g.mac ? mac : other);
  const nextChangeKey = k('⌥]', 'Alt+]');
  const nextStepKey = k('⌥⇧]', 'Alt+Shift+]');

  if (g.changeLines.length) {
    const next = g.changeLines.find((l) => l > g.cursorLine) ?? g.changeLines[0];
    return `◂ next change on line ${next + 1} · ${nextChangeKey}`;
  }
  const step = g.pending.find((s) => s.path !== g.currentPath || s.kind !== 'modify');
  if (!step) return g.pending.length ? undefined : '◂ all steps done ✓';
  switch (step.kind) {
    case 'create': {
      const dir = step.path.includes('/') ? step.path.slice(0, step.path.lastIndexOf('/')) : '';
      const folder = dir && g.folderMissing?.(step) ? ` (and its folder ${dir}/)` : '';
      return `◂ next: create ${step.path}${folder} · ${nextStepKey} creates it`;
    }
    case 'modify':
      return `◂ next: ${step.path}, ${step.changes} change${step.changes === 1 ? '' : 's'} · ${nextStepKey}`;
    case 'rename':
      return `◂ next: move ${step.from} → ${step.path} · ${nextStepKey}`;
    case 'delete':
      return `◂ next: delete ${step.path} · trash button in Steps`;
    case 'copy':
      return `◂ next: copy ${step.path} from the project · copy button in Steps`;
  }
}

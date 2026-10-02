import { describe, expect, it } from 'vitest';
import { guidanceText } from '../../src/ghost/guidance';
import { Step } from '../../src/steps/StepModel';

const base = { changeLines: [] as number[], cursorLine: 0, pending: [] as Step[], currentPath: 'src/a.ts' };

describe('guidanceText', () => {
  it('points at the next change in this file, wrapping around', () => {
    expect(guidanceText({ ...base, changeLines: [3, 10], cursorLine: 5 })).toBe('◂ next change on line 11 · Alt+]');
    expect(guidanceText({ ...base, changeLines: [3, 10], cursorLine: 12, mac: true })).toBe('◂ next change on line 4 · ⌥]');
  });

  it('when this file is done, says what the next step is, by kind', () => {
    const next = (step: Step, extra = {}) => guidanceText({ ...base, pending: [step], ...extra });
    expect(next({ kind: 'create', path: 'src/util/math.ts' }, { folderMissing: () => true })).toBe(
      '◂ next: create src/util/math.ts (and its folder src/util/) · Alt+Shift+] creates it',
    );
    expect(next({ kind: 'create', path: 'math.ts' }, { folderMissing: () => true })).toBe('◂ next: create math.ts · Alt+Shift+] creates it');
    expect(next({ kind: 'modify', path: 'src/b.ts', changes: 1 }, { mac: true })).toBe('◂ next: src/b.ts, 1 change · ⌥⇧]');
    expect(next({ kind: 'rename', path: 'lib/u.ts', from: 'u.ts' })).toBe('◂ next: move u.ts → lib/u.ts · Alt+Shift+]');
    expect(next({ kind: 'delete', path: 'old.ts' })).toBe('◂ next: delete old.ts · trash button in Steps');
    expect(next({ kind: 'copy', path: 'yarn.lock' })).toBe('◂ next: copy yarn.lock from the project · copy button in Steps');
  });

  it("skips this file's own modify step, and says when everything is done", () => {
    const pending: Step[] = [
      { kind: 'modify', path: 'src/a.ts', changes: 2 },
      { kind: 'create', path: 'b.ts' },
    ];
    expect(guidanceText({ ...base, pending })).toBe('◂ next: create b.ts · Alt+Shift+] creates it');
    expect(guidanceText({ ...base, pending: [] })).toBe('◂ all steps done ✓');
  });
});

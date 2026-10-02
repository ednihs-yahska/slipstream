import { describe, expect, it } from 'vitest';
import { computeHunks } from '../../src/diff/hunks';
import { filterWhitespace, ghostAt, lineCol, targetRange } from '../../src/diff/tolerance';

const lenient = (real: string, target: string) => filterWhitespace(real, computeHunks(real, target));

describe('whitespace', () => {
  it('lenient mode ignores indentation, spacing and blank-line differences', () => {
    const real = 'function f() {\n\tif (a)  {\n\t\treturn 1;\n\t}\n}\n';
    const target = 'function f() {\n  if (a) {\n    return 1;\n  }\n\n}\n';
    expect(lenient(real, target)).toEqual([]);
    expect(computeHunks(real, target).length).toBeGreaterThan(0);
  });

  it('still shows real changes next to whitespace changes', () => {
    const hs = lenient('if (a) {\n\treturn 1;\n}\n', 'if (a) {\n  return 2;\n}\n');
    expect(hs).toHaveLength(1);
    expect(hs[0].insert).toBe('2');
  });
});

describe('ghostAt', () => {
  it('shows the ghost when the cursor is exactly at the missing text', () => {
    const real = 'const x = ';
    expect(ghostAt(real, lenient(real, 'const x = 1;\n'), real.length)).toMatchObject({ text: '1;\n', replaceFrom: real.length });
  });

  it('tolerates editor auto-indent deeper than the target', () => {
    const real = 'if (a) {\n  b();\n    ';
    const g = ghostAt(real, computeHunks(real, 'if (a) {\n  b();\n}\n'), real.length);
    expect(g?.text).toBe('}\n');
    // Accepting types over the extra indentation.
    expect(real.slice(0, g!.replaceFrom)).toBe('if (a) {\n  b();\n');
  });

  it('tolerates a stray space before the cursor', () => {
    const real = 'foo ';
    expect(ghostAt(real, computeHunks(real, 'foo(1);\n'), real.length)).toMatchObject({ text: '(1);\n', replaceFrom: 3 });
  });

  it('does not show a ghost after real (non-space) text that differs', () => {
    const real = 'fox';
    expect(ghostAt(real, lenient(real, 'foo(1);\n'), real.length)).toBeUndefined();
  });
});

describe('targetRange', () => {
  it('maps each hunk onto the target, accounting for earlier hunks', () => {
    const real = 'const total = 1;\nkeep();\nlet a=2;\n';
    const target = 'const sum = 1;\nkeep();\nlet a = 2;\nmore();\n';
    const all = computeHunks(real, target);
    for (const h of all) {
      const r = targetRange(all, h);
      expect(target.slice(r.start, r.end)).toBe(h.insert);
    }
  });

  it('applying my text at the target range makes the hunk disappear', () => {
    const real = 'const total = 1;\nlog(total);\n';
    const target = 'const sum = 1;\nlog(total);\n';
    const all = computeHunks(real, target);
    const h = all[0];
    const r = targetRange(all, h);
    const newTarget = target.slice(0, r.start) + real.slice(h.start, h.end) + target.slice(r.end);
    expect(newTarget).toBe(real);
  });
});

describe('lineCol', () => {
  it('counts lines and columns', () => {
    expect(lineCol('ab\ncd\nef', 7)).toEqual({ line: 2, character: 1 });
    expect(lineCol('ab', 0)).toEqual({ line: 0, character: 0 });
  });
});

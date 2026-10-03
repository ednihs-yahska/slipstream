import { describe, expect, it } from 'vitest';
import { computeHunks } from '../../src/diff/hunks';
import { filterWhitespace, ghostAt, leadingBreak, lineCol, needsRoom, targetRange } from '../../src/diff/tolerance';

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

  it('keeps the ghost after a typo, remembering what was typed, so Tab can replace it', () => {
    const real = 'fox';
    const g = ghostAt(real, lenient(real, 'foo(1);\n'), real.length);
    expect(g).toMatchObject({ text: 'o(1);\n', replaceFrom: 2, mistyped: 'x' });
  });

  it('keeps it after a different word too, but not across lines or after a rewrite', () => {
    const word = 'const total';
    expect(ghostAt(word, lenient(word, 'const sum = 1;\n'), word.length)).toMatchObject({ mistyped: 'total', replaceFrom: 6 });
    const lines = 'a\nb';
    expect(ghostAt(lines, computeHunks(lines, 'xyz\n'), lines.length)).toBeUndefined();
    const long = 'q'.repeat(60);
    expect(ghostAt(long, computeHunks(long, 'z\n'), long.length)).toBeUndefined();
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

describe('needsRoom', () => {
  const ghostFor = (real: string, target: string, cursor: number) => ghostAt(real, computeHunks(real, target), cursor)!;

  it('is needed for new lines inserted in front of code on the cursor line', () => {
    const real = 'export function f() {}\n';
    const g = ghostFor(real, 'export interface O {}\n\nexport function f() {}\n', 0);
    expect(needsRoom(real, g, 0)).toBe(true);
  });

  it('is not needed on an empty line, at the end of a line, or for a mid-line insertion', () => {
    const blank = '\nexport function f() {}\n';
    expect(needsRoom(blank, ghostFor(blank, 'export interface O {}\n\nexport function f() {}\n', 0), 0)).toBe(false);
    const eol = 'a();\n'; // the new line goes on the empty last line, where nothing follows
    expect(needsRoom(eol, ghostFor(eol, 'a();\nb();\n', 5), 5)).toBe(false);
    const mid = 'foo()\n';
    expect(needsRoom(mid, ghostFor(mid, 'foo(a, b)\n', 4), 4)).toBe(false); // ")" follows, but the ghost is part of this line
  });
});

describe('leadingBreak', () => {
  const ghostFor = (real: string, target: string, cursor: number) => ghostAt(real, computeHunks(real, target), cursor)!;

  it('is the line break and indentation in front of a change that starts at the end of a line', () => {
    const real = 'if (x) {';
    expect(leadingBreak(ghostFor(real, 'if (x) {\n  go();', 8), 8)).toBe('\n  ');
    expect(leadingBreak(ghostFor(real, 'if (x) {\r\n\r\n  go();', 8), 8)).toBe('\r\n\r\n  '); // blank lines too, any line ending
  });

  it('is nothing for a ghost that starts with code, is only whitespace, or follows a mistake', () => {
    const eol = 'a();\n';
    expect(leadingBreak(ghostFor(eol, 'a();\nb();\n', 5), 5)).toBeUndefined();
    expect(leadingBreak(ghostFor('a();', 'a();\n\n', 4), 4)).toBeUndefined();
    const typo = 'if (x) {q';
    expect(leadingBreak(ghostFor(typo, 'if (x) {\n  go();', 9), 9)).toBeUndefined();
  });
});

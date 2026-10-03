import { describe, expect, it } from 'vitest';
import { declaredNames, offsetOf, orderUnits, pendingUnits, Unit, unitsOf, usesIn } from '../../src/order/units';

describe('units of a commit', () => {
  it('cuts each file into runs of changed lines, merging those only whitespace apart', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nC\nc\nd\nE\n';
    const units = unitsOf([{ rel: 'x.ts', before, after }]);
    expect(units.map((u) => after.slice(u.start, u.end))).toEqual(['B\nC', 'E']); // refined to words: the line breaks were already there
    expect(units.every((u) => !u.created)).toBe(true);
  });

  it('a new file is created, and one unit when it is all new', () => {
    const units = unitsOf([{ rel: 'n.ts', after: 'export const n = 1;\n\nexport const m = 2;\n' }]);
    expect(units).toHaveLength(1);
    expect(units[0].created).toBe(true);
  });
});

describe('ordering', () => {
  const u = (id: number, fileIndex: number, start: number): Unit => ({ id, rel: `f${fileIndex}`, start, end: start + 1, created: false, fileIndex });

  it('puts what a unit uses first, otherwise keeps file order and position', () => {
    const units = [u(0, 0, 0), u(1, 0, 10), u(2, 1, 0)];
    expect(orderUnits(units, []).map((x) => x.id)).toEqual([0, 1, 2]);
    expect(orderUnits(units, [[2, 0]]).map((x) => x.id)).toEqual([1, 2, 0]);
    expect(orderUnits(units, [[2, 0], [1, 2]]).map((x) => x.id)).toEqual([1, 2, 0]);
  });

  it('keeps a cycle together, in position order', () => {
    const units = [u(0, 0, 0), u(1, 1, 0), u(2, 2, 0)];
    expect(orderUnits(units, [[1, 2], [2, 1], [2, 0]]).map((x) => x.id)).toEqual([1, 2, 0]);
  });
});

describe('what is left', () => {
  it('a unit is pending until its text is typed; a missing file leaves all its units pending', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nB\nc\nd\nE\n';
    const units = unitsOf([{ rel: 'x.ts', before, after }]);
    const texts = new Map([['x.ts', after]]);
    expect([...pendingUnits(units, texts, () => before, false)]).toEqual([0, 1]);
    expect([...pendingUnits(units, texts, () => 'a\nB\nc\nd\ne\n', false)]).toEqual([1]);
    expect([...pendingUnits(units, texts, () => after, false)]).toEqual([]);
    expect([...pendingUnits(units, texts, () => undefined, false)]).toEqual([0, 1]);
  });
});

describe('names', () => {
  it('finds whole-word uses inside a unit only', () => {
    const text = 'const greetAll = 1;\ngreet(x); greet2(); $greet();\n';
    const unit: Unit = { id: 0, rel: 'x', start: 20, end: text.length, created: false, fileIndex: 0 };
    expect(usesIn(text, unit, 'greet')).toEqual([20]);
  });

  it('finds declarations without a language server, and maps line and column to offsets', () => {
    const text = 'export interface Opts {}\nfunction greet() {}\ndef run():\n';
    expect(declaredNames(text).map((d) => d.name)).toEqual(['Opts', 'greet', 'run']);
    expect(offsetOf(text, 1, 9)).toBe(text.indexOf('greet'));
  });
});

import { describe, expect, it } from 'vitest';
import { computeHunks, normalizeEol } from '../../src/diff/hunks';

describe('computeHunks', () => {
  it('returns nothing when real matches target', () => {
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('treats an empty file as one insertion at 0', () => {
    expect(computeHunks('', 'a\nb\n')).toEqual([{ start: 0, end: 0, insert: 'a\nb\n' }]);
  });

  it('points at the end of a half-typed line', () => {
    const real = 'imp';
    const target = 'import x from "x";\nx();\n';
    expect(computeHunks(real, target)).toEqual([
      { start: 3, end: 3, insert: 'ort x from "x";\nx();\n' },
    ]);
  });

  it('finds an insertion in the middle of a file', () => {
    const real = 'a\nfoo\nc\n';
    const target = 'a\nfoobar\nnew\nc\n';
    const [h] = computeHunks(real, target);
    expect(real.slice(0, h.start)).toBe('a\nfoo');
    expect(h).toMatchObject({ end: h.start, insert: 'bar\nnew' });
  });

  it('keeps separate hunks for separate edits', () => {
    const real = 'one\ntwo\nthree\nfour\nfive\n';
    const target = 'one\ntwo!\nthree\nfour\nfive!\n';
    const hunks = computeHunks(real, target);
    expect(hunks).toHaveLength(2);
    expect(hunks.map((h) => h.insert)).toEqual(['!', '!']);
  });

  it('reports text to remove', () => {
    const real = 'keep\ndrop me\nkeep\n';
    const target = 'keep\nkeep\n';
    const [h] = computeHunks(real, target);
    expect(real.slice(h.start, h.end)).toBe('drop me\n');
    expect(h.insert).toBe('');
  });

  it('handles an auto-closed bracket after the cursor', () => {
    const real = 'foo()\n';
    const target = 'foo(a, b)\n';
    const [h] = computeHunks(real, target);
    expect(h).toEqual({ start: 4, end: 4, insert: 'a, b' });
  });

  it('puts a new block above an edited line at the start of the line', () => {
    const real = 'export function greet(name: string): string {\n  return name;\n}\n';
    const target =
      'export interface Opts {\n  excited?: boolean;\n}\n\n' +
      'export function greet(name: string, opts: Opts = {}): string {\n  return name;\n}\n';
    const hunks = computeHunks(real, target);
    expect(hunks).toEqual([
      { start: 0, end: 0, insert: 'export interface Opts {\n  excited?: boolean;\n}\n\n' },
      { start: real.indexOf('):'), end: real.indexOf('):'), insert: ', opts: Opts = {}' },
    ]);
    expect(apply(real, hunks)).toBe(target);
  });

  it('does not anchor a new block on an unrelated closing brace', () => {
    const real = 'export function greet(name: string): string {\n  return `Hi ${name}`;\n}\n';
    const target =
      'export interface Opts {\n  excited?: boolean;\n}\n\n' +
      'export function greet(name: string, opts: Opts = {}): string {\n  const g = `Hi ${name}`;\n  return g;\n}\n';
    const hunks = computeHunks(real, target);
    expect(hunks[0]).toEqual({ start: 0, end: 0, insert: 'export interface Opts {\n  excited?: boolean;\n}\n\n' });
    expect(apply(real, hunks)).toBe(target);
  });

  it('shows a rewritten line as one replacement, not word confetti', () => {
    const real = 'const total = items.length;\n';
    const target = 'let sum = values.reduce((a, b) => a + b, 0);\n';
    expect(computeHunks(real, target)).toHaveLength(1);
  });

  it.each([
    ['a\nb\nc\nd\ne\n', 'a\nB\nc\nnew\nd\n'],
    ['', 'x\n'],
    ['x\n', ''],
    ['function f() {\n  return 1;\n}\n', 'function f(a) {\n  const b = a;\n  return b + 1;\n}\n'],
    ['one two three\n', 'zero one two two-and-a-half three four\n'],
  ])('applying every hunk produces the target (%#)', (real, target) => {
    expect(apply(real, computeHunks(real, target))).toBe(target);
  });
});

function apply(real: string, hunks: { start: number; end: number; insert: string }[]): string {
  let out = real;
  for (const h of [...hunks].reverse()) out = out.slice(0, h.start) + h.insert + out.slice(h.end);
  return out;
}

describe('normalizeEol', () => {
  it('converts both ways', () => {
    expect(normalizeEol('a\r\nb\n', '\n')).toBe('a\nb\n');
    expect(normalizeEol('a\r\nb\n', '\r\n')).toBe('a\r\nb\r\n');
  });
});

import { describe, expect, it } from 'vitest';
import { nextWord, restOfLine, truncateLines } from '../../src/ghost/acceptance';

describe('nextWord', () => {
  it.each([
    ['hello world', 'hello'],
    [' world', ' world'],
    ['(a, b)', '('],
    ['();\nx', '();'],
    ['=> {', '=>'],
    ['\n    return x;', '\n    '],
    ['\r\n  y', '\r\n  '],
    ['foo.bar', 'foo'],
  ])('%j -> %j', (ghost, expected) => {
    expect(nextWord(ghost)).toBe(expected);
  });
});

describe('restOfLine', () => {
  it.each([
    ['x = 1;\ny = 2;', 'x = 1;'],
    ['\n  y = 2;\nz', '\n  y = 2;'],
    ['\n\nz', '\n'],
    ['end', 'end'],
  ])('%j -> %j', (ghost, expected) => {
    expect(restOfLine(ghost)).toBe(expected);
  });
});

describe('restOfLine with code after the cursor', () => {
  it('takes the line break so existing code moves down', () => {
    expect(restOfLine('import x;\nimport y;\n', 'const z = 1;')).toBe('import x;\n');
  });
  it('does not when only whitespace follows', () => {
    expect(restOfLine('import x;\nimport y;\n', '  ')).toBe('import x;');
  });
  it('does not when the ghost line does not end in a line break', () => {
    expect(restOfLine('a, b', ')')).toBe('a, b');
  });
});

describe('truncateLines', () => {
  it('keeps at most N lines', () => {
    expect(truncateLines('a\nb\nc\nd', 2)).toBe('a\nb');
    expect(truncateLines('a\nb', 5)).toBe('a\nb');
  });
});

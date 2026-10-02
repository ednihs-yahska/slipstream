import { expect, it } from 'vitest';
import { hintFor } from '../../src/ghost/hint';

it('describes the code without giving it away', () => {
  expect(hintFor('export function clamp(v: number) {\n  return v;\n}\n')).toBe('◂ 3 lines · starts with `export` · defines clamp');
  expect(hintFor('(1);\n')).toBe('◂ 1 line · starts with `(`');
  expect(hintFor('  const total = 1;')).toBe('◂ 1 line · starts with `const`');
});

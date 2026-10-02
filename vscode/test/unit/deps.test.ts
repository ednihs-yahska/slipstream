import { describe, expect, it } from 'vitest';
import { definedSymbols, importCandidates, newSymbols, orderByDependencies } from '../../src/steps/deps';
import { Step } from '../../src/steps/StepModel';

describe('importCandidates', () => {
  it('resolves JS/TS relative imports, including .js-for-.ts and index files', () => {
    const c = importCandidates(
      'src/app/main.ts',
      `import { a } from './a';\nimport b from "../lib/b.js";\nexport * from './c';\nconst d = require('./d');\nawait import('./e');\nimport 'lodash';\n`,
    );
    for (const p of ['src/app/a.ts', 'src/lib/b.ts', 'src/app/c.ts', 'src/app/d.js', 'src/app/e.ts', 'src/app/a/index.ts']) {
      expect(c).toContain(p);
    }
    expect(c.some((p) => p.includes('lodash'))).toBe(false);
  });

  it('resolves Python relative and package imports', () => {
    const c = importCandidates('pkg/sub/mod.py', 'from .util import x\nfrom ..core import y\nfrom . import helpers\nimport pkg.models\n');
    for (const p of ['pkg/sub/util.py', 'pkg/core.py', 'pkg/sub/helpers.py', 'pkg/models.py', 'pkg/models/__init__.py']) {
      expect(c).toContain(p);
    }
  });
});

describe('orderByDependencies', () => {
  const s = (kind: Step['kind'], p: string): Step => ({ kind, path: p });
  const texts: Record<string, string> = {
    'src/app.ts': "import { greet } from './greet';\nimport { Opts } from './types';\n",
    'src/greet.ts': "import type { Opts } from './types';\n",
    'src/types.ts': 'export interface Opts {}\n',
    'src/z.ts': 'unrelated\n',
  };
  const order = (steps: Step[]) => orderByDependencies(steps, (p) => texts[p]).map((x) => x.path);

  it('puts imported files first, otherwise keeping the original order', () => {
    expect(
      order([s('create', 'src/app.ts'), s('modify', 'src/greet.ts'), s('create', 'src/types.ts'), s('create', 'src/z.ts'), s('delete', 'old.ts')]),
    ).toEqual(['src/types.ts', 'src/greet.ts', 'src/app.ts', 'src/z.ts', 'old.ts']);
  });

  it('survives import cycles', () => {
    const cyc: Record<string, string> = { 'a.ts': "import './b';", 'b.ts': "import './a';" };
    expect(orderByDependencies([s('create', 'a.ts'), s('create', 'b.ts')], (p) => cyc[p]).map((x) => x.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('definedSymbols', () => {
  it('finds top-level definitions across languages', () => {
    expect(
      definedSymbols(
        'export interface GreetOptions {}\nexport async function greet() {}\nexport const VERSION = 1;\nclass Local {}\nfunction helper() {\n  const inner = 1;\n}\n',
      ),
    ).toEqual(['GreetOptions', 'greet', 'VERSION', 'Local', 'helper']);
    expect(definedSymbols('def run():\n    def inner(): pass\nclass Model:\n    pass\n')).toEqual(['run', 'Model']);
    expect(definedSymbols('func (s *Server) Start() {}\npub fn main() {}\n')).toEqual(['Start', 'main']);
  });

  it('reports only what the practice file lacks', () => {
    expect(newSymbols('export function a() {}\n', 'export function a() {}\nexport function b() {}\n')).toEqual(['b']);
  });
});

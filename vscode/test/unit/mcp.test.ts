import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { listPracticeFolders, practiceProgress, readPracticeFile } from '../../src/mcp/tools';
import { writeLink } from '../../src/target/links';

let proj: string;
let practice: string;
beforeAll(() => {
  proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mcp-')));
  practice = path.join(proj, '.slipstream/practice');
  const w = (root: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w(proj, 'src/types.ts', 'export interface Opts {}\n');
  w(proj, 'src/greet.ts', "import { Opts } from './types';\nexport function greet(o: Opts) {}\n");
  w(proj, '.slipstream/plan.md', '# Plan: Greeting\n1. `src/types.ts`: the options type\n');
  w(practice, 'src/greet.ts', '// my attempt\n');
  writeLink(practice, proj);
});

describe('tools', () => {
  it('finds practice folders for a project', () => {
    expect(listPracticeFolders(proj)).toEqual([{ practice_dir: practice, target_dir: proj }]);
  });

  it('reports progress in plan/dependency order, with reasons and names', async () => {
    const p = await practiceProgress(practice);
    expect(p.plan_title).toBe('Greeting');
    expect(p.steps).toEqual([
      { kind: 'create', path: 'src/types.ts', lines: 1, reason: 'the options type', adds: ['Opts'] },
      { kind: 'modify', path: 'src/greet.ts', changes_left: 1, adds: ['greet'] },
    ]);
  });

  it('reads what the human typed, and nothing outside the practice folder', () => {
    expect(readPracticeFile(practice, 'src/greet.ts')).toBe('// my attempt\n');
    expect(() => readPracticeFile(practice, '../../src/types.ts')).toThrow(/not a file in the practice folder/);
    expect(() => readPracticeFile(practice, '.slipstream/link.json')).toThrow(/not a file in the practice folder/);
    expect(() => readPracticeFile(practice, 'src/types.ts')).toThrow(/hasn't created it/);
  });
});

describe('the MCP server over stdio', () => {
  it('lists its tools and answers calls', async () => {
    execFileSync('node', ['esbuild.mjs'], { stdio: 'pipe' });
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/mcp.js'] }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'slipstream_list_practice_folders',
        'slipstream_progress',
        'slipstream_read_practice_file',
      ]);
      expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);

      const res = await client.callTool({ name: 'slipstream_progress', arguments: { practice_dir: practice } });
      const body = JSON.parse((res.content as { text: string }[])[0].text);
      expect(body.steps_left).toBe(2);

      const bad = await client.callTool({ name: 'slipstream_progress', arguments: { practice_dir: os.tmpdir() } });
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 30000);
});

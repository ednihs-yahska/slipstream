import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';
import { listPracticeFiles } from '../../src/steps/scan';

// Regression: git exits at once outside a repository, before reading stdin. Writing more
// than a pipe buffer (64 KB) of names into it then raised an unhandled EPIPE that crashed
// the extension host. Only CI hit the timing; this forces it.
it('lists practice files when the target is not a git repo, however many there are', async () => {
  const practice = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipe-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pipe-target-'));
  const dir = path.join(practice, 'a-fairly-long-directory-name-to-fill-the-pipe');
  fs.mkdirSync(dir);
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(dir, `file-with-a-long-name-${i}.ts`), '');
  const files = await listPracticeFiles(practice, target);
  expect(files).toHaveLength(3000);
}, 30000);

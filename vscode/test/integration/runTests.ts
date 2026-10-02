import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '../../..');
  // Tests edit files, so run against a throwaway copy of the demo workspace.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-'));
  fs.cpSync(path.join(root, 'demo'), workspace, { recursive: true });

  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite', 'index'),
    // Short user-data path: macOS caps IPC socket paths at 103 chars.
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ud-'))}`],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

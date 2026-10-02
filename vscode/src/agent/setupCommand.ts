import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { excludeFiles, excludeFromGit } from '../practice/git';
import { pickProject } from '../practice/practice';
import { Sessions } from '../steps/Sessions';
import { isInside, META_DIR } from '../target/links';
import { InstructionsFile, personalFiles, planSetup, SetupChoice } from './setup';

export interface SetupArgs {
  projectRoot?: string;
  choice?: SetupChoice;
  /** Show the refactor preview before writing (default true). */
  preview?: boolean;
}

/**
 * Tell the agent a human will retype its changes (instructions file), and keep
 * Claude Code out of practice folders (deny rules in .claude/settings.local.json).
 * Everything is shown in VS Code's refactor preview before it's written.
 */
export async function setUpAgent(sessions: Sessions, args: SetupArgs = {}) {
  const projectRoot = args.projectRoot ?? (await pickProject())?.uri.fsPath;
  if (!projectRoot) return;
  const folders = practiceFolders(sessions, projectRoot);
  const choice = args.choice ?? (await ask(folders));
  if (!choice) return;

  let changes;
  try {
    changes = planSetup(choice, (rel) => {
      try {
        return fs.readFileSync(path.join(projectRoot, rel), 'utf8');
      } catch {
        return undefined;
      }
    });
  } catch (e) {
    void vscode.window.showErrorMessage((e as Error).message);
    return;
  }

  if (changes.length > 0) {
    const edit = new vscode.WorkspaceEdit();
    const meta: vscode.WorkspaceEditEntryMetadata = { label: 'Slipstream: agent setup', needsConfirmation: args.preview !== false };
    const uris: vscode.Uri[] = [];
    for (const c of changes) {
      const uri = vscode.Uri.file(path.join(projectRoot, c.path));
      uris.push(uri);
      if (fs.existsSync(uri.fsPath)) {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), c.content, meta);
      } else {
        edit.createFile(uri, { ignoreIfExists: true, contents: new TextEncoder().encode(c.content) }, meta);
      }
    }
    if (!(await vscode.workspace.applyEdit(edit))) return; // cancelled in the preview
    for (const uri of uris) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (doc?.isDirty) await doc.save();
    }
  }

  const hidden = await excludeFiles(projectRoot, personalFiles(choice));
  // The agent will write .slipstream/plan.md: keep it out of git too.
  if (choice.instructions) await excludeFromGit(projectRoot, path.join(projectRoot, META_DIR));
  const done = [
    ...(choice.instructions ? [`instructions in ${choice.instructions}`] : []),
    ...(choice.denyFolders?.length ? ['Claude Code kept out of practice folders'] : []),
  ];
  const note = hidden.length ? ` ${hidden.join(' and ')} kept out of git (.git/info/exclude).` : '';
  void vscode.window.showInformationMessage(
    changes.length === 0 ? 'The agent is already set up for Slipstream.' : `Agent set up: ${done.join('; ')}.${note}`,
  );
}

/** Practice folders inside this project: the defaults plus any that exist. */
function practiceFolders(sessions: Sessions, projectRoot: string): string[] {
  const rels = new Set([`${META_DIR}/practice`, `${META_DIR}/replay`]);
  for (const s of sessions.list()) {
    const root = s.link.practiceRoot;
    if (s.link.targetRoot === projectRoot && root !== projectRoot && isInside(root, projectRoot)) {
      rels.add(path.relative(projectRoot, root).split(path.sep).join('/'));
    }
  }
  return [...rels];
}

async function ask(folders: string[]): Promise<SetupChoice | undefined> {
  type Where = vscode.QuickPickItem & { file?: InstructionsFile };
  const where = await vscode.window.showQuickPick<Where>(
    [
      { label: 'CLAUDE.local.md', description: 'recommended: just you, not committed', detail: 'Claude Code reads it alongside CLAUDE.md.', file: 'CLAUDE.local.md' },
      { label: 'CLAUDE.md', description: 'shared with your team', detail: 'Everyone using Claude Code in this repo gets the instructions.', file: 'CLAUDE.md' },
      { label: 'AGENTS.md', description: 'other agents', detail: 'Read by many agents; Claude Code reads it only when there is no CLAUDE.md.', file: 'AGENTS.md' },
      { label: "Don't add instructions", detail: 'Skip this; the plan file just won’t be written unless you ask for it.' },
    ],
    { title: 'Slipstream: tell the agent a human will retype its changes. Where?' },
  );
  if (!where) return undefined;

  const keepOut = await vscode.window.showQuickPick(
    [
      { label: 'Yes, keep Claude Code out', description: 'recommended', detail: `Deny reading/editing ${folders.join(', ')} in .claude/settings.local.json (personal, not committed).`, yes: true },
      { label: 'No', detail: 'Rely on .git/info/exclude and the instructions alone.', yes: false },
    ],
    { title: 'Slipstream: keep Claude Code out of your practice folders?' },
  );
  if (!keepOut) return undefined;
  return { instructions: where.file, denyFolders: keepOut.yes ? folders : undefined };
}

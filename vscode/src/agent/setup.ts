import * as path from 'path';
import { mergeSection } from './instructions';

/**
 * What "Set Up Agent" writes into a project. Pure: returns new file contents;
 * the command shows them as a preview before anything is written.
 */

export type InstructionsFile = 'CLAUDE.local.md' | 'CLAUDE.md' | 'AGENTS.md';

export interface SetupChoice {
  /** Where to put the instructions, if anywhere. */
  instructions?: InstructionsFile;
  /** Add Claude Code deny rules for these practice folders (project-relative, '/'-separated). */
  denyFolders?: string[];
}

export interface FileChange {
  /** Project-relative path. */
  path: string;
  content: string;
}

/** Practice folders the agent should never read or edit, as Claude Code permission rules. */
export function denyRules(folders: string[]): string[] {
  // A leading "/" is relative to where Claude Code is started (the project root).
  return folders.flatMap((f) => {
    const dir = f.replace(/^\/+|\/+$/g, '');
    return [`Read(/${dir}/**)`, `Edit(/${dir}/**)`];
  });
}

/** Add deny rules to a Claude Code settings file's JSON, keeping everything else. */
export function mergeDenyRules(existing: string | undefined, rules: string[]): string {
  let settings: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      settings = JSON.parse(existing);
    } catch {
      throw new Error('.claude/settings.local.json is not valid JSON; fix it first, then run setup again.');
    }
  }
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as string[]) : [];
  const merged = [...deny, ...rules.filter((r) => !deny.includes(r))];
  return JSON.stringify({ ...settings, permissions: { ...permissions, deny: merged } }, null, 2) + '\n';
}

export const CLAUDE_LOCAL_SETTINGS = path.posix.join('.claude', 'settings.local.json');

/** The files to write, given the current contents of each (undefined = doesn't exist). */
export function planSetup(choice: SetupChoice, read: (rel: string) => string | undefined): FileChange[] {
  const changes: FileChange[] = [];
  if (choice.instructions) {
    const before = read(choice.instructions);
    const after = mergeSection(before);
    if (after !== before) changes.push({ path: choice.instructions, content: after });
  }
  if (choice.denyFolders?.length) {
    const before = read(CLAUDE_LOCAL_SETTINGS);
    const after = mergeDenyRules(before, denyRules(choice.denyFolders));
    if (after !== before) changes.push({ path: CLAUDE_LOCAL_SETTINGS, content: after });
  }
  return changes;
}

/** Files that are personal and must stay out of git (via .git/info/exclude). */
export function personalFiles(choice: SetupChoice): string[] {
  return [
    ...(choice.instructions === 'CLAUDE.local.md' ? ['CLAUDE.local.md'] : []),
    ...(choice.denyFolders?.length ? [CLAUDE_LOCAL_SETTINGS] : []),
  ];
}

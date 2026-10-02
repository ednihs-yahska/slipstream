# Changelog

## 0.2.0 (preview)

**Portable practice repos.** A practice folder can be its own git repository: push it, clone it onto
another machine, and it still finds its project.

- **Remote targets:** a practice folder's project can be a git URL (`"remote": { "url", "ref", "path" }`
  in `.slipstream/link.json`). Slipstream keeps a bare clone in a per-user cache, follows the branch
  (fetched when a session starts, every `slipstream.remoteFetchMinutes`, and on **Fetch Remote
  Targets**), or reads a pinned commit. Projects in a subfolder of their repository work too.
- **Where the project is, per machine:** `.slipstream/link.local.json` (never committed) wins, then the
  committed path if it's a checkout of the remote, then the remote. **Use a Local Checkout of the
  Project…** writes the override; **Stop Using the Local Checkout** removes it.
- **Clone a Practice Repository…** clones one and resolves its project.
- **Start Practice** records the project's `origin` in the link, and offers to make the practice folder
  its own git repository (with a `.gitignore` for the per-machine file and a first commit).
- **Progress in the practice folder (opt-in):** **Store Progress in the Practice Folder** keeps done
  steps and statistics in `.slipstream/progress.json`, so they travel with the repository.
- Replays and Continue to Current Files rewrite links in place, so a remote or a relative target
  survives them.
- **Workspace Trust:** declared as not supported in untrusted workspaces (Slipstream runs git there);
  previously undeclared, with the same effect.
- The Marketplace icon is the Slipstream logo.

## 0.1.0 (preview)

First release.

- **Ghost text:** your AI agent works in your project; you retype its changes in a practice folder, with
  the code still to type shown at the cursor. `Tab` accepts a word, `Shift+Tab` a line.
- **Practice folders** inside the project (`.slipstream/practice/`) or anywhere on disk, started from the
  last commit, an earlier commit, or empty. Kept out of git and VS Code search.
- **Steps view:** every file to create, change, move, delete or copy, in the agent's planned order with
  its reasons, with progress and a completion summary (time, typed vs. Tab-filled).
- **Forgiving diff:** whitespace-only differences ignored, auto-indent tolerated; quick fixes to use
  your version in the project when you deliberately write something different.
- **Replay git history:** retype any commit or range of commits, then continue to your current files.
- **Agent setup:** instructions for Claude Code / other agents and Claude Code permission rules,
  previewed before they're written.
- **Practice modes:** ghost, delayed (recall first; the code appears when you're stuck) and hint (a
  nudge, never the code). Tab still peeks in every mode.
- **Dependency order:** without a plan, imported files come first; each step says what it adds.
- **MCP server:** read-only tools so your agent can see your progress and what you typed.

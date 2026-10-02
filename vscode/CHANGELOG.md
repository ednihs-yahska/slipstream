# Changelog

## 0.2.0 (planned)

- **Portable practice repos:** practice folders as their own git projects that can be cloned anywhere,
  with remote git targets, per-machine overrides and optional progress in the repo. See PLAN.md, M6.

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

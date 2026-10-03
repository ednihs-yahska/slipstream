# Changelog

## 0.7.0 (pre-release)

**Type a commit in the order its code needs.**

- **Edits in dependency order:** while typing a commit, Alt+] goes to the next edit in the order the
  commit's symbols need, across files, creating files as needed. The order comes from your language
  extensions (document symbols and go-to-definition, run on the commit extracted into a cache), or
  from names without one. `slipstream.editOrder: "file"` restores the old behaviour.
- The diff keeps an edit and a new block apart across a closing brace when both pair cleanly
  (`return 0` → `return helper()` above a new `helper()`), so each can be typed on its own.

## 0.5.0 (pre-release)

**Practice folders of their own, and moving through history.**

- Listed as **Slipstream Review**. The extension ID stays `EdnihsYahska.slipstream-practice`, so
  installs of 0.3.0 update in place.

- **New Practice…** replaces Start Practice and works from any window. Practise a **local folder** or a
  **git URL** (fetched into a cache, optionally a folder inside the repository), starting from **one
  commit** (you retype exactly that commit), **a commit to the latest**, or **empty** (the whole
  project). With more than one **branch**, you pick the branch first: its commits are offered, and its
  tip is Latest. The new folder opens in the same window when that window is empty, or **Open Here**
  when it isn't. Practice folders are created **outside the project**, in `~/Slipstream/<project>` by default
  (`slipstream.practiceHome`); the in-project option is gone.
- **Commit by commit:** a New Practice start that replays the history from the first commit (or one you
  pick) to the latest. When a commit is typed, **Commit** commits your work with the original message,
  **Edit Message…** lets you change it, and **Next Without Committing** skips it; each moves on.
- Fixed: making a practice folder a git repository wrote a top-level `.gitignore`, which then showed up
  as a step ("delete .gitignore"). The rule for `link.local.json` now lives in `.slipstream/.gitignore`.
- **History view:** the source's commits under **Latest**, with the one you're typing towards marked.
  Click a commit, or use **Older** / **Newer**. Each move asks: **type this commit** (reset the
  practice folder to its parent; your work is committed first in a practice repository, otherwise
  trashed after you confirm) or **keep my files** (only the target changes). **Switch Branch…**
  moves a practice folder to another branch; a git-URL source is fetched first, so branches pushed
  later appear. New Practice fetches a cached git URL before listing its branches.
- Replays default to `~/Slipstream/<project>-replay`. Set Up Agent offers deny rules only for older,
  in-project practice folders. `slipstream.defaultPracticeDir` is replaced by `slipstream.practiceHome`.
- **Next / Previous Change** (`Alt+]` / `Alt+[`) lands on the change's first line of code: when a
  change starts at the end of a line, the line break and indentation are typed for you.
- Fixed: starting from a commit of a **git-URL** source failed, because extracting a commit from the
  cached bare clone asked git for a working tree it doesn't have.

## 0.3.0 (pre-release)

The first published version, on the Marketplace's pre-release channel. It includes everything below.
Listed as **Slipstream Practice** (`EdnihsYahska.slipstream-practice`), since "Slipstream" is taken on
the Marketplace. Commands, settings (`slipstream.*`) and the `.slipstream/` folder keep their names.

**Typing speed and time left.**

- **Speed from real keystrokes only:** one character, Enter with its auto-indent, or an auto-closed pair
  counts as a key. Tab/Shift+Tab accepts, undo/redo, pastes, snippets, completions and Slipstream's own
  edits never do. Backspace and Delete count as corrections, not speed.
- **Active time** leaves out pauses longer than `slipstream.idleSeconds` (5), so reading and thinking
  don't lower the number. Shown as words per minute: current (last minute), this session, and yours
  overall.
- **Time left** for the session and the whole project (a range replay includes its later commits):
  characters still to type (indentation excluded), less the share you usually Tab-fill, at your speed.
  Shown as a range that narrows as more of your typing is measured, or "about…" before there's any.
- **Where:** the status bar (`3 changes left · 42 wpm · ~12 min left`), the Steps view (time left per
  session; speed, accuracy and estimates in its tooltip; characters per step), the completion notice,
  and **Slipstream: Show Practice Stats** (per practice folder and per project).
- `slipstream.showTypingSpeed` hides it all.

**Typing new lines above existing code, and typos.** Found by hand-testing the package:
- VS Code draws a multi-line ghost as *virtual* lines that don't push the code after the cursor down.
  Typing new lines in front of existing code therefore glued the first new line to it, and Enter then
  split and re-indented it. When a ghost inserts whole lines before code on the cursor's line,
  Slipstream now opens a blank line first, so you type on a line of your own (on arrival, on a jump,
  and before Tab).
- A wrong letter used to make the ghost vanish. Now the mistake is struck through, the ghost stays,
  and Tab replaces the mistake with the right word; Backspace works as usual. In hint and delayed
  modes, a hint says what's wrong.
- The autocomplete popup used to cover the ghost and take Tab. Now, whenever a Slipstream ghost is at the
  cursor, Tab and Shift+Tab type the ghost even if the popup is open, and the popup is closed.

**Guidance where the ghost would be.** When there's nothing to type at the cursor, a hint says what to do
next: the next change in this file (`◂ next change on line 42 · Alt+]`), or the next step, including
the ones that aren't typing (create a file and its folder, move, delete, copy), or that everything is
done. End of line only; never insertable. `slipstream.guidanceHints`.

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

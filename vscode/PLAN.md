# Slipstream: VS Code Extension Plan

## 1. The idea in one paragraph

You ask an LLM agent (Claude Code, etc.) to implement something. The agent works **in your project as usual**. You then **practise in a separate practice folder**, a copy of the project from before the agent's changes, and retype what the agent wrote. The extension diffs *practice* vs *project* and turns that diff into:

- **Ghost text** at your cursor showing what to type next. You type it yourself; `Tab` accepts the next **word**, `Shift+Tab` accepts the rest of the **line**.
- **An instruction list** ("Create `src/auth/token.ts`", "Delete `legacy.js`", "Edit `server.ts` — 3 changes") that you work through by hand.

When your practice file matches the project file, that step is done. The code ends up the same, but you wrote it.

---

## 2. Core concepts

| Concept | What it is |
|---|---|
| **Project (target)** | Your real repo. The agent edits it normally. This is what you're working towards. |
| **Practice folder** | Where you type. Default `<project>/.slipstream/practice/`, or **any folder on disk**. |
| **Link** | `<practice>/.slipstream/link.json` → `{ "target": "../.." }` (relative or absolute). A practice file `src/a.ts` targets `<target>/src/a.ts`. |
| **Hunk** | One contiguous difference between a practice file and its target. |
| **Step** | A file-level instruction: create / delete / rename / modify. |
| **Session** | One practice folder + its target → a set of steps. |

Why this direction:
- **The agent needs no special setup.** It works in the real project with its normal tools, tests and git. There's nothing to redirect and no guardrail needed.
- **You practise in a sandbox.** If you mess up, delete the practice folder and start again; the real code is never at risk.
- **The link lives with the practice folder**, so it works whether the folder is inside the project, elsewhere on disk, or open in its own VS Code window.
- **Reverse mode still works**: you type in the project and the agent writes to `.slipstream/shadow/`. Put `{ "target": ".slipstream/shadow" }` in `<project>/.slipstream/link.json`. It's the same mechanism with the link pointing the other way.

---

## 3. User flow

1. Agent does its work in the project (uncommitted, or committed. Either is fine).
2. `Slipstream: Start Practice…`
   - **Where:** inside this project (`.slipstream/practice/`, default) or somewhere else.
   - **Start from:** last commit (HEAD, i.e. before the agent's uncommitted changes), another commit (`HEAD~1`, a branch, a hash), or empty.
   - The extension copies that version (`git archive`), writes the link, and hides an in-project practice folder from git and the agent's searches via `.git/info/exclude`.
3. Open files in the practice folder. The **Steps** panel (M2) lists what to create/delete/modify.
   - **Create file** → you create it in the practice folder; ghost text appears from line 1.
   - **Modify file** → jump to the first change; strikethrough = delete it, ghost = type it.
   - **Delete file** → you delete it; step ticks off.
4. You type. Ghost text shrinks as you match it. `Tab` = next word, `Shift+Tab` = rest of line.
5. The agent can keep working while you practise; ghost text updates live.
6. When every practice file matches the project, the session is done. Delete the practice folder, or keep it.

---

## 4. Architecture

```
┌──────────────────── VS Code Extension ─────────────────────┐
│                                                            │
│  Practice commands ── Start / Link / Open practice folder  │
│        │              seed from git, write link.json       │
│        ▼                                                   │
│  links.ts ─────────── practice file → target file          │
│        ▼                                                   │
│  TargetStore ──────── reads + watches targets, caches hunks│
│        ▼                                                   │
│  hunks.ts ─────────── practice vs target: line → word diff │
│     │      │                                               │
│     ▼      ▼                                               │
│  StepsView   GhostTextProvider + Decorations               │
│  (M2)        (InlineCompletionItemProvider)                │
│                    ▲ Tab / Shift+Tab                       │
└────────────────────┼───────────────────────────────────────┘
                     │ you type in the practice folder
   ┌──────────┐      │
   │  Agent   │ ── writes the project as usual (watched live)
   └──────────┘
```

### 4.1 Practice folders (`src/practice/`, `src/target/links.ts`) ✅ M0
- `Start Practice…`: pick location + starting point, `git archive <ref>:<prefix> | tar -x` (run from the repo root, so it also works when the project is a subfolder of a repo), write link, add `/<path>/` to `.git/info/exclude` if inside the repo, and add `**/.slipstream/**` to user-level `search.exclude`.
- `Link an Existing Folder…`: any two folders.
- `Open Practice Folder…`: known practice folders for this project, opened in a new window (remembered in extension global state).
- Link discovery: walk up from a file to the nearest `.slipstream/link.json` (cached). Files under the practice folder's own `.slipstream/`, and a target nested inside the practice folder, are never practice files.
- Watch each target root (ignoring events from a practice folder nested inside it) so agent edits update ghosts live.

### 4.2 DiffEngine (`src/diff/hunks.ts`) ✅ M0
- `diffLines`, then character-level prefix/suffix trim (so a half-typed word continues where you stopped), then `diffWordsWithSpace` inside the block if enough words survive (else one replacement hunk).
- Trivial lines (`}`, blank) between two changes don't anchor them together.
- Whole-line insertions slide to the start of the line.
- TODO: whitespace/formatter tolerance.

### 4.3 StepModel ✅ M2 (see §8)
- Walk practice vs target trees (respecting `.gitignore`, skipping `.slipstream/`):
  - In target, not practice → **Create**
  - In practice, not target → **Delete**
  - Delete + Create with high similarity → **Rename/Move**
  - Both, differs → **Modify** (with hunk count)
- Optional **agent plan file**: if the agent writes `.slipstream/plan.md` in the project, use it to order steps and attach a one-line "why" to each.

### 4.4 GhostTextProvider + decorations ✅ M0
- `InlineCompletionItemProvider` returns the hunk's remaining text when the cursor is exactly at a hunk start (capped at `slipstream.maxGhostLines`).
- Decorations: strikethrough for text to remove, `▸`/`▸+N lines` markers (hover shows the code) at other hunks, overview-ruler marks.
- `Alt+]` / `Alt+[` jump between changes; status bar shows changes left.

### 4.5 Keybindings ✅ M0
- `Tab` → `slipstream.acceptWord`, `Shift+Tab` → `slipstream.acceptLine`, only when `slipstream.ghostVisible` (our own context key), so normal indent/outdent work otherwise.
- Our commands insert the text themselves (no reliance on VS Code's partial-accept commands).
- No "accept whole hunk" by design. `slipstream.deleteMarked` exists unbound.

### 4.6 StepsView ✅ M2 (see §8)
```
▾ Practice: demo  →  ~/code/demo        3/7 done
   ✓ Create  src/auth/token.ts
   ● Modify  src/server.ts              2 changes left
   ○ Create  src/auth/middleware.ts
   ○ Delete  src/legacy/session.js
   ○ Rename  utils.ts → lib/utils.ts
```
Click → open the practice file (creating it for Create steps) and jump to the first change. Context menu: show diff, skip step, copy from target (escape hatch, for lockfiles/binaries).

---

## 5. Agent integration

The agent works in the project as normal, so:

1. **Agent-agnostic (now):** nothing to configure. Run any agent in your project.
2. **Keep the agent out of the practice folder:** ✅ `.git/info/exclude` plus Claude Code deny rules (Set Up Agent).
3. **Agent instructions:** ✅ Set Up Agent writes them to CLAUDE.local.md / CLAUDE.md / AGENTS.md.
4. **Later, an MCP server inside the extension:** `get_practice_progress`, `explain_step`. Lets you ask the agent "why this approach?" with your progress as context.

---

## 5b. Replaying git history

The core only needs to know which text each practice file should become, and git can answer that too.

**✅ Built in M2.5** (see §8). The design as planned:
1. `Slipstream: Replay Commit…` → pick a commit `C` from `git log` (or the Source Control graph context menu).
2. Practice folder seeded from `C^`; the target is **commit `C` read from git** (`git show C:<path>`), so it works whatever the project currently has checked out. This needs a git target source next to the folder link (`link.json`: `{ "target": "/path/to/repo", "ref": "C" }`).
3. Steps come from `git diff --name-status -M C^ C`, using git's own rename detection.
4. The commit message becomes the session description.
5. **Range replay** `A..B`: finishing one commit loads the next as the target, like reliving a feature's history.
6. Completion summary: % typed vs Tab-accepted, time taken.

Edge cases: merge commits (first-parent only), huge generated diffs (lockfiles → "copy" steps), binary files, submodules (skip).

### Stretch: symbol-aware sequencing (not required)
A file-by-file, top-to-bottom order isn't how people write code. Better: write what's needed before what needs it.

- **Find symbols** in each target file: `vscode.executeDocumentSymbolProvider` (any language with an LSP), or tree-sitter for speed/offline. Diff symbol sets practice vs target → added / changed / removed symbols.
- **Find dependencies**: for each new/changed symbol, which other new/changed symbols does its body reference? (Identifier match against the symbol table first; `vscode.executeReferenceProvider` for precision later.)
- **Order**: topological sort → types/interfaces and helpers first, then functions that use them, then call sites, then tests. Break cycles by file order.
- **Imports**: hold back import-line hunks and surface each one just before the first hunk that uses it (or at the end, the way auto-import works).
- **Steps become symbol-level**: "Add `GreetOptions` (types.ts)" → "Add `greet` options param (greet.ts)" → "Use it in `cli.ts`", instead of one step per file.
- For agent sessions, prefer the agent's own `plan.md` order when present; symbol ordering is the fallback.

---

## 6. Edge cases to design for

- **Practice folder inside the project picked up by project tooling**: a `tsconfig.json` with `include: ["**/*"]`, test runners, linters, or bundlers may see the practice copies. Mitigations: `.git/info/exclude` covers git-aware tools, and `search.exclude` (user settings) covers VS Code search ✅. For anything else, use a practice folder outside the project.
- **Formatter on save** reformats your file → spurious diffs. ✅ Whitespace-only differences ignored by default. Formatting beyond whitespace (quotes, trailing commas) still shows; possible later: run your formatter on the target before diffing.
- **You deviate on purpose** (rename a variable). ✅ Edit the project by hand, or use the "use my version in the project" quick fix. (Considered and dropped: remembered rename/ignore rules. Changing the real code is simpler, and the agent sees it too.)
- **Agent edits the project while you're typing.** Re-diff only; never move your cursor or touch your text. ✅
- **Huge generated files / lockfiles** (`package-lock.json`): "run command" steps (`npm install`) or "copy from target". Nobody should hand-type a lockfile.
- **Binary files / images:** "copy from target" step.
- **Auto-pairing** (typing `(` inserts `)`): handled by the char-level trim. ✅
- **Running practice code**: the practice folder has no `node_modules`; to run its tests, install there or symlink. Document it, maybe automate later.

---

## 7. Repo layout

```
vscode/
├── PLAN.md / README.md
├── package.json              ← commands, keybindings, config
├── src/
│   ├── extension.ts          ← wiring: commands, context keys, status bar
│   ├── diff/hunks.ts         ← practice vs target → hunks (pure)
│   ├── ghost/                ← acceptance rules, inline provider, decorations
│   ├── target/links.ts       ← practice-folder links (pure Node)
│   ├── target/TargetStore.ts ← resolves/reads/watches targets, caches hunks
│   ├── practice/practice.ts  ← Start / Link / Open practice folder
│   ├── practice/git.ts       ← git archive, info/exclude (pure Node)
│   ├── steps/scan.ts         ← listing, reading, similarity (pure Node)
│   ├── steps/StepModel.ts    ← practice vs project → steps (pure Node)
│   ├── steps/Sessions.ts     ← finds practice folders, keeps steps live, progress
│   └── steps/StepsView.ts    ← tree view + step commands
├── demo/                     ← sample project + practice folder (F5 opens it)
└── test/unit, test/integration
```

---

## 8. Milestones

**M0 — Spike** ✅ *built*
Practice folders (inside/outside project, seeded from a commit or empty), link files, reverse mode, ghost text, Tab = word / Shift+Tab = line, strikethrough removals, `Alt+]`/`Alt+[`, status bar, live updates when the agent writes.

**M1 — Single-file polish** ✅ *built*
- **Whitespace:** `slipstream.whitespace` = `lenient` (default) ignores differences that are only indentation, spacing or blank lines, so your formatter can't create noise. `exact` requires every character to match.
- **Auto-indent:** if only spaces/tabs stand between the missing text and your cursor (the editor indented deeper than the target, or a stray space), the ghost still shows and accepting types over them.
- **Divergence:** you can always edit the project by hand; the ghost follows. In addition, quick fixes (`Cmd/Ctrl+.`) on a difference in a practice file:
  - *Use my version in the project* / *Add my text to the project* / *Remove this from the project*: writes your version of that one change into the project file.
  - *Open in project to edit by hand*: opens the project file beside you, with the matching text selected.
- **Copilot coexistence:** VS Code has no API for one inline provider to silence another, so a one-time notice offers to open Copilot's settings. Tab/Shift+Tab always type Slipstream's ghost.
- **Robustness:** targets are read from disk unless the project file has unsaved edits, and cached text is checked against mtime/size, so an agent's write is never missed or overwritten by a stale editor buffer.

**M2 — Steps** ✅ *built*
- **Steps view** (Slipstream icon in the activity bar): one group per practice folder in the window (found via link files in the workspace, workspace folders that are practice folders, and remembered external practice folders whose project is open). Welcome view with Start/Link buttons when there are none.
- **Step kinds:** create, modify (N changes left), delete, move (a delete + create with ≥50% similar lines; same file name breaks ties), copy (binary, >512 KB, or a lockfile: not worth typing).
- **Project files** come from `git ls-files --cached --others --exclude-standard`: `.gitignore` respected, and the agent's uncommitted new files count. **Practice files** come from a walk, filtered through the project's ignore rules (`git check-ignore --no-index`), so build output in the practice folder isn't a "delete". Non-git: plain walk skipping `.git`, `node_modules`, `.slipstream`.
- **Actions:** click = do the natural thing (create & open at the ghost / open at first change / show old file / open project file). Inline buttons: create, move, delete (to trash), copy. Context menu: show diff, open project file, copy from project (skip typing, confirms first for modify).
- **Progress:** every step ever seen is remembered per practice folder (workspace state); done = seen and no longer pending, shown ticked at the bottom. Status bar: `N changes left · done/total steps`; a notice when everything matches. Reset Progress on the folder's context menu.
- **Live:** watchers on both folders rescan (debounced); typing only recomputes the edited file.
- **Next Step** (`Alt+Shift+]`, or the view's arrow button): the step after the current file's.

**M2.5 — Replay git history** ✅ *built*
- **Replay a Commit…**: pick from `git log` (commits touching this folder). Practice folder (`.slipstream/replay/` or anywhere; offers to trash an earlier replay there) is seeded from the commit's parent; the target is the commit itself, read from git (`link.json`: `"ref"`), so the checkout, including uncommitted work, is never touched.
- **Replay a Range of Commits…**: pick the oldest commit and the newest; commits along the first-parent history that touch the folder, oldest first (`"replay": { commits, index }`). When a commit is done, **Next Commit** (completion notice, inline button on the session, or command) points the link at the next commit. The practice folder already matches its parent, so it just continues. Moving on early is allowed, with a warning that leftovers carry over.
- Commit files open read-only via a `slipstream-git:` content provider, so *Open Project File*, *Show Diff* and *Open in project* all work. *Use my version in the project* is not offered (a commit can't change).
- Steps use the same model as live practice, with the commit as the target source (`git ls-tree` / `git cat-file`). This is more general than `git diff --name-status C^ C`: it stays correct whatever you've typed, and still detects moves.
- **Continue to Current Files**: after the last commit of a replay (when `git diff <ref>` or untracked files show more), the link drops its `ref` and the target becomes the working tree. You type on through later commits and uncommitted work.
- **Commit picker** shared by Replay and Start Practice → *An earlier commit…*: recent commits touching the folder, plus "Enter a revision…" for branches/tags/hashes.
- **Completion summary** (every session, not just replays): time taken and the share of non-whitespace characters you typed vs. Tab/Shift+Tab filled in.

**M3 — Agent niceties** ✅ *built*
- **Plan file:** the agent writes `.slipstream/plan.md` in the project: list items with a backticked path and a reason (numbered or bulleted, `—`/`:`/`-` separators, repeated paths merged). Planned steps come first in plan order (a move matches by old or new path), with the reason shown beside each step and in its tooltip; the plan's `# title` names the session. Unplanned steps follow in the usual order. The plan is re-read on every scan, so edits apply live. Replays ignore it (their target is a commit).
- **Set Up Agent…** (Steps view menu, and offered after Start Practice):
  - Instructions in `CLAUDE.local.md` (default: personal), `CLAUDE.md` (team) or `AGENTS.md` (other agents; Claude Code reads it only without a CLAUDE.md), inside `<!-- slipstream:start/end -->` markers, so re-running updates in place. They ask for focused diffs, a plan file in the parsed format (a unit test checks the example parses), and staying out of `.slipstream/`.
  - Claude Code deny rules in `.claude/settings.local.json`: `Read(/<folder>/**)` and `Edit(/<folder>/**)` for each in-project practice folder (`/` = where Claude Code starts; `Edit` also covers Write). Per the Claude Code docs, Read denies keep paths out of Grep/Glob only best-effort, which is why the git exclusion below still matters.
  - Everything is shown in VS Code's refactor preview first. Personal files (`CLAUDE.local.md`, `settings.local.json`) go into `.git/info/exclude` unless already ignored.
- **Git:** the whole `<project>/.slipstream/` (practice and replay folders, plan.md) is excluded via `.git/info/exclude`, never committed. A practice folder elsewhere in the repo is excluded by its own path.

**M4 — Polish** ✅ *built*
- **Renamed to Slipstream** (`EdnihsYahska.slipstream`): commands `Slipstream: …`, settings `slipstream.*`, per-project folder `.slipstream/`, `slipstream-git:` documents.
- **Packaging:** `npm run package` → a 43 KB `.vsix` (minified bundle, media, README, CHANGELOG, LICENSE). MIT licence, Marketplace metadata (icon, banner, categories, keywords, preview flag). Installs cleanly; integration tests pass against the production bundle. Publishing steps in CONTRIBUTING.md; publishing itself is manual.
- **Docs:** user-facing README (with settings), developer CONTRIBUTING.md, CHANGELOG.md.
- **Diagnostics:** "Slipstream" output channel with errors, and scan timings at debug level.
- **Performance:** 3,000-file git project: ~0.7 s cold scan, ~0.1 s rescan; typing recomputes one file.
- **Stats** (typed vs Tab-filled, time) in the session tooltip as well as the completion notice.
- **CI:** GitHub Actions at the repo root (`.github/workflows/slipstream.yml`): typecheck, unit and integration tests; Linux, macOS and Windows on every push and pull request; packages the `.vsix` as an artifact.
- **Repository:** <https://github.com/ednihs-yahska/slipstream> (`repository` field set; the extension lives in `vscode/`).
- **Open:** the Marketplace icon is a placeholder until the Slipstream logo is saved as `media/logo.png`.

**M5 — Nice-to-haves** ✅ *built*
- **Practice modes** (`slipstream.mode`): *ghost* (default); *delayed*: the ghost appears after `revealDelaySeconds` stuck at a spot (typing a correct character restarts the clock); *hint*: never the code, a nudge after the cursor (lines · first word · names it defines). Tab/Shift+Tab peek in every mode. Status bar shows the mode.
- **Dependency order** (§5b stretch, file level): without a plan, steps are topologically sorted by imports read from the target (JS/TS relative imports incl. `.js`→`.ts` and index files; Python relative and package imports), stable, cycle-safe; `slipstream.stepOrder: path` turns it off. Each step lists the top-level names it adds (JS/TS, Python, Go, Rust patterns). Steps keep their position while you type.
- **MCP server** (`dist/mcp.js`, stdio, read-only): `slipstream_list_practice_folders`, `slipstream_progress`, `slipstream_read_practice_file` (refuses paths outside the practice folder or in its metadata). **Connect Your Agent (MCP)…** copies it to global storage (stable across updates, refreshed on activation) and shows/types the `claude mcp add … --scope local` line without running it. Agent instructions mention the tools.
- **Not done:** symbol-level steps (a step per function rather than per file) and within-file dependency order; a language-server based version could replace the import patterns. "Reveal after N seconds" is per spot, not per line.

**M6 — Portable practice repos** *(planned: version 0.2.0)*

Goal: a practice folder can be its own git project, pushed anywhere, cloned on another machine, and still find its target, whether that's a local checkout or a remote repository.

What already works: a practice folder outside the project can be `git init`-ed and pushed (scans skip `.git`); one nested in `.slipstream/practice/` can be too, since the project's git excludes `.slipstream/`. Its commits become a history of your own typing.

What breaks today:
1. **The link is a path.** `target` is `../..` (nested) or absolute, so a practice repo cloned on its own, or on another machine, points at nothing.
2. **Progress is per machine.** Done ticks and typed-vs-Tab stats live in VS Code's workspace state.
3. **Targets must be on disk.** Replays read commits through git, but only from a local repository.

Design:
- **Remote targets:** `{ "target": { "remote": "https://github.com/owner/project.git", "ref": "main" } }`. Slipstream fetches into a cache in extension global storage and reads files with the existing `git ls-tree` / `git cat-file` code. A branch `ref` follows the branch (refetched on demand and on a timer); a commit hash pins it (a replay). Private repos use the user's own git credentials. A fetch never copies or runs the remote's hooks.
- **Per-machine override:** an untracked `.slipstream/link.local.json` (`{ "target": "~/code/project" }`) wins when present. Resolution order: local override, then the committed path if it exists, then the remote cache. You get live working-tree targets where you have a checkout, and the remote everywhere else.
- **Progress in the repo (opt-in):** `.slipstream/progress.json` holds seen steps and stats, so a cloned practice repo shows the same ticks. Workspace state stays the default.
- **Clone a Practice Repo…:** clone, resolve the target, open the Steps view. Start Practice offers to `git init` the folder it creates, with a `.gitignore` for `link.local.json`.
- **Links:** write a relative `target` only when both folders are in the same repository; otherwise absolute plus, if the project has an `origin` remote, a `remote` fallback.
- **Workspace Trust:** decide and declare `capabilities.untrustedWorkspaces` (fetching remotes makes this matter). Likely `false` with a description, since Slipstream runs git in the workspace.

Tests: a local bare repository stands in for the remote (clone, fetch, branch moves, pinned refs), plus a practice repo cloned into a second temp folder resolving via override, path and remote in turn.

Open questions: fetch cadence for branch targets (on open, on demand, and every N minutes?); whether `progress.json` should merge across machines or last-write-wins; whether the remote cache is shared between practice repos that point at the same remote.

---

## 9. Decisions

1. ~~**Which side do you type on?**~~ *You type in a practice folder; the agent works in the project. Default `.slipstream/practice/`, any folder allowed, reverse mode via link.*
2. ~~**Removed lines**~~ *By hand; an unbound `Delete Text Marked for Removal` command exists if you want a key for it.*
3. ~~**Tab at a line end**~~ *Tab takes the line break + next line's indent; Shift+Tab takes the line break + the whole next line.*
4. ~~**Scope**~~ *Agent-agnostic. Falls out naturally now that the agent needs no setup.*
5. ~~**Hide in-project practice folders?**~~ *From search only: `**/.slipstream/**` goes into `search.exclude` in **user** settings (never the project's `.vscode/settings.json`). This hides them from Find in Files and Quick Open, while the Explorer still shows them. Setting `slipstream.hideFromSearch` (default on).*

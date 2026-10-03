# Slipstream Practice

**Draft behind your AI agent.** The agent writes the code in your project as usual; you retype its
changes yourself in a **practice folder**, with what's left to type shown as ghost text. You end up with
the same code, but you wrote it, and you understand it.

| Key | Does |
|---|---|
| `Tab` | accept the next word (at end of line: the line break + indent) |
| `Shift+Tab` | accept the rest of the line (at end of line: the whole next line) |
| `Alt+]` / `Alt+[` | jump to the next / previous change in the file (past the line break, when the change starts on a new line) |
| `Alt+Shift+]` | go to the next step (file) |

`Tab` and `Shift+Tab` only take over while a Slipstream ghost is showing; otherwise they indent and
outdent as usual. There's deliberately no key to accept a whole block: the point is to type it.

No agent? **Replay any repository's git history** and retype it commit by commit.

> **Pre-release.** Slipstream 0.3.0 is on the Marketplace's pre-release channel: on its page, choose
> *Switch to Pre-Release Version*. Feedback and issues: <https://github.com/ednihs-yahska/slipstream/issues>.

## Practice modes

**Slipstream: Choose Practice Mode…** (or the eye button in the Steps view):

| Mode | The ghost |
|---|---|
| **Ghost** (default) | shows the code still to type, right away |
| **Delayed** | appears only after you've been stuck at a spot for a few seconds (`slipstream.revealDelaySeconds`); try to recall it first. Typing a correct character restarts the clock |
| **Hint** | never shows the code; a nudge instead, e.g. `◂ 3 lines · starts with export · defines clamp` |

In every mode, `Tab` / `Shift+Tab` still fill in a word / line: a peek when you're stuck.

**Requirements:** VS Code 1.100 or later, in a trusted workspace. Git, for starting from a commit,
replays, remote targets, and `.gitignore` support. Works with any coding agent; extra setup is available for Claude Code.

## Start practising

Run **Slipstream: New Practice…** from any window. No project needs to be open.

1. **What to practise:** a local folder (the project open in this window, or any other), or a **git
   URL**, which Slipstream fetches into a cache, with an optional folder inside the repository.
2. **Which branch**, if it has more than one: its commits are the ones offered next, and its tip is
   **Latest**. For a local folder, a branch other than the one checked out is read from git; the
   checked-out one is the project as it is now, uncommitted changes included.
3. **Where to start:**
   - **Type one commit:** the practice folder starts at its parent, and you retype exactly what it changed.
   - **From a commit to the latest:** it starts at that commit, and you retype everything since.
   - **Empty:** you retype the whole project.
4. **Where it lives:** a folder of its own, outside the project (`~/Slipstream/<project>` by default,
   `slipstream.practiceHome`). It can be a git repository too; New Practice offers to make one.

When it's ready, the practice folder opens: in this window if nothing else is open in it, otherwise
you choose **Open Here**, **Open in New Window** or **Add to Workspace**. Work through the **Steps**
view. Your project is never touched: commits are read straight from git.

## Moving through history

The **History** view lists the source's commits, newest first, under **Latest**. The one you're
typing towards is marked. Click any commit, or use **Older** / **Newer**, to move there. Each move asks:

- **Type this commit:** the practice folder is reset to that commit's parent, and you retype exactly
  what it changed. Your current files are committed first if the practice folder is a git repository;
  otherwise they go to the trash, after you confirm.
- **Keep my files:** only the target changes; the steps show what's left from where you are.

**Switch Branch…** (the branch button in the History view) practises another branch: your files stay,
and Latest becomes that branch's tip. For a git-URL source it fetches first, so a branch pushed after
the practice folder was made is offered too. New Practice also fetches a git URL it has cached before
listing branches.

**Latest** follows the project as it is now (or the remote's branch). For a git-URL source, **Fetch**
updates the list.

## Typing speed and time left

Slipstream measures how fast you actually type: real keystrokes only. Tab and Shift+Tab never count, nor
do undo/redo, pastes or autocomplete. Pauses longer than five seconds aren't counted as typing time.

* **Status bar:** `3 changes left · 42 wpm · ~12 min left`. The speed is your last minute of typing.
* **Steps view:** time left per practice folder. The tooltip has your speed now, this session and overall,
  how many keys were corrections, active typing time, and estimates for the session and the whole
  project (for a range replay, the commits still to come).
* **Slipstream: Show Practice Stats:** the same for every practice folder, grouped by project.

Estimates are characters still to type (indentation excluded), less the share you usually fill with Tab,
at your speed. Until you've typed enough they say "about…" and use 40 wpm. Turn it all off with
`slipstream.showTypingSpeed`.

## Working with your agent

Run **Slipstream: Set Up Agent…** in your project. It shows a preview of every change before writing it:

- **Instructions** for the agent, in `CLAUDE.local.md` (just you), `CLAUDE.md` (your team) or `AGENTS.md`
  (other agents). They say a human will retype the changes, so: keep diffs focused, leave a plan
  (`.slipstream/plan.md`), and stay out of `.slipstream/` otherwise. Re-running updates the section in place.
- Practice folders live outside the project, so the agent can't reach them. Only if you still have an
  older practice folder *inside* the project does Set Up Agent also offer Claude Code deny rules for it.

Personal files are kept out of git through `.git/info/exclude`.

### The plan file

With the instructions in place, the agent writes `.slipstream/plan.md` in your project:

```markdown
# Plan: Add greeting options
1. `src/types.ts`: add `GreetOptions`, used by `greet()`
2. `src/greet.ts`: accept options; add the excited variant
3. `src/legacy.ts`: delete, replaced by the options
```

The Steps view then follows that order, shows each reason beside its step, and uses the title as the
session's name. Files the plan doesn't mention come after. Edits to the plan show up immediately.

Without a plan, steps follow the imports: a file comes after the files it imports (JavaScript/TypeScript
and Python), so you write what's needed before what uses it. Each step says what it adds, e.g.
*adds GreetOptions, greet*.

### Connect your agent (MCP)

**Slipstream: Connect Your Agent (MCP)…** gives your agent read-only tools to see your practice:

- `slipstream_progress`: the steps you have left, in order, with reasons and the names each adds
- `slipstream_read_practice_file`: what you've typed so far in a practice file
- `slipstream_list_practice_folders`: your practice folders for a project

So you can ask "why does step 3 need that?" or "is my version of `greet` OK?" and the agent knows where
you are. The command gives you the Claude Code line to run (it never runs it for you); any other agent
can run the same script as a stdio MCP server. The tools only read; they never change your files.

## Replay git history

Practise on code that's already written: yours, your team's, or an open-source project's.

The **History** view (above) is the everyday way to move between commits. Two commands add to it:

- **Slipstream: Replay a Commit…**: pick a commit; you get a practice folder at its parent (in
  `~/Slipstream/` by default) and retype exactly what that commit changed.
- **Slipstream: Replay a Range of Commits…**: pick the oldest and newest commits; you retype them
  one after another. When a commit is done, choose **Next Commit**.
- After the last replayed commit, **Continue to Current Files** (offered when there's more) carries on to
  the project as it is now: later commits and uncommitted changes.

Two ways to start from an earlier commit, then:

| | New Practice → *From a commit to the latest* | Replay a Range → *Continue to Current Files* |
|---|---|---|
| You type | everything since that commit, all at once | one commit at a time, then what's left |
| Steps | one list for the whole difference | per commit, with a summary after each |
| Ends at | your current files | your current files |

Both pickers list recent commits and also take any revision (a branch, tag, `HEAD~5`, a hash).

The target is read straight from git, so your checkout (and any uncommitted work) is never touched.
Project files open read-only. When you finish, you get a summary: time taken, and how much you typed
yourself versus filled in with Tab.

## Take your practice anywhere

A practice folder can be its own git repository. New Practice offers to create one; push it like any
other repository. Clone it onto another machine with **Slipstream: Clone a Practice Repository…**, and
it finds its project:

1. **A local checkout you point it at**: **Use a Local Checkout of the Project…** writes
   `.slipstream/link.local.json`, which stays on this machine and out of git.
2. **The path it was created with**, if that folder exists here and is a checkout of the project.
3. **The project's git remote**: New Practice records `origin` (or, for a git-URL source, the URL), and Slipstream fetches it into a cache
   (`~/.cache/slipstream/remotes`, or `%LOCALAPPDATA%\slipstream\remotes` on Windows). It follows the
   branch, fetching when a session starts, every `slipstream.remoteFetchMinutes` minutes, and on
   **Fetch Remote Targets**.

Progress (done steps, typed versus Tab) normally stays on each machine. **Store Progress in the Practice
Folder** keeps it in `.slipstream/progress.json` instead, so it travels with the repository. If two
machines practise at once, the last write wins.

## How the practice folder finds its target

A practice folder contains `.slipstream/link.json`:

```json
{ "target": "/Users/you/code/my-app", "remote": { "url": "https://github.com/you/my-app.git", "ref": "main" }, "ref": "<commit>" }
```

`target` is the project, either absolute or relative to the practice folder (`~` works). Replays add
`"ref"` (the commit being typed) and `"replay": { "commits": [...], "index": 0 }`. A practice folder
can also carry `"remote": { "url": "…", "ref": "main", "path": "app" }`: the project's git URL, the
branch to follow, and the project's folder inside the repository (see above). A practice file at
`src/a.ts` is typed towards `<target>/src/a.ts`. A practice folder made from a git URL has only `remote`.
`ref` is the commit you're typing towards; the History view sets it. **Link an Existing Folder as
Practice Folder…** writes this file for any two folders.

Want it the other way round, typing in the project while the agent writes to a copy? Put
`{ "target": ".slipstream/shadow" }` in `<project>/.slipstream/link.json` and point the agent at
`.slipstream/shadow/`.

Older versions could put practice folders *inside* the project (`.slipstream/practice/`). Those keep
working through their link file, and stay out of git (`.git/info/exclude`) and VS Code search
(`slipstream.hideFromSearch`). New ones are always created outside the project.

## The Steps view

The Slipstream icon in the activity bar lists, per practice folder, what's left to do:

| Step | Click | Button |
|---|---|---|
| **create** | creates the empty practice file and puts you where the ghost starts | create |
| **modify** · N changes left | opens the file at the first change | diff |
| **move** | asks to move your practice file to the project's new path | move |
| **delete** | shows the file | delete (to trash) |
| **copy** (lockfiles, binaries, >512 KB) | opens the project's file | copy from project |

Done steps stay at the bottom, ticked. The status bar shows `N changes left · done/total steps`.
Right-click a step for *Show Diff with Project*, *Open Project File*, or *Copy from Project (skip typing)*.

Project files are listed with git, so `.gitignore` is respected and the agent's new, uncommitted files
count. Files in the practice folder that the project ignores (e.g. `dist/`) aren't listed as deletes.

## In the editor

- **Ghost text** at the cursor: the code still to type here.
- **`▸` markers**: other places with code to type (hover to preview it).
- **Strikethrough**: code the target no longer has. Delete it yourself, or bind
  `slipstream.deleteMarked` to a key. A typo is struck through too, and the ghost stays after it:
  Backspace, or Tab to replace it with the right word.
- **New lines above existing code**: Slipstream opens a blank line for them first, so what you type
  never glues to the code below.
- **Status bar**: changes left; click to jump to the next one.
- **A hint where the ghost would be**, when there's nothing to type at the cursor:
  `◂ next change on line 42 · Alt+]`, or the next step, e.g.
  `◂ next: create src/util/math.ts (and its folder src/util/) · Alt+Shift+] creates it`, a move, delete
  or copy, or `◂ all steps done ✓`. It only appears at the end of a line, and Tab never types it. Turn it
  off with `slipstream.guidanceHints`.

Whitespace-only differences (indentation, spacing, blank lines) are ignored by default, so your formatter
can't get in the way. Set `slipstream.whitespace` to `exact` to require every character. If the editor
auto-indents deeper than the target, the ghost still shows and Tab types over the extra spaces.

## When you write something different on purpose

Your version can become the real code. Either edit the project file by hand (the ghost text follows), or
put the cursor on the difference in your practice file and press `Cmd/Ctrl+.`:

- **Use my version in the project**: writes your version of that change into the project file
  (also *Add my text…* / *Remove this from the project* when one side is empty).
- **Open in project to edit by hand**: opens the project file beside you with that spot selected.

## Settings

| Setting | Default | |
|---|---|---|
| `slipstream.whitespace` | `lenient` | `lenient` ignores whitespace-only differences; `exact` requires every character |
| `slipstream.maxGhostLines` | `30` | the most lines of ghost text shown at once |
| `slipstream.practiceHome` | `~/Slipstream` | where New Practice creates practice folders |
| `slipstream.hideFromSearch` | `true` | older in-project practice folders: hide them from Find in Files and Quick Open |
| `slipstream.mode` | `ghost` | `ghost`, `delayed` or `hint` (see Practice modes) |
| `slipstream.revealDelaySeconds` | `3` | in `delayed` mode, how long you're stuck before the code appears |
| `slipstream.stepOrder` | `dependencies` | without a plan: `dependencies` (imported files first) or `path` |
| `slipstream.remoteFetchMinutes` | `10` | how often to fetch remote targets; `0` only at session start and on demand |
| `slipstream.showTypingSpeed` | `true` | typing speed and time left in the status bar and Steps view |
| `slipstream.idleSeconds` | `5` | pauses longer than this aren't counted as typing time |
| `slipstream.guidanceHints` | `true` | with nothing to type at the cursor, show what to do next in the ghost's place |

Errors and (at debug level) scan timings go to the **Slipstream** output channel.

## Commands

| Command | |
|---|---|
| Slipstream: New Practice… | a practice folder for a local folder or a git URL, from a commit or empty |
| Slipstream: Switch Branch… | practise another branch of the source (fetched first for a git URL) |
| Slipstream: Older Commit / Newer Commit | move through the History view (or click a commit there) |
| Slipstream: Link an Existing Folder as Practice Folder… | link any folder to any target folder |
| Slipstream: Set Up Agent… | agent instructions + Claude Code deny rules, previewed first |
| Slipstream: Connect Your Agent (MCP)… | read-only tools for your agent to see your progress |
| Slipstream: Choose Practice Mode… | ghost, delayed, or hint |
| Slipstream: Show Practice Stats | speed, accuracy and time left, per practice folder and project |
| Slipstream: Open Practice Folder… | open a known practice folder in a new window |
| Slipstream: Clone a Practice Repository… | clone a practice repo and resolve its project |
| Slipstream: Use a Local Checkout of the Project… / Stop Using the Local Checkout | where the project is on this machine |
| Slipstream: Fetch Remote Targets | update practice folders whose project is a git remote |
| Slipstream: Store Progress in the Practice Folder | keep progress in `.slipstream/progress.json` |
| Slipstream: Replay a Commit… / Replay a Range of Commits… | retype history |
| Slipstream: Next Commit | move a range replay on to its next commit |
| Slipstream: Continue to Current Files | after a replay's last commit, type on towards the project as it is now |
| Slipstream: Set Target File for Current Editor… | use any single file as the target |
| Slipstream: Clear Target File for Current Editor | undo the above |
| Slipstream: Show Diff Against Target | VS Code diff view of practice ↔ target |
| Slipstream: Delete Text Marked for Removal at Cursor | unbound by default |
| Slipstream: Use My Version in the Project | writes your version of the change at the cursor into the project |
| Slipstream: Open in Project | the project file beside you, at the change under the cursor |
| Slipstream: Go to Next Step | `Alt+Shift+]` |
| Slipstream: Refresh Steps / Reset Progress | in the Steps view |

## Known limitations

- Ghost text appears only when the cursor is where the missing code starts (spaces/tabs before the
  cursor are tolerated). Use `Alt+]` to get there.
- The History view shows the most recent 200 commits that touch the project's folder.
- Other inline-completion providers (e.g. Copilot) can show suggestions at the same time: VS Code has no
  API to silence them. A one-time notice offers Copilot's settings; Tab always types Slipstream's ghost.
- Without a plan file, steps follow imports for JavaScript/TypeScript and Python; other languages fall
  back to path order.
- Within a file, changes go top to bottom; ordering by what depends on what is file-level only.

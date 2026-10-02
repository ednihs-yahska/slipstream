# Contributing to Slipstream

[PLAN.md](PLAN.md) has the design and roadmap.

## Try it

```bash
npm install
```

Open this `vscode/` folder in VS Code and press **F5** ("Run Extension (demo workspace)"). A second window
opens on [`demo/`](demo/README.md): a project the "agent" has already changed, with a practice folder at
`.slipstream/practice/`.

## Test

```bash
npm test
```

That runs typecheck, unit tests (`vitest`: diff, acceptance, links, git helpers against a temp repo) and
integration tests (real VS Code via `@vscode/test-electron`, against a temp copy of `demo/`).

```
src/
  extension.ts                wiring: commands, context keys, status bar
  diff/hunks.ts               practice vs target → hunks (pure)
  diff/tolerance.ts           whitespace, auto-indent, mapping hunks onto the target (pure)
  ghost/acceptance.ts         what Tab / Shift+Tab take from the ghost (pure)
  ghost/GhostTextProvider.ts  inline completion provider
  ghost/Decorations.ts        strikethrough + ▸ markers
  ghost/Divergence.ts         quick fixes: use my version in / open in the project
  ghost/coexistence.ts        one-time Copilot notice
  target/links.ts             practice-folder links (pure Node)
  target/TargetStore.ts       finds each file's target, caches hunks, watches targets
  practice/practice.ts        Start / Link / Open practice folder
  practice/git.ts             git archive, history, .git/info/exclude (pure Node)
  practice/replay.ts          Replay Commit / Range / Next Commit / Continue
  practice/pickers.ts         commit picker (shared by Start Practice and Replay)
  target/gitTarget.ts         slipstream-git: URIs, a commit's files as read-only documents
  steps/scan.ts               listing (git-aware), reading, similarity (pure Node)
  steps/StepModel.ts          practice vs project → steps (pure Node)
  steps/Sessions.ts           finds practice folders, keeps steps live, tracks progress
  steps/StepsView.ts          the Steps view and its commands
  steps/plan.ts               the agent's .slipstream/plan.md: parsing and ordering (pure)
  agent/instructions.ts       instruction text + idempotent section merge (pure)
  agent/setup.ts              what Set Up Agent writes: instructions, deny rules (pure)
  agent/setupCommand.ts       the Set Up Agent command (refactor preview)
```


Integration tests set `SLIPSTREAM_CACHE_DIR` (a temporary remote-target cache) and a git identity for
the extension host in `test/integration/runTests.ts`, so they never touch your real cache or git config.

Large projects: a cold scan of a 3,000-file git project takes about 0.7 s and a rescan about 0.1 s.
While you type, only the edited file is recomputed. Set the **Slipstream** output channel to *Debug* to
see scan timings.

## Package

```bash
npm run package
```

This runs `vscode:prepublish` (a minified production build of `dist/extension.js` and the standalone
MCP server `dist/mcp.js`) and writes
`slipstream-practice-<version>.vsix`. Install it locally with:

```bash
code --install-extension slipstream-practice-0.3.0.vsix
```

The `repository` field points at <https://github.com/ednihs-yahska/slipstream>. The extension sits in
`vscode/`, so if the README ever gains relative links, check they resolve on the Marketplace (vsce rewrites
them against the repository root; pass `--baseContentUrl`/`--baseImagesUrl` if they don't).

## CI

`.github/workflows/slipstream.yml` (at the repository root) runs typecheck, unit and integration tests.
Every push and pull request runs on Linux, macOS and Windows; it can also be started by hand
(*Actions → Slipstream → Run workflow*). Each run uploads the `.vsix` as an artifact.

## Publish a pre-release

Odd minor versions (0.3.x) go to the pre-release channel; even ones (0.4.x) are releases.

1. Check by hand, once per release, that **pressing Tab types the ghost** (F5 → demo → practice `greet.ts`).
   The tests call the commands directly and never press a real key.
2. `az login` as an identity that is a member of the `EdnihsYahska` publisher, then
   `npx vsce verify-pat --azure-credential EdnihsYahska`.
3. `npm run package:pre`, then install the `.vsix` into a scratch extensions folder and smoke-test it:
   `code --extensions-dir <tmp> --install-extension slipstream-practice-<version>.vsix`.
4. `npm run publish:pre` (builds, then `vsce publish --pre-release --azure-credential`).
5. Tag the release (`git tag v<version>`, push), and publish the GitHub release with the `.vsix` attached.

## Publish

Publishing to the Visual Studio Marketplace is manual and needs the publisher's credentials:

1. The publisher `EdnihsYahska` must exist at <https://marketplace.visualstudio.com/manage>.
2. Authenticate. **Global Azure DevOps personal access tokens are retired on 2026-12-01**, so use
   Microsoft Entra ID: `npx vsce publish --azure-credential` (see the "Publishing Extensions" page on
   code.visualstudio.com). Before that date, a PAT with organization *All accessible organizations* and
   scope *Marketplace (Manage)* plus `npx vsce login EdnihsYahska` also works.
3. `npx vsce publish`, or `npx vsce publish minor` to bump the version and publish in one go.
4. Optionally publish to Open VSX too: create an eclipse.org account, sign the publisher agreement on
   open-vsx.org, create a token, `npx ovsx create-namespace EdnihsYahska -p <token>` once, then
   `npx ovsx publish slipstream-practice-<version>.vsix -p <token>`.

The Marketplace icon must be at least 128×128 (256×256 for Retina) and may not be an SVG. `media/icon.png`
is the logo (`media/logo.png`, 1000×1000, not packaged) scaled to 256×256:
`sips -z 256 256 media/logo.png --out media/icon.png`.

Not yet tested: that the `Tab` binding beats VS Code's built-in Tab (accept inline suggestion) on a real
keypress. The integration tests call the commands directly, and VS Code's docs don't say where extension
keybindings sit in the evaluation order. Check it by hand in the demo before publishing.

Before each release: update [CHANGELOG.md](CHANGELOG.md), bump `version`, run `npm test`, and check
`npx vsce ls` lists only `dist/`, `media/`, the README, CHANGELOG, LICENSE and `package.json`.

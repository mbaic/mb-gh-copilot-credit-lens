# CLAUDE.md

Guidance for working in this repository.

## What this is

**GitHub Copilot Credit Lens** — a VS Code extension (publisher `MBS`) that reads
the GitHub Copilot session logs already on disk and presents local credit/token
analytics. It is intentionally minimal, offline-first, zero-dependency, and
security-conscious. Distribution is local `.vsix` only; never the Marketplace.

## Architecture

Small, single-purpose modules with a deliberate split (UI vs. logic vs. I/O):

- **`src/types.ts`** — shared data model (`UsageEntry`, `Ledger`, `PeriodId`,
  `ParseResult`) and `SCHEMA_VERSION`. Pure data, no imports of VS Code or `fs`.
- **`src/rates.ts`** — the *only* place model→credit multipliers live. Used for
  **estimation** when a record has no exact billing value. `normalizeModel()`
  matches the longest known model-family prefix.
- **`src/paths.ts`** — all platform-specific path logic and file discovery
  (`discoverChatFiles` / `discoverDebugFiles` / `discoverCliFiles`) plus workspace
  name resolution. Missing folders return empty, never throw.
- **`src/parsers.ts`** — `parseFile(file, fromCursor)` reads only the appended
  tail of a JSONL file, tolerates malformed/unknown lines, and normalizes events
  into `UsageEntry`. Resilient field extraction via key aliases.
- **`src/ledger.ts`** — `LedgerStore`: atomic, backup-protected JSON persistence
  in `globalStorageUri`; per-file cursors; id + cross-source logical dedup
  (`debug` > `chat` > `cli`).
- **`src/scanner.ts`** — `runScan(ledger, config)` ties discovery + parsing +
  ledger together. Adding a source touches only paths/parsers/scanner.
- **`src/aggregate.ts`** — pure period filtering and aggregation into
  `DashboardData` (KPIs, daily series, by-model/source/workspace, trust chip).
- **`src/csv.ts`** — `toCsv(entries)`, RFC-4180-style escaping.
- **`src/dashboard.ts`** — the webview: HTML shell + inline CSS + a nonce'd inline
  script that renders hand-built SVG/CSS charts. All dynamic text uses
  `textContent` (never `innerHTML`). Defines the typed extension↔webview messages.
- **`src/extension.ts`** — VS Code integration only: activation, settings,
  commands, status bar, file watcher, and the webview panel lifecycle.

## Non-negotiable invariants

When changing code, preserve all of these:

1. **No network calls, no `child_process`, no `eval`.** Only local file reads via
   `fs/promises`. (`crypto` for hashing/nonce is fine — local computation.)
2. **Zero runtime dependencies.** Dev dependencies are version-pinned exactly
   (no `^`/`~`). Do not add a runtime dependency without strong justification.
3. **Read-only on Copilot's files.** The extension never writes to any discovered
   log file — it only writes its own ledger/CSV to chosen locations.
4. **Resilient parsing.** Treat log schemas as evolving: ignore unknown fields,
   tolerate missing ones, and never let one bad line/file abort a scan.
5. **Honest credits.** Exact billing values (`copilotUsageNanoAiu / 1e9`) are
   used as-is; estimates are always flagged and excluded from totals unless the
   user opts in. Keep the exact/estimated/trust distinction intact.
6. **`npm audit` must pass** at `--audit-level=moderate` (0 vulnerabilities).
7. **Webview safety:** strict CSP, a per-load script nonce, no remote resources,
   and `textContent` for any log-derived string.

## Commands

```bash
npm ci            # clean install from lockfile
npm run compile   # tsc -> out/  (strict mode; must be warning-free)
npm audit --audit-level=moderate
npx @vscode/vsce package   # produce mb-gh-copilot-credit-lens-<version>.vsix
```

There is no formal unit-test runner. Validate logic changes with a quick Node
smoke test against the compiled `out/*.js` (craft synthetic JSONL in a temp dir,
run `parseFile` → `LedgerStore` → `aggregate` → `toCsv` and assert), then
`npm run compile` and `npm audit`. Press **F5** for the Extension Development Host.

## Settings (all under `copilotCreditLens.*`)

`autoSync` · `watcherEnabled` · `openOnStartup` · `statusBarEnabled` ·
`defaultPeriod` · `includeEstimated` · `includeChatSessions` ·
`includeDebugLogs` · `includeCliSessions` · `additionalRoots`.

Adding a setting touches two places: `package.json` (`contributes.configuration`)
and `readSettings()` in `extension.ts` (plus the consumer that uses it).

## Release

Bump `version` in `package.json`, add a `CHANGELOG.md` entry, then either push a
`vX.Y.Z` tag or run the **Release** workflow (`.github/workflows/release.yml`)
manually — it derives the tag from `package.json`, runs audit + compile, packages
the VSIX, and attaches it to a GitHub Release. v0.1.0 was the first release.

Develop on the designated feature branch, then merge to `main`.

## Third-party / IP

This extension bundles no third-party code — **zero runtime dependencies**. All
code, CSS, and docs are original work under MIT (© Milos Baic). Keep it that way:
prefer original implementations over copying snippets, and never redistribute
third-party assets. Model multipliers in `rates.ts` are factual pricing data.

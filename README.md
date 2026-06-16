# GitHub Copilot Credit Lens

[![Release](https://github.com/mbaic/mb-gh-copilot-credit-lens/actions/workflows/release.yml/badge.svg)](https://github.com/mbaic/mb-gh-copilot-credit-lens/actions/workflows/release.yml)

A **local-first** VS Code extension that turns the GitHub Copilot session logs already on your disk into a clean usage dashboard — credits and tokens, broken down by period, model, source, and workspace. **No GitHub API. No telemetry. Fully offline.**

---

## Why this exists

Since Copilot moved to usage-based billing, every premium request spends AI Credits (AIU) — but VS Code shows no per-workspace, per-model breakdown, and the GitHub billing page shows only totals. Copilot already writes detailed session logs locally; this extension simply reads them.

- **Private by design** — your data never leaves the machine. The extension makes **zero network calls** and sends **zero telemetry**.
- **No supply-chain risk** — **zero runtime dependencies**, distributed as a local `.vsix` (never the Marketplace, no auto-update).
- **Durable** — usage is copied into the extension's own ledger, so it survives Copilot rotating or deleting its log files.
- **Honest numbers** — when a record carries an exact billing value it is used as-is; otherwise the credit figure is clearly labelled as an estimate and excluded from totals unless you opt in.
- **Read-only** — Copilot's own files are never modified.

## What it tracks

| Source | Path | Notes |
|---|---|---|
| VS Code Copilot **Chat** | `…/User/workspaceStorage/<hash>/chatSessions/*.jsonl` | Always available once Chat is used |
| VS Code **agent debug logs** | `…/workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/**/*.jsonl` | Most precise; requires the debug-logging setting below |
| Copilot **CLI** | `~/.copilot/session-state/*/events.jsonl` | Created automatically when the CLI is used |

Cloud (server-side) coding-agent runs do not produce local billing logs and are **not** tracked in this version — see [ROADMAP.md](ROADMAP.md).

## Dashboard

- **KPI strip:** credits this period, credits today, request count, top model.
- **Charts:** credits per day (inline SVG), plus by-model and by-source bars — all hand-built, no charting library.
- **Workspace table** and **token totals** for the selected period.
- **Period selector:** current month · rolling 3 / 6 / 9 / 12 months · since last reset · all time.
- **Exact vs estimated** toggle and an `Exact / Mixed / Estimated` trust chip.
- A compact **status-bar** item (`⚡ AIU this period`) opens the dashboard on click.

## Prerequisites

- **VS Code 1.90+**
- **GitHub Copilot Chat** installed and signed in (so logs exist to read)
- *(optional)* **GitHub Copilot CLI** for CLI-session tracking
- *(recommended)* enable precise agent credit data:
  ```json
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
  ```
  or run **Copilot Credit Lens: Enable Copilot Agent Debug Logging** from the Command Palette, then restart VS Code.

## Usage

Open the Command Palette (`Ctrl/Cmd+Shift+P`) → **Copilot Credit Lens:**

| Command | Action |
|---|---|
| Open Dashboard | Open the analytics panel |
| Sync Now | Full re-scan of all local logs |
| Reset Period (add marker) | Add a non-destructive period boundary |
| Export Usage to CSV | Export the selected period's entries |
| Clear All Data | Wipe the ledger (with confirmation) |
| Enable Copilot Agent Debug Logging | Turn on precise agent credit logging |

On startup the extension scans existing logs (backfill) and, while open, ingests new usage live via a file watcher.

## Settings

All under `copilotCreditLens.*`:

| Setting | Default | Description |
|---|---|---|
| `autoSync` | `true` | Full backfill scan on VS Code startup |
| `watcherEnabled` | `true` | Live incremental ingestion while open |
| `openOnStartup` | `false` | Auto-open the dashboard on launch |
| `statusBarEnabled` | `true` | Show the credit total in the status bar |
| `defaultPeriod` | `currentMonth` | Period selected when the dashboard opens |
| `includeEstimated` | `false` | Include estimated credits in totals by default |
| `includeChatSessions` | `true` | Parse Chat session logs |
| `includeDebugLogs` | `true` | Parse agent debug logs |
| `includeCliSessions` | `true` | Parse Copilot CLI logs |
| `additionalRoots` | `[]` | Extra VS Code `User` storage roots (other profiles / Insiders) |

Multiple profiles? Point `additionalRoots` at the other profile's folder that contains `workspaceStorage`.

## Installation (local `.vsix`)

This extension is distributed as a local `.vsix`, not via the Marketplace.

```bash
code --install-extension mb-gh-copilot-credit-lens-0.1.0.vsix
```

Or: Extensions panel → `…` menu → **Install from VSIX…**

## Development

```bash
git clone https://github.com/mbaic/mb-gh-copilot-credit-lens.git
cd mb-gh-copilot-credit-lens
npm ci
npm run compile        # tsc -> out/ (strict, warning-free)
npm audit --audit-level=moderate
```

Press **F5** in VS Code to launch the Extension Development Host. Package a VSIX with `npx @vscode/vsce package`.

## Release process

Bump `version` in `package.json` and add a `CHANGELOG.md` entry. A release is then produced automatically:

- **On every push to `main`** — CI publishes a new GitHub Release when the `package.json` version has not been released yet. Commits that don't change the version are built and validated but skip the release step (no duplicate releases).
- **On a `vX.Y.Z` tag** — always releases that exact tag.
- **Manually** — run the **Release** workflow (`workflow_dispatch`); the tag is derived from `package.json`.

In all cases CI runs `npm ci` → `npm audit` → compile → `vsce package` and attaches the `.vsix` to the Release (filename derived from `package.json`).

## Security

- No network calls, no `child_process`, no `eval` — only local file reads.
- Zero runtime dependencies; pinned-exact dev dependencies.
- The ledger stores only usage metadata — no code, prompts, or secrets.
- Copilot's log files are opened read-only and never modified.
- The dashboard webview runs under a strict Content-Security-Policy with a per-load script nonce and no remote resources.

## License

[MIT](LICENSE) © 2026 Milos Baic

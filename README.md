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
- **Charts:** credits per day (with value labels + hover tooltips), plus by-model and by-source bars labelled `credits (requests)` — all hand-built, no charting library.
- **Workspace table** with readable project names, and **token totals** that reconcile with the headline (`Exact + Estimated = Credits this period`).
- **Top 5 / Top 10 / All** filters on the by-model and by-workspace lists.
- **Period selector:** current month · rolling 3 / 6 / 9 / 12 months · since last reset · all time.
- **Exact vs estimated** toggle and an `Exact / Mixed / Estimated` trust chip.
- **Tooltips** on every chart, control and stat explaining what it shows.
- A compact **status-bar** item (`⚡ AIU this period`) opens the dashboard on click.

![Dashboard Screenshot](.images/copilot-lens-dasboard.png)

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
| Export Data Backup (JSON) | Save a full, restorable copy of the ledger |
| Clear All Data | Wipe the ledger (with confirmation) |
| Enable Copilot Agent Debug Logging | Turn on precise agent credit logging |
| Rebuild Workspace Names | Re-resolve workspace names shown as a hash |

On startup the extension scans existing logs (backfill) and, while open, ingests new usage live via a file watcher.

> **First run / handing it to a tester?** See [TESTING.md](TESTING.md) for the exact
> prerequisites, settings, install steps, and the **Enable Debug Logging → Clear All
> Data → Sync Now → Open Dashboard** order.

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
| `includeChatSessions` | `false` | Parse Chat session logs (reserved; debug logs are the authoritative meter — see below) |
| `includeDebugLogs` | `true` | Parse agent debug logs — the source of exact credits |
| `includeCliSessions` | `true` | Parse Copilot CLI logs |
| `additionalRoots` | `[]` | Extra VS Code `User` storage roots (other profiles / Insiders) |
| `backupDirectory` | `""` | Folder for automatic ledger backups (empty = off) |
| `billingStartDate` | `"2026-06-01"` | Earliest date counted in any period (min/floor `2026-06-01`) |
| `usdPerCredit` | `0.01` | USD per AI Credit for cost estimates (`0` hides cost) |

Multiple profiles? Point `additionalRoots` at the other profile's folder that contains `workspaceStorage`.

## Billing period & cost

- **Billing start date** — GitHub's usage-based billing began **2026-06-01**, so
  nothing earlier is ever counted. *All time* and the rolling 3/6/9/12-month
  windows therefore start at `billingStartDate` (default and minimum
  `2026-06-01`); *Current period* is the current calendar month. Set
  `billingStartDate` to any later date to report from there.
- **Cost estimate** — credits are AI Credits, billed at **$0.01 each**
  (`copilotUsageNanoAiu / 1e9 × $0.01`). The dashboard shows an estimated USD
  cost next to the credits. It is **gross** — it does not subtract your plan's
  included monthly allowance. Adjust `usdPerCredit` for currency/plan changes, or
  set it to `0` to hide cost figures.

## Backup & restore

Your data lives in the extension's own ledger (`ledger.json`) under VS Code's
global storage, written atomically with a one-deep `.backup` copy. Two extra
safety nets:

- **Manual backup** — run **Export Data Backup (JSON)** to save a full,
  self-contained copy of the ledger anywhere you like.
- **Automatic backup** — set `copilotCreditLens.backupDirectory` to a folder
  (e.g. a synced drive). After any sync that imports new data, a copy is written
  to `<folder>/copilot-credit-lens-backup.json`.

To **restore**, copy a backup file over `ledger.json` in the extension's global
storage folder while VS Code is closed (path shown in the Output log).

## Verify / cross-check

To independently confirm the dashboard's numbers, run the bundled PowerShell
script — it reads the same debug logs and computes the totals on its own:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-usage.ps1
# multiple profiles:
powershell -ExecutionPolicy Bypass -File .\scripts\verify-usage.ps1 -AdditionalRoots "C:\Users\you\AppData\Roaming\Code - Insiders\User"
```

It prints all-time and current-period requests, exact credits, tokens, and a
by-model table. Compare against the dashboard (period **All time** / **Current
period**, estimates off). They should match; the script is read-only and makes
no network calls.

## Installation

All three artifacts are attached to every [GitHub Release](https://github.com/mbaic/mb-gh-copilot-credit-lens/releases/latest) — no cloning or building required. Download the files for the tools you want and follow the steps below.

### 1 — VS Code extension (`.vsix`)

Download **`mb-gh-copilot-credit-lens-<version>.vsix`** then:

```bash
code --install-extension mb-gh-copilot-credit-lens-<version>.vsix
```

Or: Extensions panel → `…` menu → **Install from VSIX…**

### 2 — Standalone CLI (`ccl`)

Requires **Node.js 18+**. Download **`mb-gh-copilot-credit-lens-<version>.tgz`** then:

```bash
npm i -g ./mb-gh-copilot-credit-lens-<version>.tgz
ccl --help
ccl dashboard
```

**Windows PowerShell:**
```powershell
npm i -g .\mb-gh-copilot-credit-lens-<version>.tgz
ccl dashboard
```

### 3 — Copilot CLI `/credits` extension

Requires **GitHub Copilot CLI 1.0.56+**. Download **`copilot-cli-extension-credit-lens-<version>.zip`** then:

**Windows PowerShell:**
```powershell
Expand-Archive .\copilot-cli-extension-credit-lens-<version>.zip `
  -DestinationPath "$env:USERPROFILE\.copilot\extensions"
```

**macOS / Linux:**
```bash
unzip copilot-cli-extension-credit-lens-<version>.zip -d ~/.copilot/extensions/
```

Then enable extensions in `~/.copilot/settings.json` (create if it doesn't exist):
```json
{ "experimental": ["EXTENSIONS"] }
```

Start an **interactive** Copilot CLI session (`gh copilot` or `copilot` — no subcommand), then type `/credits`. The command works inside the session; one-shot commands like `gh copilot explain "…"` do not support slash commands.

---

> **What generates data?** Use `gh copilot explain "…"` or `gh copilot suggest "…"`.
> These write usage logs that `ccl` and `/credits` read. The standalone Copilot
> coding agent (workspace sessions with `workspace.yaml`) uses a different format
> and is not tracked by these tools.

Both terminal tools read only `~/.copilot/session-state/*/events.jsonl` (read-only), keep their own separate ledger, and make **zero network calls**. Full commands, flags, rates configuration, and a **complete testing guide** are in **[docs/cli-usage.md](docs/cli-usage.md)**.

### Keeping model rates current

When a new model appears with wrong or default estimates, you have two options:

1. **Reinstall the latest `.tgz`** — rates are updated in each release.
2. **Local override** — create `rates.json` in the tool's data directory:
   - Windows: `%APPDATA%\copilot-credit-lens\rates.json`
   - macOS: `~/Library/Application Support/copilot-credit-lens/rates.json`
   - Linux: `~/.local/share/copilot-credit-lens/rates.json`

   ```json
   { "my-new-model": 0.5 }
   ```

   Then run `ccl clear --yes && ccl sync` to recompute stored estimates.
   Run `ccl rates` to see all current rates and the exact override file path.

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

Releases are produced automatically by CI (`npm ci` → `npm audit` → version stamp → compile → package → GitHub Release with all three artifacts attached):

- **Every push to `main`** publishes a new GitHub Release with an auto-incremented version `v<major>.<minor>.<run_number>` — the `major.minor` come from `package.json`, and the patch is the workflow run number, so each commit gets a unique, increasing version with no manual bump.
- **A `vX.Y.Z` tag** releases that exact version.
- **Manual run** (`workflow_dispatch`) behaves like a `main` push.

To start a new minor/major line (e.g. `0.2.x`), bump `major.minor` in `package.json` and add a `CHANGELOG.md` entry; the next push continues numbering from there.

## Security

- No network calls, no `child_process`, no `eval` — only local file reads.
- Zero runtime dependencies; pinned-exact dev dependencies.
- The ledger stores only usage metadata — no code, prompts, or secrets.
- Copilot's log files are opened read-only and never modified.
- The dashboard webview runs under a strict Content-Security-Policy with a per-load script nonce and no remote resources.

## License

[MIT](LICENSE) © 2026 Milos Baic

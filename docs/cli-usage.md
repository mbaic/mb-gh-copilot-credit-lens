# Copilot Credit Lens — Terminal (CLI) Guide

The same local-first Copilot credit & token analytics as the VS Code extension,
for the terminal. Ships as **two front-ends over one shared, dependency-free
core** (the same modules the `.vsix` uses):

1. **`copilot-credit-lens` / `ccl`** — a standalone command-line tool. Always
   works; needs nothing but Node ≥ 18. *(Primary.)*
2. **A GitHub Copilot CLI extension** — registers a `/credits` slash command so
   you get the dashboard *inside* a live Copilot CLI session, enriched with the
   current session's live metrics.

Both read **only** `~/.copilot/session-state/*/events.jsonl` (read-only) and
write only their own ledger/exports. **Fully offline — zero network calls.**

> This does **not** affect the VS Code extension. The `.vsix` is built and
> packaged exactly as before (the CLI-only files are excluded from it via
> `.vscodeignore`). The single shared-core change for this feature — recognising
> the CLI's `totalNanoAiu` billing field — is purely additive and backward
> compatible.

---

## 1. Build

```bash
npm ci
npm run build:all      # = npm run compile (tsc -> out/) + npm run build:cli
```

- `npm run compile` emits the compiled JS to `out/` (this is also what the
  `.vsix` build runs — it must stay warning-free).
- `npm run build:cli` assembles the extension's dependency-free `core/` from
  `out/` into `extension/credit-lens/core/`.

---

## 2. Standalone CLI (`ccl`)

### Install

Run it straight from the repo:

```bash
node out/cli.js --help
```

…or install it on your `PATH` (uses the `bin` entry in `package.json`):

```bash
npm pack                                   # -> mb-gh-copilot-credit-lens-<v>.tgz
npm i -g ./mb-gh-copilot-credit-lens-<v>.tgz
copilot-credit-lens --help                 # or: ccl --help
```

For a fully air-gapped install, copy the `.tgz` to the target machine and run the
`npm i -g ./…tgz` there — no registry access needed.

### Commands

| Command | What it does |
|---|---|
| `ccl` / `ccl dashboard` | Show the dashboard (syncs first unless `--no-sync`) |
| `ccl sync` | Scan `~/.copilot/session-state` and import new usage |
| `ccl reset [--label "…"]` | Add a non-destructive period marker |
| `ccl export --csv [-o file] [--all]` | CSV of the period's entries (or all) |
| `ccl export --json [-o file]` | Full ledger backup (`-o`) or entries to stdout |
| `ccl clear --yes` | Wipe the tool's own ledger (never your Copilot logs) |
| `ccl watch` | Live view: re-scan + re-render on change. Ctrl-C to stop |
| `ccl version` / `ccl help` | Version / usage |

### Flags

| Flag | Meaning |
|---|---|
| `--period <id>` | `currentMonth` · `last3Months` · `last6Months` · `last9Months` · `last12Months` · `sinceReset` · `allTime` |
| `--estimated` / `--no-estimated` | Include / exclude estimated credits in the total |
| `--top <n\|all>` | Rows in *by model* / *by workspace* lists |
| `--no-color` | Disable ANSI colour (also honours `NO_COLOR`) |
| `--width <n>` | Render width (default: terminal width, else 80) |
| `--json` | Machine-readable output (dashboard data, or entries for `export`) |
| `-o, --output <f>` | Write export to a file |
| `--all` | `export --csv`: ignore the period, export everything |
| `--no-sync` | `dashboard`: render without scanning first |
| `--yes` | `clear`: confirm the wipe |

### Configuration (precedence: flags > env > config file > defaults)

Defaults mirror the VS Code extension exactly.

- **Env vars:** `CCL_PERIOD`, `CCL_INCLUDE_ESTIMATED`, `CCL_USD_PER_CREDIT`,
  `CCL_BILLING_START`, `CCL_BACKUP_DIR`, `NO_COLOR`.
- **Config file** (`config.json` in the data directory below), e.g.:
  ```json
  {
    "period": "allTime",
    "includeEstimated": false,
    "usdPerCredit": 0.01,
    "billingStartDate": "2026-06-01",
    "backupDirectory": "",
    "top": 0
  }
  ```
- **Billing floor:** `billingStartDate` is clamped to `2026-06-01`; nothing
  earlier is ever counted (identical to the extension).

### Data locations

| | Linux | macOS | Windows |
|---|---|---|---|
| Reads (read-only) | `~/.copilot/session-state/` | same | `%USERPROFILE%\.copilot\session-state\` |
| Ledger + config | `$XDG_DATA_HOME/copilot-credit-lens/` or `~/.local/share/copilot-credit-lens/` | `~/Library/Application Support/copilot-credit-lens/` | `%APPDATA%\copilot-credit-lens\` |

> The terminal tool keeps its **own** ledger, separate from the VS Code
> extension's, so the two never contend for the same file. Use `export --json`
> on either to combine them offline if you want a unified view.

---

## 3. Copilot CLI extension (`/credits`)

### Requirements
- GitHub Copilot CLI **1.0.56+**
- `~/.copilot/settings.json` with extensions enabled:
  ```json
  { "experimental": ["EXTENSIONS"] }
  ```

### Install

```bash
npm run build:all
npm run install:extension            # user-scoped: ~/.copilot/extensions/credit-lens
# or project-scoped (committed to a repo, shared with a team):
node scripts/install-extension.mjs --project   # -> ./.github/extensions/credit-lens
```

The installer copies `extension.mjs` + `core/` into place and prints the
one-line settings change to enable extensions (it never edits your
`settings.json` for you). Restart the Copilot CLI, then:

```
/credits
/credits allTime --estimated
/credits last3Months --no-color
```

`/credits` renders the same dashboard as `ccl`, computed from your on-disk ledger
(a quick CLI-only scan runs first) and merged with **live metrics for the current
session** via the host's usage RPC. If the live RPC is unavailable, the command
still renders full history from the ledger.

> `@github/copilot-sdk` is provided by the host CLI at runtime — it is **not**
> installed by this package and is **not** a runtime dependency.

---

## 4. How to test

No formal unit runner is used (matching the repo convention); validate against
the compiled `out/*.js` with a quick smoke test, then `npm run compile` and
`npm audit`.

### 4.1 Build & static checks

```bash
npm ci
npm run compile                 # strict tsc; must be warning-free
npm audit --audit-level=moderate   # must report 0 vulnerabilities
npm run build:cli               # assembles extension/credit-lens/core
```

### 4.2 End-to-end smoke test (synthetic data, isolated HOME)

This exercises discovery → parse → ledger → aggregate → render without touching
your real `~/.copilot`. It points `HOME` at a throwaway directory.

```bash
# 1) Create a fake session log.
export HOME="$(mktemp -d)"
export XDG_DATA_HOME="$HOME/.local/share"
SESS="$HOME/.copilot/session-state/sess-001"
mkdir -p "$SESS"
cat > "$SESS/events.jsonl" <<'JSONL'
{"type":"llm_request","ts":"2026-06-10T10:00:00Z","model":"claude-opus-4.6","inputTokens":5000,"outputTokens":200,"copilotUsageNanoAiu":1500000000}
{"type":"llm_request","ts":"2026-06-11T10:00:00Z","model":"gpt-5","inputTokens":1000,"outputTokens":50,"totalNanoAiu":2000000000}
{"type":"llm_request","ts":"2026-06-12T10:00:00Z","model":"gpt-5","inputTokens":800,"outputTokens":40}
{ this line is malformed and must be skipped
JSONL
printf 'cwd: /home/me/my-project\n' > "$SESS/workspace.yaml"

# 2) Sync and view (run from the repo root).
node out/cli.js sync
node out/cli.js dashboard --period allTime --no-color --no-sync
node out/cli.js dashboard --period allTime --estimated --no-sync --json
```

**Expected results**

- `sync` reports `1 file(s), 3 new entries` and a warning for the malformed line
  (it must not abort the scan).
- Exact-only `allTime` total = **3.5000 credits** (1.5 from `copilotUsageNanoAiu`
  + 2.0 from the new `totalNanoAiu` alias). The `gpt-5` no-billing row is an
  **estimate**, excluded from the total. Trust chip = **mixed**.
- `--estimated` total = **4.5000** (`exact 3.5 + fallback 1.0`); the JSON shows
  `kpis.creditsPeriod: 4.5`, `totals.exactCredits: 3.5`, `totals.fallbackCredits:
  1`, `estimatedRequestCount: 1`.
- The footer reconciles honestly: with estimates on it reads
  `Exact 3.5 + estimated 1.0 = 4.5`; with them off it reads
  `Exact 3.5 credits (+ 1.0 estimated, excluded)`.

**Things worth asserting explicitly**

- *Billing floor:* change a timestamp to `2026-05-31` and confirm that entry is
  excluded from *All time* (the floor is `2026-06-01`).
- *Idempotency:* run `sync` twice — the second run reports `0 new entries`
  (byte-cursor + id de-dup).
- *CSV:* `node out/cli.js export --csv --all` emits a header row plus one row per
  entry, with `creditsExact` populated for the two billed rows.
- *Terminal safety:* a model id containing an ANSI escape renders inert — control
  characters are stripped before printing.

### 4.3 Extension load path (without the live CLI)

You can verify the extension's shared-core wiring without a running Copilot CLI
(the host-provided SDK is only needed for the actual `/credits` invocation):

```bash
node --input-type=module -e '
import { createRequire } from "node:module";
const require = createRequire(process.cwd()+"/extension/credit-lens/core/x.js");
const { mapMetrics } = require("./live.js");
const { aggregate } = require("./aggregate.js");
const { renderDashboard } = require("./render-tty.js");
const live = mapMetrics({ modelMetrics: { "claude-sonnet-4.6":
  { requests:{count:4}, usage:{inputTokens:1200,outputTokens:90}, totalNanoAiu: 4000000000 } } }, "live-1");
const data = aggregate(live, "allTime", false, [], null, new Date(), {}, Date.parse("2026-06-01T00:00:00Z"), 0.01);
process.stdout.write(renderDashboard(data, { width: 80, color: false, top: 0 }));
'
```

This confirms the CommonJS `core/` loads from the ESM shim and that live metrics
map to exact credits (4.0) and render.

### 4.4 Real-world test (optional)

If you use the Copilot CLI:

1. Run a few Copilot CLI sessions so `~/.copilot/session-state/` has data.
2. `ccl sync && ccl dashboard --period allTime`.
3. Install the extension (§3), enable it, restart the CLI, run `/credits` — the
   numbers should match `ccl`, with the current session's live usage added.

### 4.5 Confirm the `.vsix` is unaffected

```bash
npm run compile
npx @vscode/vsce package        # produces mb-gh-copilot-credit-lens-<v>.vsix
npx @vscode/vsce ls             # list packaged files
```

The packaged file list should **not** include `out/cli.js`, `out/render-tty.js`,
`out/config.js`, `out/live.js`, `extension/**`, or `docs/**` — they are excluded
in `.vscodeignore`. The extension's commands and dashboard behave exactly as
before.

---

## 5. Security & offline posture

- **No network calls, no `child_process`, no `eval`** — local file reads via
  `fs/promises` only; `crypto` for ids. The extension's live-metrics call is
  local process IPC with the host CLI, not a network request.
- **Read-only** on Copilot's files; writes only the tool's own ledger/exports.
- **Zero runtime dependencies.** The ANSI renderer is hand-rolled; the
  `@github/copilot-sdk` used by the extension is provided by the host CLI.
- **Resilient parsing:** unknown fields ignored, missing ones tolerated, one bad
  line never aborts a scan.

See [`copilot-cli-credit-lens.md`](copilot-cli-credit-lens.md) for the full
design rationale and architecture.

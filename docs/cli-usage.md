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

> **What generates data?** Run `gh copilot explain "…"` or `gh copilot suggest "…"`
> in your terminal. These write `events.jsonl` to `~/.copilot/session-state/`.
> The standalone Copilot coding agent (workspace sessions) uses a different
> format (`workspace.yaml`) and does **not** produce data for these tools.

---

## 1. Install (no build required)

Download the latest release artifacts from the
[GitHub Releases page](https://github.com/mbaic/mb-gh-copilot-credit-lens/releases/latest):

| File | What it is |
|---|---|
| `mb-gh-copilot-credit-lens-<v>.vsix` | VS Code extension |
| `mb-gh-copilot-credit-lens-<v>.tgz` | Standalone `ccl` CLI |
| `copilot-cli-extension-credit-lens-<v>.zip` | Copilot CLI `/credits` extension |

### Standalone CLI (`ccl`)

Requires **Node.js 18+**.

**macOS / Linux:**
```bash
npm i -g ./mb-gh-copilot-credit-lens-<v>.tgz
ccl --help
```

**Windows PowerShell:**
```powershell
npm i -g .\mb-gh-copilot-credit-lens-<v>.tgz
ccl --help
```

### Copilot CLI extension (`/credits`)

See [section 3](#3-copilot-cli-extension-credits) below.

---

## 2. Standalone CLI (`ccl`) — commands & flags

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
| `--top <n\|all>` | Rows in *by model* / *by workspace* lists |
| `--no-color` | Disable ANSI colour (also honours `NO_COLOR`) |
| `--width <n>` | Render width (default: terminal width, else 80) |
| `--json` | Machine-readable output (dashboard data, or entries for `export`) |
| `-o, --output <f>` | Write export to a file |
| `--all` | `export --csv`: ignore the period, export everything |
| `--no-sync` | `dashboard`: render without scanning first |
| `--yes` | `clear`: confirm the wipe |

### Configuration (precedence: flags > env > config file > defaults)

- **Env vars:** `CCL_PERIOD`, `CCL_USD_PER_CREDIT`,
  `CCL_BILLING_START`, `CCL_BACKUP_DIR`, `NO_COLOR`.
- **Config file** (`config.json` in the data directory), e.g.:
  ```json
  {
    "period": "allTime",
    "usdPerCredit": 0.01,
    "billingStartDate": "2026-06-01",
    "top": 0
  }
  ```

### Data locations

| | Linux | macOS | Windows |
|---|---|---|---|
| Reads (read-only) | `~/.copilot/session-state/` | same | `%USERPROFILE%\.copilot\session-state\` |
| Ledger + config | `~/.local/share/copilot-credit-lens/` | `~/Library/Application Support/copilot-credit-lens/` | `%APPDATA%\copilot-credit-lens\` |

> The terminal tool keeps its **own** ledger, separate from the VS Code
> extension's, so the two never contend for the same file.

---

## 3. Copilot CLI extension (`/credits`)

The extension registers a `/credits` slash command inside an **interactive**
Copilot CLI session. It shows the same dashboard as `ccl`, plus live metrics
for the current session via the host's usage RPC.

### Requirements
- GitHub Copilot CLI **1.0.56+** (installed via `gh copilot` or standalone `copilot`)
- Extensions enabled in `~/.copilot/settings.json`

### Install — Windows PowerShell

```powershell
# 1. Extract the zip to the extensions folder:
Expand-Archive .\copilot-cli-extension-credit-lens-<v>.zip `
  -DestinationPath "$env:USERPROFILE\.copilot\extensions"

# 2. Verify the files are in place:
ls "$env:USERPROFILE\.copilot\extensions\credit-lens\"
# Should show: extension.mjs  core\

# 3. Enable extensions in settings.json (create the file if it doesn't exist):
notepad "$env:USERPROFILE\.copilot\settings.json"
# Add (or merge into existing file):
# { "experimental": ["EXTENSIONS"] }

# 4. Restart any running Copilot CLI session.

# 5. Start an interactive session:
gh copilot          # or: copilot

# 6. Verify the extension loaded — inside the session type:
/extensions
# Should list "credit-lens" as installed

# 7. Use the command:
/credits
/credits last3Months --no-color
```

### Install — macOS / Linux

```bash
# 1. Extract to the extensions folder:
unzip copilot-cli-extension-credit-lens-<v>.zip -d ~/.copilot/extensions/

# 2. Enable extensions:
# Edit ~/.copilot/settings.json and add:
# { "experimental": ["EXTENSIONS"] }

# 3. Restart Copilot CLI and start an interactive session:
gh copilot   # or: copilot

# Inside the session:
/credits
```

### Important: interactive session required

Slash commands (`/credits`, `/extensions`, etc.) only work inside an
**interactive** Copilot CLI session — not in one-shot commands like
`gh copilot explain "…"`. Start a session with `gh copilot` or `copilot`
(no subcommand), then type `/credits`.

> `@github/copilot-sdk` is provided by the host CLI at runtime — it is **not**
> installed by this package and is **not** a runtime dependency.

---

## 4. Testing

### Basic workflow test

```bash
# Generate some data by using gh copilot in your terminal:
gh copilot explain "ls -la"

# Import and view:
ccl sync
ccl dashboard
```

Expected: Dashboard shows the new requests and their model (e.g. `gpt-5.4-mini`,
or whichever model was used). Credits are exact billed values only: a request
whose log entry has no billing value counts as 0 and is never guessed. The
footer reads like `Credits 39.20 · ≈ $0.39 @ $0.01/credit`, followed by the
requests/tokens line.

### Smoke test with synthetic data (isolated, no real logs touched)

```bash
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

node out/cli.js sync
node out/cli.js dashboard --period allTime --no-color --no-sync
```

Expected: 1 file, 3 entries, 1 warning. Total = 3.5 credits (the third record
has no billing value, so it adds 0). The footer shows `Credits 3.50`.

### Confirm VSIX is unaffected

```bash
npm run compile
npx @vscode/vsce package
npx @vscode/vsce ls
```

The packaged file list must **not** include `out/cli.js`, `out/render-tty.js`,
`out/config.js`, `out/live.js`, `extension/**`, or `docs/**`.

---

## 5. Security & offline posture

- **No network calls, no `child_process`, no `eval`** — local file reads via
  `fs/promises` only.
- **Read-only** on Copilot's files; writes only the tool's own ledger/exports.
- **Zero runtime dependencies.** The ANSI renderer is hand-rolled.
- **Resilient parsing:** unknown fields ignored, missing ones tolerated, one bad
  line never aborts a scan.
- **Terminal safety:** all log-derived strings (model names, workspace paths) are
  stripped of ANSI escape sequences before printing.

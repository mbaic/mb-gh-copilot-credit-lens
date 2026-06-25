# Copilot Credit Lens for the GitHub Copilot CLI — Implementation Spec

> **Status:** ✅ **implemented** (both front-ends shipped). This document is the
> design rationale; for install/usage/testing see
> [`cli-usage.md`](cli-usage.md).
>
> **Audience:** maintainers of `mb-gh-copilot-credit-lens`.
> **Author intent:** preserve every non-negotiable invariant of the VS Code
> extension (offline, read-only, zero-dependency, honest credits) while adapting
> the *presentation* from a webview to a terminal.

> ### Implementation status (as built)
>
> Shipped: `src/cli.ts` (standalone `ccl`), `src/render-tty.ts`, `src/config.ts`,
> `src/live.ts`, `extension/credit-lens/extension.mjs` (the `/credits` shim),
> plus `scripts/build-cli.mjs` and `scripts/install-extension.mjs`. The shared
> core (`types`, `rates`, `csv`, `aggregate`, `ledger`, `paths`, `parsers`,
> `scanner`) is reused unchanged except for one additive line.
>
> **Deliberate deviation from §6 below — no `modelMetrics` parser expansion.**
> The repo's existing parser already extracts CLI usage from per-call
> `llm_request` lines (see the internal spec §5.3: top-level `model` +
> `inputTokens`/`outputTokens` + `copilotUsageNanoAiu`). Adding a *second* path
> that also expands `session.shutdown.modelMetrics` aggregates would risk
> **double-counting** the same usage and would change the numbers the current
> `.vsix` produces — which is non-negotiable to avoid. So the **only** shared
> change is recognising the `totalNanoAiu` alias (§6.1, item 1), which can only
> upgrade a record's exactness, never create a duplicate. The `modelMetrics`
> shape is still handled where it is safe and needed — for **live** current-
> session metrics — inside `live.ts` (`mapMetrics`), which produces fresh rows
> the ledger doesn't yet have. Revisiting the on-disk `modelMetrics` path would
> require a real `events.jsonl` sample confirming the per-call vs. aggregate
> relationship to guarantee no double count. `requestCount`/`premiumRequests`
> (§6.2) were likewise deferred for the same reason.

---

## 1. Verdict: is this doable?

**Yes — and most of the hard work is already done in this repo.**

There are two independent facts that make this straightforward:

1. **The data is already on disk and we already parse it.** The GitHub Copilot
   CLI persists every session to `~/.copilot/session-state/<session-id>/`, and
   this repo *already* discovers (`discoverCliFiles` in `src/paths.ts`) and
   parses (`source: 'cli'` in `src/parsers.ts`) those `events.jsonl` files. The
   `cli` source is a first-class citizen of the ledger today.
2. **The CLI is genuinely extensible.** As of Copilot CLI **1.0.56+** there is a
   public extension model: the CLI scans `.github/extensions/` (project-scoped)
   and `~/.copilot/extensions/` (user-scoped) for subdirectories containing an
   `extension.mjs`, forks each as a Node.js child process, and lets it register
   **custom slash commands**, tools, and hooks via `@github/copilot-sdk`'s
   `joinSession()`. Extensions can also read live session metrics over an RPC
   API (`session.rpc.usage.getMetrics()`).

So we can ship a terminal experience two ways, and we should ship **both** behind
one shared core (see §4):

- **A standalone CLI** (`copilot-credit-lens` / `ccl`) — the primary, always-works
  deliverable. Reads the on-disk session logs + the same ledger and renders an
  ANSI dashboard. No dependency on any particular Copilot CLI version.
- **A Copilot CLI extension** (`extension.mjs`) — a thin shim that registers a
  `/credits` slash command so users get the dashboard *inside* a live Copilot CLI
  session, augmented with real-time metrics for the current session.

This is not a 1:1 port of the webview (a terminal has no DOM), but it can be
**functionally equivalent**: same KPIs, same period model, same exact/estimated
trust distinction, same by-model / by-source / by-workspace breakdowns, same CSV
export.

---

## 2. Background: how the GitHub Copilot CLI stores and exposes usage

### 2.1 On-disk session state (the durable, version-independent source)

```
~/.copilot/                                  ($HOME on macOS/Linux; %USERPROFILE% on Windows)
├── settings.json                            # CLI settings, incl. experimental feature flags
├── extensions/                              # user-scoped extensions (one dir each, with extension.mjs)
└── session-state/
    └── <session-id>/
        ├── events.jsonl                     # streaming append-only event log (20+ event types)
        ├── workspace.yaml                   # session metadata (cwd / working directory, etc.)
        ├── plan.md                          # implementation plan (optional)
        ├── checkpoints/                     # context-compaction history
        └── files/                           # persisted artifacts
```

`events.jsonl` is append-only JSONL — exactly the shape this repo's incremental,
cursor-based `parseFile()` was built for. It carries 20+ event types (user
prompts, tool invocations, sub-agent activity, model changes, context
compaction, task completion, session shutdown, …).

**The billing-grade numbers live in the `session.shutdown` event**, under a
`modelMetrics` map keyed by model id. The observed shape (treat as evolving):

```jsonc
// one line of events.jsonl, abridged
{
  "type": "session.shutdown",
  "ts": "2026-06-24T18:05:11.000Z",
  "modelMetrics": {
    "claude-opus-4.6": {
      "requests": { "count": 12, "cost": 120 },   // cost = premium-request units
      "usage": {
        "inputTokens": 480213,
        "outputTokens": 38110,
        "cacheReadTokens": 1200340,
        "cacheWriteTokens": 22100
      },
      "totalNanoAiu": 1200000000                   // exact AI-credit usage, when present (÷1e9 = credits)
    },
    "gpt-5-mini": { "requests": { "count": 3, "cost": 0 }, "usage": { "inputTokens": 9100, "outputTokens": 1200 } }
  }
}
```

Key facts that map *directly* onto this repo's data model:

| Copilot CLI field                                   | This repo's `UsageEntry` field            | Notes |
|-----------------------------------------------------|-------------------------------------------|-------|
| `modelMetrics.<model>` key                          | `model`                                   | per-model split |
| `usage.inputTokens`                                 | `inputTokens`                             | alias already handled |
| `usage.outputTokens`                                | `outputTokens`                            | alias already handled |
| `usage.cacheReadTokens`                             | `cachedTokens`                            | alias already handled (`cacheReadInputTokens` etc.) |
| `totalNanoAiu`                                       | `creditsExact = totalNanoAiu / 1e9`       | **add this alias** — see §6.1 |
| `requests.cost` (premium-request units)             | (new, optional) `premiumRequests`         | optional enrichment — see §6.2 |
| `requests.count`                                    | request count                             | the CLI bundles a session's totals, not one row per call |

> ⚠️ **Important behavioural note.** The current `events.jsonl` shape reports
> **per-session, per-model aggregates** in `session.shutdown`, not one event per
> model call. So a finished CLI session yields **one `UsageEntry` per model**
> (not per request). This is fine for credit/token totals, but it means
> "requests" for the CLI source = number of model-buckets unless we read
> `requests.count`. The parser must expand `modelMetrics` into one entry per
> model and carry the real `requests.count` (see §6.2). Live (not-yet-shut-down)
> sessions won't have a `session.shutdown` line yet — that's what the extension's
> RPC path (§5) covers.

GitHub has an open issue to **formalize `events.jsonl` as an official
hook/integration API** (`github/copilot-cli#3551`); until then we keep treating
it as an evolving best-effort input — which is already invariant #4 of this
project.

### 2.2 Live metrics via the extension RPC (the real-time source)

Inside a running session, an extension can call:

```js
const metrics = await session.rpc.usage.getMetrics();
// → per-model request counts; input/cachedInput/cacheWrite/output/reasoning token buckets;
//   active model; last-call input/output token counts; totalNanoAiu when available.
```

This is how `DamianEdwards/copilot-cli-cost` surfaces live `/cost`. We reuse the
same RPC for the **current session** and fall back to / merge with the on-disk
ledger for **history**.

### 2.3 The extension model (how a "plugin" is loaded)

- Discovery: CLI scans `.github/extensions/` and `~/.copilot/extensions/` for
  subdirectories containing **`extension.mjs`** (ES module). Each is **forked as a
  child Node process**.
- SDK: `@github/copilot-sdk` is **auto-resolved by the CLI** — extensions do not
  install it; they `import { joinSession, approveAll } from '@github/copilot-sdk'`.
- Registration: `joinSession({ slashCommands, tools, hooks, onPermissionRequest })`.
  `slashCommands` adds user-triggered commands (our `/credits`); `tools` adds
  agent-triggered tools; `hooks` get lifecycle callbacks.
- Enablement: requires experimental flags in `~/.copilot/settings.json`, e.g.
  `"experimental": ["EXTENSIONS", "STATUS_LINE"]`, and Copilot CLI **1.0.56+**.
- The SDK is multi-language (Node, Python, Go, .NET) but **CLI extensions are
  Node `.mjs` only** — which suits us, since our core is TypeScript→JS already.

---

## 3. Goals, non-goals, and the invariants we keep

### Goals
- Terminal-native credit & token analytics for the Copilot CLI, as close to the
  VS Code dashboard as a TTY allows.
- Same period model, same exact/estimated/trust semantics, same breakdowns, same
  CSV export, same honest-credits rules.
- Works fully offline, read-only on Copilot's files, zero runtime dependencies.
- One shared core powering both a standalone CLI **and** a Copilot CLI extension.

### Non-goals
- No pixel-perfect re-creation of the HTML charts. Bars become Unicode/ANSI bars.
- No new network calls, telemetry, or Marketplace publishing (local `.tgz`/`npx`
  / extension dir only — mirrors the "`.vsix` only" stance).
- No write-back to Copilot's session files, ever.

### Invariants carried over verbatim (from `CLAUDE.md`)
1. **No network, no `child_process`, no `eval`.** `fs/promises` reads only;
   `crypto` for hashing/ids is fine. *(The extension runs inside a process the
   CLI forked — we still spawn nothing ourselves.)*
2. **Zero runtime dependencies.** Dev deps pinned exactly. The ANSI renderer is
   hand-rolled (no `chalk`/`blessed`/`ink`). `@github/copilot-sdk` is **provided
   by the host CLI**, not bundled or installed by us, so it does not count as a
   runtime dependency of our package.
3. **Read-only on Copilot's files.** We only ever write our own ledger/CSV to
   chosen locations.
4. **Resilient parsing.** Ignore unknown fields, tolerate missing ones, never let
   one bad line/file abort a scan.
5. **Honest credits.** `totalNanoAiu / 1e9` is exact and used as-is; everything
   else is a flagged estimate, excluded from totals unless opted in.
6. **`npm audit` clean** at `--audit-level=moderate`.
7. Terminal-safety analogue of webview-safety: never interpret log-derived
   strings as escape sequences — **sanitize control characters** before printing
   (the §7.4 rule replaces the webview's `textContent` rule).

### 3.1 The 100% offline guarantee (explicit)

This solution makes **zero network calls at runtime** — both front-ends only read
local files and (for the extension) talk to the host CLI over local process IPC.
Concretely:

- **Standalone `ccl` binary:** reads `~/.copilot/session-state/**` and its own
  ledger via `fs/promises`; renders to the terminal. Nothing leaves the machine.
  Fully usable on an air-gapped box.
- **Extension shim:** `session.rpc.usage.getMetrics()` is **local IPC** between
  our forked Node process and the Copilot CLI host — not a network request. Our
  code never opens a socket. *(The Copilot CLI host itself contacts GitHub to do
  its AI work, but that is the host, not our add-on; we add no new traffic.)*
- **The only non-runtime network touchpoints, both avoidable for air-gap:**
  1. *Installing* the tool (npm/tarball download) — a one-time step like any
     install; ship the `.tgz` / extension folder on a USB stick for true air-gap.
  2. *Dev-time* typings for `@github/copilot-sdk`. To keep even the build
     network-free, **vendor a local `copilot-sdk.d.ts`** that declares just the
     `joinSession`/`session.rpc` surface we use, instead of adding the SDK as a
     dev dependency. At runtime the SDK is provided by the host CLI regardless.

So: **runtime = 100% offline, no exceptions.** Build/install can also be made
offline by vendoring the one type file and distributing the artifact directly.

---

## 4. Architecture: one core, two front-ends

The VS Code extension already separates **logic** (`types`, `rates`, `ledger`,
`aggregate`, `csv`, most of `paths`/`parsers`/`scanner`) from **presentation**
(`dashboard.ts` webview) and **host glue** (`extension.ts`). That split is the
whole reason this is cheap: **~70% of the modules move unchanged**; only the
renderer and the host entrypoint are new.

```
┌─────────────────────────── shared core (reused, pure) ───────────────────────────┐
│  types.ts · rates.ts · csv.ts · aggregate.ts · ledger.ts                          │
│  parsers.ts (+ CLI usage aliases) · paths.ts (CLI discovery already present)      │
│  scanner.ts (gains a "CLI-only" mode)                                             │
└───────────────────────────────────────────────────────────────────────────────────┘
        ▲                                   ▲                              ▲
        │ reuses                            │ reuses                       │ reuses
┌───────┴────────┐               ┌──────────┴───────────┐        ┌─────────┴──────────┐
│  render-tty.ts │ NEW           │   cli.ts (bin)       │ NEW    │  extension.mjs     │ NEW
│  ANSI dashboard│               │   arg parsing,       │        │  joinSession(),    │
│  + tables/bars │               │   commands, config   │        │  /credits command, │
│                │               │   resolution         │        │  getMetrics() RPC  │
└────────────────┘               └──────────────────────┘        └────────────────────┘
        standalone binary  `copilot-credit-lens` / `ccl`              Copilot CLI plugin
```

### Decision: standalone CLI is primary; extension is an optional shim
- The **standalone CLI** is the robust, version-independent deliverable and the
  closest philosophical match to the VS Code extension (offline, self-contained).
- The **extension** is a thin convenience layer: it does not re-implement
  analytics — it calls into the same core and renderer, plus live `getMetrics()`.

This mirrors `copilot-cli-cost`'s split (a CLI/installer plus an extension shim)
but reuses an analytics engine we already own.

---

## 5. Front-end A → the Copilot CLI extension (`extension.mjs`)

### 5.1 Layout (user-scoped)

```
~/.copilot/extensions/credit-lens/
├── extension.mjs        # the shim (ESM, the only file the CLI looks for)
└── core/                # compiled, dependency-free copy of the shared core (out/*.js)
```

Project-scoped installs use `.github/extensions/credit-lens/` instead — identical
contents, committed to a repo so a team shares it.

### 5.2 The shim

```js
// extension.mjs — runs in a Node child process the CLI forks for us.
// @github/copilot-sdk is resolved by the host CLI; we install nothing.
import { joinSession } from '@github/copilot-sdk';
import { renderDashboardToString } from './core/render-tty.js';
import { LedgerStore }            from './core/ledger.js';
import { runScan }                from './core/scanner.js';
import { aggregate }              from './core/aggregate.js';
import { liveSessionEntries }     from './core/live.js';   // wraps getMetrics() → UsageEntry[]

await joinSession({
  // Our analytics never needs to touch the user's files/tools — decline by default.
  onPermissionRequest: () => ({ allow: false }),

  slashCommands: [
    {
      name: 'credits',
      description: 'Show local Copilot credit & token analytics (Credit Lens).',
      // args string lets us accept "/credits last3Months --estimated"
      handler: async ({ args, ui, session }) => {
        const opts = parseArgs(args);                       // tiny, local

        // 1) History from the on-disk ledger (+ a quick CLI-only rescan).
        const ledger = new LedgerStore(storageDir());
        await ledger.load();
        await runScan(ledger, { roots: [], includeChat: false, includeDebug: false, includeCli: true });

        // 2) Live current-session metrics via RPC, merged in (deduped by id).
        const live = await liveSessionEntries(session);     // [] if RPC unavailable

        const data = aggregate(
          [...ledger.entries, ...live], opts.period, opts.includeEstimated,
          ledger.resetMarkers, ledger.lastScanAt, new Date(),
          ledger.workspaceNames, billingStartMs(), usdPerCredit()
        );

        await ui.write(renderDashboardToString(data, { width: ui.columns ?? 80, color: ui.supportsColor }));
      }
    }
  ]
});
```

Notes:
- `slashCommands[].handler` receives the typed args, a `ui` writer, and the live
  `session` (for `session.rpc.usage.getMetrics()`). The exact callback shape is
  pinned by the installed SDK version at build time (see §11.4); the shim is the
  *only* place that depends on it, so SDK drift is a one-file fix.
- If `getMetrics()` is missing/throws, `liveSessionEntries` returns `[]` — history
  still renders (invariant #4).
- The shim performs a **CLI-only** scan (`includeCli: true`, others `false`) so it
  never reaches into VS Code storage from within a terminal session.

### 5.3 Install / enable

1. `~/.copilot/settings.json` → `"experimental": ["EXTENSIONS"]` (add
   `"STATUS_LINE"` only if we ship a status-line widget, §9).
2. Copy/symlink the built `credit-lens/` into `~/.copilot/extensions/`
   (our installer does this; see §11.3).
3. Restart the Copilot CLI; `/credits` appears. `/extensions` lists/min-manages it.

### 5.4 Optional: status-line widget
The CLI supports a status line (`STATUS_LINE` flag). We can publish a compact
"period credits · today" segment — the terminal analogue of the VS Code status
bar item (`statusBarEnabled`). Same one-line summary, computed from the same
`aggregate()` output. Gated behind a setting, off by default.

---

## 6. Shared-core changes (small, additive, all in existing files)

### 6.1 `parsers.ts` — recognise the CLI's billing field and shutdown shape
The generic key-alias extractor already covers `inputTokens` / `outputTokens` /
`cacheReadTokens`. Two additive changes:

1. **Add `totalNanoAiu` to the exact-credit aliases** (it's the CLI's name for
   what VS Code calls `copilotUsageNanoAiu`):
   ```ts
   const nanoAiu = pickNumber(scopes, [
     'copilotUsageNanoAiu', 'usageNanoAiu', 'nanoAiu', 'totalNanoAiu'
   ]);
   ```
2. **Expand a `session.shutdown` event's `modelMetrics` map into one
   `UsageEntry` per model.** Today `toEntry()` returns a single entry per line;
   add a `toEntries(obj, file, ts): UsageEntry[]` path that, when it sees
   `modelMetrics` (an object of `{ requests, usage, totalNanoAiu }`), emits one
   entry per key. Each entry's id mixes in the model + session so dedup stays
   deterministic and idempotent (same rules as `hashId`). Non-shutdown lines keep
   going through the existing single-entry path (and most return `null`).

   > Why per-model rows: it makes `byModel` correct and keeps `creditsExact`
   > attributable. `requests.count` is stored so the CLI source reports real
   > request counts (see §6.2) rather than "1 per model bucket".

### 6.2 `types.ts` — optional premium-request enrichment (non-breaking)
Add **one optional field** so we can show GitHub "premium requests" without
disturbing existing consumers:
```ts
export interface UsageEntry {
  // …existing…
  /** Server-reported request count for this (session,model) bucket. CLI only;
   *  undefined elsewhere. Used so CLI "requests" reflect real calls, not buckets. */
  requestCount?: number;
  /** Premium-request units (modelMetrics.<model>.requests.cost). Optional, CLI only. */
  premiumRequests?: number;
}
```
`aggregate.ts` then counts `requests += e.requestCount ?? 1` instead of `+= 1`.
This is the only aggregate change and it's backward-compatible (VS Code rows have
no `requestCount`, so they still count as 1 each). Bump `SCHEMA_VERSION`? **No** —
the field is optional and `LedgerStore.normalize()` already tolerates partial
rows; old ledgers load unchanged.

### 6.3 `paths.ts` — already done, minor hardening
`cliSessionRoot()`, `discoverCliFiles()`, and `resolveCliWorkspaceName()` exist.
Two small robustness items for the standalone tool (which may run where VS Code
never did):
- Honor `COPILOT_HOME`/`$XDG_*` overrides if the CLI ever relocates `~/.copilot`
  (best-effort, fall back to `os.homedir()`); keep the missing-folder→empty rule.
- `workspace.yaml` parsing already greps for `cwd`/`workingDirectory`/`directory`/
  `path`; leave as-is (no YAML dependency — invariant #2).

### 6.4 `scanner.ts` — a CLI-only convenience
`runScan` already takes `{ includeChat, includeDebug, includeCli }`. The new
front-ends call it with `includeChat:false, includeDebug:false, includeCli:true`.
No code change strictly required; optionally add a `scanCliOnly(ledger)` helper
for clarity.

### 6.5 What does **not** change
`rates.ts`, `csv.ts`, `aggregate.ts` (beyond the one `requestCount` line),
`ledger.ts` (atomic save, dedup, cursors, backups) are reused verbatim. The
cross-source dedup priority `debug > chat > cli` still holds — when the same user
runs both VS Code agent and the CLI, exact CLI rows coexist; they only collapse
if they're the *same logical event*, which across surfaces they won't be.

---

## 7. Front-end B → the standalone CLI (`copilot-credit-lens` / `ccl`)

A single zero-dependency Node entrypoint compiled from `src/cli.ts`, exposed as a
`bin` (§11.1). It is the terminal replacement for `dashboard.ts` + `extension.ts`.

### 7.1 Command surface (mirrors the VS Code commands)

| Command                          | VS Code analogue                | Behaviour |
|----------------------------------|---------------------------------|-----------|
| `ccl` / `ccl dashboard`          | Open Dashboard                  | Render the ANSI dashboard for the default period |
| `ccl sync`                       | Sync Now                        | Incremental CLI-only scan, then print a one-line summary (`+N entries`) |
| `ccl reset [--label "…"]`        | Reset Period (add marker)       | Append a `ResetMarker` (no data deleted) |
| `ccl export --csv [-o file]`     | Export Usage to CSV             | `toCsv(filteredEntries)` to file or stdout |
| `ccl export --json [-o file]`    | Export Data Backup (JSON)       | `LedgerStore.exportTo()` |
| `ccl clear --yes`                | Clear All Data                  | Wipe ledger (guarded; requires `--yes`) |
| `ccl watch`                      | watcher                         | `fs.watch` the CLI session root; reprint on change (see §7.3) |
| `ccl rebuild-names`              | Rebuild Workspace Names         | Re-resolve CLI `workspace.yaml` labels |

Global flags: `--period <id>` (the 7 `PeriodId`s), `--estimated` /
`--no-estimated`, `--top <5|10|all>`, `--no-color`, `--json` (machine output for
scripting), `--width <n>`.

### 7.2 Config resolution (no VS Code settings host)
There is no `workbench` settings store, so resolve config in this precedence
(highest wins):
1. CLI flags.
2. Env vars: `CCL_PERIOD`, `CCL_INCLUDE_ESTIMATED`, `CCL_USD_PER_CREDIT`,
   `CCL_BILLING_START`, `CCL_BACKUP_DIR`.
3. A config file `~/.config/copilot-credit-lens/config.json` (platform-appropriate;
   reuse `paths.ts` conventions). Same keys as the VS Code settings, minus the
   editor-only ones (`statusBarEnabled`, `openOnStartup`, `watcherEnabled` become
   CLI flags/commands).
4. Defaults identical to `package.json` (`billingStartDate` floor `2026-06-01`,
   `usdPerCredit` `0.01`, `defaultPeriod` `currentMonth`, `includeEstimated`
   false).

Storage dir for the ledger: `~/.local/share/copilot-credit-lens/` (Linux),
`~/Library/Application Support/copilot-credit-lens/` (macOS),
`%APPDATA%\copilot-credit-lens\` (Windows) — computed like `defaultUserRoots()`.

> **Decision point for maintainers:** should the standalone CLI and the VS Code
> extension **share one ledger** or keep **separate** ones? Recommended: a
> **separate** ledger for the terminal tool (clean isolation, no cross-process
> write contention with VS Code's atomic save). Both can still `export --json`
> and be merged offline if a user wants a unified view. (Sharing would require a
> file lock to make `LedgerStore.save()` multi-writer safe — out of scope.)

### 7.3 `watch`
`fs.watch(cliSessionRoot(), { recursive: true })`, debounced ~500ms → `runScan`
(CLI-only) → clear screen → reprint. Pure local FS watching; no `child_process`.
Mirrors `watcherEnabled`. Ctrl-C exits cleanly.

### 7.4 Terminal-safety rule (replaces the webview `textContent` rule)
Every log-derived string (model ids, workspace names) is **sanitized before
printing**: strip/replace C0/C1 control bytes and lone ESC (`\x1b`), and truncate
to the column budget. This prevents a crafted session log from injecting ANSI
escapes into the user's terminal — the terminal analogue of invariant #7. All
color/styling is emitted by *our* renderer, never interpolated from data.

---

## 8. Rendering: the ANSI dashboard (`render-tty.ts`)

`renderDashboardToString(data: DashboardData, opts): string` — a **pure** function
(takes the exact `DashboardData` that `aggregate()` already produces, returns a
string). Pure ⇒ trivially testable and reusable by both front-ends. It emits
nothing itself; the caller writes to stdout / `ui.write`.

Layout, top to bottom (degrades gracefully by width; respects `--no-color` and
`NO_COLOR`):

```
GitHub Copilot Credit Lens — Current period            scanned 2026-06-24 18:05
────────────────────────────────────────────────────────────────────────────
 Credits (period)   Today      Requests    Top model            Trust
 42.6800            3.1200      318         claude-opus-4.6      ● mixed
────────────────────────────────────────────────────────────────────────────
 Daily credits
 06-18 ▏ 4.10  ███████████
 06-19 ▏ 8.74  ████████████████████████
 06-20 ▏ 1.02  ███
 … (value labels + a hover-equivalent: --verbose prints the per-day table)
────────────────────────────────────────────────────────────────────────────
 By model                          credits (requests)
 claude-opus-4.6   ████████████    38.20 (210)
 gpt-5             ██              3.00  (90)        ⚠ unknown: foo-model-x
 gemini-2.5-pro    █               1.48  (18)
────────────────────────────────────────────────────────────────────────────
 By source     cli ███████ 40.1 (300) · debug █ 2.5 (18)
 By workspace  (table: name · credits · requests · tokens)
────────────────────────────────────────────────────────────────────────────
 Exact 39.20 + estimated 3.48 = 42.68 credits   ·   ≈ $0.43 @ $0.01/credit
 318 requests · 1.72M in · 39.1K out · 1.20M cached    (3 estimated requests)
```

Renderer building blocks (all hand-rolled, zero deps):
- **Bars:** scale to max in series; Unicode `█▏` eighth-blocks for sub-cell
  precision; ASCII `#`/`=` fallback when `--ascii` or non-UTF locale.
- **Tables:** fixed-width columns computed from content, right-aligned numbers,
  truncation with `…` to the width budget.
- **Color:** a tiny internal palette (`dim`, `bold`, `green`/`yellow`/`red` for
  the trust chip `exact|mixed|estimated|none`). Auto-off when not a TTY, when
  `NO_COLOR` is set, or `--no-color`.
- **Top 5/10/All:** the VS Code client-side filter becomes the `--top` flag.
- **Reconciling footer:** prints `exactCredits + fallbackCredits = creditsPeriod`
  exactly as the webview footer does, so the math always ties out.
- `--json` bypasses the renderer and prints `DashboardData` verbatim (scripting).

No external TUI library: the webview was hand-built HTML/CSS for the same
zero-dependency reason; the terminal renderer is hand-built ANSI for the same
reason. (`blessed`/`ink`/`chalk` would all violate invariant #2.)

---

## 9. Feature parity matrix (VS Code → terminal)

| VS Code extension capability        | Terminal equivalent                                  | Status |
|-------------------------------------|------------------------------------------------------|--------|
| Webview dashboard                   | ANSI dashboard (`render-tty.ts`) + `/credits`        | ✅ full |
| KPIs (period/today/requests/top)    | KPI strip                                            | ✅ full |
| Daily bar chart + hover tooltip     | Unicode bars + value labels; `--verbose` table       | ✅ functional |
| By model / source / workspace       | Bars + tables                                        | ✅ full |
| Top 5/10/All filter                 | `--top` flag                                         | ✅ full |
| Trust chip (exact/mixed/…)          | Colored trust indicator                              | ✅ full |
| Period selector (7 periods)         | `--period` / config / `/credits <period>`            | ✅ full |
| Include-estimated toggle            | `--estimated` / config                               | ✅ full |
| Reconciling credits footer          | Footer line                                          | ✅ full |
| Cost (`usdPerCredit`)               | Footer `$` figure                                    | ✅ full |
| CSV export                          | `ccl export --csv`                                   | ✅ full (reuses `csv.ts`) |
| JSON backup / auto-backup           | `ccl export --json` / `backupDirectory`              | ✅ full |
| Reset marker                        | `ccl reset`                                          | ✅ full |
| Clear data                          | `ccl clear --yes`                                    | ✅ full |
| Status bar item                     | Optional status-line widget (`STATUS_LINE`)          | ➕ optional |
| File watcher                        | `ccl watch`                                          | ✅ full |
| Rebuild workspace names             | `ccl rebuild-names` (CLI `workspace.yaml`)           | ✅ full |
| Enable agent debug logging command  | N/A (VS Code-only concept)                           | — n/a |
| **Live current-session metrics**    | **New** via extension RPC `getMetrics()`             | ➕ bonus |
| **Premium-request units**           | **New** from `requests.cost`                         | ➕ bonus |

---

## 10. New repo layout (additive — nothing existing is moved)

```
src/
  types.ts          (+ optional requestCount/premiumRequests)
  rates.ts          (unchanged)
  csv.ts            (unchanged)
  aggregate.ts      (+ requestCount in request tally)
  ledger.ts         (unchanged)
  paths.ts          (+ COPILOT_HOME/env hardening)
  parsers.ts        (+ totalNanoAiu alias, + modelMetrics expansion)
  scanner.ts        (+ optional scanCliOnly helper)
  dashboard.ts      (unchanged — VS Code webview)
  extension.ts      (unchanged — VS Code host)
  render-tty.ts     NEW  pure ANSI renderer
  config.ts         NEW  CLI config resolution (flags > env > file > defaults)
  live.ts           NEW  getMetrics() → UsageEntry[] (extension-only path)
  cli.ts            NEW  standalone bin entrypoint (arg parsing, commands)
extension/
  credit-lens/
    extension.mjs   NEW  Copilot CLI extension shim (imports compiled core)
scripts/
  build-cli.*       NEW  tsc + assemble extension/credit-lens/core from out/
  install-extension.* NEW copy/symlink into ~/.copilot/extensions + flag hint
docs/
  copilot-cli-credit-lens.md   ← this file
```

`tsconfig.json` already emits `out/`; `cli.ts`, `render-tty.ts`, `config.ts`,
`live.ts` compile alongside the existing modules. The extension `core/` is just
the relevant `out/*.js` files copied next to `extension.mjs`.

---

## 11. Packaging & distribution

Same spirit as "`.vsix` only, never the Marketplace": **local artifacts only**.

### 11.1 Standalone CLI
- Add to `package.json`:
  ```jsonc
  "bin": { "copilot-credit-lens": "out/cli.js", "ccl": "out/cli.js" }
  ```
  with a `#!/usr/bin/env node` shebang in `cli.ts`'s emitted file.
- Distribute as a local tarball: `npm pack` → `copilot-credit-lens-<v>.tgz`, run
  via `npx ./copilot-credit-lens-<v>.tgz` or `npm i -g ./…tgz`. No registry
  publish required (mirrors the local-`.vsix` stance).
- Node engine: pin `"engines": { "node": ">=18" }` (stable `fs/promises`,
  `fs.watch` recursive on macOS/Windows; Linux recursive caveat handled by a
  per-dir fallback in `watch`).

### 11.2 Versioning / release
Extend `.github/workflows/release.yml` to **also** `npm pack` the CLI tarball and
attach it to the same GitHub Release next to the `.vsix`. Reuse the existing
`v<major>.<minor>.<run_number>` scheme — one release ships both artifacts. No new
secrets; still no Marketplace/registry push.

### 11.3 Extension install
A tiny `scripts/install-extension` (Node, no deps) that:
1. Builds (`npm run compile`), assembles `extension/credit-lens/core/` from `out/`.
2. Copies `extension/credit-lens/` → `~/.copilot/extensions/credit-lens/`
   (or, with `--project`, into `./.github/extensions/`).
3. Prints the one manual step: add `"EXTENSIONS"` to `experimental` in
   `~/.copilot/settings.json` (we *show* the diff; we do **not** silently rewrite
   the user's CLI settings — read-only-by-default principle).

### 11.4 The one allowed coupling
`extension.mjs` imports `@github/copilot-sdk` — **resolved by the host CLI at
runtime**, not bundled. To get types while developing, add it as a **dev**
dependency (pinned, no `^`), used only for `joinSession`/`session.rpc` typings.
It must never appear in `dependencies`. Document the minimum CLI version (≥
1.0.56) in the extension README.

---

## 12. Testing (matches the repo's "smoke test against compiled out/*.js" rule)

There's no formal unit runner; follow the existing convention.

1. **Fixture sessions.** Create a temp `~/.copilot/session-state/<id>/` with a
   synthetic `events.jsonl` containing: a `session.shutdown` with multi-model
   `modelMetrics` (one with `totalNanoAiu`, one without → estimated), a
   malformed line, an unknown-type line, and a `workspace.yaml` with `cwd:`.
2. **Pipeline assert.** `discoverCliFiles → parseFile → LedgerStore.appendEntries
   → aggregate → renderDashboardToString` and assert: exact credits =
   `totalNanoAiu/1e9`; estimated model flagged & excluded unless `--estimated`;
   `requests` honor `requestCount`; trust = `mixed`; footer reconciles
   (`exact + fallback == creditsPeriod`); malformed line skipped with a warning,
   not a throw.
3. **Renderer snapshots.** `render-tty` with `--no-color` produces deterministic
   strings; snapshot them (and `--json`). Verify control-char sanitization: a
   model id containing `\x1b[31m` renders inert.
4. **Idempotency / cursors.** Run `runScan` twice; second run adds 0 (cursor +
   id-dedup). Append a new shutdown line; only the delta is read.
5. **Extension dry-run.** Unit-test `liveSessionEntries(session)` against a fake
   `session.rpc.usage.getMetrics()` returning the documented shape, plus the
   throw/empty cases.
6. Then `npm run compile` (strict, warning-free) and `npm audit
   --audit-level=moderate` (0 vulns). Real end-to-end: install the extension, run
   `/credits` in an actual Copilot CLI session.

---

## 13. Phased delivery

- **Phase 1 — core adaptation (small).** `parsers.ts` (`totalNanoAiu` +
  `modelMetrics` expansion), `types.ts`/`aggregate.ts` `requestCount`, fixtures &
  pipeline smoke test. *Outcome: the ledger correctly reflects CLI sessions.*
- **Phase 2 — standalone CLI.** `render-tty.ts`, `config.ts`, `cli.ts`, `bin`,
  `dashboard`/`sync`/`export`/`reset`/`clear`/`watch`/`rebuild-names`. *Outcome:
  a usable terminal dashboard, version-independent.*
- **Phase 3 — Copilot CLI extension.** `extension/credit-lens/extension.mjs`,
  `live.ts`, installer, `/credits` (+ optional status-line). *Outcome: in-session
  `/credits` with live current-session metrics.*
- **Phase 4 — release plumbing.** Extend `release.yml` to attach the CLI tarball;
  READMEs; CHANGELOG entry; bump `major.minor` if opening a new line.

Each phase is independently shippable and preserves all invariants.

---

## 14. Risks, edge cases, open questions

- **Schema drift.** `events.jsonl` is not yet an official API
  (`github/copilot-cli#3551`). Mitigation: resilient parsing is already invariant
  #4; all field access is alias-based and tolerant; unknown event types are
  ignored. A new field name = a one-line alias add in `parsers.ts`.
- **Per-session aggregation, not per-call.** The CLI reports model totals at
  shutdown, so historical "requests" come from `requests.count`, and **live**
  per-call data only exists via the extension RPC. Documented as a known
  difference from VS Code's per-request rows.
- **Live sessions have no `session.shutdown` yet.** History undercounts the
  in-flight session until it ends; the extension's `getMetrics()` path fills that
  gap when running inside the CLI; the standalone `ccl` shows it after the session
  closes (or on next `sync`).
- **SDK callback shape.** `slashCommands` handler signature / `ui` writer is
  pinned to the SDK version we build against; isolated entirely in `extension.mjs`.
- **Estimation accuracy.** `rates.ts` multipliers are GitHub's published premium
  multipliers and drift over time — already isolated to one file, already
  flagged-as-estimate in the UI. When `requests.cost` (premium units) is present
  we can *prefer* it over the multiplier for the estimate.
- **Cross-platform `~/.copilot`.** Honor `COPILOT_HOME` if set; otherwise
  `os.homedir()/.copilot`. Missing → empty result, never throw.
- **Multi-writer ledger.** If we ever share one ledger with VS Code, add a file
  lock around `LedgerStore.save()`. Default recommendation: separate ledgers.
- **Open question for maintainers:** publish to npm as a real package, or keep
  strictly local tarball + Release asset (matching the no-Marketplace stance)?
  Recommendation: local/Release-asset first; revisit npm only if there's demand.

---

## 15. Bottom line

Building a Copilot **CLI** counterpart is not only doable — it's a short hop,
because this repo already (a) reads the CLI's `events.jsonl`, and (b) cleanly
separates pure logic from presentation. The work is: ~3 small additive edits to
the shared core, one pure ANSI renderer, a thin standalone `bin`, and a ~40-line
extension shim that registers `/credits` and taps the live metrics RPC. Every
non-negotiable invariant (offline, read-only, zero-deps, honest credits, audit
clean) survives intact, and the terminal experience reaches functional parity
with the VS Code dashboard plus two bonuses unique to the CLI surface: live
current-session metrics and premium-request units.

---

## 16. References

- GitHub Docs — About GitHub Copilot CLI session data:
  <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle>
- GitHub Docs — Using / best practices for GitHub Copilot CLI:
  <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli>
- GitHub Docs — Streaming events in the Copilot SDK:
  <https://docs.github.com/en/copilot/how-tos/copilot-sdk/use-copilot-sdk/streaming-events>
- `github/copilot-cli` repository: <https://github.com/github/copilot-cli>
- `github/copilot-sdk` (Node README): <https://github.com/github/copilot-sdk/blob/main/nodejs/README.md>
- Copilot CLI Extensions — complete guide (htek.dev):
  <https://htek.dev/articles/github-copilot-cli-extensions-complete-guide>
- Copilot CLI Extensions Revamp — custom slash commands & extensibility (dev.to):
  <https://dev.to/htekdev/copilot-cli-extensions-revamp-custom-slash-commands-and-full-extensibility-1f9e>
- Copilot CLI Extensions Cookbook (htek.dev):
  <https://htek.dev/articles/copilot-cli-extensions-cookbook-examples>
- `DamianEdwards/copilot-cli-cost` (precedent: live `/cost` via `getMetrics()`):
  <https://github.com/DamianEdwards/copilot-cli-cost>
- DeepWiki — Session State & Lifecycle Management:
  <https://deepwiki.com/github/copilot-cli/6.2-session-state-and-lifecycle-management>
- DeepWiki — MCP Server Configuration:
  <https://deepwiki.com/github/copilot-cli/5.3-mcp-server-configuration>
- Issue #3551 — Formalize `events.jsonl` as an official hook/integration API:
  <https://github.com/github/copilot-cli/issues/3551>
- Issue #1394 — Persist usage statistics; #1152 — More verbose token information;
  #1880 — Monthly usage tracking.
- Community precedents: `J-Bax/copilot-token-tracker`,
  `JeffSteinbok/ghcpCliDashboard`.

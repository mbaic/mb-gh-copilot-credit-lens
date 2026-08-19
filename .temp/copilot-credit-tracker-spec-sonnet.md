# Copilot Credit Tracker — Extension Plan & Specification

**Version:** 1.0  
**Target:** VS Code Extension (TypeScript, Node.js)  
**License type supported:** GitHub Copilot Business / Enterprise  
**Author context:** Solution Architect, org-managed seat

---

## 1. Overview

Copilot Credit Tracker is a local-first, zero-telemetry VS Code extension that reads GitHub Copilot session log files from disk, extracts credit/token usage, persists it in its own ledger, and displays clean analytics in a sidebar dashboard — per period, per model, per workspace, and per source (Chat vs CLI vs Cloud Agent).

No GitHub API token required. No data leaves the machine. Works offline.

---

## 2. Problem Statement

Since GitHub Copilot moved to usage-based billing (June 1, 2026), every premium request consumes AI Credits (AIU). There is no built-in per-workspace, per-model breakdown in VS Code. The GitHub.com billing page shows totals only. Developers on Business/Enterprise seats need granular local visibility.

---

## 3. Goals

- Show current billing period consumption (1st of month → today)
- Show historical periods: last 3 months, 6 months, 9 months, 1 year
- Break down by: model, workspace/project, source (Chat / CLI / Cloud Agent)
- Persist data in extension's own ledger — survives log file deletion
- Auto-collect on VS Code startup and while open (file watcher)
- Support manual reset markers (period resets without data loss)
- Support CSV export
- Modern UI in Business Central green color theme

---

## 4. Non-Goals

- No GitHub API calls
- No remote telemetry or analytics
- No multi-machine sync
- No modification of any Copilot log files
- No authentication flow

---

## 5. Data Sources

### 5.1 VS Code Copilot Chat — chatSessions JSONL

**Path (Windows):**
```
%APPDATA%\Code\User\workspaceStorage\{workspaceHash}\chatSessions\*.jsonl
```

**Path (macOS):**
```
~/Library/Application Support/Code/User/workspaceStorage/{workspaceHash}/chatSessions/*.jsonl
```

**Path (Linux):**
```
~/.config/Code/User/workspaceStorage/{workspaceHash}/chatSessions/*.jsonl
```

**File format:** One JSON object per line. Relevant event types:

```json
{
  "type": "llm_request",
  "ts": 1718532000000,
  "sid": "session-uuid",
  "model": "claude-sonnet-4-5",
  "inputTokens": 12450,
  "outputTokens": 312,
  "cachedTokens": 8100,
  "copilotUsageNanoAiu": 1000000000
}
```

**Key field:** `copilotUsageNanoAiu` — divide by `1,000,000,000` to get exact AIU credits billed. This is the actual billing unit, not an estimate.

**Workspace name resolution:** Read `workspaceStorage/{hash}/workspace.json`:
```json
{ "folder": "file:///C:/Users/user/projects/MyProject" }
```
Extract the last path segment as the display name.

**Always available:** Yes — these files exist by default when Copilot Chat is used.

---

### 5.2 VS Code Copilot Agent Debug Logs

**Path (Windows):**
```
%APPDATA%\Code\User\workspaceStorage\{hash}\GitHub.copilot-chat\debug-logs\{sessionId}\main.jsonl
%APPDATA%\Code\User\workspaceStorage\{hash}\GitHub.copilot-chat\debug-logs\{sessionId}\runSubagent-*.jsonl
```

**Requires setting (not enabled by default):**
```json
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

**Additional fields in debug-logs vs chatSessions:**
- More granular per-turn breakdown
- Subagent calls tracked separately in `runSubagent-*.jsonl`
- `copilotUsageNanoAiu` is present and authoritative

**Priority:** When both `chatSessions` and `debug-logs` cover the same session (matched by `sid`), prefer `debug-logs` values — they are more precise.

---

### 5.3 GitHub Copilot CLI Sessions

**Path (all platforms):**
```
~/.copilot/session-state/{sessionId}/events.jsonl
```

**File format:**
```json
{
  "type": "llm_request",
  "ts": 1718532000000,
  "model": "gpt-4o",
  "inputTokens": 5200,
  "outputTokens": 180,
  "copilotUsageNanoAiu": 500000000
}
```

**Workspace metadata:**
```
~/.copilot/session-state/{sessionId}/workspace.yaml
```
Contains the working directory path — use it as the workspace label.

**Always available:** Yes — CLI creates these automatically when `gh copilot` commands are run.

**Note:** CLI sessions are tracked globally (not per VS Code workspace). They are attributed to the directory active during the CLI session.

---

### 5.4 Cloud Agent Sessions (Copilot Coding Agent)

**Status:** ⚠️ Partial — local tracking only via VS Code GitHub Pull Requests extension.

Cloud agent sessions run server-side on GitHub.com. There are **no local JSONL files** created for cloud agent sessions unless the session was initiated from VS Code with the GitHub Pull Requests extension installed.

**What IS available locally:**
- Session logs are linked from the commit via `Agent-Logs-Url` trailer in commit messages (GitHub.com URL only, not local)
- The GitHub Pull Requests extension stores session references in VS Code workspace storage — but not token/credit data

**What is NOT available locally:**
- Raw AIU credits consumed by cloud agent runs
- Full LLM turn data for server-side agent execution

**Extension approach for Cloud Agent:**
- Detect sessions that appear to be cloud-agent-initiated by checking for `agentType: "cloud"` or similar markers in debug-log events
- If found, flag them in the UI with a `☁ Cloud` badge
- Show token counts if available, with a note that credit totals may be incomplete for cloud sessions
- Add a manual entry feature: user can type in credits from the GitHub.com billing page to reconcile

---

## 6. Architecture

### 6.1 Component Map

```
extension/
├── src/
│   ├── extension.ts              ← Activation, command registration, watcher setup
│   ├── scanner/
│   │   ├── FileScanner.ts        ← Discovers all JSONL paths across sources
│   │   ├── ChatSessionParser.ts  ← Parses chatSessions/*.jsonl
│   │   ├── DebugLogParser.ts     ← Parses debug-logs/main.jsonl + subagent files
│   │   ├── CliSessionParser.ts   ← Parses ~/.copilot/session-state/*/events.jsonl
│   │   └── WorkspaceResolver.ts  ← Hash → readable project name
│   ├── ledger/
│   │   ├── Ledger.ts             ← Read/write ledger JSON in globalStorageUri
│   │   ├── LedgerEntry.ts        ← Type definitions
│   │   └── Deduplicator.ts       ← Byte-offset tracking, prevents double-count
│   ├── watcher/
│   │   └── FileWatcher.ts        ← vscode.workspace.createFileSystemWatcher
│   ├── views/
│   │   ├── DashboardPanel.ts     ← WebviewPanel host
│   │   └── dashboard/
│   │       ├── index.html        ← Dashboard HTML (embedded in extension)
│   │       ├── dashboard.css     ← BC green theme styles
│   │       └── dashboard.js      ← Chart.js rendering, period filters
│   ├── commands/
│   │   ├── SyncNow.ts            ← Manual full scan trigger
│   │   ├── ResetPeriod.ts        ← Push reset marker to ledger
│   │   └── ExportCsv.ts          ← Write filtered entries to CSV
│   └── utils/
│       ├── PathResolver.ts       ← Platform-specific path detection
│       ├── DateHelpers.ts        ← Period boundary calculations
│       └── Logger.ts             ← VS Code output channel wrapper
├── package.json
├── tsconfig.json
└── .vscodeignore
```

### 6.2 Ledger File Structure

Stored at: `context.globalStorageUri/copilot-credits-ledger.json`

This path is **never deleted by VS Code** — it survives extension updates, workspace changes, and log file rotation.

```json
{
  "schemaVersion": 2,
  "lastFullScan": "2026-06-16T17:00:00Z",
  "resetMarkers": [
    { "id": "reset-001", "ts": "2026-04-01T00:00:00Z", "label": "Q2 start" }
  ],
  "fileOffsets": {
    "C:\\Users\\user\\AppData\\Roaming\\Code\\User\\workspaceStorage\\abc123\\chatSessions\\session1.jsonl": 8192
  },
  "workspaceNames": {
    "abc123": "BC-Navision-Project",
    "def456": "CustomerPortal"
  },
  "entries": [
    {
      "id": "evt-abc123-1718532000000-1",
      "ts": "2026-06-01T09:12:00Z",
      "source": "chat",
      "model": "claude-sonnet-4-5",
      "workspaceHash": "abc123",
      "workspaceName": "BC-Navision-Project",
      "credits": 1.0,
      "inputTokens": 12450,
      "outputTokens": 312,
      "cachedTokens": 8100,
      "sessionId": "session-uuid"
    }
  ]
}
```

**Field notes:**
- `id` = `{workspaceHash}-{ts}-{sequential}` — globally unique per entry
- `source` = `"chat"` | `"debug-log"` | `"cli"` | `"cloud-agent"` | `"manual"`
- `credits` = `copilotUsageNanoAiu / 1_000_000_000` (rounded to 4 decimals)
- `workspaceName` is resolved and stored at parse time — survives workspace deletion

### 6.3 Deduplication Strategy

Each log file path has a stored `lastByteOffset` in the ledger. On every scan:
1. Open file
2. Seek to `lastByteOffset`
3. Read only new lines
4. Parse and append entries
5. Update `lastByteOffset` to new EOF position

If a file is found but has no stored offset → full parse from byte 0 (first-time scan).

**Session deduplication across sources:** When `debug-logs` and `chatSessions` both contain events with the same `sid`, keep the `debug-log` entry and discard the `chatSessions` entry (debug-log has more precision). Deduplication key: `{sid}-{turn-index}`.

---

## 7. Collection Flow

### 7.1 On Extension Activation

```
1. Resolve platform-specific storage paths (Windows / macOS / Linux)
2. Check agentDebugLog setting — show one-time notification if disabled
3. Load existing ledger from globalStorageUri
4. Run full backfill scan:
   a. Discover all JSONL files across all three sources
   b. For each file: read from stored offset (or 0 if new)
   c. Parse events, resolve workspace names, build entries
   d. Deduplicate, append to ledger, save ledger
5. Start FileSystemWatcher on discovered paths
6. Register sidebar view and commands
7. Open dashboard (if set in settings)
```

### 7.2 While VS Code is Open (Watcher)

```
FileSystemWatcher fires on *.jsonl write →
  Determine which file changed →
  Read from stored byte offset →
  Parse new events only →
  Append to ledger →
  Save ledger →
  Emit event to dashboard WebView (live update)
```

### 7.3 Manual Sync Command

`Copilot Credit Tracker: Sync Now`  
Re-runs the full backfill scan. Useful after returning from a CLI session, or after enabling debug logs for the first time.

---

## 8. Dashboard UI

### 8.1 Layout

Single-page WebView panel with:
- **Header bar:** Extension name + current period label + last sync timestamp + Sync button
- **KPI strip:** 4 stat cards (Credits Today / Credits This Period / Total Requests / Top Model)
- **Primary chart:** Bar chart — credits per day for selected period
- **Breakdown section:** Two side-by-side charts:
  - Donut chart: Credits by model
  - Donut chart: Credits by source (Chat / CLI / Cloud Agent)
- **Workspace table:** Table of projects × credits for selected period
- **Footer bar:** Period selector + Reset button + Export CSV button

### 8.2 Period Selector Options

| Label | Filter |
|---|---|
| Current period | 1st of current month → today |
| Last 3 months | Rolling 90 days |
| Last 6 months | Rolling 180 days |
| Last 9 months | Rolling 270 days |
| Last 12 months | Rolling 365 days |
| Since last reset | From latest resetMarker timestamp → today |
| All time | No filter |

### 8.3 Color Theme — Business Central Green

Primary accent: `#107C41` (BC/Microsoft green)  
Secondary accent: `#1a9652`  
Background: `#f3f9f5`  
Surface: `#ffffff`  
Dark surface: `#1c2b22`  
Text primary: `#1a2e22`  
Text muted: `#5a7a65`  
Border: `#c8e0d0`  
Chart palette: `['#107C41', '#1a9652', '#2dc06a', '#6ddc98', '#b0f0cc', '#e0f8ec']`

### 8.4 Status Bar Item

A compact status bar item at the bottom right:  
`⚡ 12.4 AIU this period`  
Clicking it opens the dashboard panel.

---

## 9. Commands

| Command ID | Title | Description |
|---|---|---|
| `copilotCredits.openDashboard` | Open Dashboard | Opens the WebView panel |
| `copilotCredits.syncNow` | Sync Now | Full backfill re-scan |
| `copilotCredits.resetPeriod` | Reset Period | Push a reset marker with optional label |
| `copilotCredits.exportCsv` | Export CSV | Export filtered entries to chosen file path |
| `copilotCredits.clearLedger` | Clear All Data | Wipe ledger (with confirmation dialog) |
| `copilotCredits.enableDebugLogs` | Enable Copilot Debug Logging | Sets the agentDebugLog setting to true |

---

## 10. Extension Settings

All settings are user-level (`settings.json`) unless noted.

| Setting | Type | Default | Description |
|---|---|---|---|
| `copilotCredits.autoSync` | boolean | `true` | Run backfill scan on every VS Code startup |
| `copilotCredits.watcherEnabled` | boolean | `true` | Enable file system watcher for live updates |
| `copilotCredits.openOnStartup` | boolean | `false` | Auto-open dashboard on VS Code launch |
| `copilotCredits.statusBarEnabled` | boolean | `true` | Show credit total in status bar |
| `copilotCredits.defaultPeriod` | string | `"currentMonth"` | Default period selector value |
| `copilotCredits.includeCliSessions` | boolean | `true` | Parse `~/.copilot/session-state/` CLI logs |
| `copilotCredits.includeChatSessions` | boolean | `true` | Parse VS Code chatSessions JSONL |
| `copilotCredits.includeDebugLogs` | boolean | `true` | Parse agent debug-log JSONL (if enabled) |
| `copilotCredits.additionalWorkspacePaths` | array | `[]` | Extra workspaceStorage paths (multi-profile users) |

---

## 11. Prerequisites & Setup Guide

### 11.1 Prerequisites

1. **VS Code** — version 1.90 or later
2. **GitHub Copilot Chat extension** — `GitHub.copilot-chat` installed and signed in
3. **GitHub Copilot CLI** — optional; only needed if you want CLI session tracking
   - Install: `gh extension install github/gh-copilot`
4. Node.js 20+ (for extension development only — not needed by end users)

### 11.2 Strongly Recommended: Enable Agent Debug Logging

This unlocks the precise `copilotUsageNanoAiu` field in agent sessions. Without it, the extension falls back to token-based estimates for agent mode only.

Add to your VS Code `settings.json`:

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

**How to apply:**
1. Open VS Code Settings (`Ctrl+,`)
2. Click the `{}` icon (top-right) to open `settings.json`
3. Add the line above
4. Restart VS Code

Or use the extension command:  
`Ctrl+Shift+P` → `Copilot Credit Tracker: Enable Copilot Debug Logging`

### 11.3 Installation (when published)

```
1. Open VS Code Extensions panel (Ctrl+Shift+X)
2. Search "Copilot Credit Tracker"
3. Click Install
4. Reload VS Code when prompted
5. The status bar item appears immediately: ⚡ syncing...
6. After first scan completes: ⚡ X.X AIU this period
```

### 11.4 Installation (from VSIX during development)

```bash
# Build the extension
cd copilot-credit-tracker
npm install
npm run build

# Package as VSIX
npx vsce package

# Install in VS Code
code --install-extension copilot-credit-tracker-1.0.0.vsix
```

### 11.5 First-Time Use

1. After installation, the extension scans all existing log files (backfill)
2. If `agentDebugLog.fileLogging.enabled` is not set, a notification appears with a one-click enable button
3. Open the dashboard: `Ctrl+Shift+P` → `Copilot Credit Tracker: Open Dashboard`
4. Select your desired period from the bottom dropdown
5. Data updates live as you use Copilot

---

## 12. Cloud Agent Sessions — Detailed Analysis

### 12.1 What Runs Server-Side

When a user triggers a Copilot Coding Agent session from GitHub.com (e.g., assigning an issue to Copilot), execution happens entirely on GitHub's servers. No local JSONL files are created on the developer's machine for the LLM calls.

### 12.2 What IS Available Locally

**Scenario A: Agent session initiated from VS Code (GitHub Pull Requests extension)**
- The session appears in the VS Code Agents panel
- Debug log events may be present in `debug-logs/{sessionId}/` with partial data
- Token and credit data may be available if the session had a local VS Code component

**Scenario B: Agent session initiated from GitHub.com**
- No local log files are created
- Commits produced by the agent include `Agent-Logs-Url` in the commit message — this is a link to GitHub.com logs, not local data
- Not parseable by this extension

### 12.3 Extension Strategy for Cloud Agent

| Detection | Action |
|---|---|
| `source === "debug-log"` and session has `agentType: "remote"` marker | Flag with `☁` badge, show available token data |
| GitHub.com-initiated session with no local data | Not detectable without API |
| Manual reconciliation | User can add entries manually via `Copilot Credit Tracker: Add Manual Entry` command, entering credits from GitHub.com billing page |

### 12.4 Manual Entry Feature

A command `copilotCredits.addManualEntry` opens a QuickPick flow:
```
1. Select date
2. Enter credit amount (from GitHub.com billing page)
3. Select model (optional)
4. Enter label (e.g., "Cloud agent — BC integration PR #42")
5. Entry saved to ledger with source: "manual"
```

Manual entries appear in all period charts and totals, clearly labeled with a `✎` icon.

---

## 13. Data Freshness & Limitations

| Scenario | Behavior |
|---|---|
| VS Code closed during Copilot session | Events captured on next VS Code open (backfill scan) |
| Log files deleted before extension installed | Historical data lost — extension can only track from first scan |
| CLI session while VS Code closed | Captured on next VS Code open (backfill scan reads ~/.copilot/) |
| Multiple VS Code profiles | Add extra paths via `copilotCredits.additionalWorkspacePaths` |
| Cloud agent (GitHub.com-initiated) | Not tracked automatically — use manual entry |
| `copilotUsageNanoAiu` field absent | Fall back to token-count-based estimate using published model rates |

---

## 14. Token Fallback Credit Estimation

When `copilotUsageNanoAiu` is absent (chatSessions format, older Copilot versions), estimate credits using published premium request multipliers:

```typescript
const MODEL_CREDIT_RATES: Record<string, number> = {
  "gpt-4o":                1.0,
  "claude-sonnet-4-5":     1.0,
  "claude-opus-4":         10.0,
  "o3":                    10.0,
  "gemini-2.5-pro":        1.0,
  // fallback for unknown models
  "default":               1.0
};
```

Estimated entries are flagged with a `~` prefix in the UI (e.g., `~0.8 AIU`) to distinguish from exact values.

---

## 15. Code Patterns & Quality Standards

### 15.1 TypeScript Conventions

- Strict mode enabled: `"strict": true` in `tsconfig.json`
- All file I/O async with `fs/promises`
- No `any` types — use discriminated unions for entry `source` field
- Error handling: never throw from parsers — return `Result<T, Error>` type
- All path operations via `PathResolver.ts` — never hardcode OS-specific paths inline

### 15.2 Parser Design

Each parser implements the `ISessionParser` interface:

```typescript
interface ISessionParser {
  readonly source: SessionSource;
  canHandle(filePath: string): boolean;
  parse(filePath: string, fromOffset: number): Promise<ParseResult>;
}

interface ParseResult {
  entries: LedgerEntry[];
  newOffset: number;
  errors: ParseError[];
}
```

Adding a new source = implement `ISessionParser` + register in `FileScanner`. No changes to `extension.ts`.

### 15.3 Dashboard Message Protocol

Extension ↔ WebView communicate via typed messages:

```typescript
type ExtensionMessage =
  | { type: 'UPDATE_DATA'; payload: DashboardData }
  | { type: 'SYNC_STATUS'; payload: { status: 'running' | 'done' | 'error' } };

type WebViewMessage =
  | { type: 'CHANGE_PERIOD'; payload: Period }
  | { type: 'REQUEST_EXPORT' }
  | { type: 'REQUEST_RESET' };
```

### 15.4 Ledger Persistence

- Ledger is loaded once into memory on activation
- All mutations go through `Ledger.appendEntries()` and `Ledger.save()`
- `save()` uses atomic write: write to `.tmp` file → rename to final path (prevents corruption on crash)
- Ledger file is human-readable JSON — can be inspected or manually edited if needed

---

## 16. Extension Manifest (package.json — key sections)

```json
{
  "name": "copilot-credit-tracker",
  "displayName": "Copilot Credit Tracker",
  "description": "Local-first GitHub Copilot credit usage tracker. No API. No telemetry.",
  "version": "1.0.0",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "copilotCredits.openDashboard", "title": "Open Dashboard", "category": "Copilot Credit Tracker" },
      { "command": "copilotCredits.syncNow", "title": "Sync Now", "category": "Copilot Credit Tracker" },
      { "command": "copilotCredits.resetPeriod", "title": "Reset Period", "category": "Copilot Credit Tracker" },
      { "command": "copilotCredits.exportCsv", "title": "Export CSV", "category": "Copilot Credit Tracker" },
      { "command": "copilotCredits.clearLedger", "title": "Clear All Data", "category": "Copilot Credit Tracker" },
      { "command": "copilotCredits.enableDebugLogs", "title": "Enable Copilot Debug Logging", "category": "Copilot Credit Tracker" },
      { "command": "copilotCredits.addManualEntry", "title": "Add Manual Entry (Cloud Agent)", "category": "Copilot Credit Tracker" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "copilotCredits", "title": "Copilot Credits", "icon": "$(graph)" }
      ]
    },
    "views": {
      "copilotCredits": [
        { "type": "webview", "id": "copilotCredits.dashboard", "name": "Dashboard" }
      ]
    },
    "configuration": {
      "title": "Copilot Credit Tracker",
      "properties": {
        "copilotCredits.autoSync": { "type": "boolean", "default": true },
        "copilotCredits.watcherEnabled": { "type": "boolean", "default": true },
        "copilotCredits.openOnStartup": { "type": "boolean", "default": false },
        "copilotCredits.statusBarEnabled": { "type": "boolean", "default": true },
        "copilotCredits.defaultPeriod": {
          "type": "string",
          "default": "currentMonth",
          "enum": ["currentMonth", "last3months", "last6months", "last9months", "last12months", "sinceReset", "allTime"]
        },
        "copilotCredits.includeCliSessions": { "type": "boolean", "default": true },
        "copilotCredits.includeChatSessions": { "type": "boolean", "default": true },
        "copilotCredits.includeDebugLogs": { "type": "boolean", "default": true },
        "copilotCredits.additionalWorkspacePaths": { "type": "array", "items": { "type": "string" }, "default": [] }
      }
    }
  }
}
```

---

## 17. VS Code Settings — Complete Reference

Add to your VS Code `settings.json` (User level):

```json
{
  // ── Required: Enable Copilot agent debug logging for precise AIU data ──
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true,

  // ── Copilot Credit Tracker settings ──
  "copilotCredits.autoSync": true,
  "copilotCredits.watcherEnabled": true,
  "copilotCredits.openOnStartup": false,
  "copilotCredits.statusBarEnabled": true,
  "copilotCredits.defaultPeriod": "currentMonth",
  "copilotCredits.includeCliSessions": true,
  "copilotCredits.includeChatSessions": true,
  "copilotCredits.includeDebugLogs": true,
  "copilotCredits.additionalWorkspacePaths": []
}
```

**If you use multiple VS Code profiles**, add the extra profile's workspaceStorage path:

```json
"copilotCredits.additionalWorkspacePaths": [
  "C:\\Users\\yourname\\AppData\\Roaming\\Code - Insiders\\User\\workspaceStorage"
]
```

---

## 18. Development Roadmap

### v1.0 — Core (MVP)
- [x] Chat session parser (chatSessions JSONL)
- [x] Agent debug log parser
- [x] CLI session parser
- [x] Ledger with byte-offset deduplication
- [x] FileSystemWatcher + startup backfill
- [x] Dashboard with period selector and charts
- [x] Status bar item
- [x] Sync / Reset / Export CSV commands

### v1.1 — Polish
- [ ] Manual entry for cloud agent credits
- [ ] Trend line overlay on bar chart
- [ ] Per-workspace detailed breakdown page
- [ ] Notification when credits exceed configurable threshold

### v1.2 — Extended Sources
- [ ] JetBrains log parser (if structure matches)
- [ ] GitHub Copilot for Xcode log parser
- [ ] Multi-machine merge via shared ledger file (opt-in, manual sync)

### v2.0 — Intelligence
- [ ] Credit budget feature with alert threshold
- [ ] Most expensive sessions list
- [ ] Model efficiency report (credits per accepted suggestion)
- [ ] `@copilotcredits` chat participant for conversational queries

---

## 19. Security & Privacy

- All data stays on local disk — no outbound HTTP calls
- Ledger file contains no secrets, code, or prompt content — only metadata
- Log files are read-only — extension never writes to Copilot's own files
- `clearLedger` command irreversibly wipes the ledger (confirmation required)
- Extension declares no network permissions in `package.json`

---

## 20. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dashboard shows 0 credits | Debug logging not enabled | Run `Enable Copilot Debug Logging` command |
| CLI sessions not appearing | CLI not installed or sessions in different home dir | Check `~/.copilot/session-state/` exists; add path via `additionalWorkspacePaths` |
| Workspace shows as hash instead of name | `workspace.json` missing or deleted | Name is resolved only if file is readable at first scan — rename manually in UI (future feature) |
| Credits seem lower than GitHub billing page | Cloud agent sessions not tracked | Add manual entries for cloud agent credits |
| Extension not activating | VS Code < 1.90 | Update VS Code |
| Sync takes long time | Many log files accumulated | Normal on first run; subsequent syncs are incremental |
| Ledger file corrupt | Crash during save (rare) | Delete `copilot-credits-ledger.json` from globalStorageUri and re-sync |

---

*Specification version 1.0 — June 2026*

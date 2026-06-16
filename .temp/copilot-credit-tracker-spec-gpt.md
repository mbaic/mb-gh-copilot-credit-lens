# Copilot Credit Tracker — Development Spec v1.1

## 1. Purpose

Copilot Credit Tracker is a local-first VS Code extension that reads local GitHub Copilot session artifacts, extracts usage events, stores them in an extension-owned ledger, and presents consumption analytics by period, model, workspace, and source. Existing local tools and session-artifact projects show this approach is feasible for VS Code and CLI usage [cite:22][cite:27][cite:38][cite:46].

## 2. Product Position

- No GitHub API usage.
- No outbound telemetry.
- Private by default.
- Best effort exactness from local logs when exact AIU/credit fields are present.
- Graceful degradation to estimated usage only when exact credit data is missing.
- Cloud-agent usage triggered on GitHub.com is **not** a supported automatic source in v1; it is manual reconciliation only unless verifiable local evidence is present for a given session [cite:39][cite:41][cite:50].

## 3. Supported Sources

### 3.1 VS Code Copilot Chat
- Read local VS Code Copilot session artifacts under user storage.
- Treat source schema as version-dependent.
- Parse only known event types and ignore unknown payloads safely.
- Capture at minimum: timestamp, session id, model, workspace identity, token counts, exact credit field when present.

### 3.2 VS Code Agent Debug Logs
- Support agent debug logs as a higher-fidelity source when enabled.
- The setting `github.copilot.chat.agentDebugLog.fileLogging.enabled` is a prerequisite for richer local agent logging [cite:29].
- If both standard chat session artifacts and debug artifacts contain the same logical event, prefer the richer debug source.

### 3.3 GitHub Copilot CLI
- Support local CLI session-state ingestion from the user profile.
- Local CLI session state on disk is a realistic source for tracking CLI usage [cite:38].
- Attribute CLI activity to the working directory/session label when available.

### 3.4 Cloud Agent
- Default status: **manual only**.
- Do not promise automatic tracking for GitHub.com-triggered cloud agent runs.
- If a local artifact clearly identifies a cloud/remote session, surface it as informational and mark totals as partial.
- Provide manual entry and reconciliation workflow for these cases [cite:39][cite:41][cite:50].

## 4. Non-Goals

- No promise of complete historical recovery before first install.
- No cross-device merge in v1.
- No scraping of GitHub.com pages.
- No mutation of Copilot-owned files.
- No dependency on undocumented remote endpoints.

## 5. Core Behavior

### 5.1 First Run
- Discover supported source roots.
- Perform full backfill over files currently present.
- Create extension ledger.
- Resolve readable workspace names where possible.
- Show onboarding state if no compatible logs are found.

### 5.2 Continuous Collection
- Use a resilient collection service that can:
  - rescan on activation,
  - rescan on manual command,
  - incrementally ingest appended data,
  - recover from missed events after VS Code restart.
- Design collection so correctness does not depend on the UI being open.

### 5.3 Data Retention
- Persist normalized entries into extension-owned storage.
- Source log deletion must not remove already imported entries.
- Clearing the extension ledger is a separate explicit user action.

## 6. Ledger Design

### 6.1 Storage
- Store in `ExtensionContext.globalStorageUri`.
- Use atomic save: write temp file, fsync/flush if practical, then replace.
- Keep schema versioned.

### 6.2 Required Ledger Fields
- `schemaVersion`
- `createdAt`
- `updatedAt`
- `lastScanAt`
- `sources`
- `fileCursors`
- `workspaceMap`
- `entries`
- `resetMarkers`

### 6.3 Entry Shape
Each normalized entry should contain:
- `id`
- `timestamp`
- `source` (`chat`, `debug`, `cli`, `manual`)
- `sessionId`
- `model`
- `workspaceKey`
- `workspaceName`
- `inputTokens`
- `outputTokens`
- `cachedTokens`
- `creditsExact`
- `creditsEstimated`
- `isEstimated`
- `rawFile`
- `rawOffset`

### 6.4 Deduplication
Use layered deduplication:
1. Per-file cursor/offset.
2. Stable event fingerprint.
3. Logical-session dedupe between overlapping VS Code sources.

## 7. Accuracy Rules

- If exact credit data exists in the local record, store it as `creditsExact`.
- If exact credit data is absent, compute `creditsEstimated` and mark the entry as estimated.
- UI totals must distinguish exact from estimated data.
- Default dashboard should show a small trust badge:
  - `Exact`
  - `Mixed`
  - `Estimated`

## 8. UX Specification

### 8.1 Shell
- Activity bar icon.
- Webview view, not a floating-first design.
- Optional status bar summary.
- Fast startup; heavy scan work must be async.

### 8.2 Default Dashboard
Default view = current billing period from day 1 of the current month to now.

Show:
- Total credits this period.
- Credits today.
- Total requests.
- Top model.
- By-model chart.
- By-workspace table.
- By-source split.
- Last sync time.
- Exact vs estimated indicator.

### 8.3 Periods
- Current period
- 3 months
- 6 months
- 9 months
- 12 months
- Since last reset
- All time

### 8.4 Commands
- Open Dashboard
- Sync Now
- Reset Period
- Export CSV
- Clear Ledger
- Enable Debug Logging
- Add Manual Entry
- Open Ledger Folder
- Rebuild Workspace Names

## 9. Visual Design

Use a calm Business Central green palette:
- Primary: `#107C41`
- Secondary: `#1A8E4A`
- Accent soft: `#DFF3E5`
- Background: `#F6FBF7`
- Surface: `#FFFFFF`
- Border: `#CFE5D5`
- Text: `#163424`
- Muted text: `#5E7B68`

Design principles:
- Native-feeling VS Code webview.
- Low-noise dashboard.
- Strong readability.
- Dark mode supported from day one.
- Avoid marketing-style gradients.

## 10. Architecture

### 10.1 Modules
- `extension.ts`
- `config/`
- `sources/`
- `normalize/`
- `ledger/`
- `collection/`
- `ui/`
- `commands/`
- `shared/`

### 10.2 Source Adapters
Create one adapter per source:
- `VsCodeChatSource`
- `VsCodeDebugSource`
- `CopilotCliSource`
- `ManualEntrySource`

Contract:
- discover files
- read incrementally
- parse supported events
- return normalized records
- report parse warnings without failing the full scan

### 10.3 Collection Engine
The collection engine is the product core.
It must:
- run full scan on activation,
- run incremental scan on file change or timed rescan,
- survive malformed lines,
- persist cursors after every successful batch,
- debounce noisy file-change bursts,
- never block VS Code activation path.

## 11. Prerequisites

### 11.1 User Prerequisites
- VS Code installed.
- GitHub Copilot Chat installed and signed in.
- GitHub CLI Copilot installed only if CLI tracking is wanted.
- Local Copilot usage must actually exist before there is data to show.

### 11.2 Recommended VS Code Setting
Enable this setting for richer local agent logs:
```json
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```
This setting is documented in VS Code/Copilot guidance around agent debug logs [cite:29].

## 12. User Settings

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true,
  "copilotCredits.autoSync": true,
  "copilotCredits.incrementalSync": true,
  "copilotCredits.statusBar.enabled": true,
  "copilotCredits.dashboard.openOnStartup": false,
  "copilotCredits.defaultPeriod": "currentPeriod",
  "copilotCredits.sources.vscodeChat": true,
  "copilotCredits.sources.vscodeDebug": true,
  "copilotCredits.sources.cli": true,
  "copilotCredits.sources.manual": true,
  "copilotCredits.scan.additionalRoots": [],
  "copilotCredits.privacy.storeRawSnippets": false
}
```

## 13. Cloud Agent Policy

For v1:
- Automatic cloud-agent billing tracking is **not supported** as a committed feature.
- Manual entries are part of the planned UX.
- UI must clearly explain why totals can differ from GitHub billing when cloud-agent usage exists.
This limitation follows from GitHub’s cloud/agent session model being GitHub-side rather than a guaranteed local billing-log source for VS Code extensions [cite:39][cite:41][cite:50].

## 14. Error Handling

- Malformed JSONL line: skip and log warning.
- Missing workspace name: keep stable fallback key.
- Missing exact credit field: estimate and mark.
- Missing source path: continue silently until next scan.
- Corrupt ledger: back up, rebuild, and notify user.

## 15. Test Plan

### 15.1 Unit Tests
- parsers
- normalizers
- dedupe
- period filters
- CSV export

### 15.2 Integration Tests
- first-run backfill
- incremental append ingestion
- duplicate overlapping source events
- source file deletion after import
- corrupt line recovery
- reset marker logic

### 15.3 Manual Validation
- VS Code chat session tracked
- agent debug session tracked
- CLI session tracked
- current period totals update live
- exported CSV matches dashboard totals
- ledger survives restart

## 16. Release Criteria

Do not publish until all are true:
- stable on Windows first,
- no blocking errors on missing sources,
- no double-counting in mixed source scenarios,
- cloud-agent limitation clearly documented,
- settings and onboarding copy finalized,
- dark mode UI reviewed,
- test dataset included for regression runs.

## 17. Delivery Decision

Recommended v1 scope:
1. VS Code chat
2. VS Code debug logs
3. Copilot CLI
4. Local ledger
5. Dashboard
6. CSV export
7. Manual cloud-agent reconciliation

Deferred from v1:
- automatic cloud-agent tracking
- cross-machine merge
- budget alerts
- advanced cost intelligence

## 18. Reasoning Note

This version keeps the strong local-ledger design, but reduces delivery risk by treating cloud-agent tracking as manual by default and by treating local log structures as evolving inputs rather than fixed guarantees [cite:39][cite:41][cite:50][cite:19][cite:36].

# Copilot Credit Tracker — Development Spec v1.2

## 1. Purpose

Copilot Credit Tracker is a local-first Visual Studio Code extension that ingests local GitHub Copilot usage artifacts, normalizes them into an extension-owned ledger, and presents consumption analytics by period, model, workspace, and source. The design assumes no GitHub API access and no outbound telemetry.

## 2. Product Principles

- Local-first and private by default.
- Production-safe: resilient to missing files, partial schemas, and malformed lines.
- Exact when local records include a billing field; clearly estimated otherwise.
- Workspace-aware for editor and CLI usage where local evidence exists.
- Honest about unsupported areas, especially cloud-agent billing.
- Simple setup for end users, maintainable architecture for developers.

## 3. Scope

### Included in v1
- VS Code Copilot Chat session ingestion.
- VS Code Copilot agent/debug log ingestion when enabled.
- GitHub Copilot CLI session ingestion.
- Extension-owned persistent ledger.
- Current-period dashboard by default.
- Historical period views: 3, 6, 9, and 12 months; all time; since reset.
- Breakdowns by model, workspace, and source.
- CSV export.
- Manual adjustment entries for non-local or unrecoverable usage.

### Explicitly out of scope for v1
- GitHub API usage.
- Cross-device sync.
- Guaranteed recovery of historical usage before the extension is installed.
- Automatic billing-accurate tracking of GitHub.com-triggered cloud-agent sessions.
- Mutation of Copilot-owned files.

## 4. Reality Constraints

### 4.1 Local logs are the only committed source
The extension must treat local session artifacts as the authoritative source for automatic collection. If a usage event never reaches local storage, the extension cannot recover it later without API access.

### 4.2 Schemas are version-dependent
Local Copilot artifacts should be treated as evolving inputs, not as a permanent contract. Parsers must ignore unknown fields, tolerate missing fields, and continue processing the rest of the file.

### 4.3 Imported data must outlive source files
Local source files may rotate, be deleted, or become inaccessible. Once usage has been imported into the extension ledger, later source-file deletion must not remove or change imported history.

### 4.4 Cloud-agent tracking is partial by design
GitHub.com-triggered cloud-agent runs are not guaranteed to produce local billing logs. v1 must present these as manual reconciliation scenarios unless a verifiable local record is available.

## 5. Supported Sources

### 5.1 VS Code Copilot Chat artifacts
The extension scans VS Code user storage for Copilot chat/session artifacts. It extracts usage events when present and resolves workspace identity from nearby workspace metadata when possible.

Minimum normalized fields:
- timestamp
- sessionId
- model
- workspaceKey
- workspaceName
- inputTokens
- outputTokens
- cachedTokens
- creditsExact when available

### 5.2 VS Code agent/debug artifacts
The extension also supports richer agent/debug artifacts when the user enables file logging in VS Code settings.

Recommended prerequisite:
```json
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Rules:
- Prefer richer agent/debug records over overlapping standard chat records.
- Support subagent-related files if they contain compatible usage events.
- Never fail the scan because one debug file is malformed.

### 5.3 GitHub Copilot CLI artifacts
The extension scans local Copilot CLI session-state directories and ingests compatible usage events. CLI entries should be attributed to the working directory or best available session label.

### 5.4 Manual entries
Manual entries exist to reconcile usage that is visible to the user but unavailable in local artifacts, especially cloud-agent work triggered outside the local editor environment.

## 6. Cloud-Agent Policy

### v1 product rule
Automatic cloud-agent billing tracking is **not** a committed feature.

### UX rule
If the extension detects evidence of a remote or cloud-style session in local artifacts, it may display an informational badge and include only the locally provable portion of that session.

### Reconciliation rule
The extension must offer a manual entry command so users can record credits that are visible elsewhere but not recoverable from local files.

## 7. Architecture

### 7.1 High-level modules
```text
src/
  extension.ts
  config/
  collection/
  sources/
  normalize/
  ledger/
  aggregation/
  ui/
  commands/
  shared/
```

### 7.2 Source adapter contract
Each source adapter implements a common contract:
- discover candidate files
- read incrementally
- parse supported events
- normalize into common records
- emit warnings instead of crashing the collection run

Suggested adapters:
- `VsCodeChatSource`
- `VsCodeDebugSource`
- `CopilotCliSource`
- `ManualEntrySource`

### 7.3 Collection engine responsibilities
The collection engine is the core runtime service. It must:
- run a full scan on activation,
- run incremental ingestion after file changes,
- debounce noisy file bursts,
- survive malformed lines,
- persist file cursors after each successful batch,
- avoid blocking VS Code startup,
- support a manual full rescan command.

## 8. Ledger Specification

### 8.1 Storage location
Use `ExtensionContext.globalStorageUri` for the ledger and companion metadata files.

### 8.2 Files
- `ledger.json`
- `ledger.backup.json`
- `scan-state.json`
- `exports/` for user-triggered CSV files

### 8.3 Required top-level fields
```json
{
  "schemaVersion": 3,
  "createdAt": "2026-06-16T00:00:00.000Z",
  "updatedAt": "2026-06-16T00:00:00.000Z",
  "lastScanAt": "2026-06-16T00:00:00.000Z",
  "sources": {},
  "fileCursors": {},
  "workspaceMap": {},
  "resetMarkers": [],
  "entries": []
}
```

### 8.4 Entry shape
```json
{
  "id": "src-session-000001",
  "timestamp": "2026-06-16T12:00:00.000Z",
  "source": "chat",
  "sessionId": "session-123",
  "model": "claude-sonnet-4-5",
  "workspaceKey": "abc123",
  "workspaceName": "MyProject",
  "inputTokens": 1200,
  "outputTokens": 240,
  "cachedTokens": 300,
  "creditsExact": 1.0,
  "creditsEstimated": null,
  "isEstimated": false,
  "rawFile": ".../session.jsonl",
  "rawOffset": 4096,
  "notes": null
}
```

### 8.5 Write strategy
- Load ledger into memory once on activation.
- Mutate through a dedicated ledger service only.
- Save atomically by writing a temp file and then replacing the prior file.
- Keep a backup copy from the previous successful save.

## 9. Deduplication and Accuracy

### 9.1 Deduplication layers
1. Per-file cursor or byte offset.
2. Stable event fingerprint.
3. Logical-session dedupe across overlapping VS Code sources.

### 9.2 Accuracy rules
- If an exact credit value exists locally, store it as `creditsExact`.
- If exact credit data is absent, compute `creditsEstimated` and mark `isEstimated = true`.
- UI totals must visibly distinguish exact, mixed, and estimated totals.

### 9.3 Trust indicator
Show one status chip in the dashboard header:
- `Exact`
- `Mixed`
- `Estimated`

## 10. Collection Lifecycle

### 10.1 On activation
1. Load settings.
2. Resolve default source roots by platform.
3. Load ledger and scan state.
4. Discover candidate files.
5. Run full/incremental scan as needed.
6. Save updated ledger.
7. Register watchers, commands, status bar, and dashboard provider.

### 10.2 During runtime
- Watch supported roots where practical.
- Debounce change events.
- Read only appended content whenever a cursor exists.
- Fall back to scheduled lightweight rescan if watcher coverage is incomplete.

### 10.3 Manual sync
A `Sync Now` command triggers a foreground full rescan and refreshes the dashboard.

## 11. User Experience

### 11.1 Default experience
The default view is the current billing period from the first day of the current month to now.

### 11.2 Dashboard sections
- Header with current period, last sync, trust indicator, and sync action.
- KPI cards: credits this period, credits today, request count, top model.
- Daily usage chart.
- Model breakdown.
- Source breakdown.
- Workspace table.
- Footer controls: period selector, export, reset.

### 11.3 Period options
- Current period
- Last 3 months
- Last 6 months
- Last 9 months
- Last 12 months
- Since last reset
- All time

### 11.4 Commands
- Open Dashboard
- Sync Now
- Reset Period
- Export CSV
- Clear Ledger
- Enable Debug Logging
- Add Manual Entry
- Open Ledger Folder
- Rebuild Workspace Map

## 12. Visual Design

Use a restrained Business Central-inspired palette.

- Primary: `#107C41`
- Secondary: `#1A8E4A`
- Surface: `#FFFFFF`
- Background: `#F6FBF7`
- Border: `#CFE5D5`
- Text: `#163424`
- Muted Text: `#5E7B68`

Design rules:
- Modern but quiet.
- Native-feeling inside VS Code.
- Dark mode supported.
- No loud gradients.
- Prioritize dense readability over decorative UI.

## 13. Settings

Recommended user settings:

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

## 14. Prerequisites

### User prerequisites
- VS Code installed.
- GitHub Copilot Chat installed and signed in.
- GitHub Copilot CLI installed only if CLI tracking is desired.
- At least one real local Copilot session must exist before data will appear.

### Developer prerequisites
- Node.js 20+
- TypeScript
- VS Code Extension tooling
- Test fixtures for all supported source shapes

## 15. Error Handling

- Malformed JSONL line: skip, warn, continue.
- Missing workspace name: use stable fallback key.
- Missing exact credit field: estimate and mark.
- Missing source path: continue and retry on next scan.
- Ledger corruption: back up, rebuild if possible, notify user.

## 16. Test Plan

### Unit tests
- parser behavior
- normalization
- deduplication
- aggregation by period/model/workspace/source
- CSV export
- reset logic

### Integration tests
- first-run backfill
- incremental append ingestion
- overlapping source dedupe
- source file deletion after import
- malformed line recovery
- ledger recovery from backup

### Manual validation
- VS Code chat session tracked
- agent/debug session tracked
- CLI session tracked
- status bar updates
- export matches visible totals
- restart does not lose imported data

## 17. Release Criteria

Do not publish until all are true:
- stable on Windows first,
- no blocking failures when a source is absent,
- no known double-counting in mixed-source scenarios,
- cloud-agent limitation clearly documented,
- onboarding text finalized,
- dark mode reviewed,
- regression fixtures included.

## 18. Recommended v1 Delivery

Ship v1 with:
1. VS Code chat ingestion
2. VS Code debug ingestion
3. Copilot CLI ingestion
4. Local ledger
5. Dashboard
6. CSV export
7. Manual reconciliation for cloud-agent usage

Defer to later versions:
- automatic cloud-agent billing tracking
- cross-device merge
- budget alerts
- advanced cost intelligence

## 19. Final Verdict

This v1.2 spec is the recommended baseline because it keeps the useful local-ledger architecture from the earlier versions while removing overconfidence around cloud-agent automation and fixed local schemas. It is stronger for production delivery because it narrows commitments to what can be supported reliably from local evidence and makes estimation, reconciliation, and failure handling explicit.

# Changelog

All notable changes to **GitHub Copilot Credit Lens** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.x] - 2026-06-16

Fix: match the real VS Code Copilot agent debug-log schema.

### Fixed
- **Usage was not being ingested** (scan reported files found but 0 entries).
  Agent debug logs (`debug-logs/**/main.jsonl`, `runSubagent-*.jsonl`,
  `searchSubagent-*.jsonl`) record each call as a span event with usage under an
  **`attrs`** object (`attrs.copilotUsageNanoAiu`, `attrs.inputTokens`,
  `attrs.outputTokens`, `attrs.cachedTokens`, `attrs.model`, `type:"llm_request"`,
  `ts`). The parser now reads the `attrs` scope, so exact credits are captured.
- Timestamps that aren't plausible epoch values fall back to the file mtime
  instead of landing entries in 1970.

### Changed
- Model rate-table prefixes updated for current ids (`claude-sonnet-4.6`,
  `gpt-4o-mini`, `gemini-*`, …).
- `includeChatSessions` now defaults to **off**: chat-session files carry no
  exact billing value and overlap the same session GUIDs as the debug logs
  (which are the authoritative meter), so scanning them would double-count.
  Reserved for future token-only estimation.

## [0.1.0] - 2026-06-16

Initial release.

### Added
- **Local log ingestion** for three sources: VS Code Copilot Chat
  (`chatSessions/*.jsonl`), agent debug logs (`GitHub.copilot-chat/debug-logs`),
  and the GitHub Copilot CLI (`~/.copilot/session-state`).
- **Extension-owned ledger** in global storage with atomic, backup-protected
  saves; imported usage survives deletion or rotation of the source log files.
- **Incremental scanning** via per-file byte cursors, plus id and cross-source
  logical de-duplication (agent debug logs take precedence over chat).
- **Startup backfill** and a debounced **file watcher** for live updates, with a
  manual **Sync Now** command.
- **Dashboard webview** (light/dark aware, Business Central green accent):
  KPI strip, credits-per-day SVG chart, by-model and by-source bars, workspace
  table, and token totals — built with no charting library or remote resources.
- **Exact vs estimated credits:** exact billing values are used when present;
  otherwise an estimate from an in-house model-rate table is shown, clearly
  labelled, with an `Exact / Mixed / Estimated` trust chip and an opt-in toggle.
- **Period selector:** current month, rolling 3/6/9/12 months, since last reset,
  and all time, plus non-destructive reset markers.
- **CSV export** of the selected period and a **Clear All Data** command.
- **Status bar** item showing exact credits for the current period.
- **Enable Copilot Agent Debug Logging** command and a one-time onboarding prompt.
- Tag-driven **GitHub Actions release** workflow producing a `.vsix` artifact.

[0.1.0]: https://github.com/mbaic/mb-gh-copilot-credit-lens/releases/tag/v0.1.0

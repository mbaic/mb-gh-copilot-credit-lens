# Changelog

All notable changes to **GitHub Copilot Credit Lens** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- **Token totals section crash**: "Est. cost (USD)" and its note referenced a
  variable removed while adding the "≈ Assumed" headline in 1.0.18, throwing
  inside `render()` and silently leaving the cost box and all three notes
  below it (`estNote`/`costNote`/`modelNote`) stuck on their initial empty
  state. Token totals now always computes cost from the verified local total,
  independent of any buffer applied to the KPI headline.
- **Ambiguous "Credits this period" wording**: the Token totals section's
  reconciliation text and tooltips referenced the "Credits this period" KPI
  by name to describe the exact+estimated sum — accurate before 1.0.18, but
  that KPI can now show the buffered "≈ Assumed" total instead. Reworded to
  say "your local total" / "your verified local total" so the section reads
  correctly regardless of the buffer setting.

### Changed
- **"≈ Assumed" headline now rounds to whole credits** (e.g. `≈ 8,409`)
  instead of showing 4 decimals on a figure that is explicitly an estimate,
  and is tinted to visually match its badge. The verified local sub-line
  keeps full precision.
- **By model / By source / By workspace / Token totals** are now tagged
  **Local only**, and the scope-note banner is trimmed to focus on why the
  headline won't match these sections' totals, instead of repeating the math
  already shown in the KPI's sub-line.

## [1.0.18] - 2026-08-31

### Fixed
- **UTC billing boundaries**: the current-month period start, the
  `2026-06-01` billing floor, the configurable `billingStartDate`, and the
  daily-chart/"today" bucketing now compute in UTC instead of local time,
  matching GitHub's `00:00:00 UTC` reset. Entries near a month or day
  boundary could previously land in the wrong bucket depending on your
  timezone.

### Added
- **`otherUsageBufferPercent` setting** (default `17.5`) and a redesigned
  **Credits this period** KPI. This extension only reads local VS Code/CLI
  logs, so its totals are a structural lower bound on your real GitHub
  account usage — GitHub Coding Agent PRs, PR code review, and usage from
  other editors/devices aren't visible locally. When the buffer is set above
  `0`, the KPI's headline number becomes your calibrated "likely real total",
  tagged **`≈ Assumed`** so it's never mistaken for a billed figure; the
  verified local-only total and the exact math move to the line below. An
  always-visible scope note explains the limitation and how to (re)calibrate
  the buffer against your own github.com usage page. Set the buffer to `0`
  to show only the verified local total, as before.

## [1.0.0] - 2026-08-19

Initial 1.0.0 release.

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
- **Dashboard webview** (light/dark aware): KPI strip, credits-per-day chart
  with per-bar value labels and hover tooltip, by-model and by-source bars,
  workspace table, Top 5/10/All filters, and token totals — built with no
  charting library or remote resources.
- **Exact vs estimated credits:** exact billing values are used when present;
  otherwise an estimate from an in-house model-rate table is shown, clearly
  labelled, with an `Exact / Mixed / Estimated` trust chip and an opt-in toggle.
- **Billing period floor** (`billingStartDate`, default and minimum
  `2026-06-01`) and a **USD cost estimate** (`usdPerCredit`, default `0.01`)
  applied consistently to the dashboard, status bar, and CSV export.
- **Period selector:** current month, rolling 3/6/9/12 months, since last reset,
  and all time, plus non-destructive reset markers.
- **CSV export** of the selected period and a **Clear All Data** command.
- **Status bar** item showing exact credits for the current period.
- **Enable Copilot Agent Debug Logging** command and a one-time onboarding
  prompt, plus a **Rebuild Workspace Names** command with smarter resolution.
- **Standalone CLI** (`copilot-credit-lens` / `ccl`): a fully-offline,
  zero-dependency command-line tool that renders the dashboard as ANSI and
  supports `dashboard`, `sync`, `reset`, `export --csv` / `--json`, `clear`, and
  a live `watch` mode. Configuration via flags > `CCL_*` env vars > a
  `config.json` > defaults, all mirroring the extension's settings.
- **GitHub Copilot CLI extension**: a `/credits` slash command
  (`extension/credit-lens/extension.mjs`) that shows the dashboard inside a live
  Copilot CLI session, merging the on-disk ledger with the current session's live
  metrics via the host usage RPC. Falls back to ledger-only if the RPC is absent.
  Installs to `~/.copilot/extensions/credit-lens` via `npm run install:extension`.
- Tag-driven **GitHub Actions release** workflow producing the `.vsix`, the
  standalone CLI tarball, and the Copilot CLI extension zip as release artifacts.
- **Docs:** `docs/cli-usage.md` (install, commands, configuration, and a
  complete testing guide) and the design rationale in
  `docs/copilot-cli-credit-lens.md`.

[1.0.0]: https://github.com/mbaic/mb-gh-copilot-credit-lens/releases/tag/v1.0.0

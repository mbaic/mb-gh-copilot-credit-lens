# Roadmap — What's Next

v0.1.0 ships a deliberately lean, maintainable core. The architecture is built so
each addition below is a small, isolated change. Items are ordered roughly by
expected value; nothing here is a commitment to a date.

## Near term (0.2.x)

- **Manual entry / cloud-agent reconciliation.** A command to record credits read
  from the GitHub.com billing page (e.g. server-side coding-agent runs that leave
  no local log), stored with `source: "manual"` and clearly badged. *Adds one
  source path and one command; no change to existing parsers.*
- **Activity-bar view.** A sidebar container with a compact summary that opens the
  full dashboard panel, for one-click discoverability.
- **Configurable credit budget + threshold notification.** Warn when the current
  period crosses a user-set AIU budget.
- **Gap-filled daily chart.** Render zero-activity days for short periods so the
  per-day bar chart reads as a true calendar.

## Medium term (0.3.x)

- **Per-workspace drill-down** page (daily trend and model split for one project).
- **Most-expensive-sessions** list and a simple model-efficiency view.
- **Rename / merge workspaces** in the UI when names resolve to a hash.
- **Streaming tail reads** for very large log files (current reader loads only the
  appended tail; this would cap memory further for pathological files).

## Longer term (0.4.x+)

- **Additional source adapters** behind the existing discovery interface
  (e.g. JetBrains, Xcode) if their local logs expose compatible usage events.
- **Opt-in multi-machine merge** via a shared ledger file (manual, no network).
- **`@copilotCreditLens` chat participant** for conversational queries over the
  ledger.

## Explicitly out of scope

- Any GitHub API calls, outbound telemetry, or network requests.
- Automatic billing-accurate tracking of GitHub.com-triggered cloud-agent runs
  (no local billing log exists to read — handled via manual reconciliation).
- Marketplace publishing (distribution stays local `.vsix`).
- Modifying Copilot's own log files.

## Maintenance notes

- **Model rates** live solely in `src/rates.ts` — update multipliers there when
  GitHub changes premium-request pricing.
- **Adding a source** = implement discovery in `src/paths.ts`, extend field
  aliases in `src/parsers.ts` if needed, and register it in `src/scanner.ts`.
- **Ledger schema changes** bump `SCHEMA_VERSION` in `src/types.ts`; `normalize()`
  in `src/ledger.ts` already tolerates missing fields from older ledgers.

# GitHub Copilot Credit Lens — Tester Setup Guide

A short, self-contained checklist for installing the extension and validating it.
Everything is **local-first**: no network calls, no telemetry, read-only on Copilot's
own logs.

---

## 1. Prerequisites

- **VS Code 1.90 or later**
- **GitHub Copilot Chat** installed and signed in (so usage logs exist to read)
- *(optional)* **GitHub Copilot CLI** — only if you want CLI-session tracking
- Some **real Copilot usage on or after 2026-06-01** (the billing start date).
  Nothing earlier is ever counted.

> The extension reads exact credits from **agent debug logs**. These are only
> written **after** logging is enabled — they are not back-filled. Enable the
> setting below first if you want precise data going forward.

---

## 2. Required VS Code setting (do this first)

Open `settings.json` (Command Palette → **Preferences: Open User Settings (JSON)**)
and add:

```jsonc
{
  // Source of EXACT per-request credits. Restart VS Code after enabling.
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

Or run the command **“Copilot Credit Lens: Enable Copilot Agent Debug Logging”**,
then **restart VS Code**.

### Recommended extension settings (all optional — sensible defaults ship)

```jsonc
{
  "copilotCreditLens.includeDebugLogs": true,      // authoritative meter — keep ON
  "copilotCreditLens.includeChatSessions": false,  // off: no exact credits, would double-count
  "copilotCreditLens.includeCliSessions": true,    // only matters if you use the Copilot CLI

  "copilotCreditLens.autoSync": true,              // backfill on startup
  "copilotCreditLens.watcherEnabled": true,        // live updates while open
  "copilotCreditLens.statusBarEnabled": true,      // ⚡ AIU in the status bar

  "copilotCreditLens.defaultPeriod": "allTime",    // use "allTime" while testing; "currentMonth" for billing view
  "copilotCreditLens.includeEstimated": false,     // exact-only by default; toggle in the dashboard

  "copilotCreditLens.billingStartDate": "2026-06-01", // floor; nothing earlier is counted
  "copilotCreditLens.usdPerCredit": 0.01,          // 1 AI Credit = $0.01 (set 0 to hide cost)

  "copilotCreditLens.additionalRoots": [],         // add other VS Code profiles/Insiders "User" folders
  "copilotCreditLens.backupDirectory": ""          // set a folder to auto-backup the ledger
}
```

---

## 3. Install the extension

Download the latest `mb-gh-copilot-credit-lens-<version>.vsix` from the repo's
**GitHub Releases**, then either:

```bash
code --install-extension mb-gh-copilot-credit-lens-<version>.vsix
```

…or in VS Code: **Extensions panel → “…” menu → Install from VSIX…** Reload when prompted.

---

## 4. First run — IMPORTANT order

Run these from the Command Palette (`Ctrl/Cmd+Shift+P`), all prefixed **“Copilot Credit Lens:”**

1. **Enable Copilot Agent Debug Logging** (if you didn't set it in step 2) → **restart VS Code**.
2. **Clear All Data** — resets the internal read-cursors. *(Only needed once, but
   always safe. It does NOT touch your Copilot logs — only the extension's own ledger.)*
3. **Sync Now** — scans all local logs.
4. **Open Dashboard**.

> **Why “Clear All Data” first?** Early builds advanced their per-file read cursors
> even when they imported 0 rows. Clearing resets the cursors so the next sync
> re-reads everything. If you're on a fresh install you can skip it, but running it
> once does no harm.

### Confirm it worked
- **View → Output → “Copilot Credit Lens”** should show: `Scan complete: N file(s), M new entries` with **M > 0**.
- The dashboard KPIs, **By model**, **By source = Agent (debug logs)**, **By workspace**, and **Credits per day** should populate.
- The status bar (bottom-right) shows `⚡ <credits> AIU`; hovering shows the ≈ USD cost.

---

## 5. Cross-check the numbers (optional, Windows/PowerShell)

The repo includes an **independent, read-only** verifier that recomputes totals
straight from the debug logs:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-usage.ps1
# other profiles / Insiders:
powershell -ExecutionPolicy Bypass -File .\scripts\verify-usage.ps1 -AdditionalRoots "C:\Users\<you>\AppData\Roaming\Code - Insiders\User"
```

Compare its **all-time** output to the dashboard with **Period = All time** and
**Include estimated credits = off**. Requests, exact credits, tokens and the
by-model breakdown should match.

---

## 6. What to test

- [ ] Dashboard opens and shows non-zero data after Sync.
- [ ] **Period** selector: *Current period* = this calendar month; *All time* / *Last 3–12 months* never show anything before **2026-06-01**.
- [ ] **Include estimated credits** toggle: `Credits this period` = exact when off, exact + estimated when on. (It may not move if the estimated requests are on free models — that's correct; watch the breakdown line under the number.)
- [ ] **Top 5 / Top 10 / All** on *By model* and *By workspace* changes how many rows show.
- [ ] **By workspace** shows readable project names (run **Rebuild Workspace Names** if any show as a hash).
- [ ] **Est. cost (USD)** ≈ credits × $0.01.
- [ ] **Export Usage to CSV** and **Export Data Backup (JSON)** produce files.
- [ ] PowerShell verifier totals match the dashboard.

---

## 7. If something looks wrong

- **Dashboard shows 0 after Sync:** check the **Output → “Copilot Credit Lens”** channel.
  - `0 file(s)` → no logs found (Copilot Chat not used yet, or a non-standard install path → add it to `additionalRoots`).
  - `N file(s), 0 new entries` → run **Clear All Data** then **Sync Now**.
- **Webview errors:** Command Palette → **Developer: Open Webview Developer Tools** → Console tab; copy any red errors.
- **Numbers differ from the GitHub billing page:** the dashboard counts only what's
  in local logs from `billingStartDate`; cloud (server-side) agent runs aren't tracked,
  and cost is **gross** of your plan's included monthly allowance.

When reporting, please include: the **Output channel** text, your VS Code version,
and (if relevant) the **PowerShell verifier** output.

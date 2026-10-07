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

> The extension reads exact credits from **VS Code chat sessions** (per turn,
> VS Code 1.125+), which are always written and kept until you delete a chat —
> no setting needed. Agent debug logs are optional extra per-call detail.

---

## 2. Settings (all optional — sensible defaults ship)

Optional per-call detail (sub-agent models inside a turn). Restart VS Code after enabling:

```jsonc
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

Extension settings:

```jsonc
{
  "copilotCreditLens.statusBarEnabled": true,      // credits in the status bar
  "copilotCreditLens.defaultPeriod": "currentMonth", // "allTime" is handy while testing
  "copilotCreditLens.usdPerCredit": 0.01,          // 1 AI Credit = $0.01 (set 0 to hide cost)
  "copilotCreditLens.additionalRoots": [],         // other VS Code profiles/Insiders "User" folders
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

1. **Sync Now** — scans all local Copilot files (runs automatically on startup too).
2. **Open Dashboard**.

> **Upgrading from 1.0.x?** Don't run **Clear All Data**. The first 1.1 sync
> migrates the ledger automatically: it keeps every debug-log row already
> imported (Copilot deletes old debug logs, so they may exist nowhere else) and
> re-reads chat sessions and CLI files with the new exact-credit parsers.

### Confirm it worked
- **View → Output → “Copilot Credit Lens”** should show: `Scan complete: N file(s), M new entries` with **M > 0**.
- The dashboard KPIs, **By model**, **By source** (*Chat sessions* first), **By workspace**, and **Credits per day** should populate.
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
- [ ] **By source** shows *Chat sessions* (and *Agent (debug logs)* / *Copilot CLI* where used); chats from windows with no folder open appear as workspace **(no folder)**.
- [ ] `Credits this period` (Current period) is close to **Credits Used** in VS Code's Copilot status menu; any gap is usage that never reaches this machine (see README → Scope).
- [ ] **Export Usage to CSV** and **Export Data Backup (JSON)** produce files.
- [ ] PowerShell verifier totals match the dashboard's **Agent (debug logs)** source bar (the verifier reads debug logs only).

---

## 7. If something looks wrong

- **Dashboard shows 0 after Sync:** check the **Output → “Copilot Credit Lens”** channel.
  - `0 file(s)` → no logs found (Copilot Chat not used yet, or a non-standard install path → add it to `additionalRoots`).
- **Webview errors:** Command Palette → **Developer: Open Webview Developer Tools** → Console tab; copy any red errors.
- **Numbers differ from Copilot's "Credits Used":** the dashboard counts only
  what's in local files on this machine since 2026-06-01; Coding Agent and PR code
  review on github.com, and other computers/editors, aren't visible locally, and
  cost is **gross** of your plan's included monthly allowance. Chats you deleted
  before the extension scanned them are also gone.

When reporting, please include: the **Output channel** text, your VS Code version,
and (if relevant) the **PowerShell verifier** output.

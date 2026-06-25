// GitHub Copilot CLI extension: registers a `/credits` slash command that shows
// local Copilot credit & token analytics (Credit Lens) inside a live session.
//
// This is a thin shim. All analytics live in the shared, dependency-free core
// (the same modules that power the standalone `ccl` binary and the VS Code
// extension); this file only wires that core to the CLI's extension API.
//
// Runtime contract:
//   • The CLI discovers this file at ~/.copilot/extensions/credit-lens/extension.mjs
//     (user-scoped) or .github/extensions/credit-lens/extension.mjs (project-scoped)
//     and forks it as a Node child process.
//   • `@github/copilot-sdk` is provided by the host CLI — we do NOT install it.
//   • Requires Copilot CLI 1.0.56+ with "EXTENSIONS" enabled in
//     ~/.copilot/settings.json ("experimental": ["EXTENSIONS"]).
//
// Invariants preserved: no network calls (local file reads + local RPC only),
// read-only on Copilot's files, resilient to API/log drift (every external call
// is guarded; on failure we still render history from the ledger).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Load the compiled CommonJS core reliably from an ES module.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const core = (name) => require(join(here, 'core', name));

const { LedgerStore } = core('ledger.js');
const { runScan } = core('scanner.js');
const { aggregate } = core('aggregate.js');
const { renderDashboard } = core('render-tty.js');
const { liveSessionEntries } = core('live.js');
const { resolveConfig, storageDir, billingStartMs, isPeriod } = core('config.js');

const CLI_SCAN = { roots: [], includeChat: false, includeDebug: false, includeCli: true };

/** Parse "/credits <period> [--estimated] [--no-color]" argument text. */
function parseArgs(args) {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  const opts = { period: undefined, includeEstimated: undefined, color: true };
  for (const tok of tokens) {
    if (tok === '--estimated') {
      opts.includeEstimated = true;
    } else if (tok === '--no-estimated') {
      opts.includeEstimated = false;
    } else if (tok === '--no-color') {
      opts.color = false;
    } else if (isPeriod(tok)) {
      opts.period = tok;
    }
  }
  return opts;
}

async function handleCredits({ args, ui, session }) {
  const opts = parseArgs(args);
  const cfg = await resolveConfig();
  const period = opts.period || cfg.period;
  const includeEstimated = opts.includeEstimated ?? cfg.includeEstimated;

  // History from the on-disk ledger, refreshed with a quick CLI-only scan.
  const ledger = new LedgerStore(storageDir());
  await ledger.load();
  try {
    await runScan(ledger, CLI_SCAN);
  } catch {
    /* a failed scan still leaves prior history intact */
  }

  // Best-effort live metrics for the current (in-flight) session.
  const live = await liveSessionEntries(session, session?.id || 'live-session');

  const data = aggregate(
    [...ledger.entries, ...live],
    period,
    includeEstimated,
    ledger.resetMarkers,
    ledger.lastScanAt,
    new Date(),
    ledger.workspaceNames,
    billingStartMs(cfg),
    cfg.usdPerCredit
  );

  const width = (ui && ui.columns) || 80;
  const color = opts.color && !(ui && ui.supportsColor === false);
  const text = renderDashboard(data, { width, color, top: cfg.top });

  // Prefer the host's writer; fall back to stdout so the command never silently fails.
  if (ui && typeof ui.write === 'function') {
    await ui.write(text);
  } else {
    process.stdout.write(text);
  }
}

const { joinSession } = await import('@github/copilot-sdk');

await joinSession({
  // Analytics never needs the user's tools/files — decline permission requests.
  onPermissionRequest: () => ({ allow: false }),
  slashCommands: [
    {
      name: 'credits',
      description: 'Show local Copilot credit & token analytics (Credit Lens).',
      handler: async (ctx) => {
        try {
          await handleCredits(ctx || {});
        } catch (err) {
          const msg = `Credit Lens: ${err instanceof Error ? err.message : String(err)}\n`;
          if (ctx && ctx.ui && typeof ctx.ui.write === 'function') {
            await ctx.ui.write(msg);
          } else {
            process.stderr.write(msg);
          }
        }
      }
    }
  ]
});

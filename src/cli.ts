#!/usr/bin/env node
// Standalone terminal front-end: `copilot-credit-lens` (alias `ccl`).
//
// The terminal counterpart to the VS Code extension. It reuses the same pure
// core (ledger, scanner, aggregate, csv) and adds an ANSI renderer instead of a
// webview. It is fully offline and read-only on Copilot's files — it only scans
// the local GitHub Copilot CLI session logs and writes its own ledger/exports.
//
// Commands: dashboard (default) · sync · reset · export · clear · watch ·
//           version · help. Run `ccl help` for flags.

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { LedgerStore } from './ledger';
import { runScan, ScanConfig } from './scanner';
import { aggregate, filterByPeriod } from './aggregate';
import { toCsv } from './csv';
import { cliSessionRoot } from './paths';
import { renderDashboard } from './render-tty';
import { CclConfig, resolveConfig, storageDir, billingStartMs, isPeriod } from './config';

/** The CLI tool only ever scans the Copilot CLI source — never VS Code storage. */
const CLI_SCAN: ScanConfig = { roots: [], includeChat: false, includeDebug: false, includeCli: true };

interface Flags {
  help: boolean;
  version: boolean;
  json: boolean;
  csv: boolean;
  yes: boolean;
  noSync: boolean;
  all: boolean;
  estimated?: boolean;
  color?: boolean;
  period?: string;
  label?: string;
  output?: string;
  top?: number;
  width?: number;
}

async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (flags.help || command === 'help') {
    printHelp();
    return 0;
  }
  if (flags.version || command === 'version') {
    process.stdout.write(`copilot-credit-lens ${readVersion()}\n`);
    return 0;
  }

  const cfg = applyFlags(await resolveConfig(), flags);
  const ledger = new LedgerStore(storageDir());
  await ledger.load();

  switch (command) {
    case '':
    case 'dashboard':
      return cmdDashboard(ledger, cfg, flags);
    case 'sync':
      return cmdSync(ledger, cfg);
    case 'reset':
      return cmdReset(ledger, flags);
    case 'export':
      return cmdExport(ledger, cfg, flags);
    case 'clear':
      return cmdClear(ledger, flags);
    case 'watch':
      return cmdWatch(ledger, cfg, flags);
    default:
      process.stderr.write(`Unknown command: ${command}\nRun \`ccl help\` for usage.\n`);
      return 2;
  }
}

// ---- commands ---------------------------------------------------------------

async function cmdDashboard(ledger: LedgerStore, cfg: CclConfig, flags: Flags): Promise<number> {
  if (!flags.noSync) {
    await runScan(ledger, CLI_SCAN);
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(buildData(ledger, cfg), null, 2)}\n`);
    return 0;
  }
  printDashboard(ledger, cfg, flags, false);
  return 0;
}

async function cmdSync(ledger: LedgerStore, cfg: CclConfig): Promise<number> {
  const res = await runScan(ledger, CLI_SCAN);
  await maybeBackup(ledger, cfg, res.added);
  const noun = res.added === 1 ? 'entry' : 'entries';
  process.stdout.write(`Scan complete: ${res.filesScanned} file(s), ${res.added} new ${noun}.\n`);
  for (const w of res.warnings.slice(0, 5)) {
    process.stderr.write(`  warn: ${w}\n`);
  }
  if (res.warnings.length > 5) {
    process.stderr.write(`  …and ${res.warnings.length - 5} more warning(s).\n`);
  }
  return 0;
}

async function cmdReset(ledger: LedgerStore, flags: Flags): Promise<number> {
  const marker = ledger.addResetMarker(flags.label || 'Reset');
  await ledger.save();
  process.stdout.write(`Added reset marker "${marker.label}" at ${marker.timestamp}.\n`);
  process.stdout.write('No data was deleted; "Since last reset" now starts here.\n');
  return 0;
}

async function cmdExport(ledger: LedgerStore, cfg: CclConfig, flags: Flags): Promise<number> {
  if (flags.json) {
    if (flags.output) {
      await ledger.exportTo(flags.output);
      process.stderr.write(`Wrote full ledger backup: ${flags.output}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(ledger.entries, null, 2)}\n`);
    }
    return 0;
  }
  const entries = flags.all
    ? [...ledger.entries]
    : filterByPeriod(ledger.entries, cfg.period, ledger.resetMarkers, new Date(), billingStartMs(cfg));
  const csv = toCsv(entries);
  if (flags.output) {
    await fsp.writeFile(flags.output, csv, 'utf8');
    process.stderr.write(`Wrote ${entries.length} row(s) to ${flags.output}\n`);
  } else {
    process.stdout.write(csv);
  }
  return 0;
}

async function cmdClear(ledger: LedgerStore, flags: Flags): Promise<number> {
  if (!flags.yes) {
    process.stderr.write('Refusing to clear without confirmation. Re-run with --yes to wipe all data.\n');
    process.stderr.write('(This only deletes the tool\'s own ledger — never your Copilot logs.)\n');
    return 2;
  }
  await ledger.clear();
  process.stdout.write('Ledger cleared. Run `ccl sync` to re-ingest from your Copilot CLI logs.\n');
  return 0;
}

async function cmdWatch(ledger: LedgerStore, cfg: CclConfig, flags: Flags): Promise<number> {
  const root = cliSessionRoot();
  await runScan(ledger, CLI_SCAN);
  printDashboard(ledger, cfg, flags, true);

  let timer: NodeJS.Timeout | undefined;
  let scanning = false;
  const rescan = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      if (scanning) {
        return;
      }
      scanning = true;
      try {
        await runScan(ledger, CLI_SCAN);
        printDashboard(ledger, cfg, flags, true);
      } finally {
        scanning = false;
      }
    }, 600);
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(root, { recursive: true }, () => rescan());
  } catch {
    process.stderr.write(`Cannot watch ${root} (folder missing?). Showed a one-time view instead.\n`);
    return 0;
  }
  process.on('SIGINT', () => {
    watcher.close();
    process.stdout.write('\n');
    process.exit(0);
  });
  // Keep the process alive until interrupted.
  return new Promise<number>(() => undefined);
}

// ---- shared helpers ---------------------------------------------------------

function buildData(ledger: LedgerStore, cfg: CclConfig): ReturnType<typeof aggregate> {
  return aggregate(
    ledger.entries,
    cfg.period,
    cfg.includeEstimated,
    ledger.resetMarkers,
    ledger.lastScanAt,
    new Date(),
    ledger.workspaceNames,
    billingStartMs(cfg),
    cfg.usdPerCredit
  );
}

function printDashboard(ledger: LedgerStore, cfg: CclConfig, flags: Flags, clear: boolean): void {
  if (clear) {
    process.stdout.write('\x1b[2J\x1b[H');
  }
  const out = renderDashboard(buildData(ledger, cfg), {
    width: resolveWidth(cfg),
    color: resolveColor(cfg, flags),
    top: cfg.top
  });
  process.stdout.write(out);
}

async function maybeBackup(ledger: LedgerStore, cfg: CclConfig, added: number): Promise<void> {
  if (!cfg.backupDirectory || added <= 0) {
    return;
  }
  try {
    await fsp.mkdir(cfg.backupDirectory, { recursive: true });
    await ledger.exportTo(path.join(cfg.backupDirectory, 'copilot-credit-lens-backup.json'));
  } catch (err) {
    process.stderr.write(`  backup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function resolveColor(cfg: CclConfig, flags: Flags): boolean {
  if (flags.color !== undefined) {
    return flags.color;
  }
  if (process.env.NO_COLOR) {
    return false;
  }
  return cfg.color && Boolean(process.stdout.isTTY);
}

function resolveWidth(cfg: CclConfig): number {
  return cfg.width || process.stdout.columns || 80;
}

function applyFlags(cfg: CclConfig, flags: Flags): CclConfig {
  const next: CclConfig = { ...cfg };
  if (flags.period && isPeriod(flags.period)) {
    next.period = flags.period;
  }
  if (flags.estimated !== undefined) {
    next.includeEstimated = flags.estimated;
  }
  if (flags.top !== undefined && Number.isFinite(flags.top)) {
    next.top = Math.max(0, flags.top);
  }
  if (flags.width !== undefined && Number.isFinite(flags.width)) {
    next.width = flags.width;
  }
  return next;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const flags: Flags = {
    help: false,
    version: false,
    json: false,
    csv: false,
    yes: false,
    noSync: false,
    all: false
  };
  let command = '';
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-')) {
      if (!command) {
        command = tok;
      }
      continue;
    }
    const name = tok.replace(/^--?/, '');
    switch (name) {
      case 'h':
      case 'help':
        flags.help = true;
        break;
      case 'v':
      case 'version':
        flags.version = true;
        break;
      case 'json':
        flags.json = true;
        break;
      case 'csv':
        flags.csv = true;
        break;
      case 'yes':
        flags.yes = true;
        break;
      case 'all':
        flags.all = true;
        break;
      case 'no-sync':
        flags.noSync = true;
        break;
      case 'estimated':
        flags.estimated = true;
        break;
      case 'no-estimated':
        flags.estimated = false;
        break;
      case 'color':
        flags.color = true;
        break;
      case 'no-color':
        flags.color = false;
        break;
      case 'period':
        flags.period = argv[++i];
        break;
      case 'label':
        flags.label = argv[++i];
        break;
      case 'o':
      case 'output':
        flags.output = argv[++i];
        break;
      case 'top': {
        const v = argv[++i];
        flags.top = v === 'all' ? 0 : Number(v);
        break;
      }
      case 'width':
        flags.width = Number(argv[++i]);
        break;
      default:
        // Unknown flags are ignored so future additions never hard-fail.
        break;
    }
  }
  return { command, flags };
}

function readVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp(): void {
  process.stdout.write(`copilot-credit-lens (ccl) — local GitHub Copilot CLI credit & token analytics

USAGE
  ccl [command] [flags]

COMMANDS
  dashboard   Show the analytics dashboard (default). Syncs first unless --no-sync.
  sync        Scan ~/.copilot/session-state and import new usage into the ledger.
  reset       Add a reset marker (for the "Since last reset" period). No data deleted.
  export      Export usage: --csv (period-scoped) or --json (full ledger backup).
  clear       Wipe the tool's own ledger (requires --yes). Never touches Copilot logs.
  watch       Live view: re-scan and re-render when CLI sessions change. Ctrl-C to stop.
  version     Print the version.
  help        Show this help.

FLAGS
  --period <id>      currentMonth | last3Months | last6Months | last9Months |
                     last12Months | sinceReset | allTime   (default: currentMonth)
  --estimated        Include estimated credits in totals (default: exact only).
  --no-estimated     Force exact-only totals.
  --top <n|all>      Rows in by-model / by-workspace lists (default: all).
  --no-color         Disable ANSI colour (also honours the NO_COLOR env var).
  --width <n>        Render width in columns (default: terminal width or 80).
  --json             Machine-readable output (dashboard data or entries).
  -o, --output <f>   Write export to a file instead of stdout.
  --all              With "export --csv": export every entry, ignoring the period.
  --label <text>     With "reset": a label for the marker.
  --no-sync          With "dashboard": render without scanning first.
  --yes              With "clear": confirm the wipe.

ENVIRONMENT
  CCL_PERIOD, CCL_INCLUDE_ESTIMATED, CCL_USD_PER_CREDIT, CCL_BILLING_START,
  CCL_BACKUP_DIR        Override defaults (lower precedence than flags).
  NO_COLOR              Disable colour.

DATA
  Reads:  ~/.copilot/session-state/*/events.jsonl   (read-only)
  Writes: the tool's own ledger in the per-user data directory; exports you request.
  Fully offline. No network calls, ever.
`);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

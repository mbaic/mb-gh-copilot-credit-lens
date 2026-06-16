// VS Code integration only. All rendering, parsing, aggregation and storage
// live in their own modules; this file wires them to commands, the status bar,
// a file watcher and the dashboard webview panel.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import { LedgerStore } from './ledger';
import { runScan, ScanConfig } from './scanner';
import { aggregate, filterByPeriod, PERIODS } from './aggregate';
import { buildDashboardHtml, WebviewMessage } from './dashboard';
import { toCsv } from './csv';
import { cliSessionRoot, defaultUserRoots } from './paths';
import { PeriodId } from './types';

const VIEW_TYPE = 'copilotCreditLens.dashboard';
const DEBUG_SETTING = 'github.copilot.chat.agentDebugLog.fileLogging.enabled';

let ledger: LedgerStore;
let panel: vscode.WebviewPanel | undefined;
let statusBar: vscode.StatusBarItem;
let log: vscode.OutputChannel;
let watchTimer: NodeJS.Timeout | undefined;
let scanning = false;

// Dashboard view state (independent of stored defaults once the user changes it).
let period: PeriodId = 'currentMonth';
let includeEstimated = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel('Copilot Credit Lens');
  context.subscriptions.push(log);

  ledger = new LedgerStore(context.globalStorageUri.fsPath);
  await ledger.load();

  const settings = readSettings();
  period = settings.defaultPeriod;
  includeEstimated = settings.includeEstimated;

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'copilotCreditLens.openDashboard';
  context.subscriptions.push(statusBar);
  updateStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotCreditLens.openDashboard', () => openDashboard(context)),
    vscode.commands.registerCommand('copilotCreditLens.syncNow', () => syncNow(true)),
    vscode.commands.registerCommand('copilotCreditLens.resetPeriod', resetPeriodCmd),
    vscode.commands.registerCommand('copilotCreditLens.exportCsv', exportCsvCmd),
    vscode.commands.registerCommand('copilotCreditLens.clearLedger', clearLedgerCmd),
    vscode.commands.registerCommand('copilotCreditLens.enableDebugLogging', enableDebugLoggingCmd)
  );

  if (settings.watcherEnabled) {
    setupWatchers(context, settings);
  }

  if (settings.autoSync) {
    void syncNow(false);
  }
  if (settings.openOnStartup) {
    openDashboard(context);
  }

  maybePromptForDebugLogging(context, settings);
}

export function deactivate(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

interface Settings {
  autoSync: boolean;
  watcherEnabled: boolean;
  openOnStartup: boolean;
  statusBarEnabled: boolean;
  defaultPeriod: PeriodId;
  includeEstimated: boolean;
  includeChat: boolean;
  includeDebug: boolean;
  includeCli: boolean;
  additionalRoots: string[];
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('copilotCreditLens');
  return {
    autoSync: c.get('autoSync', true),
    watcherEnabled: c.get('watcherEnabled', true),
    openOnStartup: c.get('openOnStartup', false),
    statusBarEnabled: c.get('statusBarEnabled', true),
    defaultPeriod: c.get<PeriodId>('defaultPeriod', 'currentMonth'),
    includeEstimated: c.get('includeEstimated', false),
    includeChat: c.get('includeChatSessions', true),
    includeDebug: c.get('includeDebugLogs', true),
    includeCli: c.get('includeCliSessions', true),
    additionalRoots: c.get<string[]>('additionalRoots', [])
  };
}

function scanConfig(settings: Settings): ScanConfig {
  return {
    roots: [...defaultUserRoots(), ...settings.additionalRoots],
    includeChat: settings.includeChat,
    includeDebug: settings.includeDebug,
    includeCli: settings.includeCli
  };
}

// ── Scanning ──────────────────────────────────────────────────────────────────

async function syncNow(foreground: boolean): Promise<void> {
  if (scanning) {
    return;
  }
  scanning = true;
  postSyncStatus(true);
  const settings = readSettings();
  try {
    const run = () => runScan(ledger, scanConfig(settings));
    const result = foreground
      ? await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Copilot Credit Lens: scanning logs…' },
          run
        )
      : await run();

    log.appendLine(
      `Scan complete: ${result.filesScanned} file(s), ${result.added} new entr${result.added === 1 ? 'y' : 'ies'}.`
    );
    if (result.warnings.length) {
      log.appendLine(`  ${result.warnings.length} warning(s):`);
      result.warnings.slice(0, 20).forEach((w) => log.appendLine(`    - ${w}`));
    }
    if (foreground) {
      vscode.window.showInformationMessage(`Copilot Credit Lens: imported ${result.added} new usage entr${result.added === 1 ? 'y' : 'ies'}.`);
    }
  } catch (err) {
    log.appendLine(`Scan failed: ${message(err)}`);
    if (foreground) {
      vscode.window.showErrorMessage(`Copilot Credit Lens: scan failed — ${message(err)}`);
    }
  } finally {
    scanning = false;
    postSyncStatus(false);
    refresh();
  }
}

function setupWatchers(context: vscode.ExtensionContext, settings: Settings): void {
  const roots = [...defaultUserRoots(), ...settings.additionalRoots, cliSessionRoot()];
  for (const root of roots) {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(root), '**/*.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = () => scheduleScan();
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    context.subscriptions.push(watcher);
  }
}

function scheduleScan(): void {
  if (watchTimer) {
    clearTimeout(watchTimer);
  }
  watchTimer = setTimeout(() => void syncNow(false), 1500);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function openDashboard(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Copilot Credit Lens', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: []
  });
  const nonce = crypto.randomBytes(16).toString('hex');
  panel.webview.html = buildDashboardHtml(nonce, panel.webview.cspSource, computeData());
  panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
  panel.webview.onDidReceiveMessage((msg: WebviewMessage) => handleMessage(msg), null, context.subscriptions);
}

function handleMessage(msg: WebviewMessage): void {
  switch (msg.type) {
    case 'ready':
      refresh();
      break;
    case 'changePeriod':
      period = msg.period as PeriodId;
      refresh();
      break;
    case 'toggleEstimated':
      includeEstimated = msg.include;
      refresh();
      break;
    case 'sync':
      void syncNow(false);
      break;
    case 'reset':
      void resetPeriodCmd();
      break;
    case 'export':
      void exportCsvCmd();
      break;
  }
}

function computeData() {
  return aggregate(ledger.entries, period, includeEstimated, ledger.resetMarkers, ledger.lastScanAt);
}

function refresh(): void {
  if (panel) {
    void panel.webview.postMessage({ type: 'updateData', payload: computeData() });
  }
  updateStatusBar();
}

function postSyncStatus(running: boolean): void {
  if (panel) {
    void panel.webview.postMessage({ type: 'syncStatus', running });
  }
}

function updateStatusBar(): void {
  const settings = readSettings();
  if (!settings.statusBarEnabled) {
    statusBar.hide();
    return;
  }
  // Status bar always reflects exact, current-month credits — the billing figure.
  const data = aggregate(ledger.entries, 'currentMonth', false, ledger.resetMarkers, ledger.lastScanAt);
  statusBar.text = `$(graph) ${data.kpis.creditsPeriod} AIU`;
  statusBar.tooltip = `Copilot credits this period (exact). ${data.kpis.requests} requests. Click to open the dashboard.`;
  statusBar.show();
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function resetPeriodCmd(): Promise<void> {
  const label = await vscode.window.showInputBox({
    title: 'Reset period',
    prompt: 'Optional label for this reset marker (does not delete any data).',
    placeHolder: 'e.g. Q3 start'
  });
  if (label === undefined) {
    return; // cancelled
  }
  ledger.addResetMarker(label);
  await ledger.save();
  refresh();
  vscode.window.showInformationMessage('Copilot Credit Lens: reset marker added. Select "Since last reset" to view from here.');
}

async function exportCsvCmd(): Promise<void> {
  const scoped = filterByPeriod(ledger.entries, period, ledger.resetMarkers, new Date());
  if (scoped.length === 0) {
    vscode.window.showWarningMessage('Copilot Credit Lens: no entries to export for the selected period.');
    return;
  }
  const label = PERIODS.find((p) => p.id === period)?.label.replace(/\s+/g, '-').toLowerCase() ?? 'export';
  const target = await vscode.window.showSaveDialog({
    title: 'Export usage to CSV',
    filters: { 'CSV files': ['csv'] },
    saveLabel: 'Export',
    defaultUri: vscode.Uri.file(`copilot-credits-${label}.csv`)
  });
  if (!target) {
    return;
  }
  try {
    await fsp.writeFile(target.fsPath, toCsv(scoped), 'utf8');
    const open = await vscode.window.showInformationMessage(
      `Copilot Credit Lens: exported ${scoped.length} rows.`,
      'Open'
    );
    if (open === 'Open') {
      void vscode.window.showTextDocument(target);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Copilot Credit Lens: export failed — ${message(err)}`);
  }
}

async function clearLedgerCmd(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Permanently delete all imported Copilot usage data? This cannot be undone. (Your Copilot log files are not touched.)',
    { modal: true },
    'Delete all data'
  );
  if (confirm !== 'Delete all data') {
    return;
  }
  await ledger.clear();
  refresh();
  vscode.window.showInformationMessage('Copilot Credit Lens: all data cleared.');
}

async function enableDebugLoggingCmd(): Promise<void> {
  try {
    await vscode.workspace.getConfiguration().update(DEBUG_SETTING, true, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      'Copilot Credit Lens: enabled Copilot agent debug logging. Restart VS Code, then run "Sync Now" to capture precise agent credits.'
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Copilot Credit Lens: could not update setting — ${message(err)}`);
  }
}

function maybePromptForDebugLogging(context: vscode.ExtensionContext, settings: Settings): void {
  const KEY = 'copilotCreditLens.debugPromptShown';
  if (!settings.includeDebug || context.globalState.get<boolean>(KEY)) {
    return;
  }
  const enabled = vscode.workspace.getConfiguration().get<boolean>(DEBUG_SETTING, false);
  if (enabled) {
    return;
  }
  void context.globalState.update(KEY, true);
  void vscode.window
    .showInformationMessage(
      'Copilot Credit Lens: enable Copilot agent debug logging for precise per-request credit data?',
      'Enable',
      'Not now'
    )
    .then((choice) => {
      if (choice === 'Enable') {
        void enableDebugLoggingCmd();
      }
    });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

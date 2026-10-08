// Platform-specific discovery of local Copilot log files.
//
// All OS-dependent path logic lives here so the rest of the extension never
// hardcodes a path. Discovery is fully best-effort: a missing folder is simply
// an empty result, never an error.

import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { SessionSource } from './types';

/** One log file the scanner should ingest, with its resolved attribution. */
export interface DiscoveredFile {
  filePath: string;
  source: SessionSource;
  sessionId: string;
  workspaceKey: string;
  workspaceName: string;
}

/** Default VS Code "User" storage roots for the current platform. */
export function defaultUserRoots(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      return [path.join(appData, 'Code', 'User')];
    }
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Code', 'User')];
    default:
      return [path.join(home, '.config', 'Code', 'User')];
  }
}

/** Root directory of GitHub Copilot CLI session state. */
export function cliSessionRoot(): string {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Resolve a readable workspace name from a workspaceStorage/{hash}/workspace.json.
 *  Handles single-folder (`folder`), multi-root (`workspace` -> a .code-workspace
 *  file) and the older `configuration.path` shape. */
async function resolveWorkspaceName(workspaceDir: string, fallback: string): Promise<string> {
  try {
    const raw = await fsp.readFile(path.join(workspaceDir, 'workspace.json'), 'utf8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const config = json.configuration as Record<string, unknown> | undefined;
    const candidate =
      pickStringField(json.folder) ||
      pickStringField(json.workspace) ||
      (config ? pickStringField(config.path) || pickStringField(config.fsPath) : '');
    if (candidate) {
      const name = lastSegment(decodeURIComponentSafe(candidate)).replace(/\.code-workspace$/i, '');
      if (name) {
        return name;
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

function pickStringField(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Resolve the display name for a single workspace hash by checking each root.
 *  Used by the "Rebuild Workspace Names" command. Returns undefined if no
 *  workspace.json can be read for that hash. */
export async function resolveWorkspaceNameForHash(roots: string[], hash: string): Promise<string | undefined> {
  for (const root of roots) {
    const dir = path.join(root, 'workspaceStorage', hash);
    const name = await resolveWorkspaceName(dir, '');
    if (name) {
      return name;
    }
  }
  return undefined;
}

/** Resolve the working directory label for a CLI session from workspace.yaml. */
async function resolveCliWorkspaceName(sessionDir: string, fallback: string): Promise<string> {
  try {
    const raw = await fsp.readFile(path.join(sessionDir, 'workspace.yaml'), 'utf8');
    // Minimal YAML read: find the first key that looks like a directory path.
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:cwd|workingDirectory|directory|path)\s*:\s*["']?([^"'\r\n]+)["']?\s*$/i);
      if (match) {
        return lastSegment(match[1].trim());
      }
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
}

/** Last meaningful path segment, used as a human-readable workspace name. */
function lastSegment(p: string): string {
  const cleaned = p.replace(/^file:\/+/, '').replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cleaned;
}

/** Display name for usage from windows with no folder open. */
export const NO_FOLDER_NAME = '(no folder)';
const NO_FOLDER_KEY = 'no-workspace';

/** Copilot Chat's storage folder: workspace storage keeps the extension id's
 *  casing, global storage lowercases it. Try both so case-sensitive file
 *  systems (Linux) resolve either way. */
const COPILOT_STORAGE_DIRS = ['GitHub.copilot-chat', 'github.copilot-chat'];

function isChatSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.json');
}

/** Discover VS Code chat session files (which carry exact per-turn credits)
 *  across the given User roots: per-workspace `chatSessions/` plus the global
 *  `emptyWindowChatSessions/` used by windows with no folder open. */
export async function discoverChatFiles(roots: string[]): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const add = (dir: string, files: string[], key: string, name: string) => {
    for (const file of files) {
      out.push({
        filePath: path.join(dir, file),
        source: 'chat',
        sessionId: file.replace(/\.jsonl?$/, ''),
        workspaceKey: key,
        workspaceName: name
      });
    }
  };
  for (const root of roots) {
    const wsRoot = path.join(root, 'workspaceStorage');
    for (const hash of await listDir(wsRoot)) {
      const wsDir = path.join(wsRoot, hash);
      const chatDir = path.join(wsDir, 'chatSessions');
      const files = (await listDir(chatDir)).filter(isChatSessionFile);
      if (files.length === 0) {
        continue;
      }
      const name = hash === NO_FOLDER_KEY ? NO_FOLDER_NAME : await resolveWorkspaceName(wsDir, hash);
      add(chatDir, files, hash, name);
    }
    const emptyDir = path.join(root, 'globalStorage', 'emptyWindowChatSessions');
    add(emptyDir, (await listDir(emptyDir)).filter(isChatSessionFile), NO_FOLDER_KEY, NO_FOLDER_NAME);
  }
  return out;
}

/** Append every `*.jsonl` under `<debugRoot>/<session>/` (main log plus any
 *  sub-agent logs) as a debug-log source. */
async function addDebugSessions(
  out: DiscoveredFile[],
  debugRoot: string,
  workspaceKey: string,
  workspaceName: string
): Promise<void> {
  for (const session of await listDir(debugRoot)) {
    const sessionDir = path.join(debugRoot, session);
    for (const file of await listDir(sessionDir)) {
      if (!file.endsWith('.jsonl')) {
        continue;
      }
      out.push({
        filePath: path.join(sessionDir, file),
        source: 'debug',
        sessionId: session,
        workspaceKey,
        workspaceName
      });
    }
  }
}

/** Discover VS Code Copilot agent debug-log files across the given User roots:
 *  per-workspace storage plus global storage (windows with no folder open). */
export async function discoverDebugFiles(roots: string[]): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const wsRoot = path.join(root, 'workspaceStorage');
    for (const hash of await listDir(wsRoot)) {
      const wsDir = path.join(wsRoot, hash);
      for (const dirName of COPILOT_STORAGE_DIRS) {
        const debugRoot = path.join(wsDir, dirName, 'debug-logs');
        const sessions = await listDir(debugRoot);
        if (sessions.length === 0 || seen.has(debugRoot.toLowerCase())) {
          continue;
        }
        seen.add(debugRoot.toLowerCase());
        const name = hash === NO_FOLDER_KEY ? NO_FOLDER_NAME : await resolveWorkspaceName(wsDir, hash);
        await addDebugSessions(out, debugRoot, hash, name);
      }
    }
    for (const dirName of COPILOT_STORAGE_DIRS) {
      const debugRoot = path.join(root, 'globalStorage', dirName, 'debug-logs');
      if (seen.has(debugRoot.toLowerCase()) || (await listDir(debugRoot)).length === 0) {
        continue;
      }
      seen.add(debugRoot.toLowerCase());
      await addDebugSessions(out, debugRoot, NO_FOLDER_KEY, NO_FOLDER_NAME);
    }
  }
  return out;
}

/** Discover GitHub Copilot CLI session event files. */
export async function discoverCliFiles(): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const root = cliSessionRoot();
  for (const session of await listDir(root)) {
    const sessionDir = path.join(root, session);
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    if (!(await isFile(eventsPath))) {
      continue;
    }
    const name = await resolveCliWorkspaceName(sessionDir, 'CLI');
    out.push({
      filePath: eventsPath,
      source: 'cli',
      sessionId: session,
      workspaceKey: 'cli',
      workspaceName: name
    });
  }
  return out;
}

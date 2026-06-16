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

/** Resolve a readable workspace name from a workspaceStorage/{hash}/workspace.json. */
async function resolveWorkspaceName(workspaceDir: string, fallback: string): Promise<string> {
  try {
    const raw = await fsp.readFile(path.join(workspaceDir, 'workspace.json'), 'utf8');
    const folder: unknown = JSON.parse(raw).folder;
    if (typeof folder === 'string' && folder.length > 0) {
      return lastSegment(decodeURIComponent(folder));
    }
  } catch {
    /* fall through to fallback */
  }
  return fallback;
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

/** Discover VS Code Copilot Chat session files across the given User roots. */
export async function discoverChatFiles(roots: string[]): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const root of roots) {
    const wsRoot = path.join(root, 'workspaceStorage');
    for (const hash of await listDir(wsRoot)) {
      const wsDir = path.join(wsRoot, hash);
      const chatDir = path.join(wsDir, 'chatSessions');
      const files = (await listDir(chatDir)).filter((f) => f.endsWith('.jsonl'));
      if (files.length === 0) {
        continue;
      }
      const name = await resolveWorkspaceName(wsDir, hash);
      for (const file of files) {
        out.push({
          filePath: path.join(chatDir, file),
          source: 'chat',
          sessionId: path.basename(file, '.jsonl'),
          workspaceKey: hash,
          workspaceName: name
        });
      }
    }
  }
  return out;
}

/** Discover VS Code Copilot agent debug-log files across the given User roots. */
export async function discoverDebugFiles(roots: string[]): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  for (const root of roots) {
    const wsRoot = path.join(root, 'workspaceStorage');
    for (const hash of await listDir(wsRoot)) {
      const wsDir = path.join(wsRoot, hash);
      const debugRoot = path.join(wsDir, 'GitHub.copilot-chat', 'debug-logs');
      const sessions = await listDir(debugRoot);
      if (sessions.length === 0) {
        continue;
      }
      const name = await resolveWorkspaceName(wsDir, hash);
      for (const session of sessions) {
        const sessionDir = path.join(debugRoot, session);
        for (const file of await listDir(sessionDir)) {
          if (!file.endsWith('.jsonl')) {
            continue;
          }
          out.push({
            filePath: path.join(sessionDir, file),
            source: 'debug',
            sessionId: session,
            workspaceKey: hash,
            workspaceName: name
          });
        }
      }
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

// Assemble the Copilot CLI extension's dependency-free `core/` from the compiled
// output in `out/`. Run AFTER `npm run compile`.
//
// The extension shim (extension/credit-lens/extension.mjs) loads the shared core
// as CommonJS via createRequire, so we copy just the runtime modules it needs —
// never the VS Code-only modules (extension.js, dashboard.js), which require the
// 'vscode' host that the terminal does not provide.
//
// Pure Node builtins, no dependencies, no network.

import { mkdir, copyFile, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'out');
const coreDir = join(root, 'extension', 'credit-lens', 'core');

// Runtime modules the extension shim depends on (no VS Code imports).
const MODULES = [
  'types.js',
  'rates.js',
  'csv.js',
  'aggregate.js',
  'ledger.js',
  'paths.js',
  'parsers.js',
  'scanner.js',
  'config.js',
  'render-tty.js',
  'live.js'
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(outDir))) {
    console.error('out/ not found — run `npm run compile` first.');
    process.exit(1);
  }
  await rm(coreDir, { recursive: true, force: true });
  await mkdir(coreDir, { recursive: true });

  let copied = 0;
  for (const mod of MODULES) {
    const src = join(outDir, mod);
    if (!(await exists(src))) {
      console.error(`Missing compiled module: ${mod}. Did the build succeed?`);
      process.exit(1);
    }
    await copyFile(src, join(coreDir, mod));
    copied++;
  }
  console.log(`Assembled extension core: ${copied} module(s) -> extension/credit-lens/core/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

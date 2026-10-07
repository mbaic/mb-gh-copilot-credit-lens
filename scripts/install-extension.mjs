// Install the Copilot CLI extension into ~/.copilot/extensions/credit-lens
// (user-scoped) or, with --project, into ./.github/extensions/credit-lens.
//
// We copy the prebuilt extension folder (extension.mjs + core/). We do NOT edit
// the user's ~/.copilot/settings.json — instead we print the one-line change
// needed to enable extensions, so nothing the user owns is rewritten silently.
//
// Pure Node builtins, no dependencies, no network. Run after:
//   npm run compile && npm run build:cli

import { cp, mkdir, readFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'extension', 'credit-lens');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const project = process.argv.includes('--project');
  const destBase = project ? join(process.cwd(), '.github', 'extensions') : join(homedir(), '.copilot', 'extensions');
  const dest = join(destBase, 'credit-lens');

  if (!(await exists(join(srcDir, 'core')))) {
    console.error('extension/credit-lens/core not found. Run `npm run build:cli` first.');
    process.exit(1);
  }

  await mkdir(destBase, { recursive: true });
  await cp(srcDir, dest, { recursive: true });
  console.log(`Installed extension -> ${dest}`);

  const settingsPath = join(homedir(), '.copilot', 'settings.json');
  let enabled = false;
  try {
    const raw = await readFile(settingsPath, 'utf8');
    enabled = /"EXTENSIONS"/.test(raw);
  } catch {
    /* no settings file yet */
  }

  if (enabled) {
    console.log('Extensions already enabled in ~/.copilot/settings.json.');
  } else {
    console.log('\nTo enable it, add "EXTENSIONS" to the experimental list in');
    console.log(`  ${settingsPath}`);
    console.log('for example:');
    console.log('  {');
    console.log('    "experimental": ["EXTENSIONS"]');
    console.log('  }');
  }
  console.log('\nThen restart the Copilot CLI and run  /credits');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// Brings the Armory addon into this repository, so the app can carry it and
// install it like the main addon. The Armory is developed in its own
// repository; addon/ForeverAICompanionArmory here is a copy of the files its
// .toc loads, and addon/armory-source.json says which commit it was taken from.
//
//   node scripts/sync-armory.js [path to the Armory repository]
//
// Without a path: FAIC_ARMORY_DIR, or a checkout next to this repository.
// Run it after changing the Armory, then commit the copy with the app.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARMORY_ADDON, ARMORY_SRC, ROOT } from '../src/config.js';

export const SOURCE_FILE = path.join(path.dirname(ARMORY_SRC), 'armory-source.json');
const REPOSITORY = 'Zemnexx/forever-ai-companion-armory';

// The Armory repository to copy from, or null.
export function armoryRepo(given = process.argv[2]) {
  const candidates = [given, process.env.FAIC_ARMORY_DIR, path.resolve(ROOT, '..', '..', 'forever-ai-companion-armory')].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, 'addon', ARMORY_ADDON, `${ARMORY_ADDON}.toc`))) || null;
}

// The addon's files as its .toc lists them: { name: text }.
export function armoryAddonFiles(repo) {
  const dir = path.join(repo, 'addon', ARMORY_ADDON);
  const tocName = `${ARMORY_ADDON}.toc`;
  const toc = fs.readFileSync(path.join(dir, tocName), 'utf8');
  const files = { [tocName]: toc };
  for (const line of toc.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || name.startsWith('#')) continue;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error(`The Armory's .toc lists a file outside its folder: ${name}`);
    files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  }
  return files;
}

function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export function syncArmory(repo) {
  const files = armoryAddonFiles(repo);
  fs.mkdirSync(ARMORY_SRC, { recursive: true });
  for (const name of fs.readdirSync(ARMORY_SRC)) {
    if (!(name in files)) fs.rmSync(path.join(ARMORY_SRC, name), { recursive: true, force: true });
  }
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ARMORY_SRC, name), text);
  const version = (files[`${ARMORY_ADDON}.toc`].match(/^## Version:\s*(.+)$/m) || [])[1]?.trim() || null;
  const source = {
    repository: REPOSITORY,
    commit: git(repo, 'rev-parse', 'HEAD') || null,
    // Files changed since that commit were copied as they are on disk.
    uncommitted: git(repo, 'status', '--porcelain', '--', `addon/${ARMORY_ADDON}`) !== '' || undefined,
    version,
    files: Object.keys(files).length,
  };
  fs.writeFileSync(SOURCE_FILE, `${JSON.stringify(source, null, 2)}\n`);
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = armoryRepo();
  if (!repo) {
    console.error('The Armory repository was not found. Pass its path: node scripts/sync-armory.js <path>');
    process.exit(1);
  }
  const source = syncArmory(repo);
  console.log(`Armory ${source.version} copied from ${repo} (${source.commit ? source.commit.slice(0, 7) : 'no commit'}${source.uncommitted ? ', with uncommitted changes' : ''}): ${source.files} files.`);
}

// Developer mode: run the companion in the terminal (no window).
import { loadConfig, resolveWowDir } from '../src/config.js';
import { ensureAddon, ensureArmory, isAddonInstalled } from '../src/install.js';
import { startWatcher } from '../src/watcher.js';
import { loadKnowledge } from '../src/prompt.js';

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

try {
  const cfg = loadConfig();
  const wowDir = resolveWowDir(cfg);
  // Updates the addon's files (or installs it under its current name when only
  // the one from before the rename is there).
  ensureAddon(cfg, { wowDir, log });
  ensureArmory(wowDir, { log }); // only when it is installed already
  if (!isAddonInstalled(wowDir, cfg)) {
    throw new Error('The addon is not installed. Run first: npm run install-addon');
  }
  const knowledge = loadKnowledge();
  log(`Forever AI Companion lista. Proveedor: ${cfg.provider}. WoW: ${wowDir}`);
  if (knowledge) log(`Conocimiento cargado: ${knowledge.length} caracteres.`);
  log('Esperando preguntas desde el juego... (Ctrl+C para salir)');
  startWatcher({ cfg, wowDir, log });
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

// The app's brain: owns the config, the watcher and the activity log, and
// implements every action the window can trigger.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PRESETS, env, envVar, loadConfig, readUserConfig, saveConfig, wowPaths } from '../config.js';
import { startBeacon } from '../beacon.js';
import { findWowDirs, isWowRunning, isWowRunningAsync, normalizeWowDir } from '../detect.js';
import {
  bundledAddonVersion, bundledArmoryVersion, ensureAddon, ensureArmory, finishLegacyMigration, hasLegacyAddon, install, installArmory,
  installedAddonVersion, installedArmoryVersion, isAddonInstalled, uninstall as uninstallAddon, uninstallArmory,
} from '../install.js';
import { ARMORY_EFFORTS, armoryModel, armoryPatch } from '../armory/index.js';
import { knowledgeReadme, micCsSource, sampleContext } from '../assets.js';
import { buildMessages, buildSystem, cleanAnswer, loadKnowledge, plainAnswer } from '../prompt.js';
import { ask, canSearch } from '../providers.js';
import { startWatcher } from '../watcher.js';
import { authStatus, findClaudeCode, openInstall, openLogin } from '../claude-code.js';
import {
  codexAuthStatus, codexInstallState, codexSearchState, codexVersion, findCodex, installCodex, openCodexLogin, searchCodex,
} from '../codex.js';
import { ttsEngineSource } from '../assets.js';
import {
  ENGINE_DLL, codeBaseIs, compileEngine, installVoice as registerVoiceForUser, installVoiceMachineWide, isLegacyEngineRegistered,
  isLegacyVoiceVisible, isVoiceVisible, machineEngineState, uninstallVoiceMachineWide, userEngine,
} from '../tts-voice.js';
import { removeLegacyInstallDir } from '../migrate.js';
import * as sys from './system.js';
import { err, getAppLang, setAppLang, t } from '../i18n.js';
import { TOPICS_FILE, currentGuide, guideFreshness, startGuideUpdates, topicsUrl } from '../guide.js';
import { createUpdater } from '../updater.js';
import { createMic, ensureMicExe } from '../mic.js';
import { createTalk, talkSettings } from '../talk.js';
import { TRUSTED_KEYS } from '../signing.js';

export const VERSION = '2.6.0';

// Where the silent voice's DLL lives (it is loaded by the game while in use).
// Only programs running as the player load this copy (per-user registration);
// elevated ones load an admin-only copy under Program Files (see tts-voice.js).
const voiceDll = () => path.join(sys.isPackaged() ? sys.installDir() : env.dataDir, ENGINE_DLL);
const engineSourceHash = () => crypto.createHash('sha256').update(ttsEngineSource()).digest('hex');
// How often to check whether the game was closed, while the addon under the
// project's previous name is still in the AddOns folder.
const LEGACY_ADDON_CHECK_MS = 10000;
// How often to check that the chosen subscription AI is still signed in.
const LOGIN_CHECK_MS = 5 * 60 * 1000;

// onUpdateAvailable(version): a newer release was found (tray notice).
export function createController({ log = () => {}, onUpdateAvailable = () => {} } = {}) {
  let cfg = loadConfig();
  setAppLang(cfg.language && cfg.language !== 'auto' ? cfg.language : null);
  let watcher = null;
  let watcherError = null;
  let beacon = null;     // app status for the game (see beacon.js)
  let loginTimer = null;
  let autostart; // cached: reading it spawns reg.exe
  let trayReady = false; // icon next to the Windows clock is running
  const events = [];
  const bundledVersion = bundledAddonVersion();
  const armoryVersion = bundledArmoryVersion(); // null: this copy carries no Armory

  const knowledgeDir = () => path.join(env.dataDir, 'knowledge');
  const ensureKnowledgeDir = () => {
    const dir = knowledgeDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), knowledgeReadme());
    }
  };
  ensureKnowledgeDir();

  // Updates from GitHub releases: only the installed app (or a test server).
  // Without a trusted signing key built in, nothing could be verified: off.
  const updateApi = envVar('UPDATE_API');
  if ((sys.isPackaged() || updateApi) && !TRUSTED_KEYS.length) log('Updates are off: this copy has no update signing key built in.');
  const updater = (sys.isPackaged() || updateApi) && TRUSTED_KEYS.length ? createUpdater({
    currentVersion: VERSION,
    dir: path.join(env.dataDir, 'updates'),
    log,
    onAvailable: onUpdateAvailable,
    ...(updateApi ? { apiUrl: updateApi, allowUrl: (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u) } : {}),
  }) : null;

  // WoW Forever guide: the one inside the app or a newer downloaded one.
  const guideDir = path.join(env.dataDir, 'guide');
  let guide = currentGuide(guideDir);
  const guideUpdates = startGuideUpdates({
    url: cfg.guideUrl, dir: guideDir, log, onUpdate: () => { guide = currentGuide(guideDir); },
  });
  // Detailed topics (dungeons, zones, classes...): each question gets its sections.
  let topics = currentGuide(guideDir, TOPICS_FILE);
  const topicsUpdates = startGuideUpdates({
    url: topicsUrl(cfg.guideUrl), dir: guideDir, file: TOPICS_FILE, log, onUpdate: () => { topics = currentGuide(guideDir, TOPICS_FILE); },
  });
  const guides = {
    current: () => guide,
    topics: () => topics,
    onPatch: () => { guideUpdates.check('patch'); topicsUpdates.check('patch'); },
  };

  // Voice questions: the microphone helper is compiled and started on first use.
  const talk = createTalk({
    getCfg: () => cfg,
    log,
    getMic: () => createMic({
      log,
      getExe: () => ensureMicExe({ source: micCsSource(), dir: sys.isPackaged() ? sys.installDir() : env.dataDir }),
    }),
  });

  const wowDirValid = () => Boolean(cfg.wowDir && fs.existsSync(cfg.wowDir));
  const addonOk = () => wowDirValid() && isAddonInstalled(cfg.wowDir, cfg);

  function addEvent(e) {
    if (e.type === 'problem') {
      events.push({ id: `p${Date.now()}`, who: 'Forever AI Companion', question: t('unreadableQuestion'), ok: false, answer: e.message, pending: false, time: new Date().toISOString() });
      while (events.length > 20) events.shift();
      return;
    }
    if (e.type === 'answer') {
      const q = events.find((x) => x.id === e.id);
      if (q) Object.assign(q, { ok: e.ok, answer: e.answer, pending: false, tokens: e.tokens || null });
      return;
    }
    if (e.type === 'heard') {
      const q = events.find((x) => x.id === e.id);
      if (q) q.question = e.question;
      return;
    }
    events.push({ ...e, pending: true, time: new Date().toISOString() });
    while (events.length > 20) events.shift();
  }

  // The addon under the project's previous name stays while the game runs (it
  // may have it loaded); once the game is closed it is removed and the saved
  // chats are copied again if the game saved them since.
  let legacyTimer = null;
  let legacyChecking = false;
  function watchLegacyAddon() {
    if (legacyTimer || !wowDirValid() || !hasLegacyAddon(cfg.wowDir)) return;
    legacyTimer = setInterval(async () => {
      if (legacyChecking) return;
      legacyChecking = true;
      try {
        const dir = cfg.wowDir;
        if (!dir || !fs.existsSync(dir) || !hasLegacyAddon(dir)) { clearInterval(legacyTimer); legacyTimer = null; return; }
        const running = await isWowRunningAsync();
        if (finishLegacyMigration(dir, { wowRunning: running, log })) { clearInterval(legacyTimer); legacyTimer = null; }
      } catch (e) {
        log(`Addon with the previous name: ${e.message}`);
      } finally {
        legacyChecking = false;
      }
    }, LEGACY_ADDON_CHECK_MS);
    legacyTimer.unref?.();
  }

  function restartWatcher() {
    if (watcher) watcher.stop();
    watcher = null;
    watcherError = null;
    if (!wowDirValid()) { watcherError = t('needGameFolder'); return; }
    try {
      // Keep the in-game addon up to date with this app's version; coming
      // from before the rename, install it under its current name.
      ensureAddon(cfg, { wowDir: cfg.wowDir, log });
    } catch (e) {
      log(`Could not update the addon: ${e.message}`);
    }
    // The Armory, when the player installed it: kept at this app's version too.
    try {
      ensureArmory(cfg.wowDir, { log });
    } catch (e) {
      log(`Could not update Forever AI Armory: ${e.message}`);
    }
    watchLegacyAddon();
    if (!addonOk()) { watcherError = t('needAddon'); return; }
    try {
      watcher = startWatcher({ cfg, wowDir: cfg.wowDir, log, onEvent: addEvent, guides, talk });
      log(`Waiting for questions (${cfg.provider}) in ${cfg.wowDir}`);
    } catch (e) {
      watcherError = e.message;
      log(`Could not start: ${e.message}`);
    }
  }

  function save(patch) {
    cfg = saveConfig(patch);
    restartWatcher();
    checkLogin();
  }

  // Whether the chosen subscription AI (Claude Code, Codex) is installed and
  // signed in: true / false, or null when unknown or not needed. Checked now
  // and then (it runs the AI's own program), and whenever settings change.
  let aiSignedIn = null;
  let loginCheck = null;
  function checkLogin() {
    const provider = cfg.provider;
    if (provider !== 'claude-code' && provider !== 'codex') {
      aiSignedIn = null;
      beacon?.refresh();
      return Promise.resolve();
    }
    // Not installed: false. The status check itself failing: unknown.
    const run = (async () => {
      const found = provider === 'claude-code' ? findClaudeCode(cfg.claudeCode.bin) : findCodex(cfg.codex.bin);
      if (!found) return false;
      const s = provider === 'claude-code' ? await authStatus(found.path) : await codexAuthStatus(found.path);
      return s.error ? null : s.loggedIn;
    })();
    loginCheck = run;
    return run
      .then((ok) => { if (loginCheck === run) aiSignedIn = typeof ok === 'boolean' ? ok : null; })
      .catch(() => { if (loginCheck === run) aiSignedIn = null; })
      .finally(() => beacon?.refresh());
  }

  // The window checked the sign-in itself (setup and dashboard): use that too,
  // so signing in shows up in the game right away.
  function noteSignIn(provider, s) {
    if (cfg.provider !== provider || s.error) return;
    const ok = Boolean(s.installed && s.loggedIn);
    if (ok !== aiSignedIn) { aiSignedIn = ok; beacon?.refresh(); }
  }

  // Why questions from the game can't be answered right now (null: ready).
  // Shown in the addon's chat header (beacon.js).
  function notReadyReason() {
    if (watcherError) return 'problem';
    // Without a choice the app falls back to "echo" (a test that repeats the
    // question): that is no AI. A provider set by hand in config.json counts.
    const preset = cfg.preset || null;
    let configured = Boolean(preset) || Boolean(envVar('PROVIDER'));
    if (!configured) {
      try { configured = Boolean(readUserConfig().provider); } catch { configured = false; }
    }
    if (!configured) return 'need-ai';
    if (preset && PRESETS[preset]?.needsKey && !cfg.keys?.[preset]) return 'need-ai';
    if (aiSignedIn === false) return 'need-login';
    return null;
  }

  // (Re)compiles the silent voice when its source changed (app updates).
  // Registration stays the same, so no administrator prompt is needed.
  async function refreshVoiceDll(force = false) {
    const dll = voiceDll();
    const source = ttsEngineSource();
    const hash = engineSourceHash();
    const hashFile = `${dll}.source-sha256`;
    const current = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8') : null;
    if (!force && current === hash && fs.existsSync(dll)) return dll;
    const src = path.join(env.dataDir, ENGINE_DLL.replace(/\.dll$/i, '.cs'));
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(src, source);
    await compileEngine(src, dll);
    fs.writeFileSync(hashFile, hash);
    log('Invisible voice updated.');
    return dll;
  }
  if (sys.isWindows) {
    Promise.all([isVoiceVisible(), isLegacyVoiceVisible()])
      .then(async ([active, legacy]) => {
        if (!active && !legacy) return;
        const dll = await refreshVoiceDll();
        // Invisible sending turned on from another copy of the app (another
        // install folder, maybe deleted since): the game would load that
        // copy's voice. Point the per-user registration at this one (no
        // prompt needed). Not from a test install, which leaves the PC alone.
        if (!active || !sys.isPackaged() || sys.isSandbox() || await isLegacyEngineRegistered()) return;
        const engine = await userEngine();
        if (engine && codeBaseIs(engine.codeBase, dll)) return;
        await registerVoiceForUser(dll);
        log(`Invisible voice now uses this copy of the app (it pointed to ${engine?.codeBase || 'nothing'}).`);
      })
      .catch((e) => log(`Could not update the invisible voice: ${e.message}`));
  }

  // First run: find the game on our own.
  if (!wowDirValid()) {
    const [found] = findWowDirs();
    if (found) {
      cfg = saveConfig({ wowDir: found });
      log(`WoW Forever found in ${found}`);
    }
  }
  restartWatcher();

  // Tells the game whether this app is open and ready (the addon's chat header).
  beacon = startBeacon({
    paths: () => (addonOk() ? wowPaths(cfg.wowDir) : null),
    reason: notReadyReason,
    log,
  });
  checkLogin();
  loginTimer = setInterval(checkLogin, LOGIN_CHECK_MS);
  loginTimer.unref?.();

  const mask =(k) => (k ? `••••${String(k).slice(-4)}` : null);

  return {
    async status() {
      const preset = cfg.preset || (cfg.provider === 'echo' ? 'echo' : null);
      return {
        version: VERSION,
        lang: getAppLang(),
        packaged: sys.isPackaged(),
        wow: {
          dir: cfg.wowDir,
          valid: wowDirValid(),
          addonInstalled: addonOk(),
          addonVersion: wowDirValid() ? installedAddonVersion(cfg.wowDir) : null,
          bundledVersion,
        },
        ai: {
          preset,
          provider: cfg.provider,
          keys: Object.fromEntries(Object.keys(PRESETS).map((p) => [p, mask(cfg.keys?.[p])])),
          models: cfg.models || {},
          defaults: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.model || null])),
          webSearch: cfg.webSearch !== false,
          // Why the chosen AI can't answer yet: "need-ai" (no AI or no key),
          // "need-login" (Claude Code / Codex signed out), or null.
          issue: ['need-ai', 'need-login'].includes(notReadyReason()) ? notReadyReason() : null,
        },
        // The Armory (optional second addon) and how its analyses are asked.
        armory: {
          available: Boolean(armoryVersion),
          installed: wowDirValid() ? installedArmoryVersion(cfg.wowDir) : null,
          bundledVersion: armoryVersion,
          effort: ARMORY_EFFORTS.includes(cfg.armory?.effort) ? cfg.armory.effort : 'high',
          model: armoryModel(cfg),
        },
        running: Boolean(watcher),
        problem: watcherError,
        events: [...events].reverse(),
        autostart: autostart === undefined ? (autostart = await sys.getAutostart()) : autostart,
        closeAction: cfg.closeAction || 'ask',
        tray: trayReady,
        guide: guide ? {
          date: guide.meta.date,
          source: guide.source,
          age: guideFreshness(guide).age,
          stale: guideFreshness(guide).stale,
          autoUpdate: Boolean(cfg.guideUrl && TRUSTED_KEYS.length),
        } : null,
        update: updater ? updater.state() : null,
      };
    },

    async checkUpdate() {
      if (!updater) return { status: 'unsupported' };
      return updater.check();
    },

    // Downloads and verifies the new version, then runs it: it closes this
    // app, replaces it and starts again in the background (the window reloads).
    async installUpdate() {
      if (!updater) throw err('updateUnsupported');
      const exe = await updater.download();
      log(`Installing update from ${exe}`);
      sys.relaunch(exe, ['--background']);
      return { restarting: true };
    },

    async checkGuide() {
      const [updated, topicsUpdated] = await Promise.all([guideUpdates.check('manual'), topicsUpdates.check('manual')]);
      return { updated: updated || topicsUpdated, date: guide?.meta.date || null };
    },

    setTrayReady(v) { trayReady = Boolean(v); },

    // Voice questions (talk.js).
    talkStatus() {
      const s = talkSettings(cfg);
      return { supported: sys.isWindows, enabled: s.enabled, model: s.model, keySource: s.keySource, key: mask(cfg.talk?.apiKey) };
    },
    setTalk({ enabled, apiKey, model, removeKey } = {}) {
      const patch = { talk: {} };
      if (typeof enabled === 'boolean') patch.talk.enabled = enabled;
      if (typeof apiKey === 'string' && apiKey.trim()) patch.talk.apiKey = apiKey.trim();
      if (removeKey) patch.talk.apiKey = null;
      if (typeof model === 'string' && /^[\w.:-]{1,80}$/.test(model.trim())) patch.talk.model = model.trim();
      const next = { ...cfg.talk, ...patch.talk };
      if (next.enabled && !next.apiKey && !cfg.keys?.chatgpt) throw err('talkNeedsKey');
      save(patch);
      return this.talkStatus();
    },
    async talkTest() {
      if (!sys.isWindows) throw err('installedOnly');
      return talk.test({ lang: getAppLang() });
    },
    setWebSearch({ enabled }) {
      save({ webSearch: Boolean(enabled) });
      return { webSearch: Boolean(enabled) };
    },
    closeAction() { return cfg.closeAction || 'ask'; },
    setCloseAction({ action }) {
      if (!['ask', 'tray', 'quit'].includes(action)) throw err('unknownOption');
      save({ closeAction: action });
      return { closeAction: action };
    },

    detectWow() {
      const dirs = findWowDirs();
      if (dirs[0]) save({ wowDir: dirs[0] });
      return { found: dirs };
    },

    async pickWow() {
      const chosen = await sys.pickFolder();
      if (!chosen) return { cancelled: true };
      const dir = normalizeWowDir(chosen);
      if (!dir) throw err('notForeverFolder');
      save({ wowDir: dir });
      return { dir };
    },

    installAddon() {
      if (!wowDirValid()) throw err('needGameFolder');
      install(cfg, { wowDir: cfg.wowDir, log });
      restartWatcher();
      return { wowRunning: isWowRunning() };
    },

    // The Armory addon: installed when the player asks, next to the main addon.
    installArmory() {
      if (!wowDirValid()) throw err('needGameFolder');
      if (!addonOk()) throw err('needAddon');
      if (!armoryVersion) throw err('armoryNotBundled');
      installArmory(cfg.wowDir, { log });
      return { version: armoryVersion, wowRunning: isWowRunning() };
    },
    uninstallArmory() {
      if (!wowDirValid()) throw err('needGameFolder');
      uninstallArmory(cfg.wowDir);
      log('Forever AI Armory removed.');
      return {};
    },
    // How the Armory's analyses are asked: how thorough, and with which model
    // of the chosen AI (empty = the chat's model).
    setArmory(body) {
      save(armoryPatch(cfg, body));
      return { effort: cfg.armory.effort, model: armoryModel(cfg) };
    },

    setAI({ preset, apiKey, model }) {
      if (!PRESETS[preset]) throw err('unknownAI');
      const patch = { preset };
      if (typeof apiKey === 'string' && apiKey.trim()) patch.keys = { [preset]: apiKey.trim() };
      if (typeof model === 'string') patch.models = { [preset]: model.trim() || null };
      if (PRESETS[preset].needsKey && !patch.keys && !cfg.keys?.[preset]) {
        throw err('pasteKey');
      }
      save(patch);
      return {};
    },

    async testAI() {
      const req = { id: 'test', question: t('testQuestion'), context: sampleContext(), history: [] };
      const started = Date.now();
      const system = buildSystem(loadKnowledge(), 'fizzi', { canSearch: canSearch(cfg), client: req.context?.client, ...(guide ? { guide } : {}) });
      const { text, model } = await ask(cfg, system, buildMessages(req), req);
      return { text: plainAnswer(cleanAnswer(text)), model, seconds: ((Date.now() - started) / 1000).toFixed(1) };
    },

    async voiceStatus() {
      if (!sys.isWindows) return { supported: false };
      const active = await isVoiceVisible();
      // Set up by a version from before the rename (the voice's previous name,
      // or its engine still the previous name's DLL): it keeps working, but the
      // window offers to update it (one administrator prompt).
      const legacyName = !active && await isLegacyVoiceVisible();
      const legacyEngine = (active || legacyName) && await isLegacyEngineRegistered();
      // Registered machine-wide from the user's own folder (installs before
      // the protected copy), or from an older engine: one prompt updates it.
      const machine = active && !legacyEngine ? await machineEngineState(engineSourceHash()).catch(() => 'ok') : 'ok';
      const unprotected = machine === 'outside' || machine === 'stale';
      const legacy = legacyName || legacyEngine || unprotected;
      const legacyReason = legacyName || legacyEngine ? 'name' : unprotected ? 'protect' : null;
      return { supported: true, active: active || legacyName, legacy, legacyReason, dll: fs.existsSync(voiceDll()) };
    },

    // Compiles the silent voice and registers it (one administrator prompt).
    async installVoice() {
      const dll = await refreshVoiceDll(true);
      await installVoiceMachineWide(dll, env.dataDir, { sourceHash: engineSourceHash() });
      log('Invisible voice enabled.');
      // The old install folder was kept only for the previous voice's DLL.
      if (sys.isPackaged()) removeLegacyInstallDir(sys.legacyInstallDir());
      return { active: await isVoiceVisible(), wowRunning: isWowRunning() };
    },

    async uninstallVoice() {
      await uninstallVoiceMachineWide(env.dataDir);
      log('Invisible voice disabled.');
      return { active: await isVoiceVisible() };
    },

    async claudeStatus() {
      const found = findClaudeCode(cfg.claudeCode.bin);
      const out = found
        ? { installed: true, source: found.source, ...(await authStatus(found.path)) }
        : { installed: false, loggedIn: false };
      noteSignIn('claude-code', out);
      return out;
    },

    claudeInstall() {
      openInstall();
      return {};
    },

    claudeLogin() {
      const found = findClaudeCode(cfg.claudeCode.bin);
      if (!found) throw err('installClaudeFirst');
      openLogin(found.path);
      return {};
    },

    async codexStatus() {
      const install = codexInstallState();
      const search = codexSearchState();
      const found = findCodex(cfg.codex.bin);
      const out = found
        ? { installed: true, source: found.source, install, search, ...(await codexAuthStatus(found.path)) }
        : { installed: false, loggedIn: false, install, search };
      noteSignIn('codex', out);
      return out;
    },

    // Already installed (any way): nothing to do. Otherwise the app downloads
    // the official build in the background; codexStatus reports the progress.
    codexInstall() {
      const found = findCodex(cfg.codex.bin);
      if (found) return { already: true, source: found.source };
      installCodex({ log }).catch(() => { /* reported by codexStatus */ });
      return { started: true };
    },

    // Looks for Codex all over the PC (running programs, then the disks) in the
    // background; codexStatus reports how it goes. What it finds is remembered.
    codexSearch() {
      const found = findCodex(cfg.codex.bin);
      if (found) return { already: true, source: found.source };
      searchCodex({ log }).then((file) => { if (file) save({ codex: { bin: file } }); }).catch(() => {});
      return { started: true };
    },

    // The player points at a codex.exe Codex installed some other way.
    async codexPick() {
      const file = await sys.pickFile({ title: t('pickCodex'), filter: 'Codex (codex*.exe;codex.cmd)|codex*.exe;codex.cmd' });
      if (!file) return { cancelled: true };
      if (!(await codexVersion(file))) throw err('codexPickInvalid');
      save({ codex: { bin: file } });
      return { path: file };
    },

    codexLogin() {
      const found = findCodex(cfg.codex.bin);
      if (!found) throw err('installCodexFirst');
      openCodexLogin(found.path);
      return {};
    },

    async setAutostart({ enabled }) {
      autostart = await sys.setAutostart(Boolean(enabled));
      return { autostart };
    },

    openKnowledge() {
      ensureKnowledgeDir();
      sys.openFolder(knowledgeDir());
      return {};
    },

    stop() {
      talk.close();
      beacon.stop();
      clearInterval(loginTimer);
      guideUpdates.stop();
      topicsUpdates.stop();
      updater?.stop();
      if (legacyTimer) clearInterval(legacyTimer);
      legacyTimer = null;
      if (watcher) watcher.stop();
      watcher = null;
    },

    // Removes everything this app created. The caller then exits.
    async uninstall() {
      this.stop();
      if (wowDirValid()) uninstallAddon(cfg, cfg.wowDir);
      if (sys.isWindows) await uninstallVoiceMachineWide(env.dataDir).catch((e) => log(e.message));
      if (sys.isPackaged()) {
        await sys.setAutostart(false).catch(() => {});
        await sys.removeShortcuts().catch(() => {});
      }
      fs.rmSync(env.dataDir, { recursive: true, force: true });
      if (sys.isPackaged()) {
        // Leftovers of the project's previous name, if any.
        removeLegacyInstallDir(sys.legacyInstallDir());
        try { fs.rmSync(sys.legacyAppDataDir(), { recursive: true, force: true }); } catch { /* in use */ }
        sys.scheduleSelfDelete(sys.installDir());
      }
      return {};
    },
  };
}

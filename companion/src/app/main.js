// Entry point of ForeverAICompanion.exe (and of `npm run app` in development).
//
// Double-clicking the downloaded exe:
//   1. copies itself to %LOCALAPPDATA%\Programs\ForeverAICompanion and creates
//      Start menu + desktop shortcuts (closing an older running version first);
//   2. starts the background service and opens the setup window.
// Running it again just reopens the window of the instance already running.
// `--background` (used by "start with Windows") starts without a window.
//
// Updating from before the rename (see config.LEGACY_NAME) also moves the data
// folder, the install folder, shortcuts and "start with Windows" to the
// current names (see migrateFromPreviousName below and ../migrate.js).
import fs from 'node:fs';
import path from 'node:path';
import { LEGACY_NAME, env, envVar } from '../config.js';
import { createController, VERSION } from './controller.js';
import { createServer, findRunning, findRunningInstance, listen, quitRunningInstance } from './server.js';
import * as sys from './system.js';
import { appIconIco, trayCsSource } from '../assets.js';
import { ensureTrayExe, startTray } from '../tray.js';
import { err, t } from '../i18n.js';
import { migrateDataDir, removeLegacyInstallDir, tidyLegacyDataDir } from '../migrate.js';
import { isLegacyEngineRegistered, isLegacyVoiceVisible } from '../tts-voice.js';

const args = process.argv.slice(2);
// --background: started with Windows, no window. --no-window: for testing.
const background = args.includes('--background') || args.includes('--no-window');

const LOG_FILE = 'forever-ai-companion.log';

function makeLogger() {
  const file = path.join(env.dataDir, LOG_FILE);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.old`);
  } catch { /* ignore */ }
  return (...parts) => {
    const line = `[${new Date().toLocaleString()}] ${parts.join(' ')}\n`;
    try { fs.appendFileSync(file, line); } catch { /* ignore */ }
    if (!sys.isPackaged()) process.stdout.write(line);
  };
}

async function selfInstall(log) {
  const target = sys.installedExe();
  if (sys.samePath(process.execPath, target)) return false;
  // Updating: close the version that is running from the install folder.
  const running = await findRunningInstance();
  if (running) await quitRunningInstance(running);
  fs.mkdirSync(sys.installDir(), { recursive: true });
  let lastError;
  for (let i = 0; i < 10; i++) {
    try {
      fs.copyFileSync(process.execPath, target);
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (lastError) throw err('installFailed', { target, error: lastError.message });
  await sys.createShortcuts(target).catch((e) => log(`Could not create shortcuts: ${e.message}`));
  log(`Installed in ${target}`);
  sys.relaunch(target, args);
  return true;
}

// Moves the data folder from before the rename (API keys, settings, chats
// state) to the current one, before anything is written there. A copy of the
// app from then may be running with files open in it: it is closed first.
async function migrateDataFolder() {
  const oldDir = sys.legacyAppDataDir();
  if (!fs.existsSync(oldDir)) return 'none';
  const running = await findRunning();
  if (running?.legacy) await quitRunningInstance(running.url);
  try {
    return migrateDataDir(oldDir, env.dataDir);
  } catch (e) {
    return `failed (${e.message})`; // the old folder is untouched: retried next start
  }
}

// Leftovers from before the rename, once the app runs from its current folder:
// the old install folder (its exe, the tray helper...) and what the old silent
// voice recreates in the old data folder. While Windows still has the voice
// registered with the old DLL (until the player clicks "Update invisible
// sending"), that DLL is kept so invisible sending keeps working. Files in use
// stay and are retried on a later start.
async function cleanUpPreviousName(log) {
  const oldInstall = sys.legacyInstallDir();
  const oldData = sys.legacyAppDataDir();
  if (!fs.existsSync(oldInstall) && !fs.existsSync(oldData)) return false;
  const voiceIsOld = await isLegacyEngineRegistered().catch(() => true);
  if (fs.existsSync(oldInstall)) {
    const removed = removeLegacyInstallDir(oldInstall, { keepVoiceDll: voiceIsOld });
    log(removed ? `Removed the old install folder (${oldInstall}).`
      : voiceIsOld ? 'Old install folder: its silent voice is kept until invisible sending is updated.'
        : 'Old install folder: some files are in use; will retry.');
  }
  if (!voiceIsOld && !(await isLegacyVoiceVisible().catch(() => true))) tidyLegacyDataDir(oldData);
  return true;
}

async function main() {
  const dataOverride = envVar('DATA_DIR');
  if (sys.isPackaged()) env.dataDir = sys.appDataDir();
  if (dataOverride) env.dataDir = dataOverride;
  const dataMigration = sys.isPackaged() && !dataOverride ? await migrateDataFolder() : 'none';
  fs.mkdirSync(env.dataDir, { recursive: true });
  const log = makeLogger();
  if (dataMigration !== 'none') log(`Data folder of the previous name (${LEGACY_NAME}): ${dataMigration}.`);

  if (sys.isPackaged() && sys.isWindows && !args.includes('--no-install')) {
    if (await selfInstall(log)) process.exit(0);
  }

  const running = await findRunning();
  if (running?.legacy) {
    // A copy from before the rename (e.g. started by its old shortcut): replace it.
    await quitRunningInstance(running.url);
  } else if (running) {
    if (!background) sys.openWindow(running.url);
    process.exit(0);
  }

  // Running from the install folder: move shortcuts and "start with Windows"
  // to this exe, and clean up what the previous name left behind.
  if (sys.isPackaged() && sys.isWindows && sys.samePath(process.execPath, sys.installedExe())) {
    if (!sys.isSandbox()) await cleanUpPreviousName(log).catch((e) => log(`Cleaning up the previous name: ${e.message}`));
    if (await sys.getAutostart()) await sys.setAutostart(true).catch((e) => log(`Start with Windows: ${e.message}`));
    // First run of a new version: fresh shortcuts so Windows shows the current
    // icon (and, coming from before the rename, they point to this exe).
    const marker = path.join(env.dataDir, 'installed-version');
    let seen = null;
    try { seen = fs.readFileSync(marker, 'utf8').trim(); } catch { /* first run */ }
    if (seen !== VERSION) {
      await sys.createShortcuts(sys.installedExe()).catch((e) => log(`Shortcuts: ${e.message}`));
      try { fs.writeFileSync(marker, VERSION); } catch { /* ignore */ }
    }
  }

  let tray = null;
  // A newer version on GitHub: a notice next to the clock (click opens the window).
  const controller = createController({
    log,
    onUpdateAvailable: (version) => tray?.notify(t('updateNoticeTitle', { version }), t('updateNoticeText')),
  });
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    controller.stop();
    tray?.stop();
    log('Forever AI Companion closed.');
    setTimeout(() => process.exit(0), 150); // lets the tray icon go away first
  };
  // Closing the window: ask, keep running next to the clock, or quit.
  let remindedTray = false;
  const onWindowClosed = () => {
    if (!tray) return; // no tray icon: keep running as before
    const action = controller.closeAction();
    if (action === 'quit') return quit();
    if (action === 'tray') {
      if (!remindedTray) tray.balloon(t('trayClickHint'));
      remindedTray = true;
      return;
    }
    tray.ask();
  };
  const server = createServer(controller, { onQuit: quit, onWindowClosed, log });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}/`;
  log(`Forever AI Companion ${background ? 'running in the background' : 'open'}: ${url}`);
  if (!background) sys.openWindow(url);

  // Icon next to the Windows clock.
  if (sys.isWindows && !args.includes('--no-tray')) {
    try {
      const ico = path.join(env.dataDir, 'app.ico');
      fs.writeFileSync(ico, appIconIco());
      const exe = await ensureTrayExe({ source: trayCsSource(), dir: sys.isPackaged() ? sys.installDir() : env.dataDir, icoPath: ico });
      tray = startTray({
        exe, icoPath: ico, log,
        onOpen: () => sys.openWindow(url),
        onQuit: quit,
        onChoice: (choice, remember) => {
          if (remember) { try { controller.setCloseAction({ action: choice }); } catch (e) { log(e.message); } }
          if (choice === 'quit') quit();
          else remindedTray = true;
        },
      });
      controller.setTrayReady(Boolean(tray));
      // Invisible sending set up by an older version: it keeps working, but it
      // should move to the protected folder (one Windows prompt). A notice next
      // to the clock, so players who never open the window find out too.
      if (tray) {
        setTimeout(() => {
          controller.voiceStatus()
            .then((v) => { if (v?.legacy) tray.notify(t('voiceUpdateNoticeTitle'), t('voiceUpdateNoticeText')); })
            .catch(() => {});
        }, 8000);
      }
    } catch (e) {
      log(`Tray icon: ${e.message}`);
    }
  }
}

// An error nobody caught would close the app without a trace: it goes to the
// log first (the app keeps running for rejected promises).
process.on('uncaughtException', (e) => {
  try { fs.appendFileSync(path.join(env.dataDir, LOG_FILE), `[${new Date().toLocaleString()}] [fatal] ${e?.stack || e}\n`); } catch { /* ignore */ }
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  try { fs.appendFileSync(path.join(env.dataDir, LOG_FILE), `[${new Date().toLocaleString()}] [error] ${e?.stack || e}\n`); } catch { /* ignore */ }
});

main().catch(async (e) => {
  try { fs.appendFileSync(path.join(env.dataDir, LOG_FILE), `[fatal] ${e.stack || e}\n`); } catch { /* ignore */ }
  if (sys.isPackaged()) await sys.showError(`${t('startFailed')}\n\n${e.message}`);
  else console.error(e);
  process.exit(1);
});

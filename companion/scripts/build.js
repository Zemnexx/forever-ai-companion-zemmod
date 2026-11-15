// Builds dist/ForeverAICompanion.exe: one self-contained Windows program with
// the companion, the setup window and the addon files embedded.
//
//   npm run build
//
// Steps: bundle with esbuild (embedding the assets) -> give a copy of Node the
// app's icon and name (rcedit) -> Node single executable application built
// from that copy (node --build-sea) -> mark the exe as a GUI program so no
// console window appears.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { ROOT } from '../src/config.js';
import { addonFiles, appIconIco, appIconPng, foreverGuide, knowledgeReadme, micCsSource, sampleContext, trayCsSource, ttsEngineSource, uiHtml } from '../src/assets.js';

const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'forever-ai-companion.cjs');
const EXE = path.join(DIST, 'ForeverAICompanion.exe');

fs.mkdirSync(DIST, { recursive: true });

// Replace src/assets.js with a module that has every file embedded.
const embedded = `
const ADDON = ${JSON.stringify(addonFiles())};
const UI = ${JSON.stringify(uiHtml())};
const SAMPLE = ${JSON.stringify(sampleContext())};
const KNOWLEDGE = ${JSON.stringify(knowledgeReadme())};
const TTS = ${JSON.stringify(ttsEngineSource())};
const ICON = ${JSON.stringify(appIconPng().toString('base64'))};
export const appIconPng = () => Buffer.from(ICON, 'base64');
const ICO = ${JSON.stringify(appIconIco().toString('base64'))};
export const appIconIco = () => Buffer.from(ICO, 'base64');
const TRAY = ${JSON.stringify(trayCsSource())};
export const trayCsSource = () => TRAY;
const MIC = ${JSON.stringify(micCsSource())};
export const micCsSource = () => MIC;
const GUIDE = ${JSON.stringify(foreverGuide())};
export const foreverGuide = () => GUIDE;
export const ttsEngineSource = () => TTS;
export const addonFiles = () => ({ ...ADDON });
export const uiHtml = () => UI;
export const sampleContext = () => structuredClone(SAMPLE);
export const knowledgeReadme = () => KNOWLEDGE;
`;
const assetsPath = path.join(ROOT, 'src', 'assets.js');
const embedAssets = {
  name: 'embed-assets',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]assets\.js$/ }, (args) =>
      (path.resolve(args.path) === assetsPath ? { contents: embedded, loader: 'js' } : undefined));
  },
};

console.log('1/4 Bundling the code…');
await build({
  entryPoints: [path.join(ROOT, 'src', 'app', 'main.js')],
  outfile: BUNDLE,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  plugins: [embedAssets],
  define: { 'import.meta.url': '__faic_import_meta_url' },
  banner: { js: 'const __faic_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  logLevel: 'warning',
});

console.log('2/4 Setting the icon and name…');
// --build-sea copies the Node executable that runs it, resources included:
// a copy of Node with our icon and version info gives the exe both.
const VERSION = fs.readFileSync(path.join(ROOT, 'src', 'app', 'controller.js'), 'utf8').match(/VERSION = '([\d.]+)'/)[1];
const base = path.join(DIST, 'node-base.exe');
fs.copyFileSync(process.execPath, base);
const rcedit = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
execFileSync(rcedit, [base,
  '--set-icon', path.join(ROOT, 'assets', 'app.ico'),
  '--set-file-version', VERSION, '--set-product-version', VERSION,
  '--set-version-string', 'FileDescription', 'Forever AI Companion',
  '--set-version-string', 'ProductName', 'Forever AI Companion',
  '--set-version-string', 'CompanyName', 'Forever AI Companion',
  '--set-version-string', 'LegalCopyright', '',
  '--set-version-string', 'InternalName', 'ForeverAICompanion',
  '--set-version-string', 'OriginalFilename', 'ForeverAICompanion.exe',
], { stdio: 'inherit' });

console.log('3/4 Creating ForeverAICompanion.exe…');
const seaConfig = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: BUNDLE,
  output: EXE,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
}, null, 2));
fs.rmSync(EXE, { force: true });
execFileSync(base, ['--build-sea', seaConfig], { stdio: 'inherit' });
fs.rmSync(base, { force: true });

console.log('4/4 Making it a window program (no console)…');
// PE header: e_lfanew at 0x3C -> "PE\0\0" + 20-byte COFF header + optional
// header, whose Subsystem field is at offset 68. 2 = Windows GUI, 3 = console.
const exe = fs.readFileSync(EXE);
const pe = exe.readUInt32LE(0x3c);
if (exe.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('El exe no tiene cabecera PE');
const subsystemOffset = pe + 4 + 20 + 68;
exe.writeUInt16LE(2, subsystemOffset);
fs.writeFileSync(EXE, exe);

// Same file name as the previous build: make Explorer show the new icon.
if (process.platform === 'win32') {
  const { refreshIcons } = await import('../src/app/system.js');
  await refreshIcons([EXE]).catch(() => {});
}

const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`Done: ${EXE} (${mb} MB)`);

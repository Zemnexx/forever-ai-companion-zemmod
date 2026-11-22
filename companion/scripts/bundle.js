// Bundles the app into one CommonJS file with every asset embedded (the
// addon, the window, the guides, the icons...), so the packaged app is
// self-contained. Used by build.js.
import path from 'node:path';
import { build } from 'esbuild';
import { ROOT } from '../src/config.js';
import { GUIDE_FILES, addonFiles, armoryFiles, appIconIco, appIconPng, foreverGuide, knowledgeReadme, micCsSource, sampleContext, trayCsSource, ttsEngineSource, uiHtml } from '../src/assets.js';

export async function bundleApp(outfile) {
  // Replace src/assets.js with a module that has every file embedded.
  const embedded = `
const ADDON = ${JSON.stringify(addonFiles())};
const ARMORY = ${JSON.stringify(armoryFiles())};
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
export const GUIDE_FILES = ${JSON.stringify(GUIDE_FILES)};
const GUIDES = ${JSON.stringify(Object.fromEntries(GUIDE_FILES.map((f) => [f, foreverGuide(f)])))};
export const foreverGuide = (file = 'wow-forever.md') => GUIDES[file] || '';
export const ttsEngineSource = () => TTS;
export const addonFiles = () => ({ ...ADDON });
export const armoryFiles = () => ({ ...ARMORY });
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
  await build({
    entryPoints: [path.join(ROOT, 'src', 'app', 'main.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    plugins: [embedAssets],
    define: { 'import.meta.url': '__faic_import_meta_url' },
    banner: { js: 'const __faic_import_meta_url = require("url").pathToFileURL(__filename).href;' },
    logLevel: 'warning',
  });
}

// Local web server for the app window. Listens on 127.0.0.1 only.
// Protection against other websites poking at it:
//  - the Host header must be our own address (blocks DNS rebinding);
//  - every POST needs the X-Forever-AI-Companion header, which a cross-site
//    page can only send after a CORS preflight that we never approve.
import http from 'node:http';
import { appIconPng, uiHtml } from '../assets.js';
import { APP_ID, LEGACY_NAME } from '../config.js';

export const BASE_PORT = 47365;
export const PORT_RANGE = 10;
const HEADER = 'x-forever-ai-companion';
// Copies from before the rename answer /api/ping with the previous name and
// expect the previous header: still recognized, to close them when updating.
const LEGACY_HEADER = `x-${LEGACY_NAME.toLowerCase()}`;

export function createServer(controller, { onQuit = () => {}, onWindowClosed = () => {}, closeDelayMs = 1000, log = () => {} } = {}) {
  // Open windows: each one has an id and asks for the status every 2 s.
  // When one closes, the app is "closed" unless another window was active in
  // the last moments or a new one appears right away (a reload).
  const pages = new Map(); // id -> last time seen
  const ALIVE_MS = 2600;
  const html = uiHtml();
  const icon = appIconPng();
  const actions = {
    'detect-wow': () => controller.detectWow(),
    'pick-wow': () => controller.pickWow(),
    'install-addon': () => controller.installAddon(),
    'set-ai': (body) => controller.setAI(body),
    'test-ai': () => controller.testAI(),
    autostart: (body) => controller.setAutostart(body),
    'claude-status': () => controller.claudeStatus(),
    'voice-status': () => controller.voiceStatus(),
    'voice-install': () => controller.installVoice(),
    'voice-uninstall': () => controller.uninstallVoice(),
    'claude-install': () => controller.claudeInstall(),
    'claude-login': () => controller.claudeLogin(),
    'codex-status': () => controller.codexStatus(),
    'codex-install': () => controller.codexInstall(),
    'codex-login': () => controller.codexLogin(),
    'codex-pick': () => controller.codexPick(),
    'codex-search': () => controller.codexSearch(),
    'guide-check': () => controller.checkGuide(),
    'update-check': () => controller.checkUpdate(),
    'update-install': () => controller.installUpdate(),
    knowledge: () => controller.openKnowledge(),
    'close-action': (body) => controller.setCloseAction(body),
    'web-search': (body) => controller.setWebSearch(body),
    'talk-status': () => controller.talkStatus(),
    'set-talk': (body) => controller.setTalk(body),
    'talk-test': () => controller.talkTest(),
    'armory-install': () => controller.installArmory(),
    'armory-uninstall': () => controller.uninstallArmory(),
    'set-armory': (body) => controller.setArmory(body),
    'window-closed': (body) => {
      const closedAt = Date.now();
      pages.delete(String(body?.page || ''));
      setTimeout(() => {
        for (const [id, seen] of pages) {
          if (seen > closedAt - ALIVE_MS) return; // another window, or the reloaded page
          pages.delete(id);
        }
        onWindowClosed();
      }, closeDelayMs);
      return {};
    },
    quit: () => { setTimeout(onQuit, 200); return {}; },
    uninstall: async () => { await controller.uninstall(); setTimeout(onQuit, 300); return {}; },
  };

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/') return send(200, html, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/icon.png') return send(200, icon, 'image/png');
      if (req.method === 'GET' && url.pathname === '/api/ping') return send(200, { app: APP_ID });
      if (req.method === 'GET' && url.pathname === '/api/status') {
        pages.set(url.searchParams.get('page') || 'unknown', Date.now());
        return send(200, await controller.status());
      }

      const m = url.pathname.match(/^\/api\/([a-z-]+)$/);
      if (req.method === 'POST' && m && actions[m[1]]) {
        // (An app window left open from before the rename sends the old header.)
        if (req.headers[HEADER] !== '1' && req.headers[LEGACY_HEADER] !== '1') return send(403, { error: 'forbidden' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 100000) throw new Error('Request too large');
        }
        const body = raw ? JSON.parse(raw) : {};
        return send(200, await actions[m[1]](body));
      }
      send(404, { error: 'not found' });
    } catch (e) {
      log(`Error en ${req.url}: ${e.message}`);
      send(400, { error: e.message });
    }
  });
  return server;
}

export function listen(server) {
  return new Promise((resolve, reject) => {
    let port = BASE_PORT;
    const attempt = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && port < BASE_PORT + PORT_RANGE - 1) { port++; attempt(); }
        else reject(e);
      });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    attempt();
  });
}

// Finds an already running copy of the app (this version or one from before
// the rename). Returns { url, legacy } or null.
export async function findRunning() {
  for (let port = BASE_PORT; port < BASE_PORT + PORT_RANGE; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(500) });
      const json = await res.json();
      if (json.app === APP_ID || json.app === LEGACY_NAME) {
        return { url: `http://127.0.0.1:${port}/`, legacy: json.app === LEGACY_NAME };
      }
    } catch { /* not here */ }
  }
  return null;
}

// URL of a running copy of the app, or null.
export async function findRunningInstance() {
  return (await findRunning())?.url || null;
}

export async function quitRunningInstance(url) {
  try {
    await fetch(`${url}api/quit`, {
      method: 'POST', headers: { [HEADER]: '1', [LEGACY_HEADER]: '1' }, signal: AbortSignal.timeout(2000),
    });
  } catch { /* already gone */ }
  for (let i = 0; i < 20; i++) {
    if (!(await findRunningInstance())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

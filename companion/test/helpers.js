// Test helpers: render a grid like the game would, encode PNG/TGA, run Lua.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { ADDON_SRC } from '../src/config.js';

const require = createRequire(import.meta.url);
const LEVELS = [0, 85, 170, 255];

// Renders cells (flat array of 6-bit symbols, W x H) at a fractional pitch
// over a busy background, with optional noise, like a real screenshot.
export function renderGrid(W, H, cells, { pitch = 6, noise = 0, width, height, seed = 1, levels = LEVELS } = {}) {
  width = width ?? Math.ceil(W * pitch) + 80;
  height = height ?? Math.ceil(H * pitch) + 60;
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = Math.floor(x / pitch);
      const r = Math.floor(y / pitch);
      let rgb;
      if (c < W && r < H) {
        const v = cells[r * W + c];
        rgb = [levels[(v >> 4) & 3], levels[(v >> 2) & 3], levels[v & 3]];
      } else {
        rgb = [(x * 7 + y * 3) % 256, (x * 13) % 256, (y * 5) % 256]; // "game world"
      }
      const i = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const n = noise ? Math.round((rand() * 2 - 1) * noise) : 0;
        data[i + ch] = Math.max(0, Math.min(255, rgb[ch] + n));
      }
    }
  }
  return { width, height, channels: 3, data };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodePNG({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    // Mix filters to exercise the decoder (0 = None, 1 = Sub, 2 = Up).
    const f = y % 3;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = data[y * stride + x];
      const left = x >= 3 ? data[y * stride + x - 3] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      raw[y * (stride + 1) + 1 + x] = (cur - (f === 1 ? left : f === 2 ? up : 0)) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodeTGA({ width, height, data }) {
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24; // bottom-up
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = ((height - 1 - y) * width + x) * 3;
      px[d] = data[s + 2]; px[d + 1] = data[s + 1]; px[d + 2] = data[s];
    }
  }
  return Buffer.concat([header, px]);
}

// Runs Lua (5.3, via fengari) with the addon files loaded into `ns`.
// `globals` are injected as Lua strings; returns the global RESULT as a string.
export function runLua(script, globals = {}, addonFiles = ['Json.lua', 'Uplink.lua'], prelude = '') {
  const { lua, lauxlib, lualib, to_luastring } = require('fengari');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const setStr = (name, value) => {
    lua.lua_pushstring(L, to_luastring(value));
    lua.lua_setglobal(L, to_luastring(name));
  };
  addonFiles.forEach((f, i) => setStr(`SRC_${i}`, fs.readFileSync(path.join(ADDON_SRC, f), 'utf8')));
  for (const [k, v] of Object.entries(globals)) setStr(k, v);
  // WoW's bit library (32-bit, results 0..2^32-1), which Lua 5.3 doesn't have.
  // fengari's integers are 32-bit and signed, so values are wrapped first.
  const bitLib = `
    if not bit then
      local function i(x) x = x % 4294967296; if x >= 2147483648 then x = x - 4294967296 end; return math.tointeger(x) end
      local function u(x) return x % 4294967296 end
      bit = {
        band = function(a, b) return u(i(a) & i(b)) end,
        bor = function(a, b) return u(i(a) | i(b)) end,
        bxor = function(a, b) return u(i(a) ~ i(b)) end,
        bnot = function(a) return u(~i(a)) end,
        rshift = function(a, n) return u(i(a) >> n) end,
        lshift = function(a, n) return u(i(a) << n) end,
      }
    end`;
  const harness = `
    ${bitLib}
    ${prelude}
    ns = {}
    for i = 0, ${addonFiles.length - 1} do
      local f = assert(load(_G["SRC_" .. i], "addon" .. i))
      f("ForeverAICompanion", ns)
    end
    ${script}`;
  const status = lauxlib.luaL_dostring(L, to_luastring(harness));
  if (status !== 0) throw new Error(lua.lua_tojsstring(L, -1));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return lua.lua_tojsstring(L, -1);
}

// Only compiles a chunk; returns null or the syntax error.
export function luaSyntaxError(source, name) {
  const { lua, lauxlib, lualib, to_luastring } = require('fengari');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const status = lauxlib.luaL_loadbuffer(L, to_luastring(source), null, to_luastring(name));
  return status === 0 ? null : lua.lua_tojsstring(L, -1);
}

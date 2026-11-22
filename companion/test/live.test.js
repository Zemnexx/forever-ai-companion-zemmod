// The way back from the app as the addon runs it: Live.lua and Plugins.lua,
// the real files, in a simulated game with a clock, tickers and sound files
// that play or not as the app would have written them (a beat that switches
// every 3 seconds, a bell per answer). What is checked is the waiting itself:
// that an answer is picked up when its bell rings, also after the plugin gave
// up waiting, and that nothing going wrong inside a tick stops the ticking.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ADDON_SRC } from '../src/config.js';

const require = createRequire(import.meta.url);

function game(script) {
  const { lua, lauxlib, lualib, to_luastring } = require('fengari');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  for (const name of ['Locale', 'Live', 'Plugins']) {
    lua.lua_pushstring(L, to_luastring(fs.readFileSync(path.join(ADDON_SRC, `${name}.lua`), 'utf8')));
    lua.lua_setglobal(L, to_luastring(`SRC_${name.toUpperCase()}`));
  }
  const code = `
    NOW, OUT = 0, {}
    function SAY(s) OUT[#OUT + 1] = string.format("%d %s", NOW, s) end
    GetTime = function() return NOW end
    time = function() return 1700000000 + math.floor(NOW) end
    TICKERS = {}
    C_Timer = {
      -- As the game does it: a ticker whose function fails is not called again.
      NewTicker = function(every, fn) TICKERS[#TICKERS + 1] = { every = every, fn = fn, at = NOW + every } return {} end,
      After = function() end,
    }
    RUNG, APP_OPEN = {}, true
    PlaySoundFile = function(file)
      local name = file:match("sig\\\\(.-)%.wav$")
      local plays = name == "ok" or name == "st" or (tonumber(name) and RUNG[tonumber(name)] == true)
      if name == "beat1" or name == "beat2" then plays = APP_OPEN and name == ((math.floor(NOW / 3) % 2 == 0) and "beat1" or "beat2") end
      if plays then return true, 1 end
      return false
    end
    StopSound = function() end
    LOADED = {}
    C_AddOns = {
      LoadAddOn = function(name) LOADED[name] = true ForeverAICompanion_Inbox = INBOX SAY("mailbox") return true end,
      IsAddOnLoaded = function(name) return LOADED[name] == true end,
    }
    ns = { db = {} }
    ns.UI = { IsShown = function() return false end, RefreshStatusBar = function() end, SetStatus = function() end, Refresh = function() end }
    ns.Core = {
      HasPending = function() return ns.Plugins:HasPending() end,
      ApplyInbox = function(_, inbox) if ns.Plugins:ApplyInbox(inbox, {}) > 0 then ns.Live:OnAnswer() end end,
    }
    ns.Voice = {}
    assert(load(SRC_LOCALE, "@Locale.lua"))("ForeverAICompanion", ns)
    assert(load(SRC_LIVE, "@Live.lua"))("ForeverAICompanion", ns)
    assert(load(SRC_PLUGINS, "@Plugins.lua"))("ForeverAICompanion", ns)
    function ADVANCE(seconds)
      local stop = NOW + seconds
      while NOW < stop do
        NOW = NOW + 0.5
        for _, t in ipairs(TICKERS) do
          while not t.dead and t.at <= NOW do
            t.at = t.at + t.every
            if not pcall(t.fn) then t.dead = true SAY("a ticker died") end
          end
        end
      end
    end
    ns.Plugins:Register("armory", { onResult = function(r)
      SAY(string.format("result %s ok=%s late=%s timedOut=%s", tostring(r.kind), tostring(r.ok), tostring(r.late), tostring(r.timedOut)))
    end })
    ${script}
    RESULT = table.concat(OUT, "\\n")`;
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error(lua.lua_tojsstring(L, -1));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return lua.lua_tojsstring(L, -1).split('\n');
}

test('an answer is picked up when its bell rings, and the app is seen as ready', () => {
  const out = game(`
    ns.db.nextSig = 7
    ns.db.plugins = { pending = { a1 = { name = "armory", kind = "talents", t = time(), timeout = 1260 } }, held = {} }
    INBOX = { answers = {} }
    ns.Live:Init()
    ns.Live:OnSent(true)
    ns.Plugins:Watch("armory", true)
    ADVANCE(8)
    SAY("app " .. ForeverAICompanionAPI.AppState())
    ADVANCE(200)
    INBOX = { answers = { { id = "a1", ok = true, answer = "Build.", data = { kind = "talents" } } } }
    RUNG[7] = true
    SAY("the app answers")
    ADVANCE(4)
    SAY("bell " .. ns.db.nextSig)`);
  assert.deepEqual(out, ['0 mailbox', '8 app ready', '208 the app answers', '210 mailbox', '210 result talents ok=true late=nil timedOut=nil', '212 bell 8'],
    'one mailbox at login for what may have been answered meanwhile, then none until the bell');
});

test('an answer that comes after the plugin gave up waiting is still delivered', () => {
  const out = game(`
    ns.db.nextSig = 3
    ns.db.plugins = { pending = { a2 = { name = "armory", kind = "gear", t = time(), timeout = 420 } }, held = {} }
    INBOX = { answers = {} }
    ns.Live:Init()
    ns.Live:OnSent(true)
    ADVANCE(540)
    INBOX = { answers = { { id = "a2", ok = true, answer = "Plan.", data = { kind = "gear" } } } }
    RUNG[3] = true
    SAY("the app answers")
    ADVANCE(4)`);
  assert.deepEqual(out.filter((l) => !/mailbox/.test(l)), ['422 result gear ok=false late=nil timedOut=true', '540 the app answers', '542 result gear ok=true late=true timedOut=nil']);
});

test('a tick that fails does not stop the ticking, and the diagnosis says what happened', () => {
  const out = game(`
    ns.db.nextSig = 5
    ns.db.plugins = { pending = { a3 = { name = "armory", kind = "gear", t = time(), timeout = 1260 } }, held = {} }
    INBOX = { answers = {} }
    ns.Live:Init()
    ns.Live:OnSent(true)
    ns.Plugins:Watch("armory", true)
    ADVANCE(10)
    -- Something breaks inside a tick, once.
    local real, broke = ns.Core.HasPending, false
    ns.Core.HasPending = function(...) if not broke then broke = true error("boom") end return real(...) end
    ADVANCE(6)
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end
    INBOX = { answers = { { id = "a3", ok = true, answer = "Plan.", data = { kind = "gear" } } } }
    RUNG[5] = true
    ADVANCE(4)`);
  const text = out.join('\n');
  assert.doesNotMatch(text, /a ticker died/);
  assert.match(text, /answers: sound on, waiting for bell 5 of 500 \(not rung yet\), mailboxes opened 1 of 50/);
  assert.match(text, /timers: last tick 0s ago/);
  assert.match(text, /app: ready, beat \d, seen switching true, last check 0s ago/);
  assert.match(text, /transport error: tick: .*boom/);
  assert.match(text, /waiting for armory gear: sent 16s ago, waits 1260s/);
  assert.match(text, /18 result gear ok=true/, 'the answer still arrives');
});

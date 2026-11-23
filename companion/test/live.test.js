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

// lenient: a game that says yes to playing any file that exists (a Mac, and
// WoW Forever 1.60.1 on Windows); canCheckLater: it has C_Sound.IsPlaying.
// deaf: what the live client seems to do: once it has looked at a sound file
// in a session, it goes on answering the same for it, so a bell the app rings
// after the first check is never heard.
function game(script, { lenient = false, canCheckLater = true, deaf = false } = {}) {
  const { lua, lauxlib, lualib, to_luastring } = require('fengari');
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  for (const name of ['Locale', 'Live', 'Plugins']) {
    lua.lua_pushstring(L, to_luastring(fs.readFileSync(path.join(ADDON_SRC, `${name}.lua`), 'utf8')));
    lua.lua_setglobal(L, to_luastring(`SRC_${name.toUpperCase()}`));
  }
  const code = `
    NOW, OUT = 0, {}
    function SAY(s) OUT[#OUT + 1] = string.format("%d %s", math.floor(NOW), s) end
    GetTime = function() return NOW end
    time = function() return 1700000000 + math.floor(NOW) end
    TICKERS = {}
    C_Timer = {
      -- As the game does it: a ticker whose function fails is not called again.
      NewTicker = function(every, fn) TICKERS[#TICKERS + 1] = { every = every, fn = fn, at = NOW + every } return {} end,
      After = function(seconds, fn) AFTERS[#AFTERS + 1] = { at = NOW + seconds, fn = fn } end,
    }
    AFTERS = {}
    RUNG, APP_OPEN = {}, true
    local really
    local FROZEN = {}
    local function heard(file)
      if not ${deaf} then return really(file) end
      if FROZEN[file] == nil then FROZEN[file] = really(file) end
      return FROZEN[file]
    end
    function really(file)
      local name = file:match("sig\\\\(.-)%.wav$")
      if name == "beat1" or name == "beat2" then
        -- BEATS(name): a test's own idea of what the game plays.
        if BEATS then return BEATS(name) end
        return APP_OPEN and name == ((math.floor(NOW / 3) % 2 == 0) and "beat1" or "beat2")
      end
      return name == "ok" or name == "st" or (tonumber(name) ~= nil and RUNG[tonumber(name)] == true)
    end
    HANDLES, PLAYED = {}, 0
    PlaySoundFile = function(file)
      PLAYED = PLAYED + 1
      if ${lenient} then
        -- Yes to anything; whether it really plays shows a moment later.
        HANDLES[PLAYED] = heard(file)
        return true, PLAYED
      end
      if heard(file) then return true, PLAYED end
      return false
    end
    if ${lenient && canCheckLater} then C_Sound = { IsPlaying = function(handle) return HANDLES[handle] == true end } end
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
        local due = AFTERS
        AFTERS = {}
        for _, a in ipairs(due) do
          if a.at <= NOW then a.fn() else AFTERS[#AFTERS + 1] = a end
        end
        for _, t in ipairs(TICKERS) do
          while not t.dead and t.at <= NOW do
            t.at = t.at + t.every
            if not pcall(t.fn) then t.dead = true SAY("a ticker died") end
          end
        end
      end
    end
    -- The app's side, for the tests that need it: SEND stores a request as
    -- Plugins:Request does (with the bell it asks for), ANSWER publishes the
    -- answer and rings max(the app's counter, the request's bell), as
    -- watcher.js does.
    APP, REQS, ANSWERS = { sig = 1 }, {}, {}
    function SEND(id, kind, timeout)
      local sig, _, round = ns.Live:RequestFields()
      ns.db.plugins = ns.db.plugins or { pending = {}, held = {} }
      ns.db.plugins.pending[id] = { name = "armory", kind = kind, t = time(), timeout = timeout or 1260, sig = sig, sigRound = round }
      REQS[id] = sig
      ns.Live:OnSent(true)
    end
    function ANSWER(id, kind)
      ANSWERS[#ANSWERS + 1] = { id = id, ok = true, answer = "Done.", data = { kind = kind } }
      INBOX = { updated = time(), answers = ANSWERS }
      APP.sig = math.max(APP.sig, REQS[id])
      RUNG[APP.sig] = true
      APP.rang, APP.sig = APP.sig, APP.sig + 1
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
  assert.match(text, /answers: sound on, bells taken at the game's word, waiting for bell 5 of 500 \(not rung yet\), mailboxes opened 1 of 50/);
  assert.match(text, /timers: last tick 0s ago/);
  assert.match(text, /app: ready, beat \d, seen switching true, last check 0s ago/);
  assert.match(text, /transport error: tick: .*boom/);
  assert.match(text, /waiting for armory gear: sent 16s ago, waits 1260s/);
  assert.match(text, /18 result gear ok=true/, 'the answer still arrives');
});

// WoW Forever 1.60.1 on Windows (and any Mac): PlaySoundFile says yes to an
// empty file. Taken at its word, every bell had "rung" at login (the addon
// waited for bell 501 of 500) and both beats "played" (app status unknown),
// so answers came only by the timer, and never once the wait was over.
test('a game that says yes to every sound file is found out, and the files are checked a moment later', () => {
  const out = game(`
    ns.db.nextSig = 7
    for i = 1, 6 do RUNG[i] = true end
    ns.db.plugins = { pending = { a1 = { name = "armory", kind = "gear", t = time(), timeout = 1260 } }, held = {} }
    INBOX = { answers = {} }
    ns.Live:Init()
    ns.Live:OnSent(true)
    ns.Plugins:Watch("armory", true)
    ADVANCE(10)
    SAY("bell " .. ns.db.nextSig .. " app " .. ForeverAICompanionAPI.AppState())
    SAY(ForeverAICompanionAPI.Diagnose()[1])
    ADVANCE(500)
    INBOX = { answers = { { id = "a1", ok = true, answer = "Plan.", data = { kind = "gear" } } } }
    RUNG[7] = true
    SAY("the app answers")
    ADVANCE(4)
    SAY("bell " .. ns.db.nextSig)
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end`, { lenient: true });
  const lines = out.filter((l) => !/mailbox$/.test(l));
  assert.equal(lines[0], '10 bell 7 app ready', 'no bell counted that has not rung, and the app\'s beat is seen');
  assert.match(lines[1], /bells checked a moment after playing \(this game says yes to every sound file\), waiting for bell 7 of 500, mailboxes opened 1 of 50/);
  assert.deepEqual(lines.slice(2, 5), ['510 the app answers', '512 result gear ok=true late=nil timedOut=nil', '514 bell 8'], 'picked up when the bell rings, not by the timer');
  // The mailboxes opened at login and at 5 minutes brought nothing: only the bell's counts.
  assert.ok(lines.some((l) => /^514 last answers: bell at 51[23]s \(after login\)$/.test(l)), lines.join('\n'));
  assert.equal(out.filter((l) => /mailbox$/.test(l) && !/^(0|300|512) /.test(l)).length, 0, 'one mailbox at login, the safety one at 5 minutes, and the answer\'s');
});

test('bells that such a game counted as rung are counted again', () => {
  const out = game(`
    ns.db.nextSig = 501
    for i = 1, 6 do RUNG[i] = true end
    INBOX = { answers = {} }
    ns.Live:Init()
    ADVANCE(6)
    SAY("bell " .. ns.db.nextSig)
    local sig, reset = ns.Live:RequestFields()
    SAY("a request asks for bell " .. sig .. ", start over: " .. tostring(reset))`, { lenient: true });
  assert.deepEqual(out, ['6 bell 7', '6 a request asks for bell 7, start over: nil'], 'the first silent bell, without asking the app to start them over');
});

test('such a game with no way to check later goes by the timer, and says so', () => {
  const out = game(`
    ns.db.nextSig = 3
    ns.db.plugins = { pending = { a1 = { name = "armory", kind = "gear", t = time(), timeout = 1260 } }, held = {} }
    INBOX = { answers = {} }
    ns.Live:Init()
    ns.Live:OnSent(true)
    ns.Plugins:Watch("armory", true)
    ADVANCE(60)
    SAY("app " .. ForeverAICompanionAPI.AppState())
    SAY(ForeverAICompanionAPI.Diagnose()[1])
    INBOX = { answers = { { id = "a1", ok = true, answer = "Plan.", data = { kind = "gear" } } } }
    ADVANCE(40)
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end`, { lenient: true, canCheckLater: false });
  const text = out.join('\n');
  assert.match(text, /60 app unknown/);
  assert.match(text, /bells NOT USED \(this game says yes to every sound file and cannot check later\)/);
  assert.match(text, /90 result gear ok=true/, 'the mailbox opened on the timer at 90 seconds brings it');
  assert.match(text, /last answers: timer \(no bells\) at 90s \(after login\)/);
});

test('the diagnosis says how each answer was picked up: by its bell or by a timer', () => {
  const out = game(`
    ns.db.nextSig = 7
    ns.db.plugins = { pending = { a1 = { name = "armory", kind = "talents", t = time(), timeout = 1260 } }, held = {} }
    INBOX = { answers = {} }
    ns.Live:Init()
    SAY(ForeverAICompanionAPI.Diagnose()[4])
    ns.Live:OnSent(true)
    ADVANCE(20)
    INBOX = { answers = { { id = "a1", ok = true, answer = "Build.", data = { kind = "talents" } } } }
    RUNG[7] = true
    ADVANCE(4)
    -- A second question whose bell never rings: the safety timer brings it, 5 minutes after it was sent.
    ns.db.plugins.pending.a2 = { name = "armory", kind = "gear", t = time(), timeout = 1260 }
    ns.Live:OnSent(true)
    INBOX = { answers = { { id = "a2", ok = true, answer = "Plan.", data = { kind = "gear" } } } }
    ADVANCE(302)
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end`);
  assert.ok(out.includes('0 last answers: none picked up since login'), out.join('\n'));
  assert.ok(out.includes('326 last answers: bell at 22s, timer (safety schedule) at 324s (after login)'), out.join('\n'));
});

test('the diagnosis keeps a short history of the heartbeat since login', () => {
  // The app switching as it should: many changes, the oldest left out.
  const switching = game(`
    INBOX = { answers = {} }
    ns.Live:Init()
    SAY(ForeverAICompanionAPI.Diagnose()[5])
    ns.Plugins:Watch("armory", true)
    ADVANCE(60)
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end`);
  const text = switching.join('\n');
  assert.match(text, /0 beat history: not checked since login/);
  assert.match(text, /60 beat history: ([0-3] for \d+s, ){11}[0-3] since \d+s \(\d+ earlier changes left out, 31 checks from 0s after login, the last 0s ago\)/);
  assert.match(text, /app: ready/, 'the history changes nothing in how the app is seen');

  // What the live client may be doing: once played, both beats go on playing.
  const stuck = game(`
    INBOX = { answers = {} }
    BEATS = function(name) return NOW < 7 and name == "beat1" or NOW >= 7 end
    ns.Live:Init()
    ns.Plugins:Watch("armory", true)
    ADVANCE(30)
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end`, { lenient: true });
  // Checked a moment after playing: the checks fall half a second after the ticks.
  assert.ok(stuck.some((l) => /^30 beat history: 1 for 8s, 3 since [89]s \(15 checks from [01]s after login, the last 2s ago\)$/.test(l)), stuck.join('\n'));
  assert.ok(stuck.some((l) => /^30 app: unknown, beat 3/.test(l)), stuck.join('\n'));

  const always = game(`
    INBOX = { answers = {} }
    BEATS = function() return true end
    ns.Live:Init()
    ns.Plugins:Watch("armory", true)
    ADVANCE(20)
    SAY(ForeverAICompanionAPI.Diagnose()[5])`, { lenient: true });
  assert.equal(always.length, 1);
  assert.match(always[0], /^20 beat history: always 3, never changed \(\d+ checks from [01]s after login, the last \ds ago\)$/);
});

// WoW Forever 1.60.1 on Windows, as measured there: the bell an answer rings
// is never heard (the beat stays at "both" all session too), the mailboxes
// work. Answers came only by the 5-minute safety timer.
const mailboxes = (out) => out.filter((l) => /mailbox$/.test(l)).map((l) => Number(l.split(' ')[0]));
const at = (out, re) => { const l = out.find((x) => re.test(x)); return l ? Number(l.split(' ')[0]) : null; };

test('a game that does not hear bells is found out by a timer pickup, and the next request goes by a tighter timer', () => {
  const out = game(`
    ns.db.nextSig = 3
    RUNG[1], RUNG[2] = true, true
    INBOX = { answers = {} }
    ns.Live:Init()
    SEND("a1", "talents")
    ADVANCE(240)
    ANSWER("a1", "talents")
    SAY("the app answers a1 with bell " .. APP.rang)
    ADVANCE(70)
    SAY("missed " .. tostring(ns.db.bellsMissed) .. ", waiting for bell " .. ns.db.nextSig)
    SEND("a2", "gear")
    SAY("a2 asks for bell " .. REQS.a2)
    ADVANCE(200)
    ANSWER("a2", "gear")
    SAY("the app answers a2 with bell " .. APP.rang)
    ADVANCE(80)
    SAY("waiting for bell " .. ns.db.nextSig .. ", the app rings " .. APP.sig .. " next")
    for _, line in ipairs(ForeverAICompanionAPI.Diagnose()) do SAY(line) end`, { lenient: true, deaf: true });
  const text = out.join('\n');
  assert.ok(out.includes('240 the app answers a1 with bell 3'), text);
  assert.equal(at(out, /result talents ok=true/), 300, 'the first one only by the safety timer');
  assert.ok(out.includes('310 missed true, waiting for bell 4'), 'the miss is remembered, and the bell numbering moved past the one a1 asked for');
  assert.ok(out.includes('310 a2 asks for bell 4'), text);
  assert.ok(out.includes('510 the app answers a2 with bell 4'), 'the app rings the bell the addon waits for');
  const second = at(out, /result gear ok=true/);
  assert.ok(second > 510 && second <= 572, `picked up within about a minute of the answer, not at 5 minutes: ${second}\n${text}`);
  assert.ok(out.includes('590 waiting for bell 5, the app rings 5 next'), text);
  assert.ok(text.includes('last answers: timer (safety schedule) at 300s, timer (bells not heard) at ' + second + 's (after login)'), text);
  // One for a1 at 5 minutes, then one a minute for a2: at 370, 430, 490 and 550.
  assert.deepEqual(mailboxes(out), [300, 370, 430, 490, 550]);
  assert.match(text, /590 bells: NOT HEARD by this game \(an answer came by timer after its bell had rung\), so mailboxes are opened by timer: 45 of 50 left this session/);
});

test('a game known not to hear bells starts the next session in the tighter mode', () => {
  const out = game(`
    ns.db.nextSig = 4
    ns.db.bellsMissed = true
    RUNG[1], RUNG[2], RUNG[3] = true, true, true
    APP.sig = 4
    INBOX = { answers = {} }
    ns.Live:Init()
    SAY(ForeverAICompanionAPI.Diagnose()[2])
    SEND("a1", "talents")
    ADVANCE(200)
    ANSWER("a1", "talents")
    ADVANCE(60)
    SAY("missed " .. tostring(ns.db.bellsMissed) .. ", waiting for bell " .. ns.db.nextSig)
    ADVANCE(300)
    SAY("nothing waited for")`, { lenient: true, deaf: true });
  const text = out.join('\n');
  assert.ok(out.includes('0 bells: NOT HEARD by this game (an answer came by timer after its bell had rung), so mailboxes are opened by timer: 50 of 50 left this session'), text);
  assert.equal(at(out, /result talents ok=true/), 240, text);
  assert.deepEqual(mailboxes(out), [60, 120, 180, 240], 'one a minute while waiting, none once nothing is waited for');
  assert.ok(out.includes('260 missed true, waiting for bell 5'), text);
});

test('a game that hears bells stays in normal mode, also when the timer takes an answer just before its bell is checked', () => {
  const out = game(`
    ns.db.nextSig = 3
    RUNG[1], RUNG[2] = true, true
    INBOX = { answers = {} }
    ns.Live:Init()
    SEND("a1", "talents")
    ADVANCE(240)
    ANSWER("a1", "talents")
    ADVANCE(4)
    SAY("missed " .. tostring(ns.db.bellsMissed) .. ", waiting for bell " .. ns.db.nextSig)
    -- Answered between two checks, half a second before the safety timer.
    SEND("a2", "gear")
    ADVANCE(299)
    ANSWER("a2", "gear")
    ADVANCE(10)
    SAY("missed " .. tostring(ns.db.bellsMissed) .. ", waiting for bell " .. ns.db.nextSig .. ", the app rings " .. APP.sig .. " next")`, { lenient: true });
  const text = out.join('\n');
  assert.equal(at(out, /result talents ok=true/), 242, 'by its bell');
  assert.ok(out.includes('244 missed nil, waiting for bell 4'), text);
  assert.equal(at(out, /result gear ok=true/), 544, 'taken by the safety timer before its bell was checked');
  assert.ok(out.includes('553 missed nil, waiting for bell 5, the app rings 5 next'), 'not counted as missed, and the bell is not waited for again');
  assert.deepEqual(mailboxes(out), [242, 544], 'no mailbox for the bell the timer got ahead of');
});

test('a remembered miss is forgotten once a bell brings an answer', () => {
  const out = game(`
    ns.db.nextSig = 3
    ns.db.bellsMissed = true
    RUNG[1], RUNG[2] = true, true
    INBOX = { answers = {} }
    ns.Live:Init()
    SEND("a1", "talents")
    ADVANCE(30)
    ANSWER("a1", "talents")
    ADVANCE(4)
    SAY("missed " .. tostring(ns.db.bellsMissed))
    SEND("a2", "gear")
    ADVANCE(250)
    SAY("waiting")`, { lenient: true });
  const text = out.join('\n');
  assert.equal(at(out, /result talents ok=true/), 32, text);
  assert.ok(out.includes('34 missed nil'), text);
  assert.deepEqual(mailboxes(out), [32], 'back to the safety timer: nothing at one minute');
});

test('in a game that does not hear bells, an answer that comes after the plugin gave up is picked up by a timer', () => {
  const out = game(`
    ns.db.nextSig = 3
    ns.db.bellsMissed = true
    RUNG[1], RUNG[2] = true, true
    INBOX = { answers = {} }
    ns.Live:Init()
    SEND("a1", "gear", 420)
    ADVANCE(600)
    ANSWER("a1", "gear")
    ADVANCE(200)
    SAY("waiting for bell " .. ns.db.nextSig)
    ADVANCE(1200)
    SAY("done")`, { lenient: true, deaf: true });
  const text = out.join('\n');
  assert.equal(at(out, /result gear ok=false late=nil timedOut=true/), 422, text);
  assert.equal(at(out, /result gear ok=true late=true/), 660, text);
  // A minute apart while the plugin waits, two minutes apart after it, none once the answer came.
  assert.deepEqual(mailboxes(out), [60, 120, 180, 240, 300, 360, 420, 540, 660]);
  assert.ok(out.includes('800 waiting for bell 4'), text);
});

test('the bell numbering keeps to the round it was asked in when the bells start over', () => {
  const out = game(`
    ns.db.nextSig = 498
    INBOX = { answers = {} }
    ns.Live:Init()
    SEND("old", "gear")
    ns.db.nextSig = 501
    SEND("new", "talents")
    SAY("asks for " .. REQS.new .. ", start over " .. tostring(ns.db.pendingReset))
    ANSWERS = { { id = "old", ok = true, answer = "x" }, { id = "new", ok = true, answer = "y" } }
    INBOX = { updated = time(), answers = ANSWERS }
    ns.Live:LoadNextSlot()
    SAY("waiting for bell " .. ns.db.nextSig .. ", start over " .. tostring(ns.db.pendingReset))`);
  assert.ok(out.includes('0 asks for 1, start over true'), out.join('\n'));
  assert.ok(out.includes('0 waiting for bell 2, start over nil'), 'the old round\'s bell 498 does not count: ' + out.join('\n'));
});

test('a chat question in a game known not to hear bells goes by the no-sound schedule', () => {
  const out = game(`
    ns.db.nextSig = 3
    ns.db.bellsMissed = true
    RUNG[1], RUNG[2] = true, true
    INBOX = { answers = {} }
    ns.Live:Init()
    SEND("a1", "talents")
    ns.Live:OnSent(false)
    ADVANCE(50)
    ANSWER("a1", "talents")
    ADVANCE(40)`, { lenient: true, deaf: true });
  assert.deepEqual(mailboxes(out), [8, 20, 40, 76], out.join('\n'));
  assert.equal(at(out, /result talents ok=true/), 76);
});

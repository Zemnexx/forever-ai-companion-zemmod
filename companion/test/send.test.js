// Runs the whole in-game send path (Core:Ask -> Collect -> Json -> Uplink:Send
// -> Draw -> Screenshot) against a fake WoW UI, then renders the textures the
// addon created and checks the companion can decode them.
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ADDON_SRC } from '../src/config.js';
import { runLua, encodePNG } from './helpers.js';
import { decodeImage } from '../src/image.js';
import { decodeGrid } from '../src/grid.js';

const FAKE_UI = `
  local function noop() end
  local function newRegion(kind, parent)
    local r = { kind = kind, parent = parent, shown = true, points = {}, w = 0, h = 0, alpha = 1, scripts = {} }
    local mt = { __index = function(t, k)
      if k == "SetPoint" then return function(self, p, rel, rp, x, y) self.x, self.y = x or 0, y or 0; self.anchored = true end end
      if k == "SetAllPoints" then return function(self) self.anchored = true end end
      if k == "SetSize" then return function(self, w, h) self.w, self.h = w, h end end
      if k == "Show" then return function(self) self.shown = true end end
      if k == "Hide" then return function(self) self.shown = false end end
      if k == "IsShown" then return function(self) return self.shown end end
      if k == "SetShown" then return function(self, v) self.shown = v end end
      if k == "SetColorTexture" then return function(self, r, g, b) self.color = { r, g, b } end end
      if k == "SetBackdropColor" then return function(self, r, g, b, a) self.bg = { r, g, b, a } end end
      if k == "SetBackdropBorderColor" then return function(self, r, g, b, a) self.edge = { r, g, b, a } end end
      if k == "SetTextColor" then return function(self, r, g, b) self.textColor = { r, g, b } end end
      if k == "CreateTexture" then return function(self) local t = newRegion("Texture", self); TEXTURES[#TEXTURES + 1] = t; return t end end
      if k == "CreateFontString" then return function(self) return newRegion("FontString", self) end end
      if k == "SetScript" then return function(self, name, fn) self.scripts[name] = fn end end
      if k == "GetScript" then return function(self, name) return self.scripts[name] end end
      if k == "GetHeight" then return function(self) return self.h end end
      if k == "GetWidth" then return function(self) return self.w end end
      if k == "SetWidth" then return function(self, v) self.w = v end end
      if k == "SetHeight" then return function(self, v) self.h = v end end
      if k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function() return 100 end end
      if k == "IsMouseOver" then return function() return false end end
      if k == "IsEnabled" then return function() return true end end
      if k == "HookScript" then return function(self, name, fn)
        local prev = self.scripts[name]
        self.scripts[name] = function(...) if prev then prev(...) end fn(...) end
      end end
      if k == "GetAlpha" then return function(self) return self.alpha end end
      if k == "SetAlpha" then return function(self, a) self.alpha = a end end
      if k == "GetText" then return function() return "" end end
      if k == "GetStringHeight" then return function() return 10 end end
      if k == "GetVerticalScrollRange" then return function() return 0 end end
      return noop
    end }
    return setmetatable(r, mt)
  end
  TEXTURES = {}
  FRAMES = {}
  CreateFrame = function(kind, name, parent)
    local f = newRegion(kind, parent)
    FRAMES[#FRAMES + 1] = f
    if name then _G[name] = f end
    return f
  end
  CreateFont = function() return newRegion("Font") end
  WorldFrame = newRegion("Frame"); WorldFrame.h = 768
  UIParent = newRegion("Frame"); UIParent.h = 768
  GetPhysicalScreenSize = function() return 2560, 1440 end
  local cvars = { screenshotFormat = "jpeg", screenshotQuality = "3" }
  GetCVar = function(k) return cvars[k] end
  SetCVar = function(k, v) cvars[k] = v end
  NOW = 100
  GetTime = function() return NOW end
  time = os.time
  SHOTS = 0
  Screenshot = function() SHOTS = SHOTS + 1 end
  GetLocale = function() return LOCALE or "enUS" end
  InCombatLockdown = function() return false end
  UnitAffectingCombat = function() return false end
  strtrim = function(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end
  print = function() end
  C_Timer = { After = function(_, fn) end, NewTicker = function() end }
  PlaySoundFile = function() return false end
  UISpecialFrames = {}
  tinsert = table.insert
  SlashCmdList = {}
  date = os.date
  UnitName = function() return "Sharp" end
  UnitLevel = function() return 33 end
  UnitClass = function() return "Cazadora", "HUNTER" end
  UnitRace = function() return "Enana" end
  UnitExists = function(u) return u == "player" end
  GetRealmName = function() return "Forever" end
  GetInventoryItemLink = function() return nil end
  C_QuestLog = {
    GetNumQuestLogEntries = function() return 30 end,
    GetInfo = function(i) return { title = "Misión " .. i .. " con un nombre bastante largo", level = 30, questID = 1000 + i } end,
    GetQuestObjectives = function() return { { text = "Algo: 3/10", finished = false } } end,
  }
  GetQuestLogQuestText = function() return "d", "Mata 10 cosas y vuelve con el explorador en el campamento." end
`;

// Lua helpers: start the addon, ask, and dump what is on screen right away.
const PRELUDE_DRIVE = `
  function START()
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then
        f.scripts.OnEvent(f, "ADDON_LOADED", "ForeverAICompanion")
        f.scripts.OnEvent(f, "PLAYER_LOGIN")
      end
    end
  end
  function RUN_FRAMES(n)
    for i = 1, n do
      for _, f in ipairs(FRAMES) do
        if f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end
      end
      NOW = NOW + 0.016
    end
  end
  -- Fake profiler clock: every call costs 0.5 ms, so a 4 ms budget is ~8 steps.
  local fakeMs = 0
  debugprofilestop = function() fakeMs = fakeMs + 0.5; return fakeMs end
  function FIRE(event, ...)
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end
    end
  end
  -- Asks and runs frames until the strip appears. Returns the dump and frame count.
  function ASK(q)
    ns.Core:Ask(q)
    for i = 1, 2000 do
      if ns.Uplink.grid and ns.Uplink.grid.shown then return DUMP(), i - 1 end
      RUN_FRAMES(1)
    end
    return DUMP(), -1
  end
  function DUMP()
    local grid = ns.Uplink.grid
    local out = {}
    for _, t in ipairs(TEXTURES) do
      if t.parent == grid and t.shown and rawget(t, "color") and rawget(t, "x") then
        out[#out + 1] = string.format("%.4f,%.4f,%.4f,%d,%d,%d", t.x, -t.y, t.w,
          math.floor(t.color[1] * 255 + 0.5), math.floor(t.color[2] * 255 + 0.5), math.floor(t.color[3] * 255 + 0.5))
      end
    end
    return tostring(grid.shown) .. ";" .. grid.w .. "," .. grid.h .. ";" .. table.concat(out, "|")
  end
`;

const FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Core.lua'];

// Renders a DUMP() like the screen would show it (UIParent: 768 units = 1440 px)
// and decodes it with the companion's decoder.
function decodeDump(dump) {
  const [shown, size, texList] = dump.split(';');
  assert.equal(shown, 'true', 'strip should be visible right after asking');
  const scale = 1440 / 768;
  const [gw, gh] = size.split(',').map(Number);
  const width = 2560, height = 160;
  assert.ok(gh * scale <= height, `strip too tall: ${gh * scale}px`);
  const data = Buffer.alloc(width * height * 3, 200); // bright game scene behind
  for (const t of texList.split('|')) {
    const [x, y, w, r, g, b] = t.split(',').map(Number);
    const x0 = Math.round(x * scale), y0 = Math.round(y * scale);
    const x1 = Math.round((x + w) * scale), y1 = Math.round((y + w) * scale);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * width + xx) * 3;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  const payload = decodeGrid({ width, height, channels: 3, data });
  assert.ok(payload, 'strip not found');
  return { req: JSON.parse(payload.toString('utf8')), stripPx: Math.round(gh * scale) };
}

test('asking shows a thin strip (no screenshot, UI untouched) that decodes', () => {
  const out = runLua(`
    START()
    local first, frames = ASK("test")
    RUN_FRAMES(40)
    RESULT = first .. "#" .. frames .. ";" .. SHOTS .. ";" .. tostring(ns.Uplink.grid.shown) .. ";" .. tostring(ns.Uplink.busy) .. ";" .. UIParent.alpha
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [dump, after] = out.split('#');
  const [frames, shots, shownAfter, busy, alpha] = after.split(';');
  assert.ok(Number(frames) > 1, `preparation should be spread over several frames (took ${frames})`);
  assert.equal(shots, '0', 'no Screenshot() any more');
  assert.equal(alpha, '1', 'UI must not be hidden');
  assert.equal(shownAfter, 'false', 'strip disappears afterwards');
  assert.equal(busy, 'false');
  const { req, stripPx } = decodeDump(dump);
  assert.equal(req.question, 'test');
  assert.equal(req.context.quests.length, 30);
  assert.ok(stripPx <= 60, `strip is ${stripPx}px tall`);
});

test('second question only sends what changed (after the first was answered)', () => {
  const out = runLua(`
    START()
    local first = ASK("primera")
    RUN_FRAMES(40)
    -- the companion answers the first question
    local msgs = ns.Chats:Current().messages; local id = msgs[#msgs].id
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "ok" } } })
    -- one quest changes, everything else stays the same
    C_QuestLog.GetQuestObjectives = function(qid)
      if qid == 1005 then return { { text = "Algo: 4/10", finished = false } } end
      return { { text = "Algo: 3/10", finished = false } }
    end
    FIRE("QUEST_LOG_UPDATE")
    local second = ASK("segunda")
    RESULT = first .. "#" .. second
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [d1, d2] = out.split('#');
  const first = decodeDump(d1).req;
  const second = decodeDump(d2);
  assert.ok(first.hashes.character && first.hashes.quests);
  assert.deepEqual(Object.keys(second.req.same).sort(), Object.keys(first.hashes).filter((k) => k !== 'quests').sort());
  assert.ok(second.req.context.quests, 'changed section is sent');
  assert.equal(second.req.context.character, undefined, 'unchanged section is not sent');
  assert.ok(JSON.stringify(second.req).length < JSON.stringify(first).length);
});

test('/ia probar-canales runs every probe, undoes it and reports through the strip', () => {
  const probeApis = `
    CALLS = {}
    local function rec(name) return function(...) CALLS[#CALLS + 1] = name; return true end end
    TIMERS = {}
    C_Timer.After = function(d, fn) TIMERS[#TIMERS + 1] = { d = d, fn = fn } end
    function RUN_TIMERS(max)
      local list = TIMERS; TIMERS = {}
      for _, t in ipairs(list) do if t.d <= max then t.fn() else TIMERS[#TIMERS + 1] = t end end
    end
    function UNTIL_STRIP()
      for i = 1, 2000 do
        if ns.Uplink.grid and ns.Uplink.grid.shown then return end
        RUN_FRAMES(1)
      end
    end
    function UNTIL_SENT()
      for i = 1, 4000 do
        if not ns.Uplink.busy and not ns.Core.working then return end
        RUN_FRAMES(1)
      end
    end
    RegisterCVar = rec("RegisterCVar")
    SetCVar = function(k, v) CALLS[#CALLS + 1] = "SetCVar:" .. k .. "=" .. tostring(v) end
    C_AddOns = { DisableAddOn = rec("DisableAddOn"), EnableAddOn = rec("EnableAddOn"), SaveAddOns = rec("SaveAddOns"),
                 IsAddOnLoaded = function() return false end, LoadAddOn = function() return false, "MISSING" end }
    GetMacroIndexByName = function() return 0 end
    CreateMacro = rec("CreateMacro")
    local logging = false
    LoggingChat = function(v) if v ~= nil then logging = v end; return logging end
    C_ChatInfo = { RegisterAddonMessagePrefix = rec("RegisterPrefix"), SendAddonMessage = rec("SendAddonMessage") }
    C_VoiceChat = { GetTtsVoices = function() return { { voiceID = 0, name = "Microsoft Helena Desktop" } } end,
                    SpeakText = rec("SpeakText") }
    FlashClientIcon = function() end
  `;
  const out = runLua(`
    START()
    -- 1. The addon asks the app to start recording, and probes nothing yet.
    ns.Probe:Run()
    UNTIL_STRIP()
    local start = DUMP()
    local before = #CALLS
    UNTIL_SENT()
    -- 2. The app answers (it is recording): the probes run, then the report is sent.
    ns.Core:ApplyInbox({ answers = { { id = ns.Probe.waiting.id, ok = true, answer = "Recording." } } })
    RUN_TIMERS(25)
    UNTIL_STRIP()
    RESULT = start .. "#" .. before .. "#" .. DUMP() .. "#" .. table.concat(CALLS, ",") .. "#" .. tostring(LoggingChat())
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE + probeApis);
  const [startDump, callsBeforeAnswer, dump, calls, loggingAfter] = out.split('#');
  const start = decodeDump(startDump).req;
  assert.match(start.probeStart, /^\d+$/);
  assert.equal(start.probe, undefined);
  assert.equal(callsBeforeAnswer, '0', 'nothing is probed before the app is recording');
  for (const c of ['SetCVar:faicProbe=FAIC-PROBE-', 'DisableAddOn', 'SaveAddOns', 'CreateMacro', 'SendAddonMessage', 'SpeakText', 'EnableAddOn', 'SetCVar:faicProbe=']) {
    assert.ok(calls.includes(c), `missing ${c} in ${calls}`);
  }
  assert.equal(loggingAfter, 'false', 'chat logging restored');
  const { req } = decodeDump(dump);
  assert.equal(req.question, 'Invisible channel test');
  assert.equal(req.probe.results.cvar, 'ok');
  assert.equal(req.probe.results.addons, 'ok');
  assert.equal(req.probe.ttsVoices[0].name, 'Microsoft Helena Desktop');
  assert.match(req.probe.token, /^\d+$/);
  assert.equal(req.probe.token, start.probeStart, 'same test');
});

test('/ia probe gives up when the app never starts recording', () => {
  const out = runLua(`
    TIMERS = {}
    C_Timer.After = function(d, fn) TIMERS[#TIMERS + 1] = { d = d, fn = fn } end
    START()
    STATUS = ""
    local setStatus = ns.UI.SetStatus
    ns.UI.SetStatus = function(self, s) STATUS = s; return setStatus(self, s) end
    ns.Probe:Run()
    for _, t in ipairs(TIMERS) do if t.d == 60 then t.fn() end end
    RESULT = tostring(ns.Probe.running) .. "#" .. STATUS
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [running, status] = out.split('#');
  assert.equal(running, 'false');
  assert.match(status, /did not answer/);
});

test('oversized requests are trimmed to the frame size limit', () => {
  const big = FAKE_UI.replace('return 30 end', 'return 120 end');
  const out = runLua(`
    START()
    ASK("grande")
    RESULT = ns.Uplink.last.bytes .. ";" .. ns.Uplink.MAX_FRAME_BYTES
  `, {}, FILES, big + PRELUDE_DRIVE);
  const [bytes, max] = out.split(';').map(Number);
  assert.ok(bytes <= max, `${bytes} > ${max}`);
});


test('chats: each chat keeps its own history, answers land in the right chat', () => {
  const out = runLua(`
    ForeverAICompanion_DB = { history = { { id = "old1", question = "pregunta vieja", status = "done", answer = "respuesta vieja", t = 100 } } }
    START()
    local migrated = ns.Chats:Current()
    local a = ns.Chats:New()
    local dumpA1 = ASK("¿Qué mazmorra hago?")
    RUN_FRAMES(40)
    local idA1 = a.messages[1].id
    ns.Core:ApplyInbox({ answers = { { id = idA1, ok = true, answer = "Gnomeregan" } } })

    local b = ns.Chats:New()
    local dumpB1 = ASK("¿Cómo va mi equipo?")
    RUN_FRAMES(40)
    local idB1 = b.messages[1].id

    -- B's answer arrives while A is open: B gets the "new" mark.
    ns.Chats:Select(a.id)
    ns.Core:ApplyInbox({ answers = { { id = idB1, ok = true, answer = "Cambia las botas" } } })
    local bUnread = tostring(b.unread)

    local dumpA2 = ASK("¿Y después de Gnomeregan?")
    RUN_FRAMES(40)

    ns.Chats:Rename(b.id, "Mi equipo")
    ns.Chats:Delete(migrated.id)
    local titles = {}
    for _, c in ipairs(ns.Chats:All()) do titles[#titles + 1] = c.title end

    RESULT = migrated.title .. "|" .. #migrated.messages .. "#" .. dumpA1 .. "#" .. dumpB1 .. "#" .. dumpA2
      .. "#" .. a.title .. "|" .. tostring(a.messages[1].answer) .. "|" .. tostring(b.messages[1].answer) .. "|" .. bUnread
      .. "#" .. table.concat(titles, ",")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [migrated, dA1, dB1, dA2, summary, titles] = out.split('#');
  assert.equal(migrated, 'Previous conversation|1');
  const a1 = decodeDump(dA1).req;
  const b1 = decodeDump(dB1).req;
  const a2 = decodeDump(dA2).req;
  assert.deepEqual(a1.history, [], 'a new chat starts without history');
  assert.deepEqual(b1.history, [], 'chat B does not see chat A');
  assert.deepEqual(a2.history, [{ q: '¿Qué mazmorra hago?', a: 'Gnomeregan' }], 'chat A sees only its own turns');
  assert.equal(a2.chat.title, '¿Qué mazmorra hago?');
  const [aTitle, aAnswer, bAnswer, bUnread] = summary.split('|');
  assert.equal(aTitle, '¿Qué mazmorra hago?', 'title comes from the first question');
  assert.equal(aAnswer, 'Gnomeregan');
  assert.equal(bAnswer, 'Cambia las botas');
  assert.equal(bUnread, 'true');
  assert.deepEqual(titles.split(',').sort(), ['Mi equipo', '¿Qué mazmorra hago?'].sort());
});

test('floating button: opens the chats, new chat, unread badge, drag, hide', () => {
  const out = runLua(`
    IsShiftKeyDown = function() return SHIFT end
    -- A round minimap 140 px wide, centered at (1000, 700); the mouse above it.
    Minimap = CreateFrame("Frame"); Minimap.w, Minimap.h = 140, 140
    Minimap.GetCenter = function() return 1000, 700 end
    Minimap.GetEffectiveScale = function() return 1 end
    Minimap.GetFrameLevel = function() return 2 end
    GetCursorPosition = function() return 1000, 900 end
    START()
    local b = ForeverAICompanionFloatingButton
    b.SetPoint = function(self, p, rel, rp, x, y) self.anchorX, self.anchorY = math.floor((x or 0) + 0.5), math.floor((y or 0) + 0.5) end
    assert(b, "button not created")
    b.dragging = false -- the fake UI answers unknown fields with a function
    local shownAtStart = tostring(b.shown)
    b.scripts.OnClick(b, "LeftButton")
    local openedByClick = tostring(ns.UI.frame.shown)
    b.scripts.OnClick(b, "LeftButton")
    local closedBySecondClick = tostring(ns.UI.frame.shown)

    ns.Core:Ask("primera")           -- the open chat now has a message
    local before = #ns.db.chats
    b.scripts.OnClick(b, "RightButton")
    local newChat = tostring(#ns.db.chats == before + 1) .. "," .. tostring(ns.UI.frame.shown)

    ns.db.chats[1].unread = true
    ns.Button:Update()
    local badge = tostring(ns.Button.badge.shown) .. "," .. ns.Button.badgeText:GetText()
    local thinking = tostring(ns.Button.thinking)

    -- Dragged to straight above the minimap's center: it slides there (90°).
    b.scripts.OnDragStart(b)
    b.scripts.OnUpdate(b, 0.016)
    b.scripts.OnDragStop(b)
    local saved = tostring(ns.db.button.angle) .. "," .. tostring(b.anchorX) .. "," .. tostring(b.anchorY)
    b.dragging = false

    SHIFT = true
    b.scripts.OnClick(b, "RightButton")
    local hidden = tostring(b.shown) .. "," .. tostring(ns.db.button.shown)

    RESULT = table.concat({ shownAtStart, openedByClick, closedBySecondClick, newChat, badge, thinking, saved, hidden }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [shownAtStart, opened, closed, newChat, badge, thinking, saved, hidden] = out.split('#');
  assert.equal(shownAtStart, 'true');
  assert.equal(opened, 'true');
  assert.equal(closed, 'false');
  assert.equal(newChat, 'true,true');
  assert.equal(badge.split(',')[0], 'true');
  assert.equal(thinking, 'true', 'a pending question makes the icon breathe');
  assert.match(saved, /^90(\.0)?,0,75$/, 'on the minimap edge, above it (radius 70 + 5)');
  assert.equal(hidden, 'false,false');
});

test('window: welcome suggestions, bubbles, copy, retry, font size and sidebar', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local ui = ns.UI
    ui:Refresh() -- the real game fires OnShow
    local welcomeShown = tostring(ui.welcome and ui.welcome.shown)
    local chips = #ui.welcome.chips

    -- A suggestion asks right away.
    ui.welcome.chips[1].scripts.OnClick(ui.welcome.chips[1])
    RUN_FRAMES(200)
    local current = ns.Chats:Current()
    local asked = current.messages[1].question

    -- Answer arrives: user bubble + AI bubble with "Copy".
    ns.Core:ApplyInbox({ answers = { { id = current.messages[1].id, ok = true, answer = "Ve a Gnomeregan" } } })
    ui:Refresh()
    local shownBubbles = 0
    for _, b in ipairs(ui.bubbles) do if b.shown then shownBubbles = shownBubbles + 1 end end
    local aiBubble = ui.bubbles[2]
    aiBubble.action.scripts.OnClick(aiBubble.action)
    local copyOpen = tostring(ui.copyFrame and ui.copyFrame.shown)

    -- An error offers "Retry", which asks again in the same chat.
    current.messages[1].status = "error"
    current.messages[1].answer = "Error: sin conexión"
    ui:Refresh()
    ui.bubbles[2].action.scripts.OnClick(ui.bubbles[2].action)
    local retried = #current.messages .. "," .. current.messages[1].status

    ui:SetFontSize(40)
    local size = ns.db.ui.fontSize
    ui:SetSidebar(false)
    local sidebar = tostring(ui.side.shown) .. "," .. tostring(ns.db.ui.sidebar)

    RESULT = table.concat({ welcomeShown, chips, asked, shownBubbles, copyOpen, retried, size, sidebar }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [welcome, chips, asked, bubbles, copyOpen, retried, size, sidebar] = out.split('#');
  assert.equal(welcome, 'true', 'empty chat shows the welcome screen');
  assert.equal(chips, '6');
  assert.equal(asked, 'Which dungeon should I run now?');
  assert.equal(bubbles, '2', 'one bubble for the question, one for the answer');
  assert.equal(copyOpen, 'true');
  assert.equal(retried, '1,pending', 'retry replaces the failed question with a new attempt');
  assert.equal(size, '20', 'font size is capped');
  assert.equal(sidebar, 'false,false');
});

test('assistant: first open asks Fizzi or Rizzik, suggests by faction, themes everything', () => {
  const out = runLua(`
    UnitFactionGroup = function() return "Horde" end
    START()
    ns.UI:Show()
    local ui = ns.UI
    ui:Refresh()
    local chooserShown = tostring(ui.chooser and ui.chooser.shown)
    local welcomeHidden = tostring(not (ui.welcome and ui.welcome.shown))
    local cards = #ui.chooser.cards
    local back = tostring(ui.chooser.back.shown)           -- nothing chosen yet: no way back
    local suggested = ns.Personas:Suggested().id

    -- Pick Rizzik: window goes gold, welcome uses his texts, button shows him.
    local rizzikCard = ui.chooser.cards[2]
    rizzikCard.pick.scripts.OnClick(rizzikCard.pick)
    local chosen = ns.Personas:Current().id .. "," .. tostring(ns.Personas:Chosen())
    local afterPick = tostring(ui.chooser.shown) .. "," .. tostring(ui.welcome.shown)
    local accent = string.format("%.2f", ui.COLORS.accent[1])
    local hello = ui.welcome.hello.textValue or ""

    -- The question carries the assistant so the app uses its personality.
    ns.Core:Ask("hola")
    local pending = ""
    for i = 1, 200 do
      RUN_FRAMES(1)
      for _, b in ipairs(ui.bubbles) do if b.shown and b.pending then pending = b.text.textValue or "" end end
    end

    -- Header click opens the chooser again; switching back to Fizzi recolors.
    ui:ShowChooser()
    local reopened = tostring(ui.chooser.shown) .. "," .. tostring(ui.chooser.back.shown)
    ui.chooser.cards[1].pick.scripts.OnClick(ui.chooser.cards[1].pick)
    local accent2 = string.format("%.2f", ui.COLORS.accent[1])

    RESULT = table.concat({ chooserShown, welcomeHidden, cards, back, suggested, chosen, afterPick,
      accent, hello, pending, reopened, accent2, ns.Personas:Current().id }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI.replace('GetStringHeight" then return function() return 10 end end',
    'GetStringHeight" then return function() return 10 end end\n      if k == "SetText" then return function(self, v) self.textValue = v end end') + PRELUDE_DRIVE);
  const [chooser, welcomeHidden, cards, back, suggested, chosen, afterPick, accent, hello, pending, reopened, accent2, final] = out.split('#');
  assert.equal(chooser, 'true', 'the first time, the window asks for an assistant');
  assert.equal(welcomeHidden, 'true');
  assert.equal(cards, '2');
  assert.equal(back, 'false');
  assert.equal(suggested, 'rizzik', 'Horde characters get the goblin suggested');
  assert.equal(chosen, 'rizzik,true');
  assert.equal(afterPick, 'false,true', 'after choosing, the welcome screen appears');
  assert.equal(accent, '0.80', 'Horde red accent for Rizzik');
  assert.match(hello, /deal/);
  assert.match(pending, /fine print|profits|contacts|transmitter|deal/, 'thinking phrases are Rizzik\'s');
  assert.equal(reopened, 'true,true', 'the chooser can be reopened, now with a way back');
  assert.equal(accent2, '0.25', 'switching to Fizzi recolors the window');
  assert.equal(final, 'fizzi');
});

test('the request tells the app which assistant answers', () => {
  const dump = runLua(`
    UnitFactionGroup = function() return "Alliance" end
    START()
    local d = ASK("¿Qué hago?")
    RESULT = d
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const { req } = decodeDump(dump);
  assert.equal(req.assistant, 'fizzi', 'asking before choosing keeps the faction\'s assistant');
  assert.equal(req.lang, 'en', 'the game\'s language travels with the request');
  const dumpEs = runLua(`
    START()
    RESULT = ASK("¿Qué hago?")
  `, {}, FILES, 'LOCALE = "esES"\n' + FAKE_UI + PRELUDE_DRIVE);
  assert.equal(decodeDump(dumpEs).req.lang, 'es');
});

test('every texture of the window is anchored (no invisible backgrounds)', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    ns.UI:Refresh()
    ns.Core:Ask("hola")
    RUN_FRAMES(200)
    ns.UI:Refresh()
    ns.UI:ShowCopy("texto")
    ns.Button:Update()
    local missing = {}
    for i, t in ipairs(TEXTURES) do
      if t.parent ~= ns.Uplink.grid and not rawget(t, "anchored") then missing[#missing + 1] = i end
    end
    RESULT = #missing .. "/" .. #TEXTURES
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [missing, total] = out.split('/').map(Number);
  assert.ok(total > 20, `expected many textures, got ${total}`);
  assert.equal(missing, 0, `${missing} textures have no anchor and would be invisible`);
});
test('notification card: preview, click opens the chat, fades away', () => {
  const out = runLua(`
    START()
    local chatA = ns.Chats:Current()
    ns.Core:Ask("¿Qué mazmorra hago?")
    RUN_FRAMES(200)
    ns.UI.frame.shown = false                 -- window closed while waiting
    ns.Chats:New()                            -- and another chat is open
    local id = chatA.messages[1].id
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Ve a Gnomeregan con tu grupo, es la mejor opción para tu nivel." } } })
    local card = ns.Notify.cards[1]
    local shown = tostring(card.shown)
    local body = card.body.textValue or ""
    local hop = tostring(ns.Button.hopUntil ~= nil)
    local badge = tostring(ns.Button.badge.shown)

    card.scripts.OnClick(card, "LeftButton")
    local opened = tostring(ns.UI.frame.shown) .. "," .. tostring(ns.db.currentChat == chatA.id) .. "," .. tostring(card.shown)

    -- A second answer (error) shows a card that disappears on its own.
    ns.Core:Ask("otra")
    RUN_FRAMES(200)
    local chatB = ns.Chats:Current()
    ns.Chats:New()
    ns.Core:ApplyInbox({ answers = { { id = chatB.messages[#chatB.messages].id, ok = false, answer = "Error: sin conexión" } } })
    local card2 = ns.Notify.cards[1].shown and ns.Notify.cards[1] or ns.Notify.cards[2]
    local before = tostring(card2.shown)
    NOW = NOW + 11
    RUN_FRAMES(2)
    local after = tostring(card2.shown)

    RESULT = table.concat({ shown, hop, badge, opened, before, after }, "#")
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [shown, hop, badge, opened, before, after] = out.split('#');
  assert.equal(shown, 'true', 'a card appears when the answer lands in a chat you are not viewing');
  assert.equal(hop, 'true', 'the floating button hops');
  assert.equal(badge, 'true', 'and shows the unread badge');
  assert.equal(opened, 'true,true,false', 'clicking the card opens that chat and closes the card');
  assert.equal(before, 'true');
  assert.equal(after, 'false', 'cards fade away after a few seconds');
});
test('portraits: race icon atlas when the game has it, icon files or the gadget otherwise', () => {
  const out = runLua(`
    START()
    local P = ns.Personas
    local function fresh(id) local p = P.list[id]; p.resolved = nil; return p end
    -- Modern client: the character creator's race icons exist.
    C_Texture = { GetAtlasInfo = function(name) if name:find("^raceicon128") then return { file = 1 } end end }
    GetFileIDFromPath = function() return nil end
    local a = P.PortraitName(fresh("rizzik")) .. "|" .. P.PortraitName(fresh("fizzi"))
    -- No atlas, but the achievement icon file exists.
    C_Texture = { GetAtlasInfo = function() return nil end }
    GetFileIDFromPath = function(path) if path:find("Goblin_Male") then return 123 end end
    local b = P.PortraitName(fresh("rizzik"))
    -- Nothing at all: the gadget.
    GetFileIDFromPath = function() return nil end
    local c = P.PortraitName(fresh("rizzik"))
    RESULT = a .. "#" .. b .. "#" .. c
  `, {}, ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'],
  FAKE_UI + PRELUDE_DRIVE);
  const [a, b, c] = out.split('#');
  assert.equal(a, 'atlas raceicon128-goblin-male|atlas raceicon128-gnome-female');
  assert.match(b, /Achievement_Character_Goblin_Male/);
  assert.match(c, /INV_Misc_Coin_01/);
});

// --- Languages ---------------------------------------------------------------
// GetLocale() picks the texts: esES / esMX -> Spanish, anything else -> English.
const ALL_FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'];
const RECORD_TEXT = FAKE_UI.replace('GetStringHeight" then return function() return 10 end end',
  'GetStringHeight" then return function() return 10 end end\n      if k == "SetText" then return function(self, v) self.textValue = v end end');
const inLocale = (locale) => `LOCALE = ${JSON.stringify(locale)}\n` + RECORD_TEXT + PRELUDE_DRIVE;

for (const { locale, code, title, hello, hint, chip, chooserTitle, pick, role, faction } of [
  { locale: 'enUS', code: 'en', title: 'New chat', hello: 'Hi, Sharp! What shall we invent today?',
    hint: 'Each chat remembers its own conversation: use one per topic.', chip: 'Which dungeon should I run now?',
    chooserTitle: 'Your assistant', pick: 'Choose Fizzi|Choose Rizzik', role: 'Gnomeregan inventor · Alliance', faction: '(your faction)' },
  { locale: 'esMX', code: 'es', title: 'Nuevo chat', hello: '¡Hola, Sharp! ¿Qué inventamos hoy?',
    hint: 'Cada chat recuerda su propia conversación: usa uno por tema.', chip: '¿Qué mazmorra me conviene hacer ahora?',
    chooserTitle: 'Tu asistente', pick: 'Elegir a Fizzi|Elegir a Rizzik', role: 'Inventora de Gnomeregan · Alianza', faction: '(tu facción)' },
]) {
  test(`window and assistant chooser in ${locale}`, () => {
    const out = runLua(`
      UnitFactionGroup = function() return "Alliance" end
      START()
      ns.UI:Show()
      local ui = ns.UI
      ui:Refresh()
      -- First open: the chooser.
      local chooser = ui.title.textValue
      local picks = ui.chooser.cards[1].pick.textValue .. "|" .. ui.chooser.cards[2].pick.textValue
      local role = ui.chooser.cards[1].role.textValue
      local full = ns.Personas.list.fizzi.fullName .. "|" .. ns.Personas.list.rizzik.fullName
      ui.chooser.cards[1].pick.scripts.OnClick(ui.chooser.cards[1].pick)
      -- Then the welcome screen of an empty chat.
      local w = ui.welcome
      RESULT = table.concat({ ns.L.code, chooser, picks, role, full, ui.title.textValue, w.hello.textValue,
        w.hint.textValue, ns.L.SUGGESTIONS[1], ui.placeholder.textValue, ns.L.WINDOW_TITLE }, "#")
    `, {}, ALL_FILES, inLocale(locale));
    const [gotCode, chooser, picks, gotRole, full, gotTitle, gotHello, gotHint, gotChip, placeholder, windowTitle] = out.split('#');
    assert.equal(gotCode, code);
    assert.equal(chooser, chooserTitle);
    assert.equal(picks, pick);
    assert.match(gotRole, new RegExp(`^${role}`));
    assert.ok(gotRole.includes(faction), `suggested assistant marked: ${gotRole}`);
    assert.equal(full, code === 'en' ? 'Fizzi Sparkwrench|Rizzik Fastfuse' : 'Fizzi Chispatuerca|Rizzik Bujíaveloz');
    assert.equal(gotTitle, title);
    assert.equal(gotHello, hello);
    assert.equal(gotHint, hint);
    assert.equal(gotChip, chip);
    assert.match(placeholder, code === 'en' ? /^Ask Fizzi/ : /^Pregúntale algo a Fizzi/);
    assert.equal(windowTitle, 'Forever AI Companion');
  });
}

test('slash commands accept English and Spanish words in any game language', () => {
  for (const locale of ['enUS', 'esES']) {
    const out = runLua(`
      START()
      PRINTED = {}
      print = function(...) PRINTED[#PRINTED + 1] = table.concat({ ... }, " ") end
      local slash = SlashCmdList.FOREVERAICOMPANION
      slash("assistant rizzik")
      local en = ns.Personas:Current().id .. "|" .. PRINTED[#PRINTED]
      slash("asistente fizzi")
      local es = ns.Personas:Current().id .. "|" .. PRINTED[#PRINTED]
      slash("help")
      local help = PRINTED[#PRINTED]
      slash("ayuda")
      local ayuda = PRINTED[#PRINTED]
      slash("button reset")
      local reset = PRINTED[#PRINTED]
      local function talk() ns.Chats:AddMessage(ns.Chats:Current(), { id = tostring(math.random()), question = "q", status = "done" }) end
      talk()
      local before = #ns.db.chats
      slash("new")
      local afterNew = #ns.db.chats - before
      talk()
      slash("nuevo")
      local afterNuevo = #ns.db.chats - before
      -- Anything else is a question, even if it starts with a command word.
      slash("data about my quests")
      local asked = ns.Chats:Current().messages[1].question
      RESULT = table.concat({ en, es, help, ayuda, reset, afterNew, afterNuevo, asked,
        SLASH_FOREVERAICOMPANION1, SLASH_FOREVERAICOMPANION2, SLASH_FOREVERAICOMPANION3 }, "#")
    `, {}, ALL_FILES, inLocale(locale));
    const [en, es, help, ayuda, reset, afterNew, afterNuevo, asked, s1, s2, s3] = out.split('#');
    const spanish = locale === 'esES';
    assert.equal(en, spanish ? 'rizzik||cff66ccffForever AI:|r Rizzik es ahora tu asistente.'
      : 'rizzik||cff66ccffForever AI:|r Rizzik is now your assistant.');
    assert.equal(es, spanish ? 'fizzi||cff66ccffForever AI:|r Fizzi es ahora tu asistente.'
      : 'fizzi||cff66ccffForever AI:|r Fizzi is now your assistant.');
    assert.equal(help, ayuda, 'help and ayuda are the same command');
    assert.match(help, spanish ? /\/ia nuevo crea un chat/ : /\/ia new creates a chat/);
    assert.match(reset, spanish ? /botón devuelto/ : /button moved back/);
    assert.equal(afterNew, '1');
    assert.equal(afterNuevo, '2');
    assert.equal(asked, 'data about my quests');
    assert.deepEqual([s1, s2, s3], ['/ia', '/azia', '/ai']);
  }
});

test('Spanish falls back to English for a missing key, and every key is translated', () => {
  const out = runLua(`
    local es, en = ns.Locales.es, ns.Locales.en
    local untranslated = {}
    for k in pairs(en) do if rawget(es, k) == nil then untranslated[#untranslated + 1] = k end end
    for k in pairs(es) do if rawget(en, k) == nil then untranslated[#untranslated + 1] = "en:" .. k end end
    local before = ns.L.SEND
    ns.L.SEND = nil                       -- a key the Spanish table does not have
    RESULT = table.concat({ ns.L.code, before, ns.L.SEND, ns.L.NO_SUCH_KEY, #ns.L.FIZZI_THINKING,
      table.concat(untranslated, ",") }, "#")
  `, {}, ['Locale.lua'], 'LOCALE = "esES"; GetLocale = function() return LOCALE end');
  const [code, before, fallback, unknown, thinking, untranslated] = out.split('#');
  assert.equal(code, 'es');
  assert.equal(before, 'Enviar');
  assert.equal(fallback, 'Send', 'missing Spanish text shows the English one');
  assert.equal(unknown, 'NO_SUCH_KEY', 'never nil');
  assert.equal(thinking, '5');
  assert.equal(untranslated, '', 'both languages have the same keys');
});
// --- App status in the chat header -------------------------------------------
// The app keeps sig/*.wav files that play or not (beacon.js); the addon reads
// them with PlaySoundFile and shows the result under the chat title.
const STATUS_UI = RECORD_TEXT + PRELUDE_DRIVE + `
  PLAYING = {}
  PlaySoundFile = function(path) return PLAYING[path:match("sig\\\\([%w%-]+)%.wav$") or ""] == true end
`;

test('chat header shows whether the app is open, ready, and why not', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local states = {}
    local function check(note)
      NOW = NOW + 2
      states[#states + 1] = (note or "") .. ns.Live:CheckApp()
    end
    PLAYING = { ok = true, st = true }
    check(); check()                          -- nothing beats: closed
    local closedText = ns.UI.channel.textValue
    PLAYING.beat1 = true; check()             -- the app starts: still closed until it switches
    PLAYING.beat1, PLAYING.beat2 = nil, true; check()   -- it switches: ready
    local readyText = ns.UI.channel.textValue
    PLAYING["need-login"] = true; PLAYING.beat1, PLAYING.beat2 = true, nil; check()
    local loginText = ns.UI.channel.textValue
    PLAYING["need-login"] = nil; PLAYING.beat1, PLAYING.beat2 = nil, true; check()
    PLAYING.beat1, PLAYING.beat2 = nil, nil; check("1:")  -- one silent check: maybe switching
    PLAYING.beat1 = true; check()
    for i = 1, 8 do check() end               -- the same beat for 16 s: stuck
    PLAYING.beat1, PLAYING.beat2 = nil, true; check()   -- alive again
    -- Window closed for a minute: no "stuck" right after reopening.
    NOW = NOW + 60; check("gap:")
    PLAYING.st = nil; check()                 -- files newer than the game
    PLAYING.ok = nil; check()                 -- game sound off
    PLAYING = { ok = true, st = true, beat1 = true, beat2 = true }
    check(); check(); check(); check()        -- both always play: can't tell
    local tip = select(1, ns.UI:AppStatusHelp())
    RESULT = table.concat(states, ",") .. "#" .. closedText .. "#" .. readyText .. "#" .. loginText .. "#" .. tip
  `, {}, ALL_FILES, STATUS_UI);
  const [states, closedText, readyText, loginText, tip] = out.split('#');
  assert.equal(states, [
    'checking', 'closed', 'closed', 'ready', 'need-login', 'ready', '1:ready', 'ready',
    // 2..14 s on the same beat is fine; 16 s is more than STALE (15).
    'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'stuck', 'ready',
    'gap:ready', 'restart', 'nosound', 'ready', 'ready', 'ready', 'unknown',
  ].join(','));
  assert.match(closedText, /\|cffff6060Forever AI Companion is closed/);
  assert.match(readyText, /Fizzi .* invisible link|Fizzi .* on-screen strip/);
  assert.match(loginText, /sign in/);
  assert.equal(tip, 'App status unknown');
});

// --- macOS: sound files are checked a moment later ------------------------------
// WoW for Mac says PlaySoundFile will play any file that exists, empty or not;
// only C_Sound.IsPlaying a moment later tells them apart. Trusting the first
// answer took every signal as rung and used up the 50 mailboxes in ~5 questions.
const MAC_SOUND = RECORD_TEXT + PRELUDE_DRIVE + `
  IsMacClient = function() return true end
  REAL = { ok = true, st = true }   -- sound files with real content
  HANDLES = {}
  PlaySoundFile = function(path)
    HANDLES[#HANDLES + 1] = path:match("sig\\\\([%w%-]+)%.wav$") or ""
    return true, #HANDLES          -- "will play", like the Mac client says for every file
  end
  StopSound = function() end
  C_Sound = { IsPlaying = function(h) return REAL[HANDLES[h]] == true end }
  TIMERS = {}
  C_Timer.After = function(_, fn) TIMERS[#TIMERS + 1] = fn end
  function FLUSH() local list = TIMERS; TIMERS = {}; for _, fn in ipairs(list) do fn() end end
  LOADS, LOADED = 0, {}
  C_AddOns = {
    IsAddOnLoaded = function(n) return LOADED[n] end,
    LoadAddOn = function(n) LOADED[n] = true; LOADS = LOADS + 1; return true end,
    EnableAddOn = function() end,
  }
`;

test('Mac: a mailbox is opened only when the app really rings, not on every check', () => {
  const out = runLua(`
    START()
    FLUSH()                                   -- the start-up scan finds nothing rung
    ns.Core.HasPending = function() return true end
    local first = ns.db.nextSig
    for i = 1, 15 do ns.Live:Tick(); FLUSH() end   -- 30 s waiting for an answer
    local idle = LOADS .. "/" .. ns.db.nextSig
    REAL[string.format("%03d", ns.db.nextSig)] = true   -- the app rings
    ns.Live:Tick(); FLUSH()
    local rung = LOADS .. "/" .. ns.db.nextSig
    for i = 1, 5 do ns.Live:Tick(); FLUSH() end    -- the next signal is still empty
    RESULT = first .. "#" .. idle .. "#" .. rung .. "#" .. LOADS .. "#" .. tostring(ns.Live.deferred)
  `, {}, ALL_FILES, MAC_SOUND);
  const [first, idle, rung, after, deferred] = out.split('#');
  assert.equal(deferred, 'true');
  assert.equal(idle, `0/${first}`, 'no mailbox used and no signal skipped while nothing rang');
  assert.equal(rung, `1/${Number(first) + 1}`, 'one ring, one mailbox');
  assert.equal(after, '1');
});

test('Mac: signals rung while the game was closed are skipped at start, one check at a time', () => {
  const out = runLua(`
    REAL["001"], REAL["002"], REAL["003"] = true, true, true
    START()
    local during = tostring(ns.Live.scanning)
    for i = 1, 5 do FLUSH() end
    RESULT = during .. "#" .. ns.db.nextSig .. "#" .. tostring(ns.Live.scanning)
  `, {}, ALL_FILES, MAC_SOUND);
  assert.equal(out, 'true#4#false');
});

test('Mac: the chat header tells closed from ready (not "unknown")', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    FLUSH()
    local states = {}
    local function check() NOW = NOW + 2; ns.Live:CheckApp(); FLUSH(); states[#states + 1] = ns.Live:AppState() end
    check(); check()                                   -- nothing beats: closed
    REAL.beat1 = true; check()
    REAL.beat1, REAL.beat2 = nil, true; check()        -- it switches: ready
    REAL["need-ai"] = true; REAL.beat1, REAL.beat2 = true, nil; check()
    RESULT = table.concat(states, ",")
  `, {}, ALL_FILES, MAC_SOUND);
  assert.equal(out.split(',').slice(-4).join(','), 'closed,closed,ready,need-ai');
});

test('Mac without C_Sound.IsPlaying: signals are not trusted, mailboxes go by the timer', () => {
  const out = runLua(`
    START()
    ns.Core.HasPending = function() return true end
    for i = 1, 10 do ns.Live:Tick() end
    RESULT = LOADS .. "#" .. tostring(ns.Live.soundOK) .. "#" .. ns.Live:CheckApp()
  `, {}, ALL_FILES, MAC_SOUND + 'C_Sound = nil\n');
  assert.equal(out, '0#false#unknown');
});

// --- A slow answer through the invisible voice ------------------------------------
const VOICE_ON = RECORD_TEXT + PRELUDE_DRIVE + `
  SPOKEN = {}
  C_VoiceChat = {
    GetTtsVoices = function() return { { voiceID = 7, name = "ForeverAICompanion" } } end,
    SpeakText = function(_, text) SPOKEN[#SPOKEN + 1] = text; return true end,
  }
  C_Timer.After = function(_, fn) fn() end
  function UNTIL_IDLE()
    for i = 1, 6000 do
      if not ns.Core.working and not ns.Uplink.busy then return end
      RUN_FRAMES(1)
    end
  end
`;

test('a slow answer through the voice: sent again as the same question, and the voice stays on', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    local id = ns.Core:Ask("¿Qué mazmorra me conviene?")
    UNTIL_IDLE()
    local chat = ns.Chats:Current()
    local entry = chat.messages[#chat.messages]
    local spoke = #SPOKEN
    entry.t = time() - 46                       -- no answer after 45 s (a slow first answer)
    ns.Core:HasPending()
    UNTIL_IDLE()
    local again = (ns.Uplink.last and ns.Uplink.last.bytes or 0) > 0
    local count = #chat.messages
    local stillPending = entry.status
    ns.Core:HasPending()                        -- only once
    UNTIL_IDLE()
    -- The answer to the first copy arrives (the app answers an id once).
    ns.Core:ApplyInbox({ answers = { { id = id, ok = true, answer = "Las Minas de la Muerte." } } })
    RESULT = table.concat({ spoke, tostring(again), count, stillPending, entry.id == id and "same-id" or "new-id",
      entry.status, tostring(ns.Voice.broken), tostring(ns.Voice:Available()) }, "#")
  `, {}, ALL_FILES, VOICE_ON);
  assert.equal(out, '1#true#1#pending#same-id#done#nil#true');
});

test('no answer at all through the voice: the question fails and the voice is given up, until an answer still arrives', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.Core:Ask("¿Hola?")
    UNTIL_IDLE()
    local chat = ns.Chats:Current()
    local entry = chat.messages[#chat.messages]
    entry.t = time() - 46; ns.Core:HasPending(); UNTIL_IDLE()
    entry.t = time() - 151; ns.Core:HasPending()
    local given = entry.status .. "#" .. tostring(ns.Voice.broken)
    -- The answer still arrives later: it is shown, and the voice is back.
    ns.Core:ApplyInbox({ answers = { { id = entry.id, ok = true, answer = "Hola, aventurera." } } })
    RESULT = given .. "#" .. entry.status .. "#" .. tostring(entry.answer) .. "#" .. tostring(ns.Voice.broken)
  `, {}, ALL_FILES, VOICE_ON);
  assert.equal(out, 'error#true#done#Hola, aventurera.#nil');
});

// --- Asking in combat ----------------------------------------------------------------
const IN_COMBAT = RECORD_TEXT + PRELUDE_DRIVE + `
  INCOMBAT = false
  UnitAffectingCombat = function() return INCOMBAT end
  InCombatLockdown = function() return INCOMBAT end
  HEALTH, MAXH = 800, 1000
  UnitHealth = function() return HEALTH end
  UnitHealthMax = function() return MAXH end
  function FIRE(event, ...)
    for _, f in ipairs(FRAMES) do
      if f.scripts.OnEvent then pcall(f.scripts.OnEvent, f, event, ...) end
    end
  end
`;

// The files in the order the game loads them (the .toc), with this fork's Fade,
// Compact and Options: the combat warning is a choice there (dimming is the default).
const COMBAT_FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Fade.lua', 'Compact.lua', 'Options.lua', 'Button.lua', 'Notify.lua', 'Probe.lua', 'Core.lua'];

test('in combat you can ask, and the window warns you to watch the game (and flashes when you get hit)', () => {
  const out = runLua(`
    START()
    ns.Fade:Set("combatWarn", true)                       -- Options: the warning instead of dimming
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    INCOMBAT = true
    FIRE("PLAYER_REGEN_DISABLED")
    local id = ns.Core:Ask("¿Qué hago con este mob?")
    local chat = ns.Chats:Current()
    local asked = id and chat.messages[#chat.messages].status or "blocked"
    local C = ns.Combat
    local bar = tostring(C.bar.shown) .. ":" .. tostring(C.text.textValue)
    FIRE("UNIT_COMBAT", "target", "WOUND", "", 50)       -- someone else hit: nothing
    local other = tostring(C.hitAt)
    FIRE("UNIT_COMBAT", "player", "WOUND", "", 200)      -- the player is hit
    C:Fade(0.1)
    local hit = string.format("%.2f", C.glow.alpha) .. ":" .. tostring(C.text.textValue) .. ":" .. tostring(C.hpText.textValue)
    NOW = NOW + 5; C:Fade(0.1)                            -- a few seconds later
    local calm = tostring(C.text.textValue)
    INCOMBAT = false
    FIRE("PLAYER_REGEN_ENABLED")
    RESULT = table.concat({ asked, bar, other, hit, calm, tostring(C.bar.shown) }, "#")
  `, {}, COMBAT_FILES, IN_COMBAT);
  const [asked, bar, other, hit, calm, after] = out.split('#');
  assert.equal(asked, 'pending', 'the question is sent in combat');
  assert.equal(bar, 'true:In combat: keep an eye on the game');
  assert.equal(other, 'nil', 'only hits on the player count');
  assert.match(hit, /^0\.34:.*You're being hit! Watch the game.*:80%$/, 'the edges glow (discreetly); the health shows');
  assert.equal(calm, 'In combat: keep an eye on the game');
  assert.equal(after, 'false', 'the bar goes away after combat');
});

test('in combat, with the game hiding health from addons: the warning still works, without errors', () => {
  const out = runLua(`
    issecretvalue = function(v) return type(v) == "number" end   -- like the game in combat
    START()
    ns.Fade:Set("combatWarn", true)
    ns.UI:Show()
    INCOMBAT = true
    FIRE("PLAYER_REGEN_DISABLED")
    FIRE("UNIT_HEALTH", "player")
    FIRE("UNIT_COMBAT", "player", "WOUND", "", 120)   -- what WoW Forever sends: the amount hidden
    ns.Combat:Fade(0.1)
    RESULT = tostring(ns.Combat.bar.shown) .. "#" .. tostring(ns.Combat.text.textValue) .. "#" .. string.format("%.2f", ns.Combat.glow.alpha)
  `, {}, COMBAT_FILES, 'LOCALE = "esES"\n' + IN_COMBAT);
  const [shown, text, flash] = out.split('#');
  assert.equal(shown, 'true');
  assert.match(text, /¡Te están golpeando! Mira el juego\|r$/);
  assert.equal(flash, '0.34', 'the hit is seen even with its amount hidden');
});

test('in combat it is one or the other: the window dims (default) or shows the warning, switched in the options', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    INCOMBAT = true
    FIRE("PLAYER_REGEN_DISABLED")
    FIRE("UNIT_COMBAT", "player", "WOUND", "", 200)
    ns.Combat:Fade(0.1)
    local r = {}
    local function state(name)
      r[#r + 1] = name .. "=" .. tostring(ns.Combat.bar.shown) .. "," .. string.format("%.2f", ns.Combat.glow.alpha) .. ","
        .. string.format("%.2f", ns.Fade:Target(GetTime())) .. "," .. ns.Fade:Settings().combatStyle
    end
    state("dim")
    -- Mid-fight, the player ticks "Show the combat warning instead": the bar shows right away.
    local o = ns.Options
    o.combatWarnControl.GetChecked = function() return true end
    o.combatWarnControl:GetScript("OnClick")(o.combatWarnControl)
    FIRE("UNIT_COMBAT", "player", "WOUND", "", 200)
    ns.Combat:Fade(0.1)
    state("warn")
    r[#r + 1] = "saved=" .. tostring(ns.db.fade.combatStyle)
    -- Ticking "Dim the window in combat" again picks dimming: the bar goes away.
    local c = o.combatControls
    c.enabled.GetChecked = function() return true end
    c.enabled:GetScript("OnClick")(c.enabled)
    state("dimAgain")
    -- Saved by an earlier test build with combat dimming turned off: the warning.
    ns.db.fade = { v = 2, combat = false }
    r[#r + 1] = "legacy=" .. ns.Fade:Settings().combatStyle
    RESULT = table.concat(r, " ")
  `, {}, COMBAT_FILES, IN_COMBAT);
  const got = Object.fromEntries(out.split(' ').map((p) => p.split('=')));
  assert.deepEqual(got, {
    dim: 'false,0.00,0.30,dim',      // no bar, no glow; the window dims
    warn: 'true,0.34,1.00,warn',     // the bar and the glow; the window stays fully visible
    saved: 'warn',
    dimAgain: 'false,0.34,0.30,dim', // (the last glow fades by itself)
    legacy: 'warn',
  });
});

test('a voice question can be asked in combat too', () => {
  const out = runLua(`
    START()
    InCombatLockdown = function() return true end
    UnitAffectingCombat = function() return true end
    ns.requestKey = KEY
    ns.Core:TalkKey("down")
    for i = 1, 4000 do if not ns.Core.working then break end RUN_FRAMES(1) end
    local msgs = ns.Chats:Current().messages
    RESULT = tostring(#SPOKEN > 0) .. "#" .. tostring(msgs[#msgs] and msgs[#msgs].listen) .. "#" .. tostring(ns.Core.listening ~= nil)
  `, { KEY: 'ab'.repeat(32) }, FILES, FAKE_UI + PRELUDE_DRIVE + `
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 7, name = "ForeverAICompanion" } } end,
      SpeakText = function(id, text) SPOKEN[#SPOKEN + 1] = text end,
    }
  `);
  assert.equal(out, 'true#true#true', 'sent through the voice, listening, no combat refusal');
});

test('a slow question is sent again as text only: never a recording, never opening the window or the box', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.Compact:Set("enabled", true)
    local reqs = {}
    local build = ns.Core.BuildFrame
    ns.Core.BuildFrame = function(self, req, ...) reqs[#reqs + 1] = req; return build(self, req, ...) end
    local id = ns.Core:Ask("¿Qué mazmorra me conviene?")
    UNTIL_IDLE()
    local chat = ns.Chats:Current()
    local typed = chat.messages[#chat.messages]
    local shows, boxes = 0, 0
    local show, box = ns.UI.Show, ns.Compact.Show
    ns.UI.Show = function(...) shows = shows + 1; return show(...) end
    ns.Compact.Show = function(...) boxes = boxes + 1; return box(...) end
    typed.t = time() - 46
    ns.Core:HasPending()
    UNTIL_IDLE()
    local resent = reqs[#reqs]
    local r = { #reqs, tostring(resent.id == id), tostring(resent.listen), tostring(ns.Core.listening), shows, boxes }
    -- Called the way the upstream code calls it (the entry 4th): still not a recording.
    ns.Core:Ask(typed.question, nil, chat.id, typed)
    UNTIL_IDLE()
    r[#r + 1] = tostring(reqs[#reqs].listen) .. "," .. tostring(ns.Core.listening)
    -- A pending voice question is never sent again, and doesn't give up the voice.
    ns.Core.working = false
    local before = #reqs
    local voiceQ = { id = "1", question = "", status = "pending", t = time() - 46, viaVoice = true, listen = true }
    ns.Chats:AddMessage(chat, voiceQ)
    ns.Core:HasPending(); UNTIL_IDLE()
    r[#r + 1] = tostring(#reqs == before)
    voiceQ.t = time() - 151; ns.Core:HasPending()
    r[#r + 1] = voiceQ.status .. "," .. tostring(ns.Voice.broken)
    RESULT = table.concat(r, "#")
  `, {}, COMBAT_FILES, VOICE_ON);
  assert.equal(out, '2#true#nil#nil#0#0#nil,nil#true#error,nil');
});

test('the "thinking" bubble is big enough for every phrase it cycles through', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("rizzik")
    ns.Core:Ask("What now?")
    local b = ns.UI.bubbles[2]
    local textW = b.box.w - 20
    local worst = 0
    for _, phrase in ipairs(ns.Personas:Current().thinking) do
      b.text.w = textW
      b.text.textValue = phrase .. "..."
      worst = math.max(worst, b.text:GetStringHeight() + 16 - b.box.h)
    end
    RESULT = tostring(b.pending) .. "#" .. worst .. "#" .. textW
  `, {}, ALL_FILES, RECORD_TEXT.replace(
    'GetStringHeight" then return function() return 10 end end',
    'GetStringHeight" then return function(self) return 14 * math.max(1, math.ceil(#(self.textValue or "") * 6 / math.max(1, self.w))) end end')
    .replace('k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function() return 100 end end',
      'k == "GetStringWidth" or k == "GetUnboundedStringWidth" then return function(self) return #(self.textValue or "") * 6 end end')
    + PRELUDE_DRIVE);
  const [pending, worst] = out.split('#');
  assert.equal(pending, 'true');
  assert.ok(Number(worst) <= 0, `a phrase is ${worst} px taller than its box`);
});

test('a linked item goes in the context; the question keeps only its name; recipes are remembered', () => {
  const out = runLua(`
    START()
    GetTradeSkillLine = function() return "Cocina", 40, 75 end
    GetNumTradeSkills = function() return 1 end
    GetTradeSkillInfo = function() return "Lobo asado", "medium", 0 end
    ns.Core:RememberRecipes("trade")
    local dump = ASK("Is |cff1eff00|Hitem:9999::::|h[Anillo del alba]|h|r better?")
    RESULT = dump .. "#" .. ns.Chats:Current().messages[1].question
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [dump, shownQuestion] = out.split('#');
  const { req } = decodeDump(dump);
  assert.equal(req.question, 'Is [Anillo del alba] better?');
  assert.equal(shownQuestion, 'Is [Anillo del alba] better?');
  assert.equal(req.context.linkedItems[0].name, 'Anillo del alba');
  assert.equal(req.context.knownRecipes[0].profession, 'Cocina');
  assert.equal(req.context.knownRecipes[0].recipes[0].difficulty, 'yellow');
});

test('a big vendor list is shortened so the question still fits the on-screen strip', () => {
  const out = runLua(`
    START()
    GetMerchantNumItems = function() return 60 end
    GetMerchantItemInfo = function(i) return "Espada larga de mercader número " .. i, 0, 1000 + i, 1, -1, true, true, false end
    GetMerchantItemLink = function() return nil end
    ns.Collect.open.merchant = true
    RESULT = ASK("¿Qué le compro?")
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const { req } = decodeDump(out);
  const items = req.context.screen.merchant.items;
  assert.ok(items.length >= 1 && items.length <= 60, `${items.length} vendor items`);
  assert.equal(items[0].name, 'Espada larga de mercader número 1');
  assert.equal(req.question, '¿Qué le compro?');
});

test('links in the question bubble keep their color and open the item like in the chat', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    local REFS = {}
    SetItemRef = function(link, text, button) REFS[#REFS + 1] = link .. "/" .. button end
    ASK("Is |cnIQ3:|Hitem:9999::::|h[Anillo del alba]|h|r better than |cff1eff00|Hitem:3000|h[Arco]|h|r? 50|50")
    ns.UI:Refresh()
    local b = ns.UI.bubbles[1]
    b.box.scripts.OnHyperlinkClick(b.box, "item:9999::::", "[Anillo del alba]", "LeftButton")
    RESULT = b.text.textValue .. "#" .. ns.Chats:Current().messages[1].question .. "#" .. table.concat(REFS, ",")
  `, {}, ALL_FILES, RECORD_TEXT + PRELUDE_DRIVE);
  const [bubble, question, refs] = out.split('#');
  assert.equal(bubble, 'Is |cnIQ3:|Hitem:9999::::|h[Anillo del alba]|h|r better than |cff1eff00|Hitem:3000|h[Arco]|h|r? 50||50',
    'links stay working, any other "|" is shown literally');
  assert.equal(question, 'Is [Anillo del alba] better than [Arco]? 50|50', 'the AI and the chat list get plain text');
  assert.equal(refs, 'item:9999::::/LeftButton', 'clicking opens it like a chat link');
});

test('each answer shows the tokens it used, and the chat total sits under the text box', () => {
  const tip = `
    TIP = {}
    GameTooltip = { SetOwner = function() TIP = {} end, AddLine = function(_, s) TIP[#TIP + 1] = s end, Show = function() end, Hide = function() end }
  `;
  for (const [locale, meta, total, read] of [
    ['enUS', '  ·  18.2k tokens', 'This chat: 18.2k tokens', 'Read: 18,000 (from the cache: 12,000)'],
    ['esMX', '  ·  18,2k tokens', 'Este chat: 18,2k tokens', 'Leídos: 18.000 (de la caché: 12.000)'],
  ]) {
    const out = runLua(`
      START()
      ns.Personas:Set("fizzi")
      ns.UI:Show()
      ns.Core:Ask("primera")
      RUN_FRAMES(200)
      local chat = ns.Chats:Current()
      ns.Core:ApplyInbox({ answers = { { id = chat.messages[1].id, ok = true, answer = "uno", tokens = { i = 18000, c = 12000, o = 234 } } } })
      ns.Core:Ask("segunda")
      RUN_FRAMES(200)
      ns.Core:ApplyInbox({ answers = { { id = chat.messages[2].id, ok = true, answer = "dos" } } })
      ns.UI:Refresh()
      local b = ns.UI.bubbles[2]
      b.metaHover.scripts.OnEnter(b.metaHover)
      local tip1 = table.concat(TIP, "|")
      -- (the fake UI answers unknown fields with a function: "no table" means unset)
      local older = type(rawget(ns.UI.bubbles[4].metaHover, "tokens")) ~= "table" and not ns.UI.bubbles[4].meta.textValue:find("tokens")
      RESULT = table.concat({ b.meta.textValue:gsub("^%d+:%d+", ""), ns.UI.usage.textValue, tip1, tostring(older) }, "#")
    `, { locale }, ALL_FILES, `LOCALE = ${JSON.stringify(locale)}\n` + tip + RECORD_TEXT + PRELUDE_DRIVE);
    const [m, t, tipText, older] = out.split('#');
    assert.equal(m, meta, `${locale}: time · tokens under the answer`);
    assert.equal(t, total, `${locale}: the whole chat under the text box`);
    assert.match(tipText, new RegExp(read.replace(/[().]/g, '\\$&')));
    assert.equal(older, 'true', 'answers from apps that send no tokens show no count');
  }
});

test('items in the AI answer become links only when the id really is that item', () => {
  const items = `
    C_Item = {
      GetItemInfo = function(id)
        if id == 9999 then return "Anillo del alba", "|cff0070dd|Hitem:9999::::|h[Anillo del alba]|h|r" end
        if id == 1234 then return "Espada de bronce", "|cffffffff|Hitem:1234::::|h[Espada de bronce]|h|r" end
        return nil
      end,
      RequestLoadItemDataByID = function(id) REQUESTED = id end,
    }
  `;
  const out = runLua(`
    local answer = "Usa {{item:9999|anillo del alba}}, no {{item:1234|Hacha}}, y {{item:5555|Capa}}. 5|5"
    RESULT = ns.UI.RenderAnswer(answer) .. "#" .. tostring(ns.UI.waitingItems) .. "#" .. tostring(REQUESTED)
      .. "#" .. ns.UI.PlainAnswer(answer)
  `, {}, ALL_FILES, items + RECORD_TEXT + PRELUDE_DRIVE);
  const [shown, waiting, requested, plain] = out.split('#');
  assert.equal(shown, 'Usa |cff0070dd|Hitem:9999::::|h[Anillo del alba]|h|r, no Hacha, y Capa. 5||5',
    'right id: a link; wrong id or not loaded yet: just the name; other "|" shown literally');
  assert.equal(waiting, 'true', 'refreshes once the game loads the missing item');
  assert.equal(requested, '5555');
  assert.equal(plain, 'Usa [anillo del alba], no [Hacha], y [Capa]. 5|5');
});

// Voice questions: the talk key sends a "listen" request (with this PC's key
// and the character data) through the silent voice, the release sends a stop,
// and what the app heard becomes the question. Follow-ups continue the chat.
test('/ia talk: hold the key, speak, release; the transcript becomes the question', async () => {
  const { createAssembler } = await import('../src/voice-inbox.js');
  const KEY = 'cd'.repeat(32);
  const voiceApis = `
    SPOKEN = {}
    C_VoiceChat = {
      GetTtsVoices = function() return { { voiceID = 7, name = "ForeverAICompanion - English (United States)" } } end,
      SpeakText = function(id, text) SPOKEN[#SPOKEN + 1] = text end,
    }
  `;
  const out = runLua(`
    START()
    ns.requestKey = KEY
    local function sent() for i = 1, 4000 do if not ns.Core.working then return end RUN_FRAMES(1) end end
    -- Released before the request was even out: the stop follows it.
    ns.Core:TalkKey("down")
    local listeningWhileSending = tostring(ns.Core.listening ~= nil)
    ns.Core:TalkKey("up")
    sent()
    local msgs = ns.Chats:Current().messages
    local e = msgs[#msgs]
    local before = tostring(e.listen) .. "|" .. e.status .. "|" .. tostring(ns.Core.listening) .. "|" .. listeningWhileSending
    ns.Core:ApplyInbox({ answers = { { id = e.id, ok = true, answer = "Head to Westfall.", question = "Where do I go now?" } } })
    local after = e.question .. "|" .. e.status
    -- A follow-up by voice goes to the same chat with the earlier turn.
    ns.Core:ToggleListen()
    sent()
    ns.Core:ToggleListen()
    RESULT = table.concat(SPOKEN, "\\0") .. "#" .. before .. "#" .. after .. "#" .. #msgs
  `, { KEY }, FILES, FAKE_UI + PRELUDE_DRIVE + voiceApis);
  const [spoken, before, after, count] = out.split('#');
  const asm = createAssembler();
  const reqs = spoken.split('\0').map((s) => asm.add(s)).filter(Boolean).map((p) => JSON.parse(p.toString('utf8')));
  assert.equal(reqs.length, 4, 'listen, stop, listen, stop');
  const [listen, stop, followUp, stop2] = reqs;
  assert.equal(listen.listen, true);
  assert.equal(listen.question, '');
  const code = (id) => crypto.createHmac('sha256', KEY).update(id).digest('hex');
  assert.equal(listen.auth, code(listen.id), 'carries the code of its id, made with this PC\'s key');
  assert.ok(!JSON.stringify(reqs).includes(KEY), 'the key itself is never sent');
  assert.ok(listen.context?.character, 'with the character data, like a typed question');
  assert.deepEqual([stop.listenStop, stop.auth, stop.question], [listen.id, code(`${listen.id}s`), '']);
  assert.equal(stop.context, undefined, 'the stop is tiny');
  assert.equal(before, 'true|pending|nil|true');
  assert.equal(after, 'Where do I go now?|done');
  assert.deepEqual(followUp.history.at(-1), { q: 'Where do I go now?', a: 'Head to Westfall.' }, 'follow-ups see the earlier turn');
  assert.equal(stop2.listenStop, followUp.id);
  // Held key: the app waits for the release. Talk clicked: it ends at a pause.
  assert.equal(listen.hold, true);
  assert.equal(followUp.hold, undefined);
  assert.equal(count, '2');
});

test('the request code: the addon\'s SHA-256 and HMAC-SHA256 match Node\'s', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const ids = ['17634000001234', '17634000001234s', '1', ''];
  const msgs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(200), 'ñandú ü'];
  const out = runLua(`
    local function hex(s) return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end
    local r = {}
    ns.requestKey = KEY
    for id in string.gmatch(IDS, "([^,]*),") do r[#r + 1] = ns.Core:AuthCode(id) end
    for m in string.gmatch(MSGS, "([^\\1]*)\\1") do r[#r + 1] = hex(ns.Core.Sha256(m)) end
    ns.requestKey = nil
    r[#r + 1] = tostring(ns.Core:AuthCode("1"))
    RESULT = table.concat(r, " ")
  `, { KEY: key, IDS: ids.map((i) => `${i},`).join(''), MSGS: msgs.map((m) => `${m}\u0001`).join('') }, FILES, FAKE_UI + PRELUDE_DRIVE);
  const want = [
    ...ids.map((id) => crypto.createHmac('sha256', key).update(id).digest('hex')),
    ...msgs.map((m) => crypto.createHash('sha256').update(Buffer.from(m, 'utf8')).digest('hex')),
    'nil',
  ];
  assert.deepEqual(out.split(' '), want);
});

test('/ia talk without invisible sending explains it and sends nothing', () => {
  const out = runLua(`
    START()
    STATUS = ""
    local setStatus = ns.UI.SetStatus
    ns.UI.SetStatus = function(self, s) STATUS = s; return setStatus(self, s) end
    ns.Core:Listen()
    RUN_FRAMES(50)
    RESULT = STATUS .. "#" .. #ns.Chats:Current().messages .. "#" .. tostring(ns.Uplink.grid and ns.Uplink.grid.shown)
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [status, count, strip] = out.split('#');
  assert.match(status, /need invisible sending/);
  assert.equal(count, '0');
  assert.notEqual(strip, 'true', 'never through the on-screen line');
});

test('the talk key has its own section in Key Bindings, with a name the addon sets', () => {
  const xml = fs.readFileSync(path.join(ADDON_SRC, 'Bindings.xml'), 'utf8');
  const binding = /<Binding\s+([^>]*)>\s*([^<]*?)\s*<\/Binding>/.exec(xml);
  assert.ok(binding, 'one binding');
  const attrs = Object.fromEntries([...binding[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  assert.equal(attrs.name, 'FOREVERAICOMPANION_TALK');
  assert.equal(attrs.category, 'Forever AI Companion', 'own section, like Questie');
  assert.equal(attrs.header, undefined, 'a header shows as a dead, bindable row in this client');
  assert.equal(attrs.runOnUp, 'true', 'key release stops the recording');
  assert.equal(binding[2], 'ForeverAICompanion_Talk(keystate)');
  const core = fs.readFileSync(path.join(ADDON_SRC, 'Core.lua'), 'utf8');
  assert.match(core, /BINDING_NAME_FOREVERAICOMPANION_TALK = L\.BINDING_TALK/);
  assert.match(core, /function ForeverAICompanion_Talk\(keystate\)/);
});

// The chat window dims while the character moves, with settings in Options > AddOns.
const FADE_FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Fade.lua', 'Compact.lua', 'Options.lua', 'Button.lua', 'Notify.lua', 'Core.lua'];
const FADE_APIS = `
  SPEED = 0; TAXI = false
  GetUnitSpeed = function(unit) assert(unit == "player"); return SPEED end
  UnitOnTaxi = function() return TAXI end
  REG = {}
  Settings = {
    RegisterCanvasLayoutCategory = function(panel, name) REG.cat = { ID = 42, name = name, panel = panel }; return REG.cat end,
    RegisterAddOnCategory = function(c) REG.added = c end,
    OpenToCategory = function(id) REG.opened = id end,
  }
  function TICK(sec) for i = 1, math.floor(sec / 0.05 + 0.5) do NOW = NOW + 0.05; ns.Fade:Update(0.05) end end
  function A() return string.format("%.2f", ns.UI.frame:GetAlpha()) end
`;

test('the chat window dims while moving and comes back after the delay, unless it is in use', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    local r = {}
    local function note(name) r[#r + 1] = name .. "=" .. A() end
    TICK(0.3); note("standing")
    SPEED = 7; TICK(0.6); note("moving")
    SPEED = 0; TICK(0.5); note("stopped0.5")
    TICK(0.8); note("stopped1.3")
    TICK(0.9); note("stopped2.2")
    -- Opened on the move: full until the next stop, then dims as usual.
    SPEED = 7; ns.Fade:Reset(); TICK(0.6); note("openedMoving")
    SPEED = 0; TICK(0.2); SPEED = 7; TICK(0.6); note("movingAgain")
    -- In use: mouse over, typing, asking by voice.
    ns.UI.frame.IsMouseOver = function() return true end; TICK(0.5); note("mouseOver")
    ns.UI.frame.IsMouseOver = function() return false end
    ns.UI.input.HasFocus = function() return true end; TICK(0.5); note("typing")
    ns.UI.input.HasFocus = function() return false end
    ns.Core.listening = { id = "x" }; TICK(0.5); note("talking"); ns.Core.listening = nil
    TAXI = true; TICK(0.5); note("taxi"); TAXI = false
    TICK(0.6); note("movingOnFoot")
    ns.Fade:Set("enabled", false); TICK(0.5); note("off")
    RESULT = table.concat(r, " ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  const got = Object.fromEntries(out.split(' ').map((p) => p.split('=')));
  assert.deepEqual(got, {
    standing: '1.00', moving: '0.50', 'stopped0.5': '0.50', 'stopped1.3': '1.00', 'stopped2.2': '1.00',
    openedMoving: '1.00', movingAgain: '0.50',
    mouseOver: '1.00', typing: '1.00', talking: '1.00', taxi: '1.00', movingOnFoot: '0.50', off: '1.00',
  });
});

test('fade settings: kept in range, previewed when changed, and on a page in Options > AddOns', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    local r = {}
    local s = ns.Fade:Settings()
    r[#r + 1] = s.enabled and "on" or "off"
    local function pair(s) return string.format("%g/%g", s.opacity, s.delay) end
    r[#r + 1] = pair(s)
    ns.db.fade.opacity, ns.db.fade.delay = 3, 12;  r[#r + 1] = pair(ns.Fade:Settings())
    ns.db.fade.opacity, ns.db.fade.delay = 99, 0.7; r[#r + 1] = pair(ns.Fade:Settings())
    ns.db.fade.opacity = 47; r[#r + 1] = string.format("%g", ns.Fade:Settings().opacity)
    -- Registered once the saved settings loaded.
    r[#r + 1] = tostring(REG.cat and REG.cat.name) .. "|" .. tostring(REG.added == REG.cat)
    -- The page's controls change the settings; a new opacity is shown on the window for a moment.
    local c = ns.Options.controls
    c.opacity:GetScript("OnValueChanged")(c.opacity, 30)
    TICK(0.5); r[#r + 1] = "preview=" .. A()
    TICK(1.5); r[#r + 1] = "after=" .. A()
    c.delay:GetScript("OnValueChanged")(c.delay, 2.5)
    c.enabled.GetChecked = function() return false end
    c.enabled:GetScript("OnClick")(c.enabled)
    r[#r + 1] = string.format("%g/%g/%s", ns.db.fade.opacity, ns.db.fade.delay, tostring(ns.db.fade.enabled))
    -- Gear, /ia options and /ia opciones open it.
    REG.opened = nil; SlashCmdList.FOREVERAICOMPANION("options"); r[#r + 1] = "slash=" .. tostring(REG.opened)
    REG.opened = nil; SlashCmdList.FOREVERAICOMPANION("opciones"); r[#r + 1] = "es=" .. tostring(REG.opened)
    RESULT = table.concat(r, " ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  assert.equal(out, 'on 50/1 10/10 95/0.5 45 Forever AI Companion|true preview=0.30 after=1.00 30/2.5/false slash=42 es=42');
});

test('without the Settings API the page goes into the older Interface Options', () => {
  const out = runLua(`
    Settings = nil
    ADDED = {}; OPENED = 0
    InterfaceOptions_AddCategory = function(panel) ADDED[#ADDED + 1] = panel.name end
    InterfaceOptionsFrame_OpenToCategory = function() OPENED = OPENED + 1 end
    START()
    ns.Options:Init()
    SlashCmdList.FOREVERAICOMPANION("options")
    RESULT = table.concat(ADDED, ",") .. "|" .. OPENED
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  assert.equal(out, 'Forever AI Companion|2', 'registered once, opened');
});

test('the chat window also dims in combat, with its own opacity and delay; the lower opacity wins', () => {
  const out = runLua(`
    COMBAT = false
    UnitAffectingCombat = function(unit) return COMBAT end
    InCombatLockdown = function() return COMBAT end
    START()
    -- Moving set apart from combat (60%, 1 s), so the lower-opacity rule shows.
    ns.db.fade = { v = 2, opacity = 60, delay = 1 }
    ns.UI:Show()
    local r = {}
    local function note(name) r[#r + 1] = name .. "=" .. A() end
    COMBAT = true; TICK(0.6); note("fighting")
    SPEED = 7; TICK(0.3); note("fightingMoving")
    COMBAT = false; TICK(0.6); note("leftCombatMoving")
    -- Seconds since the fight ended: 0.6 moving, then stopped.
    SPEED = 0; TICK(0.6); note("afterCombat1.2")
    TICK(0.5); note("afterCombat1.7")
    TICK(0.6); note("afterCombat2.3")
    -- Hovering in a fight shows it.
    COMBAT = true; TICK(0.6)
    ns.UI.frame.IsMouseOver = function() return true end; TICK(0.5); note("mouseOver")
    ns.UI.frame.IsMouseOver = function() return false end
    -- Opened mid-fight: full until the fight ends.
    ns.Fade:Reset(); TICK(0.6); note("openedInCombat")
    COMBAT = false; TICK(0.2); COMBAT = true; TICK(0.6); note("nextFight")
    -- The combat warning instead of dimming (unticking "dim in combat" picks it):
    -- fully visible for the whole fight, moving too; after it, moving dims again.
    ns.Fade:Set("combat", false); TICK(0.6); note("warn")
    SPEED = 7; TICK(0.6); note("warnMoving")
    COMBAT = false; TICK(0.6); note("warnAfterFightMoving")
    RESULT = table.concat(r, " ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  const got = Object.fromEntries(out.split(' ').map((p) => p.split('=')));
  assert.deepEqual(got, {
    fighting: '0.30', fightingMoving: '0.30', leftCombatMoving: '0.30',
    'afterCombat1.2': '0.30', 'afterCombat1.7': '0.30', 'afterCombat2.3': '1.00',
    mouseOver: '1.00', openedInCombat: '1.00', nextFight: '0.30',
    warn: '1.00', warnMoving: '1.00', warnAfterFightMoving: '0.60',
  });
});

test('combat settings: their own section of the page, kept in range and previewed', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    local r = {}
    local s = ns.Fade:Settings()
    r[#r + 1] = string.format("%s %g/%g", tostring(s.combat), s.combatOpacity, s.combatDelay)
    ns.db.fade.combatOpacity, ns.db.fade.combatDelay = 0, 99
    s = ns.Fade:Settings(); r[#r + 1] = string.format("%g/%g", s.combatOpacity, s.combatDelay)
    local c = ns.Options.combatControls
    c.opacity:GetScript("OnValueChanged")(c.opacity, 20)
    TICK(0.5); r[#r + 1] = "preview=" .. A()
    TICK(1.5); r[#r + 1] = "after=" .. A()
    c.delay:GetScript("OnValueChanged")(c.delay, 3.5)
    c.enabled.GetChecked = function() return false end
    c.enabled:GetScript("OnClick")(c.enabled)
    s = ns.Fade:Settings()
    r[#r + 1] = string.format("%g/%g/%s", s.combatOpacity, s.combatDelay, tostring(s.combat))
    r[#r + 1] = string.format("moving untouched %s %g/%g", tostring(s.enabled), s.opacity, s.delay)
    r[#r + 1] = "saved=" .. tostring(ns.db.fade.opacity) .. "/" .. tostring(ns.db.fade.delay)
    RESULT = table.concat(r, " | ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  assert.equal(out, 'true 30/2 | 10/10 | preview=0.20 | after=1.00 | 20/3.5/false | moving untouched true 50/1 | saved=nil/nil');
});

test('settings saved before combat dimming existed keep working', () => {
  const out = runLua(`
    START()
    ns.db.fade = { enabled = false, opacity = 75, delay = 4 }
    local s = ns.Fade:Settings()
    RESULT = string.format("%s %g/%g %s %g/%g", tostring(s.enabled), s.opacity, s.delay, tostring(s.combat), s.combatOpacity, s.combatDelay)
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  assert.equal(out, 'false 75/4 true 30/2');
});

test('only changed fade settings are saved, so new defaults reach everyone else', () => {
  const out = runLua(`
    START()
    local r = {}
    -- What the 1.12.0 to 1.13.0 test builds saved without the player choosing it.
    ns.db.fade = { enabled = true, opacity = 60, delay = 1, combat = true, combatOpacity = 30, combatDelay = 2 }
    local s = ns.Fade:Settings()
    r[#r + 1] = string.format("migrated %g/%g", s.opacity, s.delay)
    local keys = {}
    for k in pairs(ns.db.fade) do keys[#keys + 1] = k end
    table.sort(keys)
    r[#r + 1] = "left=" .. table.concat(keys, ",")
    -- Choices made in a test build (anything but those values) are kept.
    ns.db.fade = { opacity = 45, combat = false }
    s = ns.Fade:Settings()
    r[#r + 1] = string.format("kept %g %s", s.opacity, tostring(s.combat))
    -- From now on a choice is kept even if it equals an old default.
    ns.Fade:Set("opacity", 60)
    r[#r + 1] = string.format("chosen %g", ns.Fade:Settings().opacity)
    -- A later default change reaches settings the player never touched.
    ns.Fade.DEFAULTS.combatDelay = 3
    r[#r + 1] = string.format("newDefault %g", ns.Fade:Settings().combatDelay)
    RESULT = table.concat(r, " | ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  assert.equal(out, 'migrated 50/1 | left=v | kept 45 false | chosen 60 | newDefault 3');
});

// Compact answers: a small box instead of the window, gone after a while.
const COMPACT_APIS = `
  SPOKEN = {}
  C_VoiceChat = {
    GetTtsVoices = function() return { { voiceID = 7, name = "ForeverAICompanion - English (United States)" } } end,
    SpeakText = function(id, text) SPOKEN[#SPOKEN + 1] = text end,
  }
  GetItemInfo = function(id)
    if tonumber(id) == 9999 then return "Leotardos", "|cff1eff00|Hitem:9999::::::::|h[Leotardos]|h|r" end
  end
  function SENT() for i = 1, 4000 do if not ns.Core.working then return end RUN_FRAMES(1) end end
  function STEP(sec) for i = 1, math.floor(sec / 0.1 + 0.5) do NOW = NOW + 0.1; ns.Compact:Update(0.1) end end
  function LAST() local m = ns.Chats:Current().messages; return m[#m] end
`;

test('compact answers: a voice question shows a small box, not the window, and it goes away by itself', () => {
  const out = runLua(`
    START()
    ns.requestKey = "k"
    ns.Compact:Set("enabled", true)
    local r = {}
    ns.Core:TalkKey("down")
    SENT()
    STEP(0.3)
    r[#r + 1] = "window=" .. tostring(ns.UI:IsShown()) .. " box=" .. tostring(ns.Compact:IsShown()) .. " " .. ns.Compact.view.state
    ns.Core:TalkKey("up")
    STEP(0.3)
    r[#r + 1] = ns.Compact.view.state
    local e = LAST()
    ns.Core:ApplyInbox({ answers = { { id = e.id, ok = true, answer = "Wear {{item:9999|Leotardos}} now.", question = "What should I wear?" } } })
    local v = ns.Compact.view
    r[#r + 1] = v.state .. "|" .. tostring(v.asked) .. "|" .. tostring(v.body:find("|Hitem:9999", 1, true) ~= nil)
    r[#r + 1] = "unread=" .. tostring(ns.Chats:Current().unread) .. " inChat=" .. tostring(LAST().answer:find("Leotardos", 1, true) ~= nil)
    -- 20 s by default; the mouse on it keeps it up, then 5 s more after it leaves.
    STEP(15); r[#r + 1] = "15s=" .. tostring(ns.Compact:IsShown())
    ns.Compact.frame.IsMouseOver = function() return true end
    STEP(30); r[#r + 1] = "hovered45s=" .. tostring(ns.Compact:IsShown()) .. "@" .. string.format("%.2f", ns.Compact.frame:GetAlpha())
    ns.Compact.frame.IsMouseOver = function() return false end
    STEP(4); r[#r + 1] = "left4s=" .. tostring(ns.Compact:IsShown())
    STEP(1.5); r[#r + 1] = "left5.5s=" .. tostring(ns.Compact:IsShown())
    RESULT = table.concat(r, " ; ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + COMPACT_APIS);
  assert.equal(out, [
    'window=false box=true listening',
    'pending',
    'done|What should I wear?|true',
    'unread=true inChat=true',
    '15s=true',
    'hovered45s=true@1.00',
    'left4s=true',
    'left5.5s=false',
  ].join(' ; '));
});

test('compact answers: an answer arriving with the window closed goes to the box; the window and "Open in chat" take over', () => {
  const out = runLua(`
    START()
    local r = {}
    -- Asked in the window, then closed it before the answer came.
    ns.UI:Show()
    ns.Core:Ask("Where is Westfall?")
    SENT()
    local e = LAST()
    ns.UI.frame:Hide()
    ns.Core:ApplyInbox({ answers = { { id = e.id, ok = true, answer = "South of Elwynn." } } })
    r[#r + 1] = "off: card=" .. tostring(ns.Notify.cards and ns.Notify.cards[1] and ns.Notify.cards[1]:IsShown()) .. " box=" .. tostring(ns.Compact:IsShown())
    ns.Notify:HideAll()
    ns.Compact:Set("enabled", true)
    ns.UI:Show()
    ns.Core:Ask("And Duskwood?")
    SENT()
    e = LAST()
    ns.UI.frame:Hide()
    ns.Core:ApplyInbox({ answers = { { id = e.id, ok = true, answer = "East of Westfall." } } })
    r[#r + 1] = "on: card=" .. tostring(ns.Notify.cards[1]:IsShown()) .. " box=" .. tostring(ns.Compact:IsShown()) .. " " .. tostring(ns.Compact.view.asked)
    -- Opening the window hides the box (it shows the same answer).
    ns.UI:Show(); ns.UI.frame:GetScript("OnShow")(ns.UI.frame)
    r[#r + 1] = "windowOpened: box=" .. tostring(ns.Compact:IsShown())
    -- "Open in chat" opens that chat.
    ns.UI.frame:Hide()
    local chatId = ns.Chats:Current().id
    ns.Chats:New()
    ns.Compact:Show(e, ns.Chats:Get(chatId))
    ns.Compact:OpenChat()
    r[#r + 1] = "open: window=" .. tostring(ns.UI:IsShown()) .. " box=" .. tostring(ns.Compact:IsShown()) .. " sameChat=" .. tostring(ns.db.currentChat == chatId)
    RESULT = table.concat(r, " ; ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + COMPACT_APIS);
  assert.equal(out, [
    'off: card=true box=false',
    'on: card=false box=true And Duskwood?',
    'windowOpened: box=false',
    'open: window=true box=false sameChat=true',
  ].join(' ; '));
});

test('compact answers: problems show in the box, and the settings are on the options page and /ia compact', () => {
  const out = runLua(`
    START()
    local r = {}
    ns.Compact:Set("enabled", true)
    -- A problem (a question still being sent) shows in the box, which then goes away.
    ns.Core.working = true
    ns.Core:Listen()
    r[#r + 1] = "busy: window=" .. tostring(ns.UI:IsShown()) .. " " .. ns.Compact.view.state .. " " .. tostring(ns.Compact.view.body:find(ns.L.WAIT_PREVIOUS, 1, true) ~= nil)
    STEP(6.5); r[#r + 1] = "gone=" .. tostring(not ns.Compact:IsShown())
    ns.Core.working = false
    -- Settings: 20 s by default, 5 to 60 in steps of 5; only changes are saved.
    local s = ns.Compact:Settings()
    r[#r + 1] = string.format("%s %d", tostring(s.enabled), s.seconds)
    ns.db.compact.seconds = 3;  r[#r + 1] = tostring(ns.Compact:Settings().seconds)
    ns.db.compact.seconds = 99; r[#r + 1] = tostring(ns.Compact:Settings().seconds)
    ns.db.compact.seconds = nil
    local c = ns.Options.compactControls
    c.seconds:GetScript("OnValueChanged")(c.seconds, 35)
    r[#r + 1] = "slider=" .. tostring(ns.db.compact.seconds)
    c.enabled.GetChecked = function() return false end
    c.enabled:GetScript("OnClick")(c.enabled)
    r[#r + 1] = "box=" .. tostring(ns.Compact:Settings().enabled)
    SlashCmdList.FOREVERAICOMPANION("compact");  r[#r + 1] = tostring(ns.Compact:Settings().enabled)
    SlashCmdList.FOREVERAICOMPANION("compacto"); r[#r + 1] = tostring(ns.Compact:Settings().enabled)
    RESULT = table.concat(r, " ; ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + COMPACT_APIS);
  assert.equal(out, 'busy: window=false message true ; gone=true ; true 20 ; 5 ; 60 ; slider=35 ; box=false ; true ; false');
});

// The window's style: the game's own art (default) or flat and minimal.
const LOOK = `
  local function rgb(c) return c and string.format("%.2f,%.2f,%.2f", c[1], c[2], c[3]) or "nil" end
  function LOOK(name)
    local U = ns.UI
    local row, bubble = U.rows[1], U.bubbles[1]
    return table.concat({
      name, U:Theme(),
      "banner=" .. tostring(U.banner.shown),
      "close=" .. tostring(U.closeButton.shown) .. "/" .. tostring(U.flatClose.shown),
      "ring=" .. tostring(U.portrait.ring.shown),
      "side=" .. rgb(U.side.bg),
      "composer=" .. rgb(U.composer.bg),
      "send=" .. tostring(U.sendButton.flatBg.shown) .. ":" .. rgb(U.sendButton.flatBg.color),
      "line=" .. rgb(U.headerLine.color),
      "row=" .. tostring(row.selected.shown) .. "/" .. tostring(row.flatSel.shown) .. "/" .. tostring(row.flatBar.shown),
      "you=" .. rgb(bubble.box.bg),
    }, " ")
  end
`;
const WOW_LOOK = 'banner=true close=true/false ring=true side=0.00,0.00,0.00 composer=0.00,0.00,0.00 send=false:0.17,0.45,0.88 line=0.78,0.64,0.38 row=true/false/false you=0.09,0.27,0.34';
const FLAT_LOOK = 'banner=false close=false/true ring=false side=0.09,0.10,0.12 composer=0.05,0.06,0.07 send=true:0.17,0.45,0.88 line=0.20,0.22,0.26 row=false/true/true you=0.12,0.27,0.48';

test('window style: the WoW look by default; flat and minimal from the options, at once and both ways', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    ns.Core:Ask("¿Qué hago ahora?")
    ns.UI:Refresh()
    local r = { LOOK("default") }
    -- Options > AddOns > Forever AI Companion > Window style.
    local t = ns.Options.themeControls
    t.flat:GetScript("OnClick")(t.flat)
    r[#r + 1] = LOOK("flat")
    r[#r + 1] = "saved=" .. tostring(ns.db.ui.theme) .. " boxes=" .. tostring(t.wow.checked) .. "/" .. tostring(t.flat.checked)
    t.wow:GetScript("OnClick")(t.wow)
    r[#r + 1] = LOOK("back")
    RESULT = table.concat(r, "|")
  `, {}, COMBAT_FILES, FAKE_UI + PRELUDE_DRIVE + LOOK + `
    CHECKED = {}
  `);
  const [first, flat, saved, back] = out.split('|');
  assert.equal(first, `default wow ${WOW_LOOK}`);
  assert.equal(flat, `flat flat ${FLAT_LOOK}`, 'every part repainted, without /reload');
  assert.match(saved, /^saved=flat/);
  assert.equal(back, `back wow ${WOW_LOOK}`, 'and back to the game\'s art');
});

test('window style: a saved flat look is there when the window first opens, the copy window too', () => {
  const out = runLua(`
    ForeverAICompanion_DB = { ui = { theme = "flat" } }
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    ns.Core:Ask("¿Qué hago ahora?")
    ns.UI:Refresh()
    ns.UI:ShowCopy("texto")
    RESULT = LOOK("login")
  `, {}, COMBAT_FILES, FAKE_UI + PRELUDE_DRIVE + LOOK);
  assert.equal(out, `login flat ${FLAT_LOOK}`);
});

test('at a flight master the addon keeps which flight points the player has, and sends both lists', () => {
  const out = runLua(`
    Enum = { FlightPathState = { Current = 0, Reachable = 1, Unreachable = 2 }, UIMapType = { Continent = 2 } }
    local maps = { [1437] = { name = "Wetlands", mapType = 3, parentMapID = 1415 }, [1415] = { name = "Eastern Kingdoms", mapType = 2 } }
    C_Map = { GetBestMapForUnit = function() return 1437 end, GetMapInfo = function(id) return maps[id] end }
    UnitFactionGroup = function() return "Alliance" end
    local nodes = {
      { nodeID = 7, name = "Menethil Harbor, Wetlands", state = 0 },
      { nodeID = 8, name = "Thelsamar, Loch Modan", state = 2 },
    }
    C_TaxiMap = {
      GetAllTaxiNodes = function() return nodes end,
      GetTaxiNodesForMap = function(id)
        if id == 1415 then return { { nodeID = 7, name = nodes[1].name, faction = 2 }, { nodeID = 8, name = nodes[2].name, faction = 2 } } end
      end,
    }
    START()
    local function fire(event) for _, f in ipairs(FRAMES) do if f.scripts.OnEvent then f.scripts.OnEvent(f, event) end end end
    fire("TAXIMAP_OPENED")
    local first = ns.Json.Encode(ns.Collect:Snapshot().flightPaths)
    -- Thelsamar discovered: the next flight master's map there replaces what was seen.
    nodes[2].state = 1
    fire("TAXIMAP_OPENED")
    RESULT = first .. "#" .. ns.Json.Encode(ns.Collect:Snapshot().flightPaths)
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  const [first, second] = out.split('#').map((j) => JSON.parse(j));
  for (const list of [first, second]) {
    assert.match(list[0].seenAt, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    delete list[0].seenAt;
  }
  assert.deepEqual(first, [{ continent: 'Eastern Kingdoms', known: ['Menethil Harbor, Wetlands'], notKnown: ['Thelsamar, Loch Modan'] }]);
  assert.deepEqual(second, [{ continent: 'Eastern Kingdoms', known: ['Menethil Harbor, Wetlands', 'Thelsamar, Loch Modan'] }]);
});

test('a blank realm name (Forever build 71037): data kept by character GUID, the old stores merged in once', () => {
  const out = runLua(`
    -- Before: "Name-Realm" keys; since the patch the realm is blank ("Sharp-").
    ForeverAICompanion_DB = {
      chars = {
        ["Sharp-Forever"] = {
          bank = { seenAt = "2026-11-18 16:40", items = { { name = "Silk Cloth", count = 73 } } },
          flights = { [1415] = { seenAt = "2026-11-18 16:55", known = { { name = "Tarren Mill" } } } },
          questsDone = { [100] = { t = "Old Quest" } }, turnedIn = { "Old Quest" }, acked = { gear = "h1" },
        },
        ["Sharp-"] = {
          bank = { seenAt = "2026-11-21 11:07", items = { { name = "Silk Cloth", count = 89 } } },
          flights = { [1414] = { seenAt = "2026-11-21 11:26", known = { { name = "Thunder Bluff" } } } },
          questsDone = { [200] = { t = "New Quest", d = "2026-11-21" } }, turnedIn = { "New Quest" }, acked = { gear = "h2" },
        },
        ["Other-Forever"] = { bank = { seenAt = "2026-11-10 10:00", items = {} } },
      },
      prices = {
        ["Forever-Horde"] = { [4306] = { name = "Silk Cloth", unit = 100, seenAt = "2026-11-16 12:00" },
                              [2772] = { name = "Iron Ore", unit = 238, seenAt = "2026-11-17 18:52" } },
        ["-Horde"] = { [4306] = { name = "Silk Cloth", unit = 175, seenAt = "2026-11-20 17:57" } },
        ["Forever-Alliance"] = { [858] = { name = "Lesser Healing Potion", unit = 25, seenAt = "2026-11-16 12:00" } },
      },
      personas = { ["Sharp-Forever"] = "fizzi" },
    }
    GetRealmName = function() return "" end
    UnitGUID = function(unit) if unit == "player" then return "Player-6932-005792F1" end end
    UnitFactionGroup = function() return "Horde" end
    START()
    local d = ns.Core:CharData()
    local chars, prices = ns.db.chars, ns.Core:Prices()
    local r = {
      ns.Core.CharKey(), tostring(d.guid), tostring(d.bank.items[1].count),
      tostring(d.flights[1414] ~= nil) .. "/" .. tostring(d.flights[1415] ~= nil),
      d.questsDone[100].t .. "/" .. d.questsDone[200].t, table.concat(d.turnedIn, ","), tostring(d.acked),
      table.concat(d.oldRealms, ","),
      tostring(chars["Sharp-Forever"]) .. "/" .. tostring(chars["Sharp-"]) .. "/" .. tostring(chars["Other-Forever"] ~= nil),
      prices[4306].unit .. "/" .. prices[2772].unit,
      tostring(ns.db.prices["Forever-Horde"]) .. "/" .. tostring(ns.db.prices["-Horde"]) .. "/" .. tostring(ns.db.prices["Forever-Alliance"] ~= nil),
      tostring(ns.Personas:Current() == ns.Personas.list.fizzi) .. "/" .. tostring(ns.db.personas["Sharp-Forever"]),
      tostring(ns.Collect:Snapshot().character.realm),
    }
    RESULT = table.concat(r, " | ")
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE);
  assert.equal(out, [
    'Player-6932-005792F1', 'Player-6932-005792F1',
    '89', // the newer bank copy
    'true/true', // both continents' flight points
    'Old Quest/New Quest', 'New Quest,Old Quest', // turn-ins: all of them; the last ones, newer first
    'nil', // everything sent once to the app
    'Forever,', // where they came from (the old realm, then the blank one)
    'nil/nil/true', // the old stores are gone; another character's stays
    '175/238', // prices: the newer one per item
    'nil/nil/true', // old price keys gone; the other faction's stays
    'true/nil', // the chosen assistant moved over
    'nil', // no blank realm in the data
  ].join(' | '));
});

test('the bank is remembered as it is left: changes in its bags count, and closing it keeps what was seen', () => {
  const out = runLua(`
    START()
    -- The bank: its main slots (-1) and a bag inside it (5).
    local SILK, WOOL = "|Hitem:4306::::|h[Silk Cloth]|h", "|Hitem:2592::::|h[Wool Cloth]|h"
    BANK = { [-1] = { { SILK, 20 } }, [5] = { { SILK, 53 }, { WOOL, 40 } } }
    C_Container = {
      GetContainerNumSlots = function(bag) return BANK[bag] and 2 or 0 end,
      GetContainerItemInfo = function(bag, slot)
        local e = BANK[bag] and BANK[bag][slot]
        if e then return { hyperlink = e[1], stackCount = e[2] } end
      end,
    }
    local function seen()
      local out = {}
      for _, it in ipairs(ns.Core:CharData().bank.items) do out[#out + 1] = it.name .. "=" .. it.count end
      table.sort(out)
      return "[" .. table.concat(out, ",") .. "]"
    end
    FIRE("BANKFRAME_OPENED")
    local r = { seen() }
    -- 53 silk taken out of the bag inside the bank: only the bag changes.
    BANK[5][1] = nil
    FIRE("BAG_UPDATE_DELAYED")
    r[#r + 1] = seen()
    -- Closed: the game hides the bank. Bag changes elsewhere don't touch what was seen.
    FIRE("BANKFRAME_CLOSED")
    BANK = {}
    FIRE("BAG_UPDATE_DELAYED")
    r[#r + 1] = seen()
    -- Opened again and emptied: an empty bank is remembered too (not right at opening,
    -- when an empty read may be the bank still loading).
    FIRE("BANKFRAME_OPENED")
    r[#r + 1] = seen()
    FIRE("PLAYERBANKSLOTS_CHANGED")
    r[#r + 1] = seen()
    RESULT = table.concat(r, " ")
  `, {}, FILES, FAKE_UI + PRELUDE_DRIVE + `
    GetItemInfo = function(link) return link:match("%[(.-)%]"), link, 1 end -- read when the addon loads
  `);
  assert.equal(out, '[Silk Cloth=73,Wool Cloth=40] [Silk Cloth=20,Wool Cloth=40] [Silk Cloth=20,Wool Cloth=40] [Silk Cloth=20,Wool Cloth=40] []');
});

// Quest help (QuestHelp.lua) with a fake QuestieDB: a level 25 Undead
// paladin of the Horde in Ashenvale (area 331), at 50, 50.
const QUEST_FILES = ['Locale.lua', 'Json.lua', 'Collect.lua', 'QuestHelp.lua', 'Uplink.lua', 'Voice.lua', 'Live.lua', 'Chats.lua', 'Personas.lua', 'UI.lua', 'Button.lua', 'Notify.lua', 'Core.lua'];
const QUESTIE = `
  UnitLevel = function() return 25 end
  UnitRace = function() return "Undead", "Scourge", 5 end
  UnitClass = function() return "Paladin", "PALADIN" end
  UnitFactionGroup = function() return "Horde", "Horda" end
  ZONE = "Ashenvale"
  GetRealZoneText = function() return ZONE end
  GetZoneText = function() return ZONE end
  local areas = { [331] = "Ashenvale", [17] = "The Barrens", [406] = "Stonetalon Mountains", [405] = "Desolace", [400] = "Thousand Needles", [1637] = "Orgrimmar" }
  -- The player's map is in Kalimdor; here Stonetalon is on another continent.
  C_Map = {
    GetAreaInfo = function(id) return areas[id] end,
    GetBestMapForUnit = function() return 1440 end,
    GetMapInfo = function(id)
      if id == 1414 then return { name = "Kalimdor", mapType = 2 } end
      if id == 1441 then return { name = "Thousand Needles", mapType = 3, parentMapID = 1414 } end
      return { name = ZONE, mapType = 3, parentMapID = 1414 }
    end,
    GetMapChildrenInfo = function(id)
      if id ~= 1414 then return {} end
      return { { name = "Ashenvale" }, { name = "The Barrens" }, { name = "Desolace" }, { name = "Thousand Needles" }, { name = "Orgrimmar" } }
    end,
    GetPlayerMapPosition = function() return { GetXY = function() return 0.5, 0.5 end } end,
  }
  -- Questie, ready: its own check hides "Pickup Elsewhere" (as if blacklisted).
  Questie = { API = { isReady = true, RegisterOnReady = function(callback) READY = callback end } }
  QuestieLoader = { ImportModule = function(_, name)
    if name == "QuestieDB" then return { IsDoable = function(id) return id ~= 119 end } end
    return {}
  end }
  LOG = {
    { header = "Ashenvale" }, { id = 6571, title = "Warsong Supplies" },
    { header = "The Barrens" }, { id = 850, title = "Kolkar Leaders" },
    { header = "Stonetalon Mountains" }, { id = 861, title = "Stonetalon Log Quest" },
  }
  DONE = { 101, 50 }
  -- Yards to each quest in the log (on this continent): Stonetalon is nearer than the Barrens.
  DIST = { [6571] = 100, [850] = 5000, [861] = 1200 }
  -- Where a quest sends the player (its map): the Stonetalon one, to Thousand Needles.
  GetQuestUiMapID = function(id) return id == 861 and 1441 or 0 end
  C_QuestLog = {
    GetNumQuestLogEntries = function() return #LOG end,
    GetInfo = function(i)
      local e = LOG[i]
      if not e then return nil end
      if e.header then return { isHeader = true, title = e.header } end
      return { title = e.title, questID = e.id, level = 25 }
    end,
    GetAllCompletedQuestIDs = function() return DONE end,
    GetDistanceSqToQuest = function(id) local d = DIST[id]; if d then return d * d, true end return nil, false end,
    GetTitleForQuestID = function(id) return ({ [6571] = "Warsong Supplies" })[id] end,
  }
  -- 530: Friendly enough; 92 (Gelkis): Hated; 93 (Magram): Friendly.
  local reps = { [530] = { currentStanding = 3500, reaction = 5 }, [92] = { currentStanding = -40000, reaction = 1 },
                 [93] = { currentStanding = 4000, reaction = 5 } }
  C_Reputation = { GetFactionDataByID = function(id) return reps[id] end }
  IsPlayerSpell = function(id) return id == 7328 end
  -- Race bits as the game's (Horde: orc 2, undead 16, tauren 32, troll 128); 2^32 = a race beyond 32 bits.
  local H, A = 178, 77
  local function q(name, zone, level, extra)
    local t = { name = name, zoneOrSort = zone, questLevel = level, requiredLevel = level - 3, requiredRaces = H, startedBy = { { 900 } } }
    for k, v in pairs(extra or {}) do t[k] = v end
    return t
  end
  local quests = {
    [6571] = q("Warsong Supplies", 331, 25, { nextQuestInChain = 6572 }),
    [6572] = q("Warsong Scout Update", 331, 25, { preQuestSingle = { 6571 } }),
    [100] = q("Wood for the Front", 331, 25),
    [101] = q("Done Before", 331, 24),
    [102] = q("Arcane Studies", 331, 25, { requiredClasses = 128 }),
    [103] = q("Alliance Only", 331, 25, { requiredRaces = A }),
    [104] = q("After Done Before", 331, 25, { preQuestSingle = { 101 }, startedBy = { { 901 } } }),
    [105] = q("Needs Two", 331, 25, { preQuestGroup = { 101, 999 } }),
    [106] = q("Too Soon", 331, 33),
    [107] = q("Grey Errand", 331, 12),
    [108] = q("Other Path", 331, 25, { exclusiveTo = { 101 } }),
    [109] = q("Old Step", 331, 25, { nextQuestInChain = 6571 }),
    [110] = q("Strange Note", 331, 25, { startedBy = { {}, {}, { 5000 } } }),
    [111] = q("Silverwing Plea", 331, 25, { requiredRaces = 0, startedBy = { { 902 } } }),
    [112] = q("Friends of the Horde", 331, 26, { requiredMinRep = { 530, 3000 } }),
    [113] = q("Honored Errand", 331, 26, { requiredMinRep = { 530, 9000 } }),
    [114] = q("Smithing Job", 331, 25, { requiredSkill = { 164, 50 } }),
    [115] = q("Festival", 331, 25, { specialFlags = 2 }),
    [116] = q("Skyborne Welcome", 331, 24, { requiredRaces = H + 2^32, startedBy = { { 903 } } }),
    [117] = q("Paladin Calling", 331, 25, { requiredClasses = 2, requiredSpell = 7328, startedBy = { {}, { 300 } } }),
    [118] = q("Forgotten Lore", 331, 25, { requiredSpell = -7328 }),
    [119] = q("Pickup Elsewhere", 331, 25, { startedBy = { { 904 } } }),
    [120] = q("Far Above", 331, 30, { requiredLevel = 20 }), -- red: 5 levels above
    -- Reputation to earn: with the Gelkis (Hated) not one to do; with the Magram (Friendly) fine.
    [121] = q("Gelkis Pact", 331, 25, { objectives = { [4] = { 92, 3000 } } }),
    [122] = q("Magram Pact", 331, 25, { objectives = { [4] = { { 93, 9000 } } }, startedBy = { { 901 } } }),
    [50] = q("Orgrimmar Errand", 1637, 10),
    [850] = q("Kolkar Leaders", 17, 25),
    [851] = q("Barrens Errand", 17, 23, { startedBy = { { 905 } } }),
    [852] = q("Barrens Two", 17, 24, { startedBy = { { 905 } } }),
    [853] = q("Barrens Three", 17, 25, { startedBy = { { 905 } } }),
    [854] = q("Barrens Four", 17, 26, { startedBy = { { 905 } } }),
    [860] = q("Stonetalon Task", 406, 24, { startedBy = { { 906 } } }),
    [861] = q("Stonetalon Log Quest", 406, 25, { startedBy = { { 906 } } }),
    [870] = q("Desolace Task", 405, 25, { startedBy = { { 907 } } }),
    [880] = q("Needles Task", 400, 25, { startedBy = { { 908 } } }),
  }
  QUESTS, QUEST_ROW = quests, q -- for a test to add its own
  local npcs = {
    [900] = { name = "Kuray'bin", friendlyToFaction = "H", spawns = { [331] = { { 60, 50 } } } },
    [901] = { name = "Mitsuwa", friendlyToFaction = "H", spawns = { [331] = { { 40, 40 } } } },
    [902] = { name = "Sentinel Onaeya", friendlyToFaction = "A", spawns = { [331] = { { 30, 70 } } } },
    [903] = { name = "Skyborne Herald", friendlyToFaction = "AH", spawns = { [331] = { { 50, 52 } } } },
    [904] = { name = "Gryshka", friendlyToFaction = "H", spawns = { [1637] = { { 45.04, 63.37 } } } },
    [905] = { name = "Thork", friendlyToFaction = "H", spawns = { [17] = { { 51.5, 30.3 } } } },
    [906] = { name = "Seereth Stonebreak", friendlyToFaction = "H", spawns = { [406] = { { 70, 70 } } } },
    [907] = { name = "Takata Steelblade", friendlyToFaction = "H", spawns = { [405] = { { 55, 26 } } } },
    [908] = { name = "Grenka Bloodscreech", friendlyToFaction = "H", spawns = { [400] = { { 30, 50 } } } },
  }
  local objects = { [300] = { name = "Altar of the Light", spawns = { [331] = { { 30, 30 } } } } }
  local function entity(rows)
    return {
      Get = function(id, key) local r = rows[id]; return r and r[key] end,
      GetAllIds = function() local ids = {} for id in pairs(rows) do ids[#ids + 1] = id end table.sort(ids) return ids end,
    }
  end
  QuestDB, NpcDB, ObjectDB = entity(quests), entity(npcs), entity(objects)
  LibQuestieDB = {
    contractVersion = 4,
    RequireContract = function(v) return v >= 1 and v <= 4, "ok" end,
    Enum = { raceMaskById = { [1] = 1, [5] = 16 }, classKeys = { PALADIN = 2, MAGE = 128 } },
    Quest = QuestDB, Npc = NpcDB, Object = ObjectDB,
  }
`;

test('quest help: done quests of the zone, quests available now with their giver, and the next one of a chain', () => {
  const out = runLua(`
    ns.QuestHelp.START_DELAY = 0
    START()
    RUN_FRAMES(300)
    local snap = ns.Collect:Snapshot()
    local log = {}
    for _, q in ipairs(snap.quests or {}) do log[#log + 1] = q.title .. ">" .. tostring(q.next) end
    local r = { ns.Json.Encode(snap.completedQuests), ns.Json.Encode(snap.availableQuests), table.concat(log, ",") }
    assert(type(READY) == "function", "the lists are worked out again when Questie is ready")
    -- Asking about another zone: its quests go along with that question.
    local orig = ns.Core.BuildFrame
    ns.Core.BuildFrame = function(self, req, step, maxBytes, extra) CAPTURED = extra; return orig(self, req, step, maxBytes, extra) end
    ASK("What can I do in Desolace?")
    r[#r + 1] = ns.Json.Encode(CAPTURED and CAPTURED.availableQuestsAsked)
    -- A zone asked about with nothing left in it says so.
    r[#r + 1] = ns.Json.Encode(ns.QuestHelp:ForQuestion("Anything in Orgrimmar?"))
    -- Warsong Supplies turned in: kept with its zone, and the next quest of the chain opens.
    FIRE("QUEST_TURNED_IN", 6571)
    table.remove(LOG, 2)
    FIRE("QUEST_REMOVED", 6571)
    RUN_FRAMES(300)
    local snap2 = ns.Collect:Snapshot()
    local rec = ns.Core:CharData().questsDone[6571]
    r[#r + 1] = rec.t .. "|" .. rec.z .. "|" .. ns.Json.Encode(snap2.completedQuests.inZone) .. "|" .. snap2.availableQuests[1].quests[1].name
    -- In a zone with nothing left to pick up: it says so, first.
    ZONE = "Orgrimmar"
    FIRE("ZONE_CHANGED_NEW_AREA")
    RUN_FRAMES(300)
    r[#r + 1] = ns.Json.Encode(ns.Collect:Snapshot().availableQuests[1])
    -- A zone's completed list cut short says how many more there are.
    ZONE = "Ashenvale"
    ns.QuestHelp.MAX_DONE = 1
    FIRE("ZONE_CHANGED_NEW_AREA")
    RUN_FRAMES(300)
    r[#r + 1] = ns.Json.Encode(ns.Collect:Snapshot().completedQuests)
    RESULT = table.concat(r, "#")
  `, {}, QUEST_FILES, FAKE_UI + PRELUDE_DRIVE + QUESTIE);
  const [done, available, log, asked, askedNone, after, empty, cut] = out.split('#');
  assert.deepEqual(JSON.parse(done), { total: 2, zone: 'Ashenvale', inZone: ['Done Before'] });
  const g = (giver, zone, x, y) => ({ giver, at: { zone, x, y } });
  assert.deepEqual(JSON.parse(available), [
    {
      zone: 'Ashenvale',
      quests: [
        // Closest to the player's level first, then nearest.
        { id: 100, name: 'Wood for the Front', level: 25, minLevel: 22, ...g("Kuray'bin", 'Ashenvale', 60, 50) },
        { id: 104, name: 'After Done Before', level: 25, minLevel: 22, ...g('Mitsuwa', 'Ashenvale', 40, 40) },
        { id: 122, name: 'Magram Pact', level: 25, minLevel: 22, ...g('Mitsuwa', 'Ashenvale', 40, 40) },
        { id: 117, name: 'Paladin Calling', level: 25, minLevel: 22, ...g('Altar of the Light', 'Ashenvale', 30, 30) },
        // (Pickup Elsewhere: hidden by Questie's own check.)
        { id: 116, name: 'Skyborne Welcome', level: 24, minLevel: 21, ...g('Skyborne Herald', 'Ashenvale', 50, 52) },
        { id: 112, name: 'Friends of the Horde', level: 26, minLevel: 23, ...g("Kuray'bin", 'Ashenvale', 60, 50) },
      ],
    },
    // Zones the quests in the log come from or send to, this continent's first,
    // then nearest: a few more to pick up there. Thousand Needles: where the
    // Stonetalon quest sends the player.
    { zone: 'Thousand Needles', quests: [{ id: 880, name: 'Needles Task', level: 25, minLevel: 22, ...g('Grenka Bloodscreech', 'Thousand Needles', 30, 50) }] },
    {
      zone: 'The Barrens', more: 1,
      quests: [
        // Same distance from the player's level: by name.
        { id: 853, name: 'Barrens Three', level: 25, minLevel: 22, ...g('Thork', 'The Barrens', 51.5, 30.3) },
        { id: 854, name: 'Barrens Four', level: 26, minLevel: 23, ...g('Thork', 'The Barrens', 51.5, 30.3) },
        { id: 852, name: 'Barrens Two', level: 24, minLevel: 21, ...g('Thork', 'The Barrens', 51.5, 30.3) },
      ],
    },
    // Nearer than the Barrens, but on another continent.
    { zone: 'Stonetalon Mountains', quests: [{ id: 860, name: 'Stonetalon Task', level: 24, minLevel: 21, ...g('Seereth Stonebreak', 'Stonetalon Mountains', 70, 70) }] },
  ]);
  assert.equal(log, 'Warsong Supplies>Warsong Scout Update,Kolkar Leaders>nil,Stonetalon Log Quest>nil');
  assert.deepEqual(JSON.parse(asked), [
    { zone: 'Desolace', quests: [{ id: 870, name: 'Desolace Task', level: 25, minLevel: 22, ...g('Takata Steelblade', 'Desolace', 55, 26) }] },
  ]);
  // ...and the quests done there.
  assert.deepEqual(JSON.parse(askedNone), { zones: [{ zone: 'Orgrimmar', none: true, done: ['Orgrimmar Errand'] }] });
  assert.equal(after, 'Warsong Supplies|Ashenvale|["Done Before","Warsong Supplies"]|Warsong Scout Update');
  assert.deepEqual(JSON.parse(empty), { zone: 'Orgrimmar', none: true });
  assert.deepEqual(JSON.parse(cut), { total: 3, zone: 'Ashenvale', inZone: ['Done Before'], more: 1 });
});

test('quest help: quests named or linked in a question, with where each stands', () => {
  const out = runLua(`
    -- Two parts of a chain sharing a name, the first one done.
    QUESTS[130] = QUEST_ROW("Twin Trail", 405, 25, { nextQuestInChain = 131, startedBy = { { 907 } } })
    QUESTS[131] = QUEST_ROW("Twin Trail", 405, 25, { preQuestSingle = { 130 }, startedBy = { { 907 } } })
    DONE = { 101, 50, 130 }
    -- 45 more quests done in Desolace.
    for i = 1, 45 do
      QUESTS[2000 + i] = QUEST_ROW(string.format("Desolace Deed %02d", i), 405, 20)
      DONE[#DONE + 1] = 2000 + i
    end
    ns.QuestHelp.START_DELAY = 0
    START()
    RUN_FRAMES(300)
    local r = {}
    local function ask(text) r[#r + 1] = ns.Json.Encode(ns.QuestHelp:ForQuestion(text)) end
    ask("Did I finish Done Before? And Warsong Supplies, where do I get Wood for the Front?")
    ask("Can I do Needs Two, Too Soon or Other Path yet?")
    ask("What about Gelkis Pact, Grey Errand and Far Above?")
    ask("Is Pickup Elsewhere worth it, and Twin Trail?")
    -- Part of a word, or a short one-word name, doesn't count.
    ask("Wood for the Frontier")
    -- A linked quest, through a question: its status goes along with it.
    local orig = ns.Core.BuildFrame
    ns.Core.BuildFrame = function(self, req, step, maxBytes, extra) CAPTURED = extra; return orig(self, req, step, maxBytes, extra) end
    ASK("Should I do |cffffff00|Hquest:118:25|h[Forgotten Lore]|h|r?")
    r[#r + 1] = ns.Json.Encode(CAPTURED and CAPTURED.questsAsked)
    -- A zone asked about: every quest done there; cut to 40 first when the request is too big.
    local extra = { availableQuestsAsked = ns.QuestHelp:ForQuestion("What did I do in Desolace?").zones }
    local frame = ns.Uplink.Frame
    ns.Uplink.Frame = function(json, step) SENT = json; return frame(json, step) end
    local function build(max) return #ns.Core:BuildFrame({ id = "t", question = "q" }, function() end, max, extra) end
    local whole = build(1e9)
    local level0 = ns.Core.lastEncode.level
    build(whole - 1)
    ns.Uplink.Frame = frame
    local z = extra.availableQuestsAsked[1]
    r[#r + 1] = ns.Json.Encode({ #z.done, z.doneMore or 0, level0, ns.Core.lastEncode.level })
    r[#r + 1] = SENT
    RESULT = table.concat(r, string.char(1))
  `, {}, QUEST_FILES, FAKE_UI + PRELUDE_DRIVE + QUESTIE);
  const [first, notYet, colors, hidden, partWord, linked, full, sent] = out.split('\x01').map((x) => JSON.parse(x));
  // All 46 (with Twin Trail) sent when they fit; cut to 40 (the first thing cut) when they don't; the list itself kept.
  assert.deepEqual(full, [46, 0, 0, 1]);
  const trimmed = sent.context.availableQuestsAsked[0];
  assert.deepEqual([trimmed.done.length, trimmed.doneMore, trimmed.done[39]], [40, 6, 'Desolace Deed 40']);
  const at = (zone, x, y) => ({ zone, x, y });
  const ash = { zone: 'Ashenvale', level: 25, minLevel: 22 };
  // The longest name first; done, in the log, available with its giver.
  assert.deepEqual(first, { quests: [
    { id: 100, name: 'Wood for the Front', ...ash, status: 'available', giver: "Kuray'bin", at: at('Ashenvale', 60, 50) },
    { id: 6571, name: 'Warsong Supplies', zone: 'Ashenvale', level: 25, status: 'inLog' },
    { id: 101, name: 'Done Before', zone: 'Ashenvale', level: 24, status: 'done' },
  ] });
  // Not yet: why.
  assert.deepEqual(notYet, { quests: [
    { id: 108, name: 'Other Path', ...ash, status: 'notYet', why: ['closed: you did or took Done Before'] },
    { id: 105, name: 'Needs Two', ...ash, status: 'notYet', why: ['first: quest 999'] },
    { id: 106, name: 'Too Soon', zone: 'Ashenvale', level: 33, minLevel: 30, status: 'notYet', why: ['level 30'] },
  ] });
  // Grey and red ones can be taken (and say so); one needing a hostile reputation can't.
  assert.deepEqual(colors, { quests: [
    { id: 107, name: 'Grey Errand', zone: 'Ashenvale', level: 12, minLevel: 9, status: 'available', color: 'grey', giver: "Kuray'bin", at: at('Ashenvale', 60, 50) },
    { id: 121, name: 'Gelkis Pact', ...ash, status: 'notYet', why: ['needs reputation with a faction you are Hostile or Hated with'] },
    { id: 120, name: 'Far Above', zone: 'Ashenvale', level: 30, minLevel: 20, status: 'available', color: 'red', giver: "Kuray'bin", at: at('Ashenvale', 60, 50) },
  ] });
  // Hidden by Questie; a chain's parts sharing a name: the one to do now, and how many are done.
  assert.deepEqual(hidden, { quests: [
    { id: 119, name: 'Pickup Elsewhere', ...ash, status: 'notYet', why: ['Questie hides it (not on this server, or you hid it)'] },
    { id: 131, name: 'Twin Trail', zone: 'Desolace', level: 25, minLevel: 22, status: 'available', giver: 'Takata Steelblade', at: at('Desolace', 55, 26), parts: 2, doneParts: 1 },
  ] });
  assert.equal(partWord, null);
  // Linked (and named): once.
  assert.deepEqual(linked, [
    { id: 118, name: 'Forgotten Lore', ...ash, status: 'notYet', why: ['not once you know a certain spell'] },
  ]);
});

test('quest help without QuestieDB: the total and the quests the addon saw turned in, nothing more', () => {
  const out = runLua(`
    LibQuestieDB, QuestDB = nil, nil
    ns.QuestHelp.START_DELAY = 0
    START()
    FIRE("QUEST_TURNED_IN", 6571)
    table.remove(LOG, 2)
    RUN_FRAMES(200)
    local snap = ns.Collect:Snapshot()
    RESULT = ns.Json.Encode(snap.completedQuests) .. "#" .. tostring(snap.availableQuests) .. "#" .. tostring(snap.quests and snap.quests[1] and snap.quests[1].next)
  `, {}, QUEST_FILES, FAKE_UI + PRELUDE_DRIVE + QUESTIE);
  const [done, available, next] = out.split('#');
  assert.deepEqual(JSON.parse(done), { total: 3, zone: 'Ashenvale', inZone: ['Warsong Supplies'] });
  assert.equal(available, 'nil');
  assert.equal(next, 'nil');
});

// The corner grips (UI.Resizer): a fake mouse, and frames that know where they are.
const RESIZE = `
  CURSOR = { 0, 0 }
  GetCursorPosition = function() return CURSOR[1], CURSOR[2] end
  function PLACE(f, left, top)
    f.GetLeft = function() return left end
    f.GetTop = function() return top end
    f.SetPoint = function(self, p, rel, rp, x, y) self.pt = { p, rp or p, x or 0, y or 0 } end
    f.GetPoint = function(self) local p = self.pt or {}; return p[1], UIParent, p[2], p[3], p[4] end
  end
  function DRAG(grip, x, y)
    CURSOR = { x, y }
    if grip.scripts.OnUpdate then grip.scripts.OnUpdate(grip, 0.016) end
  end
  function SIZE(f) return string.format("%dx%d", f.w, f.h) end
`;

test('chat window: the corner resizes by how far the mouse moves, a click alone changes nothing', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    local f, grip = ns.UI.frame, ns.UI.grip
    PLACE(f, 200, 700)
    local r = { "start=" .. SIZE(f) }
    -- Pressed on the corner (the mouse is a few pixels inside it), not moved.
    CURSOR = { 1046, 114 }
    grip.scripts.OnMouseDown(grip, "LeftButton")
    DRAG(grip, 1046, 114)
    r[#r + 1] = "pressed=" .. SIZE(f) .. " anchor=" .. f.pt[1] .. "/" .. f.pt[2] .. " " .. f.pt[3] .. "," .. f.pt[4]
    DRAG(grip, 1146, 64)
    r[#r + 1] = "dragged=" .. SIZE(f)
    DRAG(grip, 0, 2000)
    r[#r + 1] = "min=" .. SIZE(f)
    DRAG(grip, 1146, 64)
    grip.scripts.OnMouseUp(grip, "LeftButton")
    local s = ns.db.ui
    r[#r + 1] = "saved=" .. s.width .. "x" .. s.height .. " " .. s.point .. "/" .. s.relPoint .. " " .. s.x .. "," .. s.y
    r[#r + 1] = "stopped=" .. tostring(grip.scripts.OnUpdate) .. "," .. tostring(grip.sizing)
    -- Never past the right or bottom edge of the screen.
    UIParent.GetRight = function() return 1200 end
    grip.scripts.OnMouseDown(grip, "LeftButton")
    DRAG(grip, 3000, -3000)
    grip.scripts.OnMouseUp(grip, "LeftButton")
    r[#r + 1] = "edge=" .. SIZE(f)
    -- A click alone, again: nothing moves.
    CURSOR = { 1190, 10 }
    grip.scripts.OnMouseDown(grip, "LeftButton")
    DRAG(grip, 1190, 10)
    grip.scripts.OnMouseUp(grip, "LeftButton")
    r[#r + 1] = "click=" .. SIZE(f) .. "," .. s.width .. "x" .. s.height
    -- The button let go where the grip didn't hear it (the window was hidden): it stops.
    HELD = true
    IsMouseButtonDown = function(b) return HELD and b == "LeftButton" end
    grip.scripts.OnMouseDown(grip, "LeftButton")
    DRAG(grip, 1100, 200)
    HELD = false
    DRAG(grip, 900, 300)
    r[#r + 1] = "letGo=" .. SIZE(f) .. "," .. s.width .. "x" .. s.height .. "," .. tostring(grip.scripts.OnUpdate)
    -- Right-click doesn't resize.
    grip.scripts.OnMouseDown(grip, "RightButton")
    DRAG(grip, 400, 600)
    grip.scripts.OnMouseUp(grip, "RightButton")
    r[#r + 1] = "right=" .. SIZE(f)
    RESULT = table.concat(r, " ")
  `, {}, COMBAT_FILES, FAKE_UI + PRELUDE_DRIVE + RESIZE);
  assert.equal(out, [
    'start=860x600',
    'pressed=860x600 anchor=TOPLEFT/BOTTOMLEFT 200,700',
    'dragged=960x650',
    'min=600x430',
    'saved=960x650 TOPLEFT/BOTTOMLEFT 200,700',
    'stopped=nil,false',
    'edge=1000x700',
    'click=1000x700,1000x700',
    'letGo=910x510,910x510,nil',
    'right=910x510',
  ].join(' '));
});

test('compact answers: the box is resized from its corner, keeps the size, and right-click goes back to automatic', () => {
  const out = runLua(`
    START()
    ns.Compact:Set("enabled", true)
    local C = ns.Compact
    C:Message("hola")
    local f, grip = C.frame, C.grip
    PLACE(f, 300, 600)
    local r = { "auto=" .. SIZE(f) }
    -- A click on the corner without moving: nothing changes, nothing is saved.
    CURSOR = { 670, 526 }
    grip.scripts.OnMouseDown(grip, "LeftButton")
    DRAG(grip, 670, 526)
    grip.scripts.OnMouseUp(grip, "LeftButton")
    r[#r + 1] = "click=" .. SIZE(f) .. "," .. tostring(ns.db.compact.size)
    -- Dragging the corner: the size follows the mouse, and the answer the size.
    grip.scripts.OnMouseDown(grip, "LeftButton")
    DRAG(grip, 810, 310)
    r[#r + 1] = "live=" .. C.text.w .. "," .. C.scroll.h
    -- At most MAX_W wide, and not past the bottom of the screen.
    DRAG(grip, 5000, -5000)
    r[#r + 1] = "max=" .. SIZE(f)
    DRAG(grip, 810, 310)
    -- Redrawn meanwhile (the "thinking" dots): it keeps the size the mouse gives it.
    C:Render()
    r[#r + 1] = "redraw=" .. SIZE(f)
    grip.scripts.OnMouseUp(grip, "LeftButton")
    local s, p = ns.db.compact.size, ns.db.compact.pos
    r[#r + 1] = "saved=" .. s.w .. "x" .. s.h .. " frame=" .. SIZE(f) .. " text=" .. C.text.w .. " scroll=" .. C.scroll.w .. "x" .. C.scroll.h
    r[#r + 1] = "pos=" .. p.point .. "/" .. p.rel .. " " .. p.x .. "," .. p.y
    -- The next time it shows: the same size (a long answer scrolls inside).
    C:Hide()
    C:Message("otra")
    r[#r + 1] = "again=" .. SIZE(f)
    -- Sizes out of range are kept in range.
    ns.db.compact.size = { w = 5000, h = 10 }
    C:Render()
    r[#r + 1] = "clamped=" .. SIZE(f)
    -- Right-click on the corner: the automatic size again.
    grip.scripts.OnMouseUp(grip, "RightButton")
    r[#r + 1] = "reset=" .. tostring(ns.db.compact.size) .. "," .. SIZE(f)
    RESULT = table.concat(r, " ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + COMPACT_APIS + RESIZE);
  assert.equal(out, [
    'auto=380x84',
    'click=380x84,nil',
    'live=476,230',
    'max=900x600',
    'redraw=520x300',
    'saved=520x300 frame=520x300 text=476 scroll=480x230',
    'pos=TOPLEFT/BOTTOMLEFT 300,600',
    'again=520x300',
    'clamped=900x110',
    'reset=nil,380x84',
  ].join(' '));
});

test('turning the camera with the mouse over the window does not keep it from dimming (combat)', () => {
  const out = runLua(`
    COMBAT = false; MOUSELOOK = false
    UnitAffectingCombat = function() return COMBAT end
    InCombatLockdown = function() return COMBAT end
    IsMouselooking = function() return MOUSELOOK end
    START()
    ns.UI:Show()
    local r = {}
    local function note(name) r[#r + 1] = name .. "=" .. A() end
    COMBAT = true; TICK(0.6); note("fighting")
    -- Hover: fully visible.
    ns.UI.frame.IsMouseOver = function() return true end
    TICK(0.5); note("hovered")
    -- Hold a mouse button to turn: the hidden cursor is still over the window.
    MOUSELOOK = true; TICK(0.6); note("turningCamera")
    MOUSELOOK = false; TICK(0.5); note("cursorBack")
    ns.UI.frame.IsMouseOver = function() return false end
    TICK(0.6); note("mouseAway")
    -- The compact box keeps counting down while the camera turns.
    ns.Compact:Message("hello")
    ns.Compact.frame.IsMouseOver = function() return true end
    MOUSELOOK = true
    for i = 1, 70 do NOW = NOW + 0.1; ns.Compact:Update(0.1) end
    r[#r + 1] = "compactGone=" .. tostring(not ns.Compact:IsShown())
    RESULT = table.concat(r, " ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS);
  const got = Object.fromEntries(out.split(' ').map((p) => p.split('=')));
  assert.deepEqual(got, {
    fighting: '0.30', hovered: '1.00', turningCamera: '0.30', cursorBack: '1.00', mouseAway: '0.30', compactGone: 'true',
  });
});

// Newer clients make some values "secret" in combat: they can't be compared.
// A table stands in for one (comparing it with a number is an error too).
const SECRET_APIS = `
  SECRET = setmetatable({}, { __tostring = function() return "<secret>" end })
  COMBAT = false; MOVING = false; SECRETS = false; HAS_ISSECRET = true
  InCombatLockdown = function() return COMBAT end
  UnitAffectingCombat = function() if SECRETS then return SECRET end return COMBAT end
  GetUnitSpeed = function() if SECRETS then return SECRET end return MOVING and 7 or 0 end
  UnitOnTaxi = function() if SECRETS then return SECRET end return false end
  issecretvalue = function(v) return HAS_ISSECRET and v == SECRET end
  function COMBAT_ON() COMBAT = true; SECRETS = true end
  function COMBAT_OFF() COMBAT = false; SECRETS = false end
`;

test('in combat the speed is a secret: dimming keeps working, with movement events, and never errors', () => {
  for (const hasIsSecret of [true, false]) {
    const out = runLua(`
      START()
      HAS_ISSECRET = ${hasIsSecret}
      ns.UI:Show()
      local r = {}
      local function note(name) r[#r + 1] = name .. "=" .. A() end
      MOVING = true; TICK(0.6); note("moving")
      COMBAT_ON(); TICK(0.6); note("fight")
      -- Your steps: hover in the fight, then move the mouse away.
      ns.UI.frame.IsMouseOver = function() return true end; TICK(0.5); note("hovered")
      ns.UI.frame.IsMouseOver = function() return false end; TICK(0.6); note("mouseAway")
      -- Opening the window mid-fight (Reset read the speed: the error in the report).
      ns.Fade:Reset(); TICK(0.6); note("openedInFight")
      -- Movement in the fight comes from the events (opened mid-fight, combat
      -- doesn't dim until the fight ends, so moving shows on its own).
      FIRE("PLAYER_STOPPED_MOVING"); TICK(1.6); note("fightStopped")
      FIRE("PLAYER_STARTED_MOVING"); TICK(0.6); note("fightMoving")
      COMBAT_OFF(); MOVING = false; FIRE("PLAYER_STOPPED_MOVING"); TICK(2.6); note("after")
      r[#r + 1] = "error=" .. tostring(ns.Fade.lastError)
      RESULT = table.concat(r, " ")
    `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + SECRET_APIS);
    const got = Object.fromEntries(out.split(' ').map((p) => p.split('=')));
    const want = {
      moving: '0.50', fight: '0.30', hovered: '1.00', mouseAway: '0.30', openedInFight: '1.00',
      fightStopped: '1.00', fightMoving: '0.50', after: '1.00', error: 'nil',
    };
    // Without issecretvalue, the speed check's own error is caught, but other
    // values can't be told apart from real ones: only check the reported bug.
    if (!hasIsSecret) { delete want.fightStopped; delete want.fightMoving; delete got.fightStopped; delete got.fightMoving; }
    assert.deepEqual(got, want, `issecretvalue ${hasIsSecret ? 'available' : 'missing'}`);
  }
});

test('IsPlayerMoving (readable in combat) is used before the secret speed', () => {
  const out = runLua(`
    IsPlayerMoving = function() return MOVING end
    START()
    ns.UI:Show()
    local r = {}
    local function note(name) r[#r + 1] = name .. "=" .. A() end
    COMBAT_ON()
    ns.db.fade = { v = 2, combatOpacity = 95 } -- combat barely dims: moving shows
    MOVING = true; TICK(0.6); note("fightMoving")
    MOVING = false; TICK(1.6); note("fightStopped")
    r[#r + 1] = "error=" .. tostring(ns.Fade.lastError)
    RESULT = table.concat(r, " ")
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + SECRET_APIS);
  assert.equal(out, 'fightMoving=0.50 fightStopped=0.95 error=nil', 'no movement events needed');
});

test('an unexpected error in the dimming shows the window fully instead of freezing it, and /ia status says why', () => {
  const out = runLua(`
    START()
    ns.UI:Show()
    MOVING = true; TICK(0.6)
    local before = A()
    local real = ns.Fade.InUse
    ns.Fade.InUse = function() error("boom") end
    TICK(0.6)
    local during = A()
    ns.Fade.InUse = real
    RESULT = before .. " " .. during .. " " .. tostring(ns.Live:Status():find("Dimming paused by an error", 1, true) ~= nil)
  `, {}, FADE_FILES, FAKE_UI + PRELUDE_DRIVE + FADE_APIS + SECRET_APIS);
  assert.equal(out, '0.50 1.00 true');
});

test('a new chat suggests questions about the game window that is open (vendor, auction house...)', () => {
  const out = runLua(`
    START()
    ns.Personas:Set("fizzi")
    ns.UI:Show()
    ns.UI:Refresh()
    local w = ns.UI.welcome
    local before = w.chips[1].label.textValue
    -- The player talks to a vendor.
    ns.Collect.open.merchant = true
    ns.UI:OnGameWindow()
    local title, first, last = w.context.textValue, w.chips[1].label.textValue, w.chips[5].label.textValue
    w.chips[1].scripts.OnClick(w.chips[1])
    local asked = ns.Chats:Get(ns.db.currentChat).messages[1].question
    -- With a conversation going, opening the auction house changes nothing.
    ns.Collect.open.merchant = nil
    ns.Collect.open.auction = true
    ns.UI:OnGameWindow()
    RESULT = table.concat({ before, title, first, last, asked, tostring(w:IsShown()) }, "#")
  `, {}, ALL_FILES, inLocale('esMX'));
  const [before, title, first, last, asked, welcomeShown] = out.split('#');
  assert.equal(before, '¿Qué mazmorra me conviene hacer ahora?');
  assert.match(title, /vendedor abierto/);
  assert.equal(first, '¿Qué me conviene comprarle a este vendedor?');
  assert.equal(last, '¿Qué mazmorra me conviene hacer ahora?', 'then the usual ones');
  assert.equal(asked, first, 'clicking asks it');
  assert.equal(welcomeShown, 'false');
});


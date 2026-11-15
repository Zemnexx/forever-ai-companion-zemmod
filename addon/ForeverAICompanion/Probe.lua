-- /ia probe (probar-canales): tries every "invisible" way the game might have to hand
-- data to the companion app, and lets the app measure which ones work here.
--
-- Each probe writes a marker "FAIC-PROBE-<token>" somewhere the WoW client
-- may save to disk (a custom CVar, a macro, the addon list, the chat log) and
-- reports what the text-to-speech API offers. The companion app watches those
-- files; after WAIT seconds the addon undoes its changes and sends the results
-- through the normal channel, and the app answers with the verdict.
--
-- The app only watches those files while a test is running, so the test
-- first asks it to start recording and runs the probes once it has answered.
local _, ns = ...

local Probe = {}
ns.Probe = Probe

local WAIT = 25
local START_TIMEOUT = 60 -- seconds to wait for the app to start recording
local MACRO = "FAICPROBE"
local SLOT = "ForeverAICompanion_S50"
local PREFIX = "FAICPROBE"

local function try(fn, ...)
  if type(fn) ~= "function" then return false, ns.L.PROBE_NO_API end
  local ok, err = pcall(fn, ...)
  if ok then return true end
  return false, tostring(err):gsub("^.-:%d+: ", ""):sub(1, 80)
end

local function api(path)
  local v = _G
  for part in path:gmatch("[^%.]+") do
    v = type(v) == "table" and v[part] or nil
  end
  return v
end

local function enableAddOn(name, on)
  local fn = on and (api("C_AddOns.EnableAddOn") or EnableAddOn) or (api("C_AddOns.DisableAddOn") or DisableAddOn)
  local ok, err = try(fn, name, UnitName("player"))
  if not ok then ok, err = try(fn, name) end
  local save = api("C_AddOns.SaveAddOns") or SaveAddOns
  local saved, serr = try(save)
  return ok and saved, err or serr
end

function Probe:Run()
  local L = ns.L
  if self.running then
    ns.UI:SetStatus(L.PROBE_RUNNING)
    return
  end
  if InCombatLockdown() or UnitAffectingCombat("player") then
    ns.UI:SetStatus("|cffff6060" .. L.PROBE_COMBAT .. "|r")
    return
  end
  if ns.Core.working or ns.Uplink.busy then
    ns.UI:SetStatus(L.WAIT_PREVIOUS)
    return
  end
  local token = tostring(time()) .. tostring(math.random(1000, 9999))
  local id = ns.Core:Ask(L.PROBE_START_QUESTION, { probeStart = token })
  if not id then return end
  self.running = true
  self.waiting = { id = id, token = token }
  ns.UI:SetStatus(string.format(L.PROBE_STARTED, WAIT))
  local waiting = self.waiting
  C_Timer.After(START_TIMEOUT, function()
    if Probe.waiting ~= waiting then return end
    Probe.waiting = nil
    Probe.running = false
    ns.UI:SetStatus("|cffff6060" .. L.PROBE_NO_APP .. "|r")
  end)
end

-- Core:ApplyInbox calls this for every answer that arrives: the app's answer
-- to the start request means it is recording.
function Probe:OnAnswer(id, ok)
  local w = self.waiting
  if not w or w.id ~= id then return end
  self.waiting = nil
  if not ok then
    self.running = false
    return
  end
  self:Start(w.token)
end

function Probe:Start(token)
  local L = ns.L
  ns.UI:SetStatus(string.format(L.PROBE_STARTED, WAIT))
  local marker = "FAIC-PROBE-" .. token
  local r = { token = token, actions = {}, results = {} }
  local function did(name, ok, err)
    r.actions[name] = time()
    r.results[name] = ok and "ok" or (err or L.PROBE_FAILED)
  end

  -- 1. Custom CVar (Config.wtf).
  try(RegisterCVar, "faicProbe", "")
  local setCVar = api("C_CVar.SetCVar") or SetCVar
  did("cvar", try(setCVar, "faicProbe", marker))

  -- 2. Addon list (AddOns.txt): disable the last mailbox and save.
  did("addons", enableAddOn(SLOT, false))

  -- 3. A macro (macros-cache.txt).
  local body = "-- " .. marker
  local index = GetMacroIndexByName and GetMacroIndexByName(MACRO) or 0
  if index and index > 0 then
    did("macro", try(EditMacro, index, MACRO, nil, body))
  else
    did("macro", try(CreateMacro, MACRO, "INV_MISC_QUESTIONMARK", body, false))
  end

  -- 4. Chat log: an addon message whispered to ourselves, with logging on.
  if LoggingChat then
    r.chatLoggingBefore = LoggingChat() and true or false
    try(LoggingChat, true)
  end
  local register = api("C_ChatInfo.RegisterAddonMessagePrefix") or RegisterAddonMessagePrefix
  local send = api("C_ChatInfo.SendAddonMessage") or SendAddonMessage
  try(register, PREFIX)
  did("chat", try(send, PREFIX, marker, "WHISPER", UnitName("player")))

  -- 5. Text to speech: which voices the game offers, and whether it speaks.
  local voices = {}
  local getVoices = api("C_VoiceChat.GetTtsVoices")
  if getVoices then
    local ok, list = pcall(getVoices)
    for _, v in ipairs(ok and list or {}) do
      voices[#voices + 1] = { id = v.voiceID, name = v.name }
    end
  end
  r.ttsVoices = voices
  local speak = api("C_VoiceChat.SpeakText")
  if speak and voices[1] then
    -- Volume 0: nothing is heard. Two known signatures across game versions.
    local ok, err = try(speak, voices[1].id, "ForeverAICompanion", 0, 0, false)
    if not ok then ok, err = try(speak, voices[1].id, "ForeverAICompanion", 1, 0, 0) end
    did("tts", ok, err)
  else
    did("tts", false, speak and L.PROBE_NO_VOICES or L.PROBE_NO_API)
  end

  -- 6. Taskbar icon flash (a 1-bit signal).
  r.flashClientIcon = FlashClientIcon and true or false

  C_Timer.After(WAIT, function()
    -- Undo everything.
    enableAddOn(SLOT, true)
    local idx = GetMacroIndexByName and GetMacroIndexByName(MACRO) or 0
    if idx and idx > 0 then try(DeleteMacro, idx) end
    try(setCVar, "faicProbe", "")
    if LoggingChat and r.chatLoggingBefore ~= nil then try(LoggingChat, r.chatLoggingBefore) end
    Probe.running = false
    ns.Core:Ask(L.PROBE_QUESTION, { probe = r })
  end)
end

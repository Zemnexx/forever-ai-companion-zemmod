-- Events and the /armory command.
local ADDON, ns = ...
local L = ns.L
local Util = ns.Util

local Core = {}
ns.Core = Core

local TALENT_EVENTS = { "CHARACTER_POINTS_CHANGED", "PLAYER_TALENT_UPDATE", "TRAIT_CONFIG_UPDATED", "ACTIVE_TALENT_GROUP_CHANGED", "PLAYER_LEVEL_UP" }
local SPELL_EVENTS = { "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB" }
-- What changes the stats a tooltip scales with (Calibrate.lua). Several of
-- these may be missing on this client; the others still come.
local STAT_EVENTS = { "PLAYER_EQUIPMENT_CHANGED", "UNIT_ATTACK_POWER", "UNIT_RANGED_ATTACK_POWER", "UNIT_STATS",
  "SPELL_POWER_CHANGED", "PLAYER_DAMAGE_DONE_MODS", "PLAYER_ENTERING_WORLD" }

local byEvent = {}
local frame = CreateFrame("Frame")

local function on(events, fn)
  for _, event in ipairs(events) do
    byEvent[event] = byEvent[event] or {}
    table.insert(byEvent[event], fn)
    -- An event this client doesn't have only fails to register.
    pcall(frame.RegisterEvent, frame, event)
  end
end

local function touch()
  if ns.UI and ns.UI.Touch then ns.UI:Touch() end
end

on({ "ADDON_LOADED" }, function(_, name)
  if name ~= ADDON then return end
  ns.Store:Init()
  local meta = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
  ns.version = meta and Util.safe(meta, ADDON, "Version") or ""
  -- The companion app stamps the copy it installs (## X-Build), so a test
  -- build can be told from another with the same version. A copy installed
  -- by hand has none.
  local build = meta and Util.safe(meta, ADDON, "X-Build")
  ns.build = type(build) == "string" and build:match("^%x+$") and build or nil
end)

-- Talent points: one line in the chat when a point is gained ---------------------------

-- Points read in the first seconds after login are where the character
-- already stood (the game may hand them over late), not points gained.
local SETTLE = 15
local points = {}

local function now()
  return GetTime and GetTime() or 0
end

-- Unspent points now, compared with the last count: a gain names the
-- build's next talent, once.
function Core.WatchPoints()
  local ranks, section = ns.Scan.Ranks()
  local available = section and Util.num(section.available)
  if not available then return end
  local before = points.known
  points.known = available
  if before == nil or available <= before then return end
  if points.loginAt and now() - points.loginAt < SETTLE then return end
  local result = ns.Store:Result("talents")
  local data = result and result.data
  -- A test-mode build is a placeholder, not a plan to follow.
  if type(data) ~= "table" or data.test or type(data.order) ~= "table" then return end
  local name, tree = ns.Build.NextTalent(data.order, ranks, section)
  if not name then return end
  Util.chat(tree and string.format(L.NUDGE, name, tree) or string.format(L.NUDGE_NO_TREE, name))
end

on({ "PLAYER_LOGIN" }, function()
  if not ns.db then ns.Store:Init() end
  ns.Store:PruneSeen()
  pcall(ns.Dump.Init)
  -- Registers with the main addon: answers to requests still waiting arrive now.
  if not ns.Advisor:Init() then Util.chat(L.NEED_COMPANION) end
  pcall(ns.Tooltip.Init, ns.Tooltip)
  pcall(ns.Button.Init, ns.Button)
  -- Where the points stand at login: nothing to say about those.
  points.loginAt = now()
  pcall(Core.WatchPoints)
  pcall(ns.Calibrate.Poke, "PLAYER_LOGIN")
end)

on(TALENT_EVENTS, function(event)
  ns.Scan.Changed("talents")
  touch()
  pcall(Core.WatchPoints)
  -- Talents and levels change tooltip numbers: readings start a new group.
  pcall(ns.Calibrate.Poke, event, true)
  -- The new point may be handed over a moment after the level.
  if event == "PLAYER_LEVEL_UP" and C_Timer and C_Timer.After then
    C_Timer.After(2, function() pcall(Core.WatchPoints) end)
  end
end)

-- The modern client's own event for a change of unspent points.
on({ "TRAIT_TREE_CURRENCY_INFO_UPDATED" }, function()
  Core.WatchPoints()
end)

on(SPELL_EVENTS, function(event)
  ns.Scan.Changed("spells")
  pcall(ns.Calibrate.Poke, event, true)
end)

-- Calibration: a reading once the stats settle, never in combat.
on(STAT_EVENTS, function(event, unit)
  if event:find("^UNIT_") and unit ~= "player" then return end
  ns.Calibrate.Poke(event)
end)

on({ "PLAYER_REGEN_ENABLED" }, function()
  -- The procs of the fight just over are among the buffs still on.
  pcall(ns.Auras.Learn)
  ns.Calibrate.CombatEnded()
end)

-- A buff went on or off: the rotation tab says which of its buffs are active.
-- A buff also changes the stats calibration reads, and may be one to remember.
on({ "UNIT_AURA" }, function(event, unit)
  if unit ~= "player" then return end
  pcall(ns.Auras.Changed)
  if ns.UI and ns.UI.IsShown and ns.UI:IsShown() then touch() end
  ns.Calibrate.Poke(event)
end)

on({ "PLAYER_EQUIPMENT_CHANGED" }, function()
  ns.Items.Forget()
  touch()
end)

on({ "GET_ITEM_INFO_RECEIVED" }, function(_, itemId, success)
  -- An item seen before the game had loaded it is looked at again.
  pcall(ns.Items.OnSeenInfo, itemId, success)
  if ns.Items.OnItemInfo(itemId, success) then touch() end
end)

on(ns.Items.EVENTS, function(event, ...)
  ns.Items.OnEvent(event, ...)
end)

on(ns.Auction.EVENTS, function(event)
  ns.Auction:OnEvent(event)
end)

frame:SetScript("OnEvent", function(_, event, ...)
  for _, fn in ipairs(byEvent[event] or {}) do
    local ok, err = pcall(fn, event, ...)
    if not ok then Core.lastError = tostring(err) end
  end
end)

-- /armory -----------------------------------------------------------------------------

local TABS = {
  build = "build", talents = "talents", gear = "gear", rotation = "rotation", lab = "discover", discover = "discover",
}

SLASH_FOREVERAICOMPANIONARMORY1 = "/armory"
SLASH_FOREVERAICOMPANIONARMORY2 = "/faa"
SlashCmdList.FOREVERAICOMPANIONARMORY = function(msg)
  local word = Util.trim(msg or ""):lower()
  if word == "" then
    ns.UI:Toggle()
  elseif TABS[word] then
    ns.UI:Show(TABS[word])
  elseif word == "resetwindow" then
    ns.UI:ResetWindow()
    Util.chat(L.WINDOW_RESET)
  elseif word == "debug" then
    -- What this client let the addon read: the first thing to share when a tab stays empty.
    Util.chat("version: " .. tostring(ns.version) .. (ns.build and (", build " .. ns.build) or ", no build stamp (not installed by the companion app)"))
    for _, line in ipairs(ns.Scan.Diagnose()) do Util.chat(line) end
    local read, auras = pcall(ns.Auras.Diagnose)
    Util.chat(read and auras or ("buffs seen: " .. tostring(auras)))
    local calibrated, line = pcall(ns.Calibrate.Diagnose)
    Util.chat(calibrated and line or ("calibration: " .. tostring(line)))
    Util.chat("companion: " .. tostring(ns.Advisor:Blocked() or ("ready, app " .. tostring(ns.Advisor:AppState()))))
    -- Whether answers can get back, as the main addon sees it (its newer versions tell).
    local api = ns.Advisor.API()
    local ok, lines = pcall(function() return api and api.Diagnose and api.Diagnose() or nil end)
    for _, line in ipairs(ok and type(lines) == "table" and lines or {}) do Util.chat(tostring(line)) end
    local exported, line = pcall(ns.OneButton.Diagnose)
    Util.chat(exported and line or ("one button: " .. tostring(line)))
    if Core.lastError then Util.chat("last error: " .. Core.lastError) end
    if ns.UI and ns.UI.lastError then Util.chat("window error: " .. ns.UI.lastError) end
  elseif word == "onebutton" then
    -- The rotation as a profile for Forever One Button, or why there is none.
    local ok, why = ns.UI:ShowOneButton()
    if not ok then Util.chat(why == "class" and L.OB_NO_CLASS or L.OB_NOTHING) end
  elseif word == "dump" then
    -- The game's own talent data, saved for the addon's author to read.
    local ok, nodes = pcall(ns.Dump.Run)
    if ok then
      Util.chat(string.format(L.DUMP_DONE, nodes))
      Util.chat(L.DUMP_NEXT)
    else
      Util.chat(string.format(L.DUMP_FAILED, tostring(nodes)))
    end
  else
    Util.chat(L.HELP)
  end
end

-- The addon list next to the minimap (## AddonCompartmentFunc).
function ForeverAICompanionArmory_Toggle()
  ns.UI:Toggle()
end

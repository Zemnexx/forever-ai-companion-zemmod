-- Events and the /armory command.
local ADDON, ns = ...
local L = ns.L
local Util = ns.Util

local Core = {}
ns.Core = Core

local TALENT_EVENTS = { "CHARACTER_POINTS_CHANGED", "PLAYER_TALENT_UPDATE", "TRAIT_CONFIG_UPDATED", "ACTIVE_TALENT_GROUP_CHANGED", "PLAYER_LEVEL_UP" }
local SPELL_EVENTS = { "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB" }

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
end)

on({ "PLAYER_LOGIN" }, function()
  if not ns.db then ns.Store:Init() end
  ns.Store:PruneSeen()
  pcall(ns.Dump.Init)
  -- Registers with the main addon: answers to requests still waiting arrive now.
  if not ns.Advisor:Init() then Util.chat(L.NEED_COMPANION) end
  pcall(ns.Tooltip.Init, ns.Tooltip)
  pcall(ns.Button.Init, ns.Button)
end)

on(TALENT_EVENTS, function()
  ns.Scan.Changed("talents")
  touch()
end)

on(SPELL_EVENTS, function()
  ns.Scan.Changed("spells")
end)

on({ "PLAYER_EQUIPMENT_CHANGED" }, function()
  ns.Items.Forget()
  touch()
end)

on({ "GET_ITEM_INFO_RECEIVED" }, function(_, itemId, success)
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
  elseif word == "debug" then
    -- What this client let the addon read: the first thing to share when a tab stays empty.
    for _, line in ipairs(ns.Scan.Diagnose()) do Util.chat(line) end
    Util.chat("companion: " .. tostring(ns.Advisor:Blocked() or ("ready, app " .. tostring(ns.Advisor:AppState()))))
    if Core.lastError then Util.chat("last error: " .. Core.lastError) end
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

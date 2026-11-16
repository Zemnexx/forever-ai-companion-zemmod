-- The player's personal assistant in Azeroth. Each character picks one the
-- first time the window opens (suggested by faction) and can change it later:
--   Alliance: Fizzi Chispatuerca, gnome inventor from Gnomeregan.
--   Horde:    Rizzik Bujíaveloz, goblin engineer and dealer of the Bilgewater Cartel.
-- A persona sets the window colors, the texts, the minimap button and the
-- personality the AI plays (the companion app has the matching prompt).
-- Texts come from Locale.lua (English names: Fizzi Sparkwrench, Rizzik Fastfuse).
local _, ns = ...
local L = ns.L

local Personas = {}
ns.Personas = Personas

Personas.ORDER = { "fizzi", "rizzik" }

Personas.list = {
  fizzi = {
    id = "fizzi",
    name = "Fizzi",
    fullName = L.FIZZI_FULLNAME,
    role = L.FIZZI_ROLE,
    faction = "Alliance",
    factionLabel = L.FACTION_ALLIANCE,
    -- Best first: race icons of the character creator, then icon files.
    portraits = {
      { atlas = "raceicon128-gnome-female" },
      { atlas = "raceicon-gnome-female" },
      { file = "Interface\\Icons\\Achievement_Character_Gnome_Female" },
    },
    gadget = "Interface\\Icons\\INV_Misc_Gear_01",
    device = L.FIZZI_DEVICE,
    nameColor = "|cff5fd8f5",
    pitch = L.FIZZI_PITCH,
    sample = L.FIZZI_SAMPLE,
    online = L.FIZZI_ONLINE,
    hello = L.FIZZI_HELLO,
    helloNoName = L.FIZZI_HELLO_NONAME,
    sub = L.FIZZI_SUB,
    placeholder = L.FIZZI_PLACEHOLDER,
    thinking = L.FIZZI_THINKING,
    notifyOk = L.FIZZI_NOTIFY_OK,
    notifyFail = L.FIZZI_NOTIFY_FAIL,
    errorIntro = L.FIZZI_ERROR_INTRO,
    tooltipThinking = L.FIZZI_TOOLTIP_THINKING,
    statusOnline = L.FIZZI_STATUS_ONLINE,
    colors = {
      window   = { 0.055, 0.067, 0.078, 0.97 },
      sidebar  = { 0.039, 0.047, 0.056, 1 },
      header   = { 0.071, 0.086, 0.1, 1 },
      line     = { 0.3, 0.85, 1, 0.2 },
      user     = { 0.09, 0.27, 0.34, 0.95 },
      ai       = { 0.12, 0.14, 0.165, 0.95 },
      accent   = { 0.25, 0.8, 0.95, 1 },
      onAccent = { 0.02, 0.08, 0.1, 1 },
      button   = { 0.14, 0.17, 0.2, 1 },
      chip     = { 0.11, 0.14, 0.17, 1 },
      input    = { 0.085, 0.1, 0.12, 1 },
      selected = { 0.3, 0.85, 1, 0.13 },
      ring     = { 0.45, 0.8, 0.95 },
      badge    = { 0.2, 0.72, 0.9, 1 },
    },
  },

  rizzik = {
    id = "rizzik",
    name = "Rizzik",
    fullName = L.RIZZIK_FULLNAME,
    role = L.RIZZIK_ROLE,
    faction = "Horde",
    factionLabel = L.FACTION_HORDE,
    portraits = {
      { atlas = "raceicon128-goblin-male" },
      { atlas = "raceicon-goblin-male" },
      { file = "Interface\\Icons\\Achievement_Character_Goblin_Male" },
      { file = "Interface\\Icons\\Achievement_Goblinhead" },
    },
    gadget = "Interface\\Icons\\INV_Misc_Coin_01",
    device = L.RIZZIK_DEVICE,
    nameColor = "|cffff4b3a",
    pitch = L.RIZZIK_PITCH,
    sample = L.RIZZIK_SAMPLE,
    online = L.RIZZIK_ONLINE,
    hello = L.RIZZIK_HELLO,
    helloNoName = L.RIZZIK_HELLO_NONAME,
    sub = L.RIZZIK_SUB,
    placeholder = L.RIZZIK_PLACEHOLDER,
    thinking = L.RIZZIK_THINKING,
    notifyOk = L.RIZZIK_NOTIFY_OK,
    notifyFail = L.RIZZIK_NOTIFY_FAIL,
    errorIntro = L.RIZZIK_ERROR_INTRO,
    tooltipThinking = L.RIZZIK_TOOLTIP_THINKING,
    statusOnline = L.RIZZIK_STATUS_ONLINE,
    colors = {
      window   = { 0.07, 0.055, 0.052, 0.97 },
      sidebar  = { 0.052, 0.04, 0.038, 1 },
      header   = { 0.1, 0.07, 0.065, 1 },
      line     = { 0.85, 0.2, 0.15, 0.3 },
      user     = { 0.26, 0.15, 0.1, 0.95 },
      ai       = { 0.15, 0.12, 0.115, 0.95 },
      accent   = { 0.8, 0.16, 0.12, 1 },
      onAccent = { 1, 0.95, 0.9, 1 },
      button   = { 0.22, 0.15, 0.13, 1 },
      chip     = { 0.16, 0.115, 0.105, 1 },
      input    = { 0.11, 0.08, 0.075, 1 },
      selected = { 0.85, 0.2, 0.15, 0.16 },
      ring     = { 1, 0.3, 0.22 },
      badge    = { 0.85, 0.18, 0.13, 1 },
    },
  },
}

-- The first portrait this client has: an atlas the game knows, or an icon
-- file that exists. Without a way to check, the first icon file is used. If
-- none exists, the persona's gadget (gear or coin).
local function exists(img)
  if img.atlas then
    if not (C_Texture and C_Texture.GetAtlasInfo) then return false end
    local ok, info = pcall(C_Texture.GetAtlasInfo, img.atlas)
    return ok and type(info) == "table"
  end
  if not GetFileIDFromPath then return true end
  local ok, id = pcall(GetFileIDFromPath, img.file)
  return ok and id ~= nil
end

function Personas.Portrait(p)
  if not p.resolved then
    for _, img in ipairs(p.portraits) do
      if exists(img) then p.resolved = img break end
    end
    p.resolved = p.resolved or { file = p.gadget }
  end
  return p.resolved
end

-- Shows the persona's portrait on a texture (icons are trimmed of their border).
function Personas.SetPortrait(texture, p)
  local img = Personas.Portrait(p)
  if img.atlas and texture.SetAtlas then
    texture:SetAtlas(img.atlas)
  else
    texture:SetTexture(img.file)
    if texture.SetTexCoord then texture:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
  end
end

-- "atlas raceicon128-goblin-male" (for /ia status).
function Personas.PortraitName(p)
  local img = Personas.Portrait(p)
  return img.atlas and ("atlas " .. img.atlas) or (L.PORTRAIT_FILE .. tostring(img.file))
end

local function charKey()
  return (UnitName and UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?")
end

local function store()
  ns.db.personas = ns.db.personas or {}
  return ns.db.personas
end

-- The one matching the character's faction.
function Personas:Suggested()
  local faction = UnitFactionGroup and UnitFactionGroup("player")
  for _, id in ipairs(self.ORDER) do
    if self.list[id].faction == faction then return self.list[id] end
  end
  return self.list.fizzi
end

-- Has this character picked an assistant yet?
function Personas:Chosen()
  return self.list[store()[charKey()] or ""] ~= nil
end

function Personas:Current()
  return self.list[store()[charKey()] or ""] or self:Suggested()
end

function Personas:Set(id)
  if not self.list[id] then return end
  store()[charKey()] = id
  if ns.UI and ns.UI.ApplyPersona then ns.UI:ApplyPersona() end
  if ns.Button and ns.Button.ApplyPersona then ns.Button:ApplyPersona() end
end

-- "Counting the profits..." : a new phrase every ~2.7 s, dots every tick.
function Personas:ThinkingText(tick)
  tick = tick or 0
  local list = self:Current().thinking
  return list[math.floor(tick / 6) % #list + 1] .. string.rep(".", tick % 3 + 1)
end

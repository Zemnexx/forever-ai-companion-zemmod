-- What the Armory remembers between sessions (ForeverAICompanionArmory_DB):
--   chars[key]   per character: the build the player is going for (profile),
--                the last result of each analysis, what is being asked now, and
--                the rotation's lists for Forever One Button (oneButton, OneButton.lua)
--   seen         items the addon has seen in the game, for every character
--   ui           the window's place and options
local _, ns = ...
local Util = ns.Util

local Store = {}
ns.Store = Store

Store.KINDS = { "talents", "gear", "rotation", "discover" }
Store.GOALS = { "leveling", "dungeons", "raids", "pvp", "solo" }
Store.ROLES = { "dps", "tank", "healer" }
-- What the gear plan may send the player to do. Each can be left out of the
-- plan; at least one of them stays in.
Store.GEAR_SOURCES = { "dungeon", "raid", "quest" }
local MAX_SEEN = 1500

function Store:Init()
  ForeverAICompanionArmory_DB = ForeverAICompanionArmory_DB or {}
  local db = ForeverAICompanionArmory_DB
  db.v = db.v or 1
  db.chars = db.chars or {}
  db.seen = db.seen or {}
  db.ui = db.ui or {}
  if db.ui.tooltip == nil then db.ui.tooltip = true end
  if db.ui.button == nil then db.ui.button = true end
  ns.db = db
  return db
end

-- This character's data.
function Store:Char()
  if not ns.db then return nil end
  local key = Util.charKey()
  local c = ns.db.chars[key]
  if not c then
    c = {}
    ns.db.chars[key] = c
  end
  c.profile = c.profile or {}
  c.results = c.results or {}
  c.asking = c.asking or {}
  return c
end

-- The build the player is going for. Defaults: leveling as damage.
function Store:Profile()
  local c = self:Char()
  local p = c and c.profile or {}
  p.goal = p.goal or "leveling"
  p.role = p.role or "dps"
  return p
end

function Store:SetProfile(field, value)
  local p = self:Profile()
  if p[field] == value then return false end
  p[field] = value
  return true
end

-- Where this character wants gear from: { dungeon = true, raid = true, quest = true }.
-- Kept as what is left out, so a character that never chose has all three.
function Store:GearSources()
  local c = self:Char()
  local without = c and c.gearWithout or {}
  local out = {}
  for _, source in ipairs(Store.GEAR_SOURCES) do out[source] = not without[source] end
  return out
end

-- Takes a source into the gear plan or leaves it out. False when that would
-- leave none of them in (or the source is not one of them): nothing changes.
function Store:SetGearSource(source, on)
  local c = self:Char()
  local known, others = false, 0
  local without = c and c.gearWithout or {}
  for _, s in ipairs(Store.GEAR_SOURCES) do
    if s == source then known = true elseif not without[s] then others = others + 1 end
  end
  if not c or not known or (not on and others == 0) then return false end
  without[source] = (not on) or nil
  c.gearWithout = next(without) and without or nil
  return true
end

-- The sources left out, in their fixed order, or nil when none is.
function Store:GearWithout()
  local c = self:Char()
  local without = c and c.gearWithout or {}
  local out = {}
  for _, source in ipairs(Store.GEAR_SOURCES) do
    if without[source] then out[#out + 1] = source end
  end
  return #out > 0 and out or nil
end

-- Whether this character's rotation is asked for fighting several enemies at once.
function Store:Aoe()
  local c = self:Char()
  return c ~= nil and c.aoe == true
end

function Store:SetAoe(on)
  local c = self:Char()
  if c then c.aoe = on and true or nil end
end

-- A result: { data, at, model, tokens, text, profile, weapon }.
function Store:Result(kind)
  local c = self:Char()
  return c and c.results[kind] or nil
end

-- weapon: the item id in the main hand when it was asked (0 for none), or
-- nil to take the one equipped now. Kept so the tab can tell when the
-- rotation or the gear plan was made for another weapon.
function Store:SaveResult(kind, result, weapon)
  local c = self:Char()
  if not c then return end
  local p = self:Profile()
  if weapon == nil and ns.Items and ns.Items.EquippedId then weapon = ns.Items.EquippedId("mainHand") or 0 end
  c.results[kind] = {
    data = result.data, text = result.text, model = result.model, tokens = result.tokens,
    at = time(), profile = { spec = p.spec, goal = p.goal, role = p.role }, weapon = weapon,
  }
  -- The rotation's lists for Forever One Button are kept apart: one per kind
  -- of fight, while only the last result is kept. Guarded: they came over
  -- the wire, and the result itself is saved whatever happens to them.
  if kind == "rotation" and ns.OneButton then pcall(ns.OneButton.Remember, c, result.data) end
end

-- The stat weights the item scores use: from the gear plan (keyed like the
-- game's item stats), or none yet.
function Store:Weights()
  local gear = self:Result("gear")
  local w = gear and gear.data and gear.data.weights
  return type(w) == "table" and next(w) ~= nil and w or nil
end

-- What is being asked now, per kind: { id, t, state, message }.
function Store:Asking(kind)
  local c = self:Char()
  return c and c.asking[kind] or nil
end

function Store:SetAsking(kind, value)
  local c = self:Char()
  if c then c.asking[kind] = value end
end

-- Items seen in the game ----------------------------------------------------------

-- Remembers an item with where it was seen. entry: { n = name, s = equip slot
-- (INVTYPE_...), l = item level, r = required level, q = quality, y = type }.
function Store:Remember(itemId, entry, src)
  if not ns.db or type(itemId) ~= "number" or type(entry) ~= "table" then return end
  local seen = ns.db.seen
  local e = seen[itemId] or {}
  for k, v in pairs(entry) do e[k] = v end
  e.t = time()
  -- A source that says more (a boss, a vendor) is kept over "auction".
  if src and (not e.src or e.src == "auction" or src ~= "auction") then e.src = src end
  seen[itemId] = e
end

-- Drops the items seen longest ago once there are too many.
function Store:PruneSeen()
  if not ns.db then return end
  local seen = ns.db.seen
  local ids = {}
  for id in pairs(seen) do ids[#ids + 1] = id end
  if #ids <= MAX_SEEN then return end
  table.sort(ids, function(a, b) return (seen[a].t or 0) > (seen[b].t or 0) end)
  for i = MAX_SEEN + 1, #ids do seen[ids[i]] = nil end
end

-- The buffs seen on the character, by name and spell id. One Button checks a
-- buff by the buff's own spell id, and a proc (a buff no spell in the
-- spellbook gives: a talent's, an item's) has an id only the game knows. So
-- the Armory remembers every buff it sees on the player, and rotation
-- requests carry them (the section armory_auras) for the app to let the AI
-- use them in a list for One Button.
--
-- Read when the player's buffs change (at most about once a second), when a
-- fight ends and when a rotation request is put together, with whichever of
-- the game's ways to read buffs this client has. Kept per character as
-- c.auras = { { name, id, at }, ... }, the most recently seen first.
local _, ns = ...
local Util = ns.Util

local Auras = {}
ns.Auras = Auras

Auras.MAX_KEPT = 150
Auras.MAX_SENT = 120
-- More than any client shows on one character.
local MAX_INDEX = 80
-- Seconds between two reads on UNIT_AURA, which comes many times a second in a fight.
local THROTTLE = 1

-- How the last read went, for /armory debug.
Auras.how = nil   -- the way it was read
Auras.why = nil   -- why it could not be read

-- A name and an id the addon can keep: plain values, never the client's
-- hidden ("secret") ones.
local function plainName(name)
  if type(name) ~= "string" or Util.secret(name) then return nil end
  name = Util.clean(name)
  name = name and Util.trim((name:gsub("[%c|]", " "))) or ""
  if name == "" then return nil end
  return name:sub(1, 80)
end

local function plainId(id)
  if type(id) ~= "number" or Util.secret(id) then return nil end
  if id <= 0 or id >= 2147483648 or id ~= math.floor(id) then return nil end
  return id
end

-- name, id of an aura as a table (the modern AuraData), or nil.
local function fromData(aura)
  if type(aura) ~= "table" then return nil end
  local ok, name, id = pcall(function() return aura.name, aura.spellId end)
  if not ok then return nil end
  return plainName(name), plainId(id)
end

-- The ways to read the player's buffs, tried in this order. Each returns the
-- auras found as { { name, id } }, or nil and why it could not be used.
local WAYS = {
  {
    name = "C_UnitAuras.GetAuraDataByIndex",
    read = function(add)
      local get = type(C_UnitAuras) == "table" and C_UnitAuras.GetAuraDataByIndex
      if type(get) ~= "function" then return false, "missing" end
      for i = 1, MAX_INDEX do
        local ok, aura = pcall(get, "player", i, "HELPFUL")
        if not ok then
          if i == 1 then return false, tostring(aura) end
          break
        end
        if aura == nil then break end
        add(fromData(aura))
      end
      return true
    end,
  },
  {
    name = "AuraUtil.ForEachAura",
    read = function(add)
      local each = type(AuraUtil) == "table" and AuraUtil.ForEachAura
      if type(each) ~= "function" then return false, "missing" end
      local count = 0
      -- Packed: the modern client hands over an AuraData table. An older one
      -- hands over UnitBuff's values, the spell id tenth.
      local ok, err = pcall(each, "player", "HELPFUL", nil, function(first, ...)
        count = count + 1
        if type(first) == "table" then
          add(fromData(first))
        else
          add(plainName(first), plainId((select(9, ...))))
        end
        return count >= MAX_INDEX
      end, true)
      if not ok then return false, tostring(err) end
      return true
    end,
  },
  {
    name = "UnitBuff",
    read = function(add)
      if type(UnitBuff) ~= "function" then return false, "missing" end
      for i = 1, MAX_INDEX do
        local ok, name, _, _, _, _, _, _, _, _, id = pcall(UnitBuff, "player", i)
        if not ok then
          if i == 1 then return false, tostring(name) end
          break
        end
        if name == nil then break end
        add(plainName(name), plainId(id))
      end
      return true
    end,
  },
}
Auras.WAYS = WAYS

-- The buffs on the player now, in the order the game lists them, or nil when
-- no way to read them works on this client.
function Auras.Read()
  local failed = {}
  for _, way in ipairs(WAYS) do
    local found, seen = {}, {}
    local function add(name, id)
      -- An aura with a hidden name or id is skipped; so is one listed twice.
      if name and id and not seen[id] then
        seen[id] = true
        found[#found + 1] = { name = name, id = id }
      end
    end
    local ok, worked, why = pcall(way.read, add)
    if ok and worked then
      Auras.how, Auras.why = way.name, nil
      return found
    end
    if not ok then why = worked end
    if why ~= "missing" then failed[#failed + 1] = way.name .. " failed: " .. tostring(why) end
  end
  Auras.how = nil
  Auras.why = #failed > 0 and table.concat(failed, "; ") or "this client has none of C_UnitAuras.GetAuraDataByIndex, AuraUtil.ForEachAura, UnitBuff"
  return nil
end

-- The list kept for this character, cleaned of anything that is not an
-- entry (saved data can be anything).
local function kept()
  local c = ns.Store:Char()
  if not c then return nil end
  local out = {}
  for _, e in ipairs(type(c.auras) == "table" and c.auras or {}) do
    if type(e) == "table" and plainName(e.name) and plainId(e.id) then out[#out + 1] = e end
  end
  c.auras = out
  return out
end

-- Reads the buffs now and puts them at the front of what is kept: a buff
-- seen again moves there. Returns how many are on now, or nil.
function Auras.Learn()
  local list = kept()
  if not list then return nil end
  local now = Auras.Read()
  if not now then return nil end
  if #now == 0 then return 0 end
  local at = time()
  local out, placed = {}, {}
  for _, a in ipairs(now) do
    out[#out + 1] = { name = a.name, id = a.id, at = at }
    placed[a.id] = true
  end
  for _, e in ipairs(list) do
    if #out >= Auras.MAX_KEPT then break end
    if not placed[e.id] then
      out[#out + 1] = e
      placed[e.id] = true
    end
  end
  ns.Store:Char().auras = out
  return #now
end

-- Whole seconds are enough for "about once a second".
local function clock()
  return Util.num(Util.safe(time)) or 0
end

local lastRead, waiting = nil, false

-- The player's buffs changed. Read at once, unless a read was less than a
-- second ago: then once more a second later, so the last change is not missed.
function Auras.Changed()
  local t = clock()
  if lastRead == nil or t - lastRead >= THROTTLE then
    lastRead = t
    pcall(Auras.Learn)
    return
  end
  if waiting or not (C_Timer and C_Timer.After) then return end
  waiting = true
  C_Timer.After(THROTTLE, function()
    waiting = false
    lastRead = clock()
    pcall(Auras.Learn)
  end)
end

-- For a rotation request: what is on now, then the most recently seen,
-- { name, id } only. An empty list when nothing could be read.
function Auras.Section()
  pcall(Auras.Learn)
  local out = {}
  for _, e in ipairs(kept() or {}) do
    if #out >= Auras.MAX_SENT then break end
    out[#out + 1] = { name = e.name, id = e.id }
  end
  return out
end

-- One line for /armory debug.
function Auras.Diagnose()
  pcall(Auras.Learn)
  local list = kept() or {}
  local names = {}
  for i = 1, math.min(3, #list) do names[i] = list[i].name end
  local line = string.format("buffs seen: %d remembered", #list)
  if #names > 0 then line = line .. " (latest " .. table.concat(names, ", ") .. ")" end
  if Auras.how then return line .. "; read with " .. Auras.how end
  return line .. "; none could be read now: " .. tostring(Auras.why or "not tried")
end

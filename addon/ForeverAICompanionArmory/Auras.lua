-- The buffs seen on the character, by name and spell id. One Button checks a
-- buff by the buff's own spell id, and a proc (a buff no spell in the
-- spellbook gives: a talent's, an item's) has an id only the game knows. So
-- the Armory remembers every buff it sees on the player, and rotation
-- requests carry them (the section armory_auras) for the app to let the AI
-- use them in a list for One Button. A name and an id do not say what a buff
-- is ("Echo of Command" is a talent's stored seal), so each also carries what
-- its spell's tooltip says and the most stacks seen on it.
--
-- Read when the player's buffs change (at most about once a second), when a
-- fight ends and when a rotation request is put together, with whichever of
-- the game's ways to read buffs this client has. Kept per character as
-- c.auras = { { name, id, at, first, desc, stacks }, ... }, the most recently
-- seen first: "at" when it was last seen, "first" when it was first seen (an
-- entry saved without it counts as first seen when it was last seen), "desc"
-- the spell's tooltip text and "stacks" the most applications seen, each only
-- when known.
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
-- Tooltip reads for descriptions: a learn runs up to once a second in a
-- fight, so it reads only a few, and the rest wait for later learns. A buff
-- whose tooltip gives nothing is tried a few times a session, not forever.
Auras.DESC_READS = 3
Auras.DESC_TRIES = 3
Auras.MAX_DESC = 200
-- Spell id -> tooltip reads tried this session (not saved).
Auras.tries = {}

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

-- Stacks worth keeping: a plain whole number above 1 (a buff that does not
-- stack shows 0 or 1).
local function plainStacks(n)
  if type(n) ~= "number" or Util.secret(n) then return nil end
  if n <= 1 or n >= 10000 or n ~= math.floor(n) then return nil end
  return n
end

local function plainDesc(s)
  if type(s) ~= "string" or Util.secret(s) or s == "" then return nil end
  return s
end

-- name, id, stacks of an aura as a table (the modern AuraData), or nil.
local function fromData(aura)
  if type(aura) ~= "table" then return nil end
  local ok, name, id = pcall(function() return aura.name, aura.spellId end)
  if not ok then return nil end
  -- Read on its own: an aura whose count is hidden still has its name and id.
  local okStacks, stacks = pcall(function() return aura.applications end)
  return plainName(name), plainId(id), okStacks and plainStacks(stacks) or nil
end

-- The ways to read the player's buffs, tried in this order. Each returns the
-- auras found as { { name, id, stacks } }, or nil and why it could not be used.
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
      -- hands over UnitBuff's values, the count third and the spell id tenth.
      local ok, err = pcall(each, "player", "HELPFUL", nil, function(first, ...)
        count = count + 1
        if type(first) == "table" then
          add(fromData(first))
        else
          add(plainName(first), plainId((select(9, ...))), plainStacks((select(2, ...))))
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
        local ok, name, _, count, _, _, _, _, _, _, id = pcall(UnitBuff, "player", i)
        if not ok then
          if i == 1 then return false, tostring(name) end
          break
        end
        if name == nil then break end
        add(plainName(name), plainId(id), plainStacks(count))
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
    local function add(name, id, stacks)
      -- An aura with a hidden name or id is skipped; so is one listed twice.
      if name and id and not seen[id] then
        seen[id] = true
        found[#found + 1] = { name = name, id = id, stacks = stacks }
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

-- Reads the tooltips of a few buffs still without a description, in the
-- order kept (the ones on now first). Each read is guarded and a hidden or
-- empty tooltip leaves the buff as it was, for a later learn.
local function describe(list)
  local reads = 0
  for _, e in ipairs(list) do
    if reads >= Auras.DESC_READS then return end
    if not plainDesc(e.desc) and (Auras.tries[e.id] or 0) < Auras.DESC_TRIES then
      reads = reads + 1
      Auras.tries[e.id] = (Auras.tries[e.id] or 0) + 1
      local ok, desc = pcall(ns.Scan.SpellDescription, e.id, Auras.MAX_DESC)
      if ok and plainDesc(desc) then e.desc = desc end
    end
  end
end

-- The most stacks seen: the old count or the new one.
local function most(old, new)
  old, new = plainStacks(old), plainStacks(new)
  if old and new then return math.max(old, new) end
  return old or new
end

-- Reads the buffs now and puts them at the front of what is kept: a buff
-- seen again moves there. Returns how many are on now, or nil.
function Auras.Learn()
  local list = kept()
  if not list then return nil end
  local now = Auras.Read()
  if not now then return nil end
  if #now == 0 then
    describe(list)
    return 0
  end
  local at = time()
  local before = {}
  for _, e in ipairs(list) do
    if before[e.id] == nil then before[e.id] = e end
  end
  local out, placed = {}, {}
  for _, a in ipairs(now) do
    -- A buff seen again keeps when it was first seen.
    local old = before[a.id]
    local first = old and (tonumber(old.first) or tonumber(old.at)) or at
    out[#out + 1] = { name = a.name, id = a.id, at = at, first = first,
      desc = old and plainDesc(old.desc) or nil, stacks = most(old and old.stacks, a.stacks) }
    placed[a.id] = true
  end
  for _, e in ipairs(list) do
    if #out >= Auras.MAX_KEPT then break end
    if not placed[e.id] then
      out[#out + 1] = e
      placed[e.id] = true
    end
  end
  describe(out)
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
-- { name, id, desc, stacks } (the last two when known) and nothing else. An
-- empty list when nothing could be read.
function Auras.Section()
  pcall(Auras.Learn)
  local out = {}
  for _, e in ipairs(kept() or {}) do
    if #out >= Auras.MAX_SENT then break end
    local desc = plainDesc(e.desc)
    out[#out + 1] = { name = e.name, id = e.id, desc = desc and desc:sub(1, Auras.MAX_DESC) or nil, stacks = plainStacks(e.stacks) }
  end
  return out
end

-- When an entry was first seen: saved before that was kept, when it was last seen.
local function firstSeen(e)
  return tonumber(e.first) or tonumber(e.at) or 0
end

-- What is kept, the buffs added to the list most recently first: the
-- question is usually whether a new one (a proc) was learned, and the buffs
-- that are always on stay at the front of the list itself.
function Auras.Newest()
  local list = kept() or {}
  local order = {}
  for i, e in ipairs(list) do order[#order + 1] = { e = e, i = i } end
  table.sort(order, function(a, b)
    local fa, fb = firstSeen(a.e), firstSeen(b.e)
    if fa ~= fb then return fa > fb end
    return a.i < b.i
  end)
  local out = {}
  for i, o in ipairs(order) do out[i] = o.e end
  return out
end

-- Entries per chat line of /armory buffs.
local PER_LINE = 5

-- The chat lines of /armory buffs: every buff remembered, newest first, with
-- its spell id and the most stacks seen, the ones on the character now
-- marked. The descriptions are too long for chat and are not listed.
function Auras.Lines()
  pcall(Auras.Learn)
  local list = Auras.Newest()
  local L = ns.L
  if #list == 0 then return { L.AURAS_NONE } end
  local ok, current = pcall(Auras.Read)
  local on = {}
  for _, a in ipairs(ok and type(current) == "table" and current or {}) do on[a.id] = true end
  local lines, parts = { string.format(L.AURAS_HEADING, #list) }, {}
  for _, e in ipairs(list) do
    local stacks = plainStacks(e.stacks)
    local entry = stacks and string.format(L.AURAS_STACKS, e.name, e.id, stacks) or string.format("%s (%d)", e.name, e.id)
    if on[e.id] then entry = entry .. " " .. L.AURAS_ON end
    parts[#parts + 1] = entry
    if #parts >= PER_LINE then
      lines[#lines + 1] = table.concat(parts, ", ")
      parts = {}
    end
  end
  if #parts > 0 then lines[#lines + 1] = table.concat(parts, ", ") end
  return lines
end

-- One line for /armory debug.
function Auras.Diagnose()
  pcall(Auras.Learn)
  local list = Auras.Newest()
  local names = {}
  for i = 1, math.min(3, #list) do names[i] = list[i].name end
  local described = 0
  for _, e in ipairs(list) do
    if plainDesc(e.desc) then described = described + 1 end
  end
  local line = string.format("buffs seen: %d remembered, %d with a description", #list, described)
  if #names > 0 then line = line .. " (newest: " .. table.concat(names, ", ") .. ")" end
  if Auras.how then return line .. "; read with " .. Auras.how end
  return line .. "; none could be read now: " .. tostring(Auras.why or "not tried")
end

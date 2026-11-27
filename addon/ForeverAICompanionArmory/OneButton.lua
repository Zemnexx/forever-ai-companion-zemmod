-- The best rotation as a profile for Forever One Button, another addon of the
-- same owner that suggests abilities from priority lists. One Button has no
-- function another addon can call, so the profile is a line of text the
-- player copies here and pastes into its Rotations window (Import).
--
-- The app translates the best rotation into One Button's own entries and
-- conditions (data.oneButton in a rotation result). This file keeps them per
-- character, one list per kind of fight, works out which of One Button's
-- talent trees they belong to the way One Button does, leaves out what One
-- Button would refuse, and writes the text in One Button's format.
local _, ns = ...
local L = ns.L
local Util = ns.Util

local OneButton = {}
ns.OneButton = OneButton

OneButton.ADDON = "ForeverOneButton"
-- The lists the app sends: one enemy, or several. One Button also has a
-- cleave list; without one it uses the AoE list, then single target.
OneButton.CONTEXTS = { "st", "aoe" }

-- Limits, validators and SCHEMA below are copied from Forever One Button
-- 1.1.4-zm9, Core/Profiles.lua, so that what is exported is exactly what its
-- importer keeps. Keep them in step with that file.
local PREFIX = "FOB1:"
local MAX_ENTRIES = 60    -- per list
local MAX_GATES = 12      -- per entry and per group
local MAX_DEPTH = 3       -- entry gates are depth 1; groups nest up to here
local MAX_NAME = 40
OneButton.MAX_ENTRIES, OneButton.MAX_GATES, OneButton.MAX_DEPTH = MAX_ENTRIES, MAX_GATES, MAX_DEPTH

-- What the Armory keeps of the app's plain sentences.
local MAX_LEFT, MAX_LINE = 12, 300

-- A sentence from the app as plain text: no markup, no line breaks, bounded.
function OneButton.Plain(s, limit)
  s = Util.clean(s)
  if not s then return nil end
  s = Util.trim((s:gsub("[%c|]", " ")))
  if s == "" then return nil end
  return s:sub(1, limit or MAX_LINE)
end

local OPS = {}
for _, op in ipairs({ ">=", ">", "<=", "<", "=", "!=" }) do OPS[op] = true end

-- Validators: the clean value, or nil.
local function Spell(v)
  v = tonumber(v)
  if v and v > 0 and v < 2147483648 and v == math.floor(v) then return v end
  return nil
end
local function Num(low, high)
  return function(v)
    v = tonumber(v)
    if v and v == v and v >= low and v <= high then return v end
    return nil
  end
end
local function Enum(set)
  return function(v)
    if set[v] then return v end
    return nil
  end
end
local function Flag(v)
  if v == true then return true end
  return nil
end
local function Op(v)
  if OPS[v] then return v end
  return nil
end
local function Slot(v)
  v = tonumber(v)
  if v and v >= 1 and v <= 4 and v == math.floor(v) then return v end
  return nil
end

-- Every condition type One Button's engine reads, its fields and the ones
-- it cannot do without. Groups hold other conditions in `g`.
local SCHEMA = {
  power = { fields = { res = Enum({ mana = true, rage = true, energy = true }), op = Op, n = Num(-100000, 100000),
    ispct = Flag }, required = { "res", "op", "n" } },
  buff = { fields = { id = Spell, dur = Num(0, 86400), neg = Flag }, required = { "id" } },
  cd = { fields = { id = Spell, neg = Flag }, required = { "id" } },
  stack = { fields = { id = Spell, op = Op, n = Num(0, 1000), tgt = Flag }, required = { "id", "op", "n" } },
  targets = { fields = { op = Op, n = Num(0, 100) }, required = { "op", "n" } },
  health = { fields = { op = Op, pct = Num(0, 100) }, required = { "op", "pct" } },
  execute = { fields = { op = Op, pct = Num(0, 100) }, required = { "op", "pct" } },
  resource = { fields = { res = Enum({ combo_points = true }), op = Op, n = Num(0, 10) }, required = { "op", "n" },
    fixed = { res = "combo_points" } },
  known = { fields = { id = Spell, neg = Flag }, required = { "id" } },
  stealth = { fields = { neg = Flag }, required = {} },
  near = { fields = { n = Num(0, 100) }, required = { "n" } },
  totem = { fields = { slot = Slot, neg = Flag }, required = { "slot" } },
  swing = { fields = { op = Op, n = Num(0, 10), ranged = Flag }, required = { "op", "n" } },
  dot = { fields = { id = Spell }, required = { "id" } },
  starved = { fields = {}, required = {} },
  tick = { fields = { op = Op, n = Num(-100000, 100000) }, required = {} },
  unconfirmed = { fields = {}, required = {} },
  any = { group = true },
  all = { group = true },
}
OneButton.SCHEMA = SCHEMA

-- The sanitizer: what One Button's would keep. report.dropped counts what
-- was left out (conditions, fields, entries), as One Button counts it.
local function drop(report)
  if report then report.dropped = (report.dropped or 0) + 1 end
end

local sanitizeGate
function sanitizeGate(raw, depth, report)
  if type(raw) ~= "table" then return drop(report) end
  local spec = SCHEMA[raw.t]
  if not spec then return drop(report) end
  if spec.group then
    if depth >= MAX_DEPTH then return drop(report) end
    local members = {}
    for _, member in ipairs(type(raw.g) == "table" and raw.g or {}) do
      if #members >= MAX_GATES then
        drop(report)
        break
      end
      local gate = sanitizeGate(member, depth + 1, report)
      if gate then members[#members + 1] = gate end
    end
    if #members == 0 then return drop(report) end
    return { t = raw.t, g = members }
  end
  local out, bad = { t = raw.t }, 0
  for key, value in pairs(raw) do
    if key ~= "t" then
      local validate = spec.fields[key]
      local clean = validate and validate(value)
      if clean ~= nil then
        out[key] = clean
      elseif value ~= false then
        bad = bad + 1 -- an unknown field, or a value out of range
      end
    end
  end
  for key, value in pairs(spec.fixed or {}) do out[key] = value end
  for _, key in ipairs(spec.required) do
    if out[key] == nil then return drop(report) end -- the whole condition counts once
  end
  if report and bad > 0 then report.dropped = (report.dropped or 0) + bad end
  return out
end

-- An entry as One Button keeps it: { id, gates }. One Button's own markers
-- (w, delegated) are not part of what the app sends and are not carried.
local function sanitizeEntry(raw, report)
  if type(raw) ~= "table" then return drop(report) end
  local id = Spell(raw.id)
  if not id then return drop(report) end
  local entry = { id = id, gates = {} }
  for _, rawGate in ipairs(type(raw.gates) == "table" and raw.gates or {}) do
    if #entry.gates >= MAX_GATES then
      drop(report)
      break
    end
    local gate = sanitizeGate(rawGate, 1, report)
    if gate then entry.gates[#entry.gates + 1] = gate end
  end
  return entry
end

-- named: also keep each entry's name (for the window and to recognize the
-- spell; it is never exported).
function OneButton.SanitizeList(raw, report, named)
  local list = {}
  for _, entry in ipairs(type(raw) == "table" and raw or {}) do
    if #list >= MAX_ENTRIES then
      drop(report)
      break
    end
    local clean = sanitizeEntry(entry, report)
    if clean then
      if named then clean.name = OneButton.Plain(entry.name, 80) end
      list[#list + 1] = clean
    end
  end
  return list
end

-- Printable, no escape sequences (|), trimmed, at most 40 characters: One
-- Button's CleanName.
function OneButton.CleanName(name)
  if type(name) ~= "string" then return nil end
  name = name:gsub("[%c|]", ""):gsub("^%s+", ""):gsub("%s+$", "")
  if #name > MAX_NAME then name = name:sub(1, MAX_NAME):gsub("%s+$", "") end
  if name == "" then return nil end
  return name
end

-- The text format ---------------------------------------------------------------------
-- "FOB1:" .. body .. ":" .. six hex digits of checksum, where body is a table
-- literal: the array part first, then the string keys sorted. Written exactly
-- as One Button's Encode writes it, so its Decode reads back the same tables.

local function quote(s)
  return '"' .. s:gsub('[%c"\\]', function(c) return string.format("\\%03d", c:byte()) end) .. '"'
end

local function encode(value, out)
  local kind = type(value)
  if kind == "table" then
    local parts = {}
    local n = #value
    for i = 1, n do
      local piece = {}
      encode(value[i], piece)
      parts[#parts + 1] = table.concat(piece)
    end
    local keys = {}
    for key in pairs(value) do
      if not (type(key) == "number" and key >= 1 and key <= n and key == math.floor(key)) then
        if type(key) ~= "string" or not key:match("^[%a_][%w_]*$") then error("unsupported key") end
        keys[#keys + 1] = key
      end
    end
    table.sort(keys)
    for _, key in ipairs(keys) do
      local piece = {}
      encode(value[key], piece)
      parts[#parts + 1] = key .. "=" .. table.concat(piece)
    end
    out[#out + 1] = "{" .. table.concat(parts, ",") .. "}"
  elseif kind == "string" then
    out[#out + 1] = quote(value)
  elseif kind == "number" then
    if value ~= value or value == math.huge or value == -math.huge then error("unsupported number") end
    out[#out + 1] = string.format("%.14g", value)
  elseif kind == "boolean" then
    out[#out + 1] = value and "true" or "false"
  else
    error("unsupported value")
  end
end

function OneButton.Encode(value)
  local out = {}
  encode(value, out)
  return table.concat(out)
end

function OneButton.Checksum(s)
  local sum = 0
  for i = 1, #s do sum = (sum * 31 + s:byte(i)) % 16777213 end
  return string.format("%06x", sum)
end

-- The whole line for a profile table, or nil when it cannot be written.
function OneButton.Text(profile)
  local ok, body = pcall(OneButton.Encode, profile)
  if not ok then return nil end
  return PREFIX .. body .. ":" .. OneButton.Checksum(body)
end

-- Talent trees ------------------------------------------------------------------------
-- One Button's lists per class (its Data/Rotations.lua) and the tree it
-- falls back to when no points are spent.
local TREES = {
  DRUID = { default = "feral", "balance", "feral", "feral_bear", "restoration" },
  HUNTER = { default = "beast_mastery", "beast_mastery", "marksmanship", "survival" },
  MAGE = { default = "frost", "arcane", "fire", "frost" },
  PALADIN = { default = "retribution", "holy", "protection", "retribution" },
  PRIEST = { default = "shadow", "discipline", "holy", "shadow" },
  ROGUE = { default = "combat", "assassination", "combat", "subtlety" },
  SHAMAN = { default = "enhancement", "elemental", "enhancement", "restoration" },
  WARLOCK = { default = "affliction", "affliction", "demonology", "destruction" },
  WARRIOR = { default = "arms", "arms", "fury", "protection" },
}
for _, trees in pairs(TREES) do
  trees.keys = {}
  for _, key in ipairs(trees) do trees.keys[key] = true end
end
OneButton.TREES = TREES

-- "Feral Combat" -> "feral_combat", as One Button turns tree names into keys.
local function slug(name)
  if type(name) ~= "string" or Util.secret(name) then return nil end
  return (name:lower():gsub("[^%a]+", "_"):gsub("^_+", ""):gsub("_+$", ""))
end

-- The class's key for a tree's name: the same, or its first word
-- ("feral_combat" -> "feral").
local function match(trees, name)
  local s = slug(name)
  if not s or s == "" then return nil end
  if trees.keys[s] then return s end
  local first = s:match("^[^_]+")
  if first and trees.keys[first] then return first end
  return nil
end

-- The class token ("PALADIN"), or nil.
function OneButton.Class()
  local ok, _, token = pcall(UnitClass, "player")
  if not ok or type(token) ~= "string" or Util.secret(token) or not token:match("^[A-Z]+$") then return nil end
  return token
end

-- The tree One Button would use for this character, and the class: the tree
-- with the most points spent; with none spent, the specialization chosen in
-- the Build tab; else the class's default. A feral druid who tanks gets the
-- bear list (One Button picks it in bear form). Nil for a class One Button
-- has no lists for.
function OneButton.TreeKey()
  local class = OneButton.Class()
  local trees = class and TREES[class]
  if not trees then return nil end
  local ok, _, section = pcall(ns.Scan.Ranks)
  local best, most = nil, 0
  for _, tree in ipairs(ok and type(section) == "table" and type(section.trees) == "table" and section.trees or {}) do
    local key = match(trees, tree.name)
    local points = Util.num(tree.points) or 0
    if key and points > most then best, most = key, points end
  end
  local profile = ns.Store:Profile()
  if not best and profile.spec then best = match(trees, profile.spec) end
  best = best or trees.default
  if best == "feral" and trees.keys.feral_bear and profile.role == "tank" then best = "feral_bear" end
  return best, class
end

-- "beast_mastery" -> "Beast Mastery".
function OneButton.TreeName(key)
  return (tostring(key or ""):gsub("_", " "):gsub("(%a)(%a*)", function(a, b) return a:upper() .. b end))
end

-- Remembering -------------------------------------------------------------------------

local plain = OneButton.Plain

local function plainLines(list)
  local out = {}
  for _, line in ipairs(type(list) == "table" and list or {}) do
    if #out >= MAX_LEFT then break end
    local s = plain(line)
    if s then out[#out + 1] = s end
  end
  return out
end

-- A rotation result was saved (Store:SaveResult): its list for One Button is
-- kept for its kind of fight. Lists from another tree than the one kept are
-- dropped, as they would go into another profile. A placeholder from test
-- mode is not a rotation to play, so it is not kept.
function OneButton.Remember(c, data)
  if type(c) ~= "table" or type(data) ~= "table" or data.test then return false end
  local sent = data.oneButton
  if type(sent) ~= "table" or sent.v ~= 1 then return false end
  local context = (sent.context == "st" or sent.context == "aoe") and sent.context or nil
  if not context then return false end
  local tree, class = OneButton.TreeKey()
  if not tree then return false end
  local kept = c.oneButton
  if type(kept) ~= "table" or kept.tree ~= tree or kept.class ~= class or type(kept.lists) ~= "table" then
    kept = { class = class, tree = tree, lists = {} }
    c.oneButton = kept
  end
  local report = { dropped = 0 }
  local list = OneButton.SanitizeList(sent.list, report, true)
  -- The newest analysis of a kind replaces the last one, even when it brought nothing.
  if #list == 0 then
    kept.lists[context] = nil
    return true
  end
  kept.lists[context] = {
    list = list, at = time(), rotation = plain(sent.rotation, 120), left = plainLines(sent.left),
    dropped = report.dropped > 0 and report.dropped or nil,
  }
  return true
end

-- Building the profile ----------------------------------------------------------------

local function ask(fn, id)
  if type(fn) ~= "function" then return nil end
  local ok, known = pcall(fn, id)
  if not ok or known == nil or Util.secret(known) then return nil end
  return known and true or false
end

local function spellName(id)
  local get = C_Spell and C_Spell.GetSpellName
  local name = get and Util.safe(get, id)
  if type(name) ~= "string" and GetSpellInfo then name = Util.safe(GetSpellInfo, id) end
  if type(name) ~= "string" or Util.secret(name) then return nil end
  return name
end

-- Whether the character knows the entry's spell now. The Armory's spell
-- list knows it by id or by name (any rank of it); the game is asked too.
-- When neither can tell, it is kept: One Button checks again in combat.
function OneButton.Known(entry, spells)
  local name = entry.name or spellName(entry.id)
  if spells then
    for _, s in ipairs(spells) do
      if s.id == entry.id or (name and Util.sameName(s.name, name)) then return true end
    end
  end
  local player, book = ask(IsPlayerSpell, entry.id), ask(IsSpellKnown, entry.id)
  if player or book then return true end
  -- A list cut at its size limit may be missing spells the character has.
  if spells and #spells < (ns.Scan.MAX_SPELLS or math.huge) then return false end
  if player == false or book == false then return false end
  return true
end

local function level()
  return Util.num(Util.safe(UnitLevel, "player"))
end

-- The profile to export, or nil and why ("class" for a class One Button has
-- no lists for, "none" for nothing to export). The second value says what is
-- in it: { tree, class, name, text, copied, unknown, dropped, lists = { st = {
-- count, unknown, at, rotation, left } } }.
function OneButton.Build()
  local tree, class = OneButton.TreeKey()
  if not tree then return nil, "class" end
  local c = ns.Store:Char()
  local kept = c and c.oneButton
  if type(kept) ~= "table" or kept.tree ~= tree or kept.class ~= class or type(kept.lists) ~= "table" then
    return nil, "none"
  end
  local okSpells, spells = pcall(ns.Scan.Spells)
  spells = okSpells and type(spells) == "table" and spells or nil
  local lists, info = {}, { tree = tree, class = class, unknown = 0, dropped = 0, lists = {} }
  for _, context in ipairs(OneButton.CONTEXTS) do
    local held = kept.lists[context]
    if type(held) == "table" and type(held.list) == "table" then
      local out, unknown = {}, 0
      for _, entry in ipairs(held.list) do
        if OneButton.Known(entry, spells) then
          out[#out + 1] = { id = entry.id, gates = entry.gates }
        else
          unknown = unknown + 1
        end
      end
      info.unknown = info.unknown + unknown
      info.dropped = info.dropped + (Util.num(held.dropped) or 0)
      if #out > 0 then
        lists[context] = out
        info.lists[context] = { count = #out, unknown = unknown, at = held.at, rotation = held.rotation, left = held.left }
      end
    end
  end
  if not lists.st and not lists.aoe then return nil, "none" end
  -- Without a single-target list One Button suggests nothing against one enemy.
  if not lists.st then
    lists.st = lists.aoe
    info.copied = true
  end
  local lvl = level()
  info.name = OneButton.CleanName("Armory " .. OneButton.TreeName(tree) .. (lvl and (" " .. lvl) or ""))
  info.text = OneButton.Text({ v = 1, class = class, tree = tree, name = info.name, lists = lists })
  if not info.text then return nil, "none" end
  return info.text, info
end

-- Whether Forever One Button is loaded: true, false, or nil when the game cannot say.
function OneButton.Loaded()
  local fn = (C_AddOns and C_AddOns.IsAddOnLoaded) or IsAddOnLoaded
  if type(fn) ~= "function" then return nil end
  local ok, loaded = pcall(fn, OneButton.ADDON)
  if not ok or Util.secret(loaded) then return nil end
  return loaded and true or false
end

-- The dialog's texts --------------------------------------------------------------------

local function contextName(context)
  return context == "aoe" and L.OB_AOE or L.OB_ST
end

local function abilities(n)
  return n == 1 and L.OB_ONE_ABILITY or string.format(L.OB_ABILITIES, n)
end

-- "For Arms: single target, 12 abilities, and several enemies, 9 abilities."
-- With when each was analyzed when that is not the same for both.
local function summary(info)
  local present = {}
  for _, context in ipairs(OneButton.CONTEXTS) do
    if info.lists[context] then present[#present + 1] = context end
  end
  local ages = {}
  for _, context in ipairs(present) do ages[context] = Util.ago(info.lists[context].at, L) end
  local differ = #present > 1 and ages[present[1]] ~= ages[present[2]]
  local parts = {}
  for _, context in ipairs(present) do
    local part = string.format(L.OB_LIST, contextName(context), abilities(info.lists[context].count))
    if differ then part = part .. " " .. string.format(L.OB_ANALYZED, ages[context]) end
    parts[#parts + 1] = part
  end
  return string.format(L.OB_SUMMARY, OneButton.TreeName(info.tree), table.concat(parts, L.OB_AND))
end

-- What could not be carried over: the app's sentences, the abilities left
-- out, and the parts One Button would not have read.
local function leftLines(info)
  local out, seen = {}, {}
  for _, context in ipairs(OneButton.CONTEXTS) do
    local list = info.lists[context]
    for _, line in ipairs(list and list.left or {}) do
      if not seen[line] then
        seen[line] = true
        out[#out + 1] = line
      end
    end
  end
  if info.unknown > 0 then
    out[#out + 1] = info.unknown == 1 and L.OB_UNKNOWN_ONE or string.format(L.OB_UNKNOWN, info.unknown)
  end
  if info.dropped > 0 then out[#out + 1] = string.format(L.OB_DROPPED, info.dropped) end
  return out
end

-- Everything the dialog shows, or nil and why there is nothing.
function OneButton.Dialog()
  local text, info = OneButton.Build()
  if not text then return nil, info end
  local d = {
    text = text, name = info.name, summary = summary(info),
    copied = info.copied and L.OB_COPIED or nil,
    steps = { L.OB_STEP_COPY, L.OB_STEP_IMPORT, L.OB_STEP_PASTE, string.format(L.OB_STEP_USE, info.name) },
    left = leftLines(info), standing = L.OB_STANDING,
  }
  if OneButton.Loaded() == false then d.missing = L.OB_NOT_LOADED end
  return d
end

-- One line for /armory debug.
function OneButton.Diagnose()
  local tree, class = OneButton.TreeKey()
  local c = ns.Store:Char()
  local kept = c and type(c.oneButton) == "table" and c.oneButton or nil
  local counts = {}
  for _, context in ipairs(OneButton.CONTEXTS) do
    local held = kept and type(kept.lists) == "table" and kept.lists[context]
    local n = type(held) == "table" and type(held.list) == "table" and #held.list or 0
    counts[#counts + 1] = string.format("%s %d", context, n)
  end
  local line = "one button: tree " .. (tree and (tree .. " (" .. class:lower() .. ")") or "none (class not in One Button)")
  line = line .. "; remembered " .. table.concat(counts, ", ")
  if kept and kept.tree ~= tree then line = line .. " for " .. tostring(kept.tree) end
  local loaded = OneButton.Loaded()
  return line .. "; Forever One Button " .. (loaded == nil and "unknown" or (loaded and "loaded" or "not loaded"))
end

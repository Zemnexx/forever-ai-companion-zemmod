-- /armory dump: writes down what this client's talent functions answer, as
-- they answer it, into the addon's saved variables. The talent reader in
-- Scan.lua was written without access to the game; this is what it gets
-- corrected from. Nothing is sent anywhere: the file is the player's to pass
-- on, and a dump is dropped again after a few days.
local _, ns = ...
local Util = ns.Util
local safe = Util.safe

local Dump = {}
ns.Dump = Dump

local MAX_DEPTH, MAX_TEXT, MAX_NAMES = 7, 300, 300
local KEEP_DAYS = 3

-- A copy of a value that the game can save: numbers, texts, true or false,
-- and tables of them. Anything else (a function, a widget, a value the game
-- keeps secret) is named instead of copied.
local function plain(v, depth, seen)
  if Util.secret(v) then return "<secret>" end
  local t = type(v)
  if t == "boolean" then return v end
  if t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "<" .. tostring(v) .. ">" end
    return v
  end
  if t == "string" then return #v > MAX_TEXT and (v:sub(1, MAX_TEXT) .. "...") or v end
  if t == "nil" then return nil end
  if t ~= "table" then return "<" .. t .. ">" end
  depth, seen = depth or 0, seen or {}
  if depth >= MAX_DEPTH then return "<deeper>" end
  if seen[v] then return "<again>" end
  seen[v] = true
  local out = {}
  for key, value in pairs(v) do
    if not Util.secret(key) then
      local k = (type(key) == "number" or type(key) == "string") and key or tostring(key)
      out[k] = plain(value, depth + 1, seen)
    end
  end
  seen[v] = nil
  return out
end

local function pack(...)
  return { n = select("#", ...), ... }
end

-- What a game function answers: its one result, the list of them, or why
-- there is none.
local function call(fn, ...)
  if type(fn) ~= "function" then return "<no such function>" end
  local r = pack(pcall(fn, ...))
  if not r[1] then return { error = tostring(r[2]) } end
  if r.n == 1 then return "<nothing>" end
  local out = {}
  for i = 2, r.n do
    local v = plain(r[i])
    if v == nil then v = "<nil>" end
    out[i - 1] = v
  end
  if r.n == 2 then return out[1] end
  return out
end

-- A part of the dump: one that fails leaves its error, not a hole in the rest.
local function part(fn)
  local ok, result = pcall(fn)
  if ok then return result end
  return { error = tostring(result) }
end

local function numbers(list)
  local out = {}
  for _, v in ipairs(type(list) == "table" and list or {}) do
    if type(v) == "number" and not Util.secret(v) then out[#out + 1] = v end
  end
  return out
end

-- Names ------------------------------------------------------------------------------

local WORDS = { "talent", "trait", "speciali" }
-- Functions that ask or change something, not the ones that draw a window.
local VERBS = { "Get", "Set", "Is", "Can", "Has", "Num", "Learn", "Unlearn", "Add", "Remove", "Reset", "Confirm", "Check", "Preview", "Unit" }

local function related(name)
  if type(name) ~= "string" then return false end
  local lower = name:lower()
  for _, word in ipairs(WORDS) do
    if lower:find(word, 1, true) then return true end
  end
  return false
end

local function verb(name)
  for _, v in ipairs(VERBS) do
    if name:sub(1, #v) == v then return true end
  end
  return false
end

-- The game's functions, function tables and windows that have to do with
-- talents, by name: which of them this client has at all.
local function names()
  local functions, tables, frames = {}, {}, {}
  local function consider(name, value)
    local t = type(value)
    if t == "function" then
      if verb(name) and #functions < MAX_NAMES then functions[#functions + 1] = name end
    elseif t == "table" and name:match("^C_") then
      local keys = {}
      for key in pairs(value) do
        if type(key) == "string" and #keys < MAX_NAMES then keys[#keys + 1] = key end
      end
      table.sort(keys)
      tables[name] = keys
    elseif t == "table" and type(rawget(value, 0)) == "userdata" and #frames < MAX_NAMES then
      -- A window or one of its parts: which talent window this client uses.
      frames[#frames + 1] = name
    end
  end
  for name, value in pairs(_G) do
    -- One the game does not let an addon look at is only skipped.
    if related(name) then pcall(consider, name, value) end
  end
  table.sort(functions)
  table.sort(frames)
  return { functions = functions, tables = tables, frames = frames }
end

-- The three ways a client can describe talents -----------------------------------------

local function classic()
  return {
    tabs = call(GetNumTalentTabs),
    tab1 = call(GetTalentTabInfo, 1), tab2 = call(GetTalentTabInfo, 2), tab3 = call(GetTalentTabInfo, 3),
    talentsInTab1 = call(GetNumTalents, 1),
    talent1 = call(GetTalentInfo, 1, 1),
    prerequisite1 = call(GetTalentPrereqs, 1, 1),
    unspent = call(UnitCharacterPoints, "player"),
    group = call(GetActiveTalentGroup),
  }
end

local function specs()
  local api = type(C_SpecializationInfo) == "table" and C_SpecializationInfo or {}
  local classID = select(3, safe(UnitClass, "player"))
  local out = {
    count = call(GetNumSpecializations or api.GetNumSpecializations),
    current = call(GetSpecialization or api.GetSpecialization),
    classID = plain(classID),
    classCount = call(GetNumSpecializationsForClassID or api.GetNumSpecializationsForClassID, classID),
    list = {}, byClass = {},
  }
  local own = GetSpecializationInfo or api.GetSpecializationInfo
  local forClass = GetSpecializationInfoForClassID or api.GetSpecializationInfoForClassID
  for i = 1, 5 do
    out.list[i] = call(own, i)
    out.byClass[i] = call(forClass, classID, i)
  end
  return out
end

-- A tooltip the game hands over as data, down to its lines.
local function tip(fn, ...)
  if type(fn) ~= "function" then return "<no such function>" end
  local ok, data = pcall(fn, ...)
  if not ok then return { error = tostring(data) } end
  if type(data) ~= "table" then return "<" .. type(data) .. ">" end
  local out = { type = plain(data.type), lines = {} }
  for i, line in ipairs(type(data.lines) == "table" and data.lines or {}) do
    if i > 14 or type(line) ~= "table" then break end
    out.lines[i] = { left = plain(line.leftText), right = plain(line.rightText), type = plain(line.type) }
  end
  return out
end

local function spellName(spellID)
  local get = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  return plain((safe(get, spellID)))
end

-- Every tree and node of the active talent setup, with what each node costs,
-- what it requires and what it gives, and whatever those refer to.
local function traits()
  local T = C_Traits
  if type(T) ~= "table" then return "<no C_Traits>" end
  local out = { trees = {}, conditions = {}, subTrees = {}, currencies = {}, groups = {} }
  local configID = type(C_ClassTalents) == "table" and safe(C_ClassTalents.GetActiveConfigID) or nil
  out.configID = plain(configID) or "<nil>"
  if configID == nil then return out end
  local config = safe(T.GetConfigInfo, configID)
  out.config = plain(config) or "<nil>"

  local want = { conditions = {}, subTrees = {}, currencies = {}, groups = {} }
  local function note(kind, id)
    if type(id) == "number" and not Util.secret(id) then want[kind][id] = true end
  end

  for _, treeID in ipairs(numbers(type(config) == "table" and config.treeIDs)) do
    local info = safe(T.GetTreeInfo, configID, treeID)
    local currencies = safe(T.GetTreeCurrencyInfo, configID, treeID, false)
    local tree = {
      id = treeID, info = plain(info) or "<nil>", currencies = plain(currencies) or "<nil>", nodes = {},
      -- Forever's own additions, whose answers this addon has not seen yet.
      groupDisplay = call(T.GetGroupDisplayInfoByTreeID, treeID),
      groupDisplayWithConfig = call(T.GetGroupDisplayInfoByTreeID, configID, treeID),
      systemID = call(T.GetSystemIDByTreeID, treeID),
    }
    for _, gate in ipairs(type(info) == "table" and type(info.gates) == "table" and info.gates or {}) do
      note("conditions", type(gate) == "table" and gate.conditionID)
    end
    for _, c in ipairs(type(currencies) == "table" and currencies or {}) do
      note("currencies", type(c) == "table" and c.traitCurrencyID)
    end
    for _, nodeID in ipairs(numbers(safe(T.GetTreeNodes, treeID))) do
      local node = safe(T.GetNodeInfo, configID, nodeID)
      local cost = safe(T.GetNodeCost, configID, nodeID)
      local entry = { id = nodeID, info = plain(node) or "<nil>", cost = plain(cost) or "<nil>", entries = {} }
      for _, c in ipairs(type(cost) == "table" and cost or {}) do
        note("currencies", type(c) == "table" and c.ID)
      end
      if type(node) == "table" then
        for _, id in ipairs(numbers(node.conditionIDs)) do note("conditions", id) end
        for _, id in ipairs(numbers(node.groupIDs)) do note("groups", id) end
        note("subTrees", node.subTreeID)
        for _, entryID in ipairs(numbers(node.entryIDs)) do
          local e = safe(T.GetEntryInfo, configID, entryID)
          local def = type(e) == "table" and e.definitionID and safe(T.GetDefinitionInfo, e.definitionID)
          local spellID = type(def) == "table" and def.spellID
          note("subTrees", type(e) == "table" and e.subTreeID)
          -- How the game words the talent at its first and its last rank.
          local tips = type(C_TooltipInfo) == "table" and C_TooltipInfo or {}
          local ranks = type(node.maxRanks) == "number" and not Util.secret(node.maxRanks) and node.maxRanks or 1
          entry.entries[#entry.entries + 1] = {
            id = entryID, info = plain(e) or "<nil>", definition = plain(def) or "<nil>",
            spell = spellID and spellName(spellID) or nil,
            description = spellID and call(C_Spell and C_Spell.GetSpellDescription, spellID) or nil,
            tip = tip(tips.GetTraitEntry, entryID, 1),
            tipAtMax = ranks > 1 and tip(tips.GetTraitEntry, entryID, ranks) or nil,
          }
        end
      end
      tree.nodes[#tree.nodes + 1] = entry
    end
    out.trees[#out.trees + 1] = tree
  end

  -- By the id as text: these ids are large and far apart.
  for id in pairs(want.conditions) do out.conditions[tostring(id)] = call(T.GetConditionInfo, configID, id) end
  for id in pairs(want.subTrees) do out.subTrees[tostring(id)] = call(T.GetSubTreeInfo, configID, id) end
  for id in pairs(want.currencies) do out.currencies[tostring(id)] = call(T.GetTraitCurrencyInfo, id) end
  -- All groups in one question: the function takes a list of them.
  local groups = {}
  for id in pairs(want.groups) do groups[#groups + 1] = id end
  table.sort(groups)
  out.groups = groups
  out.groupCurrencies = call(T.GetGroupCurrencyInfo, configID, groups)
  return out
end

-- The dump ---------------------------------------------------------------------------

function Dump.Collect()
  local d = {
    v = 1, addon = tostring(ns.version or ""), at = time and time() or 0,
    client = call(GetBuildInfo), project = plain(WOW_PROJECT_ID), locale = call(GetLocale),
    class = call(UnitClass, "player"), race = call(UnitRace, "player"), level = call(UnitLevel, "player"),
    maxLevel = call(GetMaxPlayerLevel), maxLevelConstant = plain(MAX_PLAYER_LEVEL),
  }
  d.names = part(names)
  d.classic = part(classic)
  d.specs = part(specs)
  d.traits = part(traits)
  -- What the Armory made of all that: /armory debug, and the trees as it sends them.
  d.read = part(function() return plain(ns.Scan.Diagnose()) end)
  d.talents = part(function() return plain(ns.Scan.Talents()) or "<nil>" end)
  d.specsOffered = part(function() return plain(ns.Scan.Specs()) end)
  return d
end

-- Saves the dump and returns how many talent nodes it holds.
function Dump.Run()
  local d = Dump.Collect()
  ns.db.dump = d
  local nodes = 0
  for _, tree in ipairs(type(d.traits) == "table" and type(d.traits.trees) == "table" and d.traits.trees or {}) do
    nodes = nodes + #tree.nodes
  end
  return nodes, d
end

-- A dump is for one exchange with the addon's author, not to be carried in
-- the saved variables from then on.
function Dump.Init()
  local d = ns.db and ns.db.dump
  if type(d) ~= "table" then return end
  local age = (time and time() or 0) - (tonumber(d.at) or 0)
  if age > KEEP_DAYS * 86400 then ns.db.dump = nil end
end

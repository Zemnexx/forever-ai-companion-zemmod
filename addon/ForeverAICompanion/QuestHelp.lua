-- Quest help: which quests the character has done, and which ones they can
-- pick up now, for "what should I do next?" answers.
--
-- Always: every quest turned in is kept by id, with its title and the zone the
-- quest log listed it under (Core:RememberTurnIn), and the game says how many
-- quests the character has completed in all.
-- With the QuestieDB addon (the quest database Questie uses, read through its
-- public API, LibQuestieDB) also:
--   - the names of the quests done before, in the current zone (the game keeps
--     the ids of every completed quest; the database knows their names and zones),
--   - the quests available now: right level (not grey or red), race and class,
--     prerequisites done, not done and not in the log, with the quest giver and
--     where it stands, in the current zone (saying so when there is none), the
--     nearest zones the quests in the log come from or send the player to, and a
--     zone named in the question,
--   - the next quest of a chain, for quests in the log.
-- With Questie loaded too, its own check is applied on top (QuestieDB.IsDoable:
-- the quests it hides or blacklists, daily and event rules, quests the player
-- hid in Questie), so the list matches the "!" Questie shows.
-- The database is indexed by zone once per session, a little each frame and
-- never in combat, so the game doesn't stutter; the lists are worked out again
-- the same way when the zone, the level or the quest log changes.
local _, ns = ...

local QuestHelp = {}
ns.QuestHelp = QuestHelp

QuestHelp.CONTRACT = 4       -- QuestieDB API version this is written for
QuestHelp.BUDGET_MS = 2      -- work per frame, in milliseconds
QuestHelp.START_DELAY = 3    -- seconds after login before the first index
QuestHelp.MAX_HERE = 10      -- available quests listed for the current zone
QuestHelp.MAX_ASKED = 10     -- ...for a zone named in the question (2 zones at most)
QuestHelp.MAX_LOG_ZONES = 4  -- other zones that quests in the log come from or send to...
QuestHelp.MAX_LOG_ZONE = 3   -- ...and quests listed for each
QuestHelp.MAX_DONE = 150     -- completed quests sent for a zone (the app shows 40 unless the question is about quests)
QuestHelp.MAX_NAMED = 3      -- quests named in a question that get their status
QuestHelp.RED = 5            -- quests this many levels above the player are left out (red)

local floor, abs, sqrt, huge = math.floor, math.abs, math.sqrt, math.huge

local function now() return debugprofilestop and debugprofilestop() or GetTime() * 1000 end
local function num(v) return type(v) == "number" and v or nil end
local function round1(v) return floor(v * 10 + 0.5) / 10 end

-- QuestieDB's entities, when it is installed and speaks this API version.
local function database()
  local L = LibQuestieDB
  if type(L) ~= "table" then return nil end
  if type(L.RequireContract) == "function" then
    local ok, fits = pcall(L.RequireContract, QuestHelp.CONTRACT)
    if not ok or not fits then return nil end
  end
  local quest = L.Quest or QuestDB
  if type(quest) ~= "table" or type(quest.Get) ~= "function" or type(quest.GetAllIds) ~= "function" then return nil end
  return { quest = quest, npc = L.Npc or NpcDB, object = L.Object or ObjectDB, enum = type(L.Enum) == "table" and L.Enum or {} }
end
QuestHelp.Database = database

-- One field of one entity (QuestieDB's Get is called with a dot).
local function get(entity, id, key)
  if type(entity) ~= "table" or type(entity.Get) ~= "function" then return nil end
  local ok, v = pcall(entity.Get, id, key)
  if ok then return v end
end

local function areaName(id)
  if not (C_Map and C_Map.GetAreaInfo) then return nil end
  local ok, name = pcall(C_Map.GetAreaInfo, id)
  if ok and type(name) == "string" and name ~= "" then return name end
end

-- The quests the addon saw turned in (Core:RememberTurnIn): id -> { t = title, z = zone }.
local function record()
  local data = ns.Core and ns.Core.CharData and ns.Core:CharData()
  return data and type(data.questsDone) == "table" and data.questsDone or {}
end

-- The ids of every quest the character completed, from the game, plus the
-- ones just turned in (the game's list can lag a moment behind). nil, nil
-- without an API for it.
local function completedSet()
  local set, n = {}, 0
  local list = C_QuestLog and C_QuestLog.GetAllCompletedQuestIDs and C_QuestLog.GetAllCompletedQuestIDs()
  if type(list) == "table" then
    for _, id in ipairs(list) do if not set[id] then set[id] = true; n = n + 1 end end
  elseif GetQuestsCompleted then
    for id in pairs(GetQuestsCompleted() or {}) do set[id] = true; n = n + 1 end
  else
    return nil, nil
  end
  for id in pairs(record()) do if not set[id] then set[id] = true; n = n + 1 end end
  return set, n
end

local function mapName(map)
  local info = num(map) and map > 0 and C_Map and C_Map.GetMapInfo and C_Map.GetMapInfo(map)
  return type(info) == "table" and type(info.name) == "string" and info.name or nil
end

-- Where a quest sends the player: its area on the map, or else its next
-- waypoint (the turn-in, for a finished quest).
local function destination(id)
  if GetQuestUiMapID then
    local ok, map = pcall(GetQuestUiMapID, id)
    local name = ok and mapName(map)
    if name then return name end
  end
  if C_QuestLog and C_QuestLog.GetNextWaypoint then
    local ok, map = pcall(C_QuestLog.GetNextWaypoint, id)
    return ok and mapName(map) or nil
  end
end

-- The quest log: questID -> { title, zone (its header: where it came from),
-- dest (where it sends the player), dist (yards to it, when on this
-- continent) }, and those zones in order.
local lastLog = {}
local function questLog()
  local entries, zones, seen = {}, {}, {}
  local function zone(name)
    if name and not seen[name] then seen[name] = true; zones[#zones + 1] = name end
  end
  local function add(id, title, header)
    if not id then return end
    local e = { title = title, zone = header, dest = destination(id) }
    if C_QuestLog and C_QuestLog.GetDistanceSqToQuest then
      local ok, distSq, onContinent = pcall(C_QuestLog.GetDistanceSqToQuest, id)
      if ok and num(distSq) and onContinent then e.dist = sqrt(distSq) end
    end
    entries[id] = e
    zone(header)
    zone(e.dest)
  end
  local header
  if C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo then
    for i = 1, C_QuestLog.GetNumQuestLogEntries() or 0 do
      local info = C_QuestLog.GetInfo(i)
      if info then
        if info.isHeader then header = info.title
        elseif not info.isHidden then add(info.questID, info.title, header) end
      end
    end
  elseif GetNumQuestLogEntries and GetQuestLogTitle then
    for i = 1, GetNumQuestLogEntries() or 0 do
      local title, _, _, isHeader, _, _, _, questID = GetQuestLogTitle(i)
      if isHeader then header = title else add(questID, title, header) end
    end
  end
  lastLog = entries
  return entries, zones
end

-- What the quest log said about a quest (now, or when it was last read): for
-- the turn-in record, when the quest has just left the log.
function QuestHelp:LogEntry(questID)
  local before = lastLog
  local entries = questLog()
  return entries[questID] or before[questID]
end

-- Is the bit (a power of two) set in a mask? Race masks pass 2^32, more than
-- the game's bit library handles.
local function hasBit(mask, bit) return mask % (bit * 2) >= bit end

-- Questie's own check, when Questie is loaded and ready (Questie.API.isReady):
-- QuestieDB.IsDoable, plus its rune setting where it has one. It only removes
-- quests; the level rules stay ours (Questie's check has none). Internal to
-- Questie, so every call is guarded: if it changes, the list goes on without it.
local function questieGate()
  local api = type(Questie) == "table" and Questie.API
  if type(api) ~= "table" or api.isReady ~= true then return nil end
  if type(QuestieLoader) ~= "table" or type(QuestieLoader.ImportModule) ~= "function" then return nil end
  local ok, mod = pcall(QuestieLoader.ImportModule, QuestieLoader, "QuestieDB")
  if not ok or type(mod) ~= "table" or type(mod.IsDoable) ~= "function" then return nil end
  local doable, rune = mod.IsDoable, mod.IsRuneAndShouldBeHidden
  return function(id)
    local okDoable, yes = pcall(doable, id)
    if okDoable and yes == false then return false end
    if type(rune) == "function" then
      local okRune, hidden = pcall(rune, id)
      if okRune and hidden == true then return false end
    end
    return true
  end
end

-- Names (lowercase) of the maps on the player's continent: zones, cities and
-- dungeons, to list the zones of quests in the log on this continent first.
local function continentNames()
  local names = {}
  if not (C_Map and C_Map.GetBestMapForUnit and C_Map.GetMapInfo and C_Map.GetMapChildrenInfo) then return names end
  local continent = Enum and Enum.UIMapType and Enum.UIMapType.Continent or 2
  local map, found = C_Map.GetBestMapForUnit("player"), false
  for _ = 1, 8 do
    local info = map and C_Map.GetMapInfo(map)
    if type(info) ~= "table" then break end
    if info.mapType == continent then found = true break end
    map = info.parentMapID
  end
  if not found then return names end
  local ok, kids = pcall(C_Map.GetMapChildrenInfo, map, nil, true)
  for _, k in ipairs(ok and type(kids) == "table" and kids or {}) do
    if type(k) == "table" and type(k.name) == "string" then names[k.name:lower()] = true end
  end
  return names
end

local function player(db)
  local p = { level = UnitLevel("player") or 1 }
  local _, _, raceId = UnitRace("player")
  local races, classes = db and db.enum.raceMaskById, db and db.enum.classKeys
  p.raceBit = type(races) == "table" and num(races[raceId]) or nil
  local _, classToken = UnitClass("player")
  p.classBit = type(classes) == "table" and num(classes[classToken]) or nil
  local faction = UnitFactionGroup and UnitFactionGroup("player")
  p.faction = (faction == "Alliance" and "A") or (faction == "Horde" and "H") or nil
  p.completed, p.completedCount = completedSet()
  p.log, p.logZones = questLog()
  p.gate = db and questieGate() or nil
  p.here = continentNames()
  -- Grey quests (little experience) are left out.
  local green = GetQuestGreenRange and num(GetQuestGreenRange())
  p.minQuestLevel = p.level - (green or 8)
  p.zone = GetRealZoneText and GetRealZoneText() or nil
  if C_Map and C_Map.GetBestMapForUnit and C_Map.GetPlayerMapPosition then
    local map = C_Map.GetBestMapForUnit("player")
    local pos = map and C_Map.GetPlayerMapPosition(map, "player")
    if pos then
      local x, y = pos:GetXY()
      if num(x) and num(y) then p.x, p.y = x * 100, y * 100 end
    end
    local info = map and C_Map.GetMapInfo and C_Map.GetMapInfo(map)
    p.mapName = info and info.name
  end
  return p
end

-- Index ------------------------------------------------------------------------
-- Quests by zone (QuestieDB's zoneOrSort: positive = the zone's area id), and
-- the zones' names in the client's language. Built once per session.
local index

-- "The Barrens" is also found as "Barrens" in a question.
local ARTICLES = { "the ", "el ", "la ", "los ", "las " }

local function buildIndex(db, step)
  local ok, ids = pcall(db.quest.GetAllIds)
  if not ok or type(ids) ~= "table" then return nil end
  local byArea, names, byName, byQuest = {}, {}, {}, {}
  for i, id in ipairs(ids) do
    local zone = num(get(db.quest, id, "zoneOrSort"))
    if zone and zone > 0 then
      local list = byArea[zone]
      if not list then list = {}; byArea[zone] = list end
      list[#list + 1] = id
    end
    -- Quests by name (lowercase), to find the ones named in a question.
    local qname = get(db.quest, id, "name")
    if type(qname) == "string" and #qname >= 6 then
      local key = qname:lower()
      local same = byQuest[key]
      if not same then same = {}; byQuest[key] = same end
      same[#same + 1] = id
    end
    if i % 25 == 0 then step() end
  end
  local n = 0
  for area, list in pairs(byArea) do
    local name = areaName(area)
    if name then
      names[area] = name
      local key = name:lower()
      local keys = { key }
      for _, a in ipairs(ARTICLES) do
        if key:sub(1, #a) == a and #key > #a + 3 then keys[#keys + 1] = key:sub(#a + 1) end
      end
      for _, k in ipairs(keys) do
        local other = byName[k]
        if not other or #byArea[other] < #list then byName[k] = area end
      end
    end
    n = n + 1
    if n % 25 == 0 then step() end
  end
  return { byArea = byArea, names = names, byName = byName, byQuest = byQuest }
end

local function areaFor(name)
  return index and type(name) == "string" and index.byName[name:lower()] or nil
end

-- The player's zone as an area id (its name, as the game shows it).
local function currentArea(p)
  return areaFor(p.zone) or areaFor(GetZoneText and GetZoneText()) or areaFor(p.mapName)
end

-- Availability -------------------------------------------------------------------

local function list(v) return type(v) == "table" and v or {} end

local function anyDone(ids, p)
  for _, id in ipairs(list(ids)) do if p.completed[id] then return true end end
  return false
end
local function allDone(ids, p)
  for _, id in ipairs(list(ids)) do if not p.completed[id] then return false end end
  return true
end
local function anyDoneOrActive(ids, p)
  for _, id in ipairs(list(ids)) do if p.completed[id] or p.log[id] then return true end end
  return false
end
local function pairSet(v) return type(v) == "table" and num(v[1]) and v[1] ~= 0 end

-- Raw reputation with a faction, as the game counts it (QuestieDB's thresholds).
local function repValue(factionId)
  if C_Reputation and C_Reputation.GetFactionDataByID then
    local ok, d = pcall(C_Reputation.GetFactionDataByID, factionId)
    return ok and type(d) == "table" and num(d.currentStanding) or nil
  elseif GetFactionInfoByID then
    local ok, _, _, _, _, _, value = pcall(GetFactionInfoByID, factionId)
    return ok and num(value) or nil
  end
end

-- Standing with a faction (1 Hated, 2 Hostile... 8 Exalted), or nil if unknown.
local function factionStanding(factionId)
  if C_Reputation and C_Reputation.GetFactionDataByID then
    local ok, d = pcall(C_Reputation.GetFactionDataByID, factionId)
    return ok and type(d) == "table" and num(d.reaction) or nil
  elseif GetFactionInfoByID then
    local ok, _, _, standing = pcall(GetFactionInfoByID, factionId)
    return ok and num(standing) or nil
  end
end

-- A quest whose objective is reputation with a faction the player is Hostile
-- or Hated with (Gelkis Alliance after siding with the Magram): not one to do.
-- QuestieDB's objectives: group 4 = reputation, { factionId, value } (one pair
-- or a list of them).
local function needsHostileRep(objectives)
  local rep = type(objectives) == "table" and objectives[4]
  if type(rep) ~= "table" then return false end
  local list = type(rep[1]) == "number" and { rep } or rep
  for _, pair in ipairs(list) do
    local standing = type(pair) == "table" and num(pair[1]) and factionStanding(pair[1])
    if standing and standing <= 2 then return true end
  end
  return false
end

local function knowsSpell(id)
  if IsPlayerSpell then return IsPlayerSpell(id) and true or false end
  if IsSpellKnown then return IsSpellKnown(id) and true or false end
end

-- A spawn of an NPC or object: in the given area if it has one there.
local function spawnIn(spawns, area)
  if type(spawns) ~= "table" then return nil end
  local where, points = area, spawns[area]
  if type(points) ~= "table" or not points[1] then
    where, points = nil, nil
    for a, l in pairs(spawns) do
      if type(l) == "table" and l[1] then where, points = a, l; break end
    end
  end
  local s = points and points[1]
  if type(s) == "table" and num(s[1]) and num(s[2]) then return where, s[1], s[2] end
end

-- Who gives the quest and where: an NPC friendly to the player, or an object.
-- A quest that starts from an item isn't one to pick up somewhere.
local function questGiver(db, id, p, area)
  local by = get(db.quest, id, "startedBy")
  if type(by) ~= "table" then return nil end
  local function place(name, spawns)
    local zone, x, y = spawnIn(spawns, area)
    local g = { name = name }
    if zone and x then
      g.at = { zone = (index and index.names[zone]) or areaName(zone), x = round1(x), y = round1(y) }
      if zone == p.area and p.x then g.dist = sqrt((x - p.x) ^ 2 + (y - p.y) ^ 2) end
    end
    return g
  end
  for _, npc in ipairs(list(by[1])) do
    local friendly = get(db.npc, npc, "friendlyToFaction")
    if type(friendly) ~= "string" or (p.faction and friendly:find(p.faction, 1, true)) then
      local name = get(db.npc, npc, "name")
      if type(name) == "string" then return place(name, get(db.npc, npc, "spawns")) end
    end
  end
  for _, object in ipairs(list(by[2])) do
    local name = get(db.object, object, "name")
    if type(name) == "string" then return place(name, get(db.object, object, "spawns")) end
  end
end

-- Can the player pick this quest up now? Its row, or nil.
local function available(db, id, p, area)
  local Q = db.quest
  if p.completed[id] or p.log[id] then return nil end
  local minLevel = num(get(Q, id, "requiredLevel")) or 0
  if minLevel > p.level then return nil end
  local maxLevel = num(get(Q, id, "requiredMaxLevel")) or 0
  if maxLevel > 0 and p.level > maxLevel then return nil end
  local level = num(get(Q, id, "questLevel")) or 0
  if level > 0 and (level < p.minQuestLevel or level - p.level >= QuestHelp.RED) then return nil end
  local races = num(get(Q, id, "requiredRaces")) or 0
  if races ~= 0 and not (p.raceBit and hasBit(races, p.raceBit)) then return nil end
  local classes = num(get(Q, id, "requiredClasses")) or 0
  if classes ~= 0 and not (p.classBit and hasBit(classes, p.classBit)) then return nil end
  -- Left out: repeatable, event and monthly quests, and ones needing a
  -- profession, a rank, a specialization or a special start.
  if (num(get(Q, id, "specialFlags")) or 0) ~= 0 then return nil end
  if pairSet(get(Q, id, "requiredSkill")) then return nil end
  if (num(get(Q, id, "requiredSpecialization")) or 0) ~= 0 then return nil end
  if next(list(get(Q, id, "requiredRanks"))) then return nil end
  if (num(get(Q, id, "availableStartingWith")) or 0) ~= 0 then return nil end
  -- Done first: one of preQuestSingle, all of preQuestGroup.
  local single = list(get(Q, id, "preQuestSingle"))
  if #single > 0 and not anyDone(single, p) then return nil end
  if not allDone(get(Q, id, "preQuestGroup"), p) then return nil end
  if anyDoneOrActive(get(Q, id, "exclusiveTo"), p) then return nil end
  -- The next quest of its chain taken or done: this one is gone.
  local nextQuest = num(get(Q, id, "nextQuestInChain")) or 0
  if nextQuest ~= 0 and (p.completed[nextQuest] or p.log[nextQuest]) then return nil end
  local parent = num(get(Q, id, "parentQuest")) or 0
  if parent ~= 0 and not p.log[parent] then return nil end
  local leadsTo = num(get(Q, id, "breadcrumbForQuestId")) or 0
  if leadsTo ~= 0 and (p.completed[leadsTo] or p.log[leadsTo]) then return nil end
  for _, key in ipairs({ "disabledByQuest", "availableUntilCompleted" }) do
    local q = num(get(Q, id, key)) or 0
    if q ~= 0 and p.completed[q] then return nil end
  end
  local minRep, maxRep = get(Q, id, "requiredMinRep"), get(Q, id, "requiredMaxRep")
  if pairSet(minRep) then
    local v = repValue(minRep[1])
    if not v or v < (num(minRep[2]) or 0) then return nil end
  end
  if pairSet(maxRep) then
    local v = repValue(maxRep[1])
    if not v or v >= (num(maxRep[2]) or 0) then return nil end
  end
  if needsHostileRep(get(Q, id, "objectives")) then return nil end
  local spell = num(get(Q, id, "requiredSpell")) or 0
  if spell ~= 0 then
    local known = knowsSpell(abs(spell))
    if known == nil or known ~= (spell > 0) then return nil end
  end
  if p.gate and not p.gate(id) then return nil end
  local name = get(Q, id, "name")
  if type(name) ~= "string" then return nil end
  local giver = questGiver(db, id, p, area)
  if not giver then return nil end
  return {
    id = id, name = name, level = level > 0 and level or nil, minLevel = minLevel > 1 and minLevel or nil,
    giver = giver.name, at = giver.at, dist = giver.dist,
  }
end

-- The quests available in one zone, closest to the player's level first, then
-- nearest. { zone, quests, more = how many more there are }. With none:
-- { zone, none = true } when keepEmpty (the current zone, a zone asked about),
-- nil otherwise.
local function zoneList(db, area, p, max, step, keepEmpty)
  local rows = {}
  for i, id in ipairs(index.byArea[area] or {}) do
    local row = available(db, id, p, area)
    if row then rows[#rows + 1] = row end
    if i % 10 == 0 then step() end
  end
  if #rows == 0 then return keepEmpty and { zone = index.names[area], none = true } or nil end
  local function gap(r) return abs((r.level or p.level) - p.level) end
  table.sort(rows, function(a, b)
    if gap(a) ~= gap(b) then return gap(a) < gap(b) end
    if (a.dist or huge) ~= (b.dist or huge) then return (a.dist or huge) < (b.dist or huge) end
    return a.name < b.name
  end)
  local quests = {}
  for i = 1, math.min(max, #rows) do
    rows[i].dist = nil
    quests[i] = rows[i]
  end
  return { zone = index.names[area], quests = quests, more = #rows > max and (#rows - max) or nil }
end

-- Where a quest named in a question stands: "done", "inLog", "available"
-- (with its giver and where; "color" grey or red when it is), or "notYet"
-- with "why" (what is missing).
local function questStatus(db, id, p)
  local Q = db.quest
  local function nameOf(qid)
    local n = get(Q, qid, "name")
    return type(n) == "string" and n or ("quest " .. tostring(qid))
  end
  local s = { id = id, name = nameOf(id) }
  local zone = num(get(Q, id, "zoneOrSort"))
  if zone and zone > 0 and index then s.zone = index.names[zone] end
  local level = num(get(Q, id, "questLevel")) or 0
  if level > 0 then s.level = level end
  if p.completed[id] then s.status = "done" return s end
  if p.log[id] then s.status = "inLog" return s end
  local why = {}
  local function add(text) why[#why + 1] = text end
  local minLevel = num(get(Q, id, "requiredLevel")) or 0
  if minLevel > 1 then s.minLevel = minLevel end
  if minLevel > p.level then add("level " .. minLevel) end
  local maxLevel = num(get(Q, id, "requiredMaxLevel")) or 0
  if maxLevel > 0 and p.level > maxLevel then add("only up to level " .. maxLevel) end
  local races = num(get(Q, id, "requiredRaces")) or 0
  if races ~= 0 and not (p.raceBit and hasBit(races, p.raceBit)) then add("not for your race or faction") end
  local classes = num(get(Q, id, "requiredClasses")) or 0
  if classes ~= 0 and not (p.classBit and hasBit(classes, p.classBit)) then add("not for your class") end
  local single = list(get(Q, id, "preQuestSingle"))
  if #single > 0 and not anyDone(single, p) then
    local options = {}
    for _, q in ipairs(single) do options[#options + 1] = nameOf(q) end
    add("first one of: " .. table.concat(options, ", "))
  end
  local missing = {}
  for _, q in ipairs(list(get(Q, id, "preQuestGroup"))) do
    if not p.completed[q] then missing[#missing + 1] = nameOf(q) end
  end
  if #missing > 0 then add("first: " .. table.concat(missing, ", ")) end
  for _, q in ipairs(list(get(Q, id, "exclusiveTo"))) do
    if p.completed[q] or p.log[q] then add("closed: you did or took " .. nameOf(q)) break end
  end
  local nextQuest = num(get(Q, id, "nextQuestInChain")) or 0
  if nextQuest ~= 0 and (p.completed[nextQuest] or p.log[nextQuest]) then
    add("a later part (" .. nameOf(nextQuest) .. ") is done or taken")
  end
  local parent = num(get(Q, id, "parentQuest")) or 0
  if parent ~= 0 and not p.log[parent] then add("needs " .. nameOf(parent) .. " in your quest log") end
  local leadsTo = num(get(Q, id, "breadcrumbForQuestId")) or 0
  if leadsTo ~= 0 and (p.completed[leadsTo] or p.log[leadsTo]) then
    add("it leads to " .. nameOf(leadsTo) .. ", already done or taken")
  end
  for _, key in ipairs({ "disabledByQuest", "availableUntilCompleted" }) do
    local q = num(get(Q, id, key)) or 0
    if q ~= 0 and p.completed[q] then add("closed by " .. nameOf(q)) end
  end
  local minRep, maxRep = get(Q, id, "requiredMinRep"), get(Q, id, "requiredMaxRep")
  if pairSet(minRep) then
    local v = repValue(minRep[1])
    if not v or v < (num(minRep[2]) or 0) then add("needs more reputation") end
  end
  if pairSet(maxRep) then
    local v = repValue(maxRep[1])
    if not v or v >= (num(maxRep[2]) or 0) then add("your reputation is too high for it") end
  end
  if needsHostileRep(get(Q, id, "objectives")) then add("needs reputation with a faction you are Hostile or Hated with") end
  if pairSet(get(Q, id, "requiredSkill")) then add("needs a profession skill") end
  if (num(get(Q, id, "requiredSpecialization")) or 0) ~= 0 then add("needs a profession specialization") end
  local spell = num(get(Q, id, "requiredSpell")) or 0
  if spell ~= 0 then
    local known = knowsSpell(abs(spell))
    if known ~= nil and known ~= (spell > 0) then add(spell > 0 and "needs a spell you don't know" or "not once you know a certain spell") end
  end
  if #why == 0 and p.gate and not p.gate(id) then add("Questie hides it (not on this server, or you hid it)") end
  if #why > 0 then s.status, s.why = "notYet", why return s end
  s.status = "available"
  if level > 0 and level < p.minQuestLevel then s.color = "grey"
  elseif level > 0 and level - p.level >= QuestHelp.RED then s.color = "red" end
  local giver = questGiver(db, id, p, zone)
  if giver then
    s.giver, s.at = giver.name, giver.at
  elseif list(list(get(Q, id, "startedBy"))[3])[1] then
    s.startsFrom = "an item"
  end
  return s
end

-- Several quests can share a name (the parts of a chain): the one in the log,
-- else the one available, else the first not done; "parts" and "doneParts".
local STATUS_ORDER = { inLog = 1, available = 2, notYet = 3, done = 4 }
local function statusFor(db, ids, p)
  local best, done = nil, 0
  for _, id in ipairs(ids) do
    local s = questStatus(db, id, p)
    if s.status == "done" then done = done + 1 end
    if not best or STATUS_ORDER[s.status] < STATUS_ORDER[best.status] then best = s end
  end
  if best and #ids > 1 then
    best.parts = #ids
    if done > 0 and best.status ~= "done" then best.doneParts = done end
  end
  return best
end

-- The text has the key as words of its own (not inside a longer word).
local WORD = "[%w\128-\255]"
local function hasWords(text, key)
  local from = 1
  while true do
    local s, e = text:find(key, from, true)
    if not s then return false end
    if not text:sub(s - 1, s - 1):find(WORD) and not text:sub(e + 1, e + 1):find(WORD) then return true end
    from = s + 1
  end
end

-- Quest names in a question (lowercase text): the longest first, not one
-- inside a longer one found, nor a zone's name. A name of one word only
-- when it is long (8 letters or more), so common words don't count.
local function namedQuests(lower, yield)
  local found, n = {}, 0
  for key, ids in pairs(index.byQuest) do
    n = n + 1
    if n % 300 == 0 then yield() end
    if not index.byName[key] and (#key >= 8 or key:find(" ", 1, true)) and hasWords(lower, key) then
      found[#found + 1] = { key = key, ids = ids }
    end
  end
  table.sort(found, function(a, b) return #a.key > #b.key end)
  local out = {}
  for _, f in ipairs(found) do
    local inside = false
    for _, o in ipairs(out) do if o.key:find(f.key, 1, true) then inside = true break end end
    if not inside then out[#out + 1] = f end
    if #out >= QuestHelp.MAX_NAMED then break end
  end
  return out
end

-- Completed quests of a zone: from the database (every completed quest) and
-- from the addon's own record (quests the database doesn't know, or no database).
local function doneIn(db, area, zone, p, step)
  local names, seen = {}, {}
  local function add(name)
    if type(name) == "string" and not seen[name] then seen[name] = true; names[#names + 1] = name end
  end
  if db and area and p.completed then
    local i = 0
    for id in pairs(p.completed) do
      i = i + 1
      if num(get(db.quest, id, "zoneOrSort")) == area then add(get(db.quest, id, "name")) end
      if i % 25 == 0 then step() end
    end
  end
  for _, rec in pairs(record()) do
    if type(rec) == "table" and rec.z and rec.z == zone then add(rec.t) end
  end
  table.sort(names)
  local more = #names - QuestHelp.MAX_DONE
  while #names > QuestHelp.MAX_DONE do table.remove(names) end
  return #names > 0 and names or nil, more > 0 and more or nil
end

-- The zones quests in the log come from or send the player to: those on the
-- player's continent first, then nearest (by the nearest of their quests on
-- this continent), then in log order.
local function nearestZones(p)
  local best, order = {}, {}
  for _, e in pairs(p.log) do
    for _, z in ipairs({ e.zone or false, e.dest or false }) do
      if z and e.dist and (not best[z] or e.dist < best[z]) then best[z] = e.dist end
    end
  end
  for i, zone in ipairs(p.logZones) do order[i] = { zone = zone, i = i, here = p.here[zone:lower()] and 0 or 1 } end
  table.sort(order, function(a, b)
    if a.here ~= b.here then return a.here < b.here end
    local da, dz = best[a.zone] or huge, best[b.zone] or huge
    if da ~= dz then return da < dz end
    return a.i < b.i
  end)
  local out = {}
  for i, o in ipairs(order) do out[i] = o.zone end
  return out
end

-- Everything for the snapshot.
local function compute(db, step)
  local p = player(db)
  local out = {}
  local zone = p.zone
  local area = db and index and currentArea(p) or nil
  p.area = area
  local zoneName = (area and index.names[area]) or zone
  local inZone, more = doneIn(db, area, zone, p, step)
  out.completedQuests = { total = p.completedCount, zone = zoneName, inZone = inZone, more = more }
  if db and index and p.completed then
    local zones = {}
    if area then zones[#zones + 1] = zoneList(db, area, p, QuestHelp.MAX_HERE, step, true) end
    -- Zones quests in the log come from or go to, nearest first: what else to pick up there.
    local others = 0
    for _, header in ipairs(nearestZones(p)) do
      local a = areaFor(header)
      if a and a ~= area and others < QuestHelp.MAX_LOG_ZONES then
        local z = zoneList(db, a, p, QuestHelp.MAX_LOG_ZONE, step)
        if z then zones[#zones + 1] = z; others = others + 1 end
      end
    end
    out.availableQuests = #zones > 0 and zones or nil
  end
  return out
end

-- Runner -------------------------------------------------------------------------
-- One job at a time in a coroutine, BUDGET_MS per frame, paused in combat.

local job, wanted, delay
local runner = CreateFrame and CreateFrame("Frame")

local function step()
  if now() > (QuestHelp.deadline or 0) then coroutine.yield() end
end

local function work()
  local db = database()
  if db and not index then index = buildIndex(db, step) end
  QuestHelp.results = compute(db, step)
  QuestHelp.version = (QuestHelp.version or 0) + 1
  if ns.Collect and ns.Collect.dirty then
    ns.Collect.dirty.questHelp = true
    ns.Collect.dirty.quests = true -- the "next" quest of each chain
  end
end

local function onUpdate(frame, elapsed)
  if delay then
    delay = delay - (elapsed or 0)
    if delay > 0 then return end
    delay = nil
  end
  if InCombatLockdown and InCombatLockdown() then return end
  if not job then
    if not wanted then frame:SetScript("OnUpdate", nil) return end
    wanted = false
    job = coroutine.create(work)
  end
  QuestHelp.deadline = now() + QuestHelp.BUDGET_MS
  local ok, err = coroutine.resume(job)
  if coroutine.status(job) == "dead" then
    job = nil
    if not ok then QuestHelp.lastError = tostring(err) end
  end
end

-- Work the lists out again (soon, a little per frame).
function QuestHelp:Refresh(after)
  wanted = true
  if after then delay = math.max(delay or 0, after) end
  if runner then runner:SetScript("OnUpdate", onUpdate) end
end

if runner then
  for _, e in ipairs({ "PLAYER_LOGIN", "ZONE_CHANGED_NEW_AREA", "PLAYER_LEVEL_UP", "QUEST_ACCEPTED", "QUEST_REMOVED" }) do
    pcall(runner.RegisterEvent, runner, e)
  end
  runner:SetScript("OnEvent", function(_, event)
    -- A quest just taken: read the log now, so its zone is known at the turn-in.
    if event == "QUEST_ACCEPTED" then pcall(questLog) end
    -- Questie finishes starting after login: its check is used from then on.
    if event == "PLAYER_LOGIN" and type(Questie) == "table" and type(Questie.API) == "table"
      and type(Questie.API.RegisterOnReady) == "function" then
      pcall(Questie.API.RegisterOnReady, function() QuestHelp:Refresh() end)
    end
    QuestHelp:Refresh(event == "PLAYER_LOGIN" and QuestHelp.START_DELAY or nil)
  end)
end

-- For the snapshot (Collect's "questHelp" section).
function QuestHelp:Snapshot()
  local r = self.results
  if r then return { completedQuests = r.completedQuests, availableQuests = r.availableQuests } end
  -- Not worked out yet (just logged in): what is known right away.
  local _, n = completedSet()
  return { completedQuests = n and { total = n } or nil }
end

-- The next quest of a quest's chain, by name (for the quest log), unless done.
function QuestHelp:Next(questID)
  local db = database()
  if not db then return nil end
  local nextQuest = num(get(db.quest, questID, "nextQuestInChain")) or 0
  if nextQuest == 0 then return nil end
  local name = get(db.quest, nextQuest, "name")
  return type(name) == "string" and name or nil
end

-- Zones named in a question (not the current one): their available quests,
-- for that question only. Runs in the question's preparation (step yields).
-- For one question: { zones = the zones it names (not the current one) with
-- their available quests and the ones done there ("done", "doneMore"),
-- quests = the quests it names or links, with their status }. Runs in the
-- question's preparation (yield pauses it).
function QuestHelp:ForQuestion(text, yield, linked)
  local db = index and database()
  if not db then return nil end
  yield = yield or function() end
  local p = player(db)
  if not p.completed then return nil end
  p.area = currentArea(p)
  local lower = type(text) == "string" and text:lower() or ""
  local zones = {}
  if lower ~= "" then
    local found, seen = {}, {}
    for key, area in pairs(index.byName) do
      if #key >= 4 and area ~= p.area and not seen[area] and lower:find(key, 1, true) then
        seen[area] = true
        found[#found + 1] = { area = area, len = #key }
      end
    end
    table.sort(found, function(a, b) return a.len > b.len end)
    for i = 1, math.min(2, #found) do
      local area = found[i].area
      local z = zoneList(db, area, p, self.MAX_ASKED, yield, true)
      if z then
        z.done, z.doneMore = doneIn(db, area, index.names[area], p, yield)
        zones[#zones + 1] = z
      end
    end
  end
  local quests, seenIds = {}, {}
  for _, l in ipairs(type(linked) == "table" and linked or {}) do
    if type(l) == "table" and l.kind == "quest" and num(l.id) and not seenIds[l.id] and #quests < self.MAX_NAMED then
      seenIds[l.id] = true
      quests[#quests + 1] = statusFor(db, { l.id }, p)
    end
  end
  if lower ~= "" and index.byQuest and #quests < self.MAX_NAMED then
    for _, f in ipairs(namedQuests(lower, yield)) do
      if #quests >= self.MAX_NAMED then break end
      local linkedHere = false
      for _, id in ipairs(f.ids) do if seenIds[id] then linkedHere = true end end
      if not linkedHere then
        for _, id in ipairs(f.ids) do seenIds[id] = true end
        quests[#quests + 1] = statusFor(db, f.ids, p)
      end
    end
  end
  if #zones == 0 and #quests == 0 then return nil end
  return { zones = #zones > 0 and zones or nil, quests = #quests > 0 and quests or nil }
end

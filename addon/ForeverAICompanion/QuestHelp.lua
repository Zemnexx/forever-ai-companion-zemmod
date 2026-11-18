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
--   - the quests available now: right level (not grey), race and class,
--     prerequisites done, not done and not in the log, with the quest giver and
--     where it stands, in the current zone, the zones of quests in the log and a
--     zone named in the question,
--   - the next quest of a chain, for quests in the log.
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
QuestHelp.MAX_LOG_ZONES = 3  -- other zones with quests in the log...
QuestHelp.MAX_LOG_ZONE = 3   -- ...and quests listed for each
QuestHelp.MAX_DONE = 40      -- completed quests listed for the zone

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

-- The quest log: questID -> { title, zone (its header) }, and the zones in order.
local lastLog = {}
local function questLog()
  local entries, zones, seen = {}, {}, {}
  local function add(id, title, header)
    if not id then return end
    entries[id] = { title = title, zone = header }
    if header and not seen[header] then seen[header] = true; zones[#zones + 1] = header end
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
  local byArea, names, byName = {}, {}, {}
  for i, id in ipairs(ids) do
    local zone = num(get(db.quest, id, "zoneOrSort"))
    if zone and zone > 0 then
      local list = byArea[zone]
      if not list then list = {}; byArea[zone] = list end
      list[#list + 1] = id
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
  return { byArea = byArea, names = names, byName = byName }
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
  if level > 0 and level < p.minQuestLevel then return nil end
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
  local spell = num(get(Q, id, "requiredSpell")) or 0
  if spell ~= 0 then
    local known = knowsSpell(abs(spell))
    if known == nil or known ~= (spell > 0) then return nil end
  end
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
-- nearest. { zone, quests, more = how many more there are }.
local function zoneList(db, area, p, max, step)
  local rows = {}
  for i, id in ipairs(index.byArea[area] or {}) do
    local row = available(db, id, p, area)
    if row then rows[#rows + 1] = row end
    if i % 10 == 0 then step() end
  end
  if #rows == 0 then return nil end
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
  while #names > QuestHelp.MAX_DONE do table.remove(names) end
  return #names > 0 and names or nil
end

-- Everything for the snapshot.
local function compute(db, step)
  local p = player(db)
  local out = {}
  local zone = p.zone
  local area = db and index and currentArea(p) or nil
  p.area = area
  local zoneName = (area and index.names[area]) or zone
  out.completedQuests = {
    total = p.completedCount, zone = zoneName, inZone = doneIn(db, area, zone, p, step),
  }
  if db and index and p.completed then
    local zones = {}
    if area then zones[#zones + 1] = zoneList(db, area, p, QuestHelp.MAX_HERE, step) end
    -- Zones of quests in the log: what else to pick up there.
    local others = 0
    for _, header in ipairs(p.logZones) do
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
function QuestHelp:ForQuestion(text, yield)
  local db = index and database()
  if not db or type(text) ~= "string" or text == "" then return nil end
  local p = player(db)
  if not p.completed then return nil end
  p.area = currentArea(p)
  local lower = text:lower()
  local found, seen = {}, {}
  for key, area in pairs(index.byName) do
    if #key >= 4 and area ~= p.area and not seen[area] and lower:find(key, 1, true) then
      seen[area] = true
      found[#found + 1] = { area = area, len = #key }
    end
  end
  table.sort(found, function(a, b) return a.len > b.len end)
  local out = {}
  for i = 1, math.min(2, #found) do
    local z = zoneList(db, found[i].area, p, self.MAX_ASKED, yield or function() end)
    if z then out[#out + 1] = z end
  end
  return #out > 0 and out or nil
end

-- Reads what the Armory needs beyond the main addon's character snapshot:
--   Talents()  every talent of the class, with its place in the tree, the
--              points in it and the game's own description
--   Spells()   the spellbook with each ability's tooltip as the game shows it
--              for this character right now (cost, cast time, cooldown, numbers)
--   Combat()   the numbers a simulator needs (weapon damage and speed per
--              hand, attack and spell power, crit, hit, haste, resource)
--   Seen()     items the addon has seen in the game that this character could wear
--   Specs()    the specializations the player can choose from
--
-- WoW Forever runs classic content on the modern client, and this addon was
-- written without access to the game, so every read tries the classic-style
-- function first and the modern one after it, each inside pcall: whatever
-- this client lacks only leaves that field out. /armory debug (Scan.Diagnose)
-- shows which way each part was read.
local _, ns = ...
local Util = ns.Util
local safe, num, clean, round = Util.safe, Util.num, Util.clean, Util.round

local Scan = {}
ns.Scan = Scan

Scan.icons = {}   -- talent id -> icon (for the window; not sent)
Scan.how = {}     -- part -> how it was read (Diagnose)

local MAX_DESC = 420
local MAX_SPELLS = 110
local MAX_SEEN_SENT = 80

-- Every result of a game function, at its own position (results can have
-- gaps), or nil when the function is missing or fails.
local function results(fn, ...)
  if type(fn) ~= "function" then return nil end
  local function collect(ok, ...)
    if not ok then return nil end
    return { n = select("#", ...), ... }
  end
  return collect(pcall(fn, ...))
end

local function put(t, key, fn)
  local ok, v = pcall(fn)
  if ok and v ~= nil and not Util.secret(v) then t[key] = v end
end

-- Tooltips -------------------------------------------------------------------------

local function oneLine(s)
  return (s:gsub("%s+", " "):gsub("^ ", ""):gsub(" $", ""))
end

local function joinSides(left, right)
  left = left and oneLine(left) or ""
  right = right and oneLine(right) or ""
  if left ~= "" and right ~= "" then return left .. "  " .. right end
  return left ~= "" and left or (right ~= "" and right or nil)
end

-- Lines of a tooltip the game hands over as data (C_TooltipInfo).
local function dataLines(data)
  if type(data) ~= "table" or type(data.lines) ~= "table" then return nil end
  local lines = {}
  for _, line in ipairs(data.lines) do
    local text = joinSides(clean(line.leftText), clean(line.rightText))
    if text then lines[#lines + 1] = text end
  end
  return #lines > 0 and lines or nil
end

-- A hidden tooltip, for what the game only describes by showing it.
local tip
local function scanTip()
  if tip == nil then
    tip = false
    if CreateFrame then
      local ok, f = pcall(CreateFrame, "GameTooltip", "ForeverAICompanionArmoryScanTip", nil, "GameTooltipTemplate")
      if ok and f then tip = f end
    end
  end
  return tip or nil
end

-- Lines of the hidden tooltip after `set(tooltip)` filled it.
local function tipLines(set)
  local t = scanTip()
  if not t then return nil end
  local ok = pcall(function()
    t:SetOwner(UIParent or WorldFrame, "ANCHOR_NONE")
    t:ClearLines()
    set(t)
  end)
  if not ok then return nil end
  local lines = {}
  local name = t:GetName()
  for i = 1, num(safe(t.NumLines, t)) or 0 do
    local left, right = _G[name .. "TextLeft" .. i], _G[name .. "TextRight" .. i]
    local l = left and clean(safe(left.GetText, left))
    local r = right and safe(right.IsShown, right) and clean(safe(right.GetText, right)) or nil
    local text = joinSides(l, r)
    if text then lines[#lines + 1] = text end
  end
  pcall(t.Hide, t)
  return #lines > 0 and lines or nil
end

-- "Rank %d/%d" -> a pattern that matches "Rank 3/5".
local function formatPattern(fmt)
  if type(fmt) ~= "string" or fmt == "" then return nil end
  local p = fmt:gsub("[%^%$%(%)%.%[%]%*%+%-%?]", "%%%0")
  p = p:gsub("%%%%d", "%%d+"):gsub("%%%%s", ".+")
  return "^" .. p .. "$"
end

-- Tooltip lines that say nothing about what a talent does.
local noise
local function isNoise(line)
  if not noise then
    noise = { exact = {}, patterns = {} }
    for _, key in ipairs({ "TOOLTIP_TALENT_LEARN", "TOOLTIP_TALENT_UNLEARN", "TOOLTIP_TALENT_PREVIEW", "TALENT_TOOLTIP_ADDPREVIEWPOINT",
                           "TALENT_TOOLTIP_REMOVEPREVIEWPOINT" }) do
      if type(_G[key]) == "string" and _G[key] ~= "" then noise.exact[oneLine(_G[key])] = true end
    end
    for _, key in ipairs({ "TOOLTIP_TALENT_RANK", "TRAIT_TOOLTIP_RANK" }) do
      local p = formatPattern(_G[key])
      if p then noise.patterns[#noise.patterns + 1] = p end
    end
  end
  if noise.exact[line] then return true end
  for _, p in ipairs(noise.patterns) do
    if line:match(p) then return true end
  end
  return false
end

-- The description part of a tooltip: everything under the name, without the
-- rank line and the "click to learn" hints.
local function description(lines, limit)
  local out = {}
  for i = 2, #lines do
    if not isNoise(lines[i]) then out[#out + 1] = lines[i] end
  end
  local s = table.concat(out, " | ")
  if s == "" then return nil end
  return s:sub(1, limit or MAX_DESC)
end
Scan.Description = description

-- A talent of the modern trees, described at a rank: the game's own tooltip
-- for that rank carries that rank's numbers ("6%" at 3/3), where the spell's
-- description only has the first rank's ("2%"). The tooltip may or may not
-- start with the talent's name.
local function traitDescription(entryID, rank, name)
  local get = C_TooltipInfo and C_TooltipInfo.GetTraitEntry
  if type(get) ~= "function" or not entryID then return nil end
  local lines = dataLines(safe(get, entryID, math.max(rank or 0, 1)))
  if not lines then return nil end
  local out = {}
  for i, line in ipairs(lines) do
    if not (i == 1 and name and line == name) and not isNoise(line) then out[#out + 1] = line end
  end
  local s = table.concat(out, " | ")
  return s ~= "" and s or nil
end

-- Talents --------------------------------------------------------------------------

-- The classic names of each class's trees, in the order they stand from left
-- to right. Forever reworked the classes, so the game's own names are used
-- wherever it gives them; these are for where it gives none.
local CLASS_SPECS = {
  WARRIOR = { "Arms", "Fury", "Protection" },
  PALADIN = { "Holy", "Protection", "Retribution" },
  HUNTER = { "Beast Mastery", "Marksmanship", "Survival" },
  ROGUE = { "Assassination", "Combat", "Subtlety" },
  PRIEST = { "Discipline", "Holy", "Shadow" },
  SHAMAN = { "Elemental", "Enhancement", "Restoration" },
  MAGE = { "Arcane", "Fire", "Frost" },
  WARLOCK = { "Affliction", "Demonology", "Destruction" },
  DRUID = { "Balance", "Feral Combat", "Restoration" },
}

local function maxLevel()
  local cap = num(safe(GetMaxPlayerLevel)) or num(MAX_PLAYER_LEVEL)
  return cap and cap >= 10 and cap or 60
end

local function talentTip(tab, index)
  -- The tooltip the talent window itself shows.
  local lines = tipLines(function(t) t:SetTalent(tab, index) end)
  if lines and #lines > 1 then return lines, "SetTalent" end
  -- Or the talent's link.
  local link = safe(GetTalentLink, tab, index)
  if type(link) == "string" and not Util.secret(link) then
    if C_TooltipInfo and C_TooltipInfo.GetHyperlink then
      lines = dataLines(safe(C_TooltipInfo.GetHyperlink, link))
      if lines and #lines > 1 then return lines, "GetTalentLink" end
    end
    lines = tipLines(function(t) t:SetHyperlink(link) end)
    if lines and #lines > 1 then return lines, "GetTalentLink" end
  end
  return nil
end

-- Classic-style trees: GetTalentInfo(tab, index).
-- light: without descriptions (just the points, to follow a build).
local function classicTalents(light)
  if not (GetNumTalentTabs and GetNumTalents and GetTalentInfo and GetTalentTabInfo) then return nil end
  local tabs = num(safe(GetNumTalentTabs)) or 0
  if tabs < 1 then return nil end
  local trees, spent, described, total = {}, 0, 0, 0
  for tab = 1, tabs do
    local r = results(GetTalentTabInfo, tab) or {}
    local tree = { id = tab, talents = {} }
    -- (id, name, description, icon, pointsSpent, ...) or (name, icon, pointsSpent, ...)
    if type(r[1]) == "number" then tree.name = clean(r[2]) else tree.name = clean(r[1]) end
    tree.name = tree.name or ("Tree " .. tab)
    local byPlace = {}
    for i = 1, num(safe(GetNumTalents, tab)) or 0 do
      -- name, icon, tier, column, rank, maxRank
      local t = results(GetTalentInfo, tab, i)
      local name = t and clean(t[1])
      local max = t and num(t[6])
      if name and max and max > 0 then
        local talent = {
          id = tab * 100 + i, name = name, row = num(t[3]) or 1, col = num(t[4]) or 1,
          rank = math.min(num(t[5]) or 0, max), max = max,
        }
        Scan.icons[talent.id] = t[2]
        if not light then
          local lines = talentTip(tab, i)
          talent.desc = lines and description(lines) or nil
          if talent.desc then described = described + 1 end
        end
        byPlace[talent.row * 100 + talent.col] = talent.id
        tree.talents[#tree.talents + 1] = talent
        spent = spent + talent.rank
        total = total + 1
      end
    end
    -- What each talent needs first: the talent at (tier, column).
    for _, talent in ipairs(tree.talents) do
      local p = results(GetTalentPrereqs, tab, talent.id - tab * 100)
      if p and num(p[1]) and num(p[2]) then talent.requires = byPlace[p[1] * 100 + p[2]] end
    end
    local points = 0
    for _, talent in ipairs(tree.talents) do points = points + talent.rank end
    tree.points = points
    trees[#trees + 1] = tree
  end
  if total == 0 then return nil end
  Scan.how.talents = string.format("classic (GetTalentInfo): %d talents in %d trees%s", total, #trees,
    light and "" or string.format(", %d with a description", described))
  return {
    api = "classic", rowPoints = 5, trees = trees, spent = spent,
    available = num(safe(UnitCharacterPoints, "player")) or 0,
    level = num(safe(UnitLevel, "player")), pointsAtCap = maxLevel() - 9,
  }
end

-- Forever keeps a class's three talent trees inside ONE tree of the modern
-- system, drawn side by side. What the live client says about it (/armory
-- dump): every talent belongs to a handful of groups, and the largest of
-- them is its tree; rows are evenly spaced from the top and columns from
-- each tree's left edge; a row needs 5 points in its own tree for every row
-- above it; and an arrow between two talents is an edge from the one that
-- is required to the one it unlocks.

-- The trees' names by group, from a function Forever added. On the live
-- client it answers with a list of { groupID, displayName, orderIndex, icon,
-- ... }, one per talent tree. Read loosely (anything that pairs a group with
-- a name), so another shape on another build still gives the names.
local function groupNames(treeID)
  local names = {}
  local function walk(t, depth, key)
    if type(t) ~= "table" or depth > 3 then return end
    local id, name = (type(key) == "number") and key or nil, nil
    for k, v in pairs(t) do
      if type(k) == "string" then
        local lower = k:lower()
        if lower:find("group", 1, true) and num(v) then id = num(v) end
        if lower:find("name", 1, true) and clean(v) and v ~= "" then name = name or clean(v) end
      end
    end
    if id and name then names[id] = name end
    for k, v in pairs(t) do walk(v, depth + 1, k) end
  end
  walk(safe(C_Traits.GetGroupDisplayInfoByTreeID, treeID), 0)
  return names
end

-- The smallest gap between two different positions: one row, or one column.
local function step(values)
  local sorted, seen = {}, {}
  for _, v in ipairs(values) do
    if not seen[v] then
      seen[v] = true
      sorted[#sorted + 1] = v
    end
  end
  table.sort(sorted)
  local gap
  for i = 2, #sorted do
    local d = sorted[i] - sorted[i - 1]
    if d > 0 and (not gap or d < gap) then gap = d end
  end
  return gap, sorted[1]
end

local function place(value, first, gap)
  if not gap or gap <= 0 then return 1 end
  return math.floor((value - first) / gap + 0.5) + 1
end

local function traitTalents(light)
  if not (C_ClassTalents and C_ClassTalents.GetActiveConfigID and C_Traits and C_Traits.GetConfigInfo) then return nil end
  local configID = safe(C_ClassTalents.GetActiveConfigID)
  local config = configID and safe(C_Traits.GetConfigInfo, configID)
  if type(config) ~= "table" or type(config.treeIDs) ~= "table" then return nil end
  local getName = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  local getIcon = (C_Spell and C_Spell.GetSpellTexture) or GetSpellTexture
  local className, classToken = safe(UnitClass, "player")
  className = clean(className)
  local trees, spent, total, available, named = {}, 0, 0, 0, nil

  for _, treeID in ipairs(config.treeIDs) do
    -- Every talent of this tree of the game's, with where it is drawn.
    local nodes, requires, inGroup = {}, {}, {}
    for _, nodeID in ipairs(safe(C_Traits.GetTreeNodes, treeID) or {}) do
      local node = safe(C_Traits.GetNodeInfo, configID, nodeID)
      local max = type(node) == "table" and num(node.maxRanks)
      if max and max > 0 and node.isVisible ~= false then
        local entryID = (type(node.activeEntry) == "table" and node.activeEntry.entryID)
          or (type(node.entryIDs) == "table" and node.entryIDs[1])
        local entry = entryID and safe(C_Traits.GetEntryInfo, configID, entryID)
        local def = type(entry) == "table" and entry.definitionID and safe(C_Traits.GetDefinitionInfo, entry.definitionID)
        local spellID = type(def) == "table" and num(def.spellID)
        local name = spellID and clean(safe(getName, spellID))
        if name then
          local talent = {
            id = nodeID, name = name, y = num(node.posY) or 0, x = num(node.posX) or 0, groups = {},
            rank = math.min(num(node.activeRank) or num(node.ranksPurchased) or 0, max), max = max,
          }
          for _, group in ipairs(type(node.groupIDs) == "table" and node.groupIDs or {}) do
            if num(group) then
              talent.groups[#talent.groups + 1] = group
              inGroup[group] = (inGroup[group] or 0) + 1
            end
          end
          Scan.icons[nodeID] = safe(getIcon, spellID)
          if not light then
            -- At the rank the player has; and what it becomes with every point in it.
            local desc = traitDescription(entryID, talent.rank, name)
            local full = max > 1 and talent.rank < max and traitDescription(entryID, max, name) or nil
            if not desc then
              desc = C_Spell and C_Spell.GetSpellDescription and clean(safe(C_Spell.GetSpellDescription, spellID))
            end
            if not desc or desc == "" then
              local lines = C_TooltipInfo and C_TooltipInfo.GetSpellByID and dataLines(safe(C_TooltipInfo.GetSpellByID, spellID))
              desc = lines and description(lines)
            end
            talent.desc = desc and desc ~= "" and oneLine(desc):sub(1, MAX_DESC) or nil
            full = full and oneLine(full):sub(1, MAX_DESC) or nil
            if full and full ~= talent.desc then talent.descMax = full end
          end
          for _, edge in ipairs(type(node.visibleEdges) == "table" and node.visibleEdges or {}) do
            if type(edge) == "table" and edge.targetNode and not requires[edge.targetNode] then requires[edge.targetNode] = nodeID end
          end
          nodes[#nodes + 1] = talent
          spent = spent + talent.rank
          total = total + 1
        end
      end
    end

    -- A talent's tree: the largest group it belongs to.
    local byHome, homes = {}, {}
    for _, talent in ipairs(nodes) do
      local home, size = 0, 0
      for _, group in ipairs(talent.groups) do
        local n = inGroup[group]
        if n > size or (n == size and group < home) then home, size = group, n end
      end
      talent.groups = nil
      if not byHome[home] then
        byHome[home] = { group = home, talents = {}, left = talent.x }
        homes[#homes + 1] = byHome[home]
      end
      local tree = byHome[home]
      tree.talents[#tree.talents + 1] = talent
      if talent.x < tree.left then tree.left = talent.x end
    end
    -- Anything but a few trees of some size is not that layout: one tree then, as the game has it.
    local split = #homes >= 2 and #homes <= 4
    for _, tree in ipairs(homes) do
      if tree.group == 0 or #tree.talents < 3 then split = false end
    end
    if not split then
      local left
      for _, talent in ipairs(nodes) do
        if not left or talent.x < left then left = talent.x end
      end
      homes = { { group = 0, talents = nodes, left = left or 0 } }
    end
    table.sort(homes, function(a, b) return a.left < b.left end)

    local xs, ys = {}, {}
    for _, talent in ipairs(nodes) do
      xs[#xs + 1], ys[#ys + 1] = talent.x, talent.y
    end
    local column = step(xs)
    local row, top = step(ys)
    local names = split and groupNames(treeID) or {}
    local known = split and CLASS_SPECS[clean(classToken) or ""] or nil
    if known and #known ~= #homes then known = nil end
    for i, home in ipairs(homes) do
      local tree = { id = #trees + 1, talents = home.talents, points = 0 }
      if not split then
        tree.name = className or ("Tree " .. tree.id)
      elseif names[home.group] then
        tree.name, named = names[home.group], "named by the game"
      else
        -- Not named by the game: the class's trees as they have always stood, left to right.
        tree.name, named = known and known[i] or ("Tree " .. tree.id), named or "named by their place"
      end
      for _, talent in ipairs(tree.talents) do
        talent.row = place(talent.y, top or talent.y, row)
        talent.col = place(talent.x, home.left, column)
        talent.requires = requires[talent.id]
        talent.x, talent.y = nil, nil
        tree.points = tree.points + talent.rank
      end
      trees[#trees + 1] = tree
    end
    for _, c in ipairs(safe(C_Traits.GetTreeCurrencyInfo, configID, treeID, false) or {}) do
      available = available + (type(c) == "table" and num(c.quantity) or 0)
    end
  end
  if total == 0 then return nil end
  local parts = {}
  for _, tree in ipairs(trees) do parts[#parts + 1] = string.format("%s %d", tree.name, #tree.talents) end
  Scan.how.talents = string.format("modern (C_Traits): %d talents in %d trees", total, #trees)
    .. (#trees > 1 and string.format(" (%s; %s)", table.concat(parts, ", "), named or "") or "")
  return {
    api = "traits", rowPoints = 5, trees = trees, spent = spent, available = available,
    -- Forever gives one point per level from 10 here too (28 points at level
    -- 37 on the live client), so the build is planned to the level cap.
    level = num(safe(UnitLevel, "player")), pointsAtCap = math.max(maxLevel() - 9, spent + available),
  }
end

local talentCache
-- Every talent of the class. Kept until the points change (Scan.Changed).
function Scan.Talents()
  if not talentCache then
    Scan.how.talents = "not available on this client"
    talentCache = safe(classicTalents) or safe(traitTalents) or false
  end
  return talentCache or nil
end

-- Points per talent right now: { [id] = rank }, read without the tooltips.
function Scan.Ranks()
  local section = safe(classicTalents, true) or safe(traitTalents, true)
  local ranks = {}
  for _, tree in ipairs(section and section.trees or {}) do
    for _, talent in ipairs(tree.talents) do ranks[talent.id] = talent.rank end
  end
  return ranks, section
end

-- Specializations --------------------------------------------------------------------

local MAX_SPECS = 6

-- Names read from the game: no empty or repeated ones.
local function nameList()
  local names, seen = {}, {}
  return names, function(name)
    name = clean(name)
    if name and name ~= "" and not seen[name] and #names < MAX_SPECS then
      seen[name] = true
      names[#names + 1] = name
    end
  end
end

-- The class's talent trees are its specializations, however the client
-- hands them over. One tree alone is the whole class, not a choice.
local function treeSpecs()
  local section = Scan.Talents()
  if not section or #section.trees < 2 then return nil end
  local names, add = nameList()
  for _, tree in ipairs(section.trees) do
    -- "Tree 2" is what a tree is called when the game gave no name for it.
    if not tostring(tree.name):match("^Tree %d+$") then add(tree.name) end
  end
  return #names > 1 and names or nil
end

-- A modern client's own list: for the character, or else for its class.
local function listedSpecs()
  local api = type(C_SpecializationInfo) == "table" and C_SpecializationInfo or {}
  local names, add = nameList()
  -- info(i): the game's answer for the i-th one: (id, name, description, icon, role, ...)
  local function read(count, info)
    count = num(count)
    if not count then return end
    for i = 1, math.min(count, MAX_SPECS) do
      local r = info(i)
      add(r and r[2])
    end
  end
  local own = GetSpecializationInfo or api.GetSpecializationInfo
  read(safe(GetNumSpecializations) or safe(api.GetNumSpecializations), function(i) return results(own, i) end)
  if #names == 0 then
    local classID = num((select(3, safe(UnitClass, "player"))))
    local forClass = GetSpecializationInfoForClassID or api.GetSpecializationInfoForClassID
    if classID then
      read(safe(GetNumSpecializationsForClassID, classID) or safe(api.GetNumSpecializationsForClassID, classID),
        function(i) return results(forClass, classID, i) end)
    end
  end
  -- Forever's client lists one specialization per class, named after the
  -- class ("Paladin"): that is nothing to choose from.
  return #names > 1 and names or nil
end

-- The specializations the player can choose from in the Build tab: from the
-- talent trees, from the game's list, or the classic names of the class.
-- Empty only for a class this addon does not know on a client that names none.
function Scan.Specs()
  local names, from = safe(treeSpecs), "talent trees"
  if not names then names, from = safe(listedSpecs), "the game's list" end
  if not names then
    local token = select(2, safe(UnitClass, "player"))
    names, from = CLASS_SPECS[clean(token) or ""], "built-in list"
  end
  Scan.how.specs = names and (table.concat(names, ", ") .. " (" .. from .. ")") or "none known for this class"
  return names or {}
end

-- Spells ---------------------------------------------------------------------------

local AUTO_ATTACK = 6603

local function spellTip(spellID, slot, bookType)
  if spellID and C_TooltipInfo and C_TooltipInfo.GetSpellByID then
    local lines = dataLines(safe(C_TooltipInfo.GetSpellByID, spellID))
    if lines and #lines > 1 then return lines end
  end
  if spellID then
    local lines = tipLines(function(t) t:SetSpellByID(spellID) end)
    if lines and #lines > 1 then return lines end
  end
  if slot then
    local lines = tipLines(function(t) t:SetSpellBookItem(slot, bookType) end)
    if lines and #lines > 1 then return lines end
  end
  return nil
end

local function spellEntry(name, rank, spellID, tabName, passive, lines)
  local e = { name = name, id = spellID, tab = tabName }
  if rank and rank ~= "" then e.rank = rank end
  if passive then e.passive = true end
  if lines then
    -- Under the name: the rank line repeats "rank", the rest is what it does.
    local out = {}
    for i = 2, #lines do
      if lines[i] ~= rank then out[#out + 1] = lines[i] end
    end
    local text = table.concat(out, " | ")
    if text ~= "" then e.tip = text:sub(1, 480) end
  end
  return e
end

local function modernSpells()
  if not (C_SpellBook and C_SpellBook.GetNumSpellBookSkillLines and C_SpellBook.GetSpellBookItemInfo) then return nil end
  local bank = Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Player or 0
  local types = Enum and Enum.SpellBookItemType or {}
  local list, seen = {}, {}
  for i = 1, num(safe(C_SpellBook.GetNumSpellBookSkillLines)) or 0 do
    local line = safe(C_SpellBook.GetSpellBookSkillLineInfo, i)
    if type(line) == "table" and not line.offSpecID and not line.shouldHide then
      local first = (num(line.itemIndexOffset) or 0) + 1
      for j = first, first + (num(line.numSpellBookItems) or 0) - 1 do
        local info = safe(C_SpellBook.GetSpellBookItemInfo, j, bank)
        local name = type(info) == "table" and clean(info.name)
        local id = name and (num(info.spellID) or num(info.actionID))
        local skip = not name or not id or id == AUTO_ATTACK or seen[name]
          or (types.Flyout and info.itemType == types.Flyout)
          or (types.FutureSpell and info.itemType == types.FutureSpell)
        if not skip and #list < MAX_SPELLS then
          seen[name] = true
          list[#list + 1] = spellEntry(name, clean(info.subName), id, clean(line.name), info.isPassive and true or false, spellTip(id))
        end
      end
    end
  end
  return #list > 0 and list or nil
end

local function classicSpells()
  if not (GetNumSpellTabs and GetSpellTabInfo and GetSpellBookItemName) then return nil end
  local book = BOOKTYPE_SPELL or "spell"
  local order, best = {}, {}
  for t = 1, num(safe(GetNumSpellTabs)) or 0 do
    local tab = results(GetSpellTabInfo, t) or {}
    local tabName, offset, count = clean(tab[1]), num(tab[3]) or 0, num(tab[4]) or 0
    for i = offset + 1, offset + count do
      -- name, rank, spellID (the id only on newer clients)
      local r = results(GetSpellBookItemName, i, book) or {}
      local name, rank = clean(r[1]), clean(r[2])
      local info = results(GetSpellBookItemInfo, i, book) or {}
      local id = num(r[3]) or num(info[2])
      local kind = info[1]
      if name and kind ~= "FLYOUT" and kind ~= "FUTURESPELL" and id ~= AUTO_ATTACK then
        if not best[name] then order[#order + 1] = name end
        -- Ranks are listed in order: the last one is the highest.
        best[name] = { rank = rank, id = id, slot = i, tab = tabName, passive = safe(IsPassiveSpell, i, book) and true or false }
      end
    end
  end
  local list = {}
  for _, name in ipairs(order) do
    local s = best[name]
    if #list < MAX_SPELLS then
      list[#list + 1] = spellEntry(name, s.rank, s.id, s.tab, s.passive, spellTip(s.id, s.slot, book))
    end
  end
  return #list > 0 and list or nil
end

local spellCache
-- The spellbook with tooltips. Kept until the spells change (Scan.Changed).
function Scan.Spells()
  if not spellCache then
    local list = safe(modernSpells)
    Scan.how.spells = list and "modern (C_SpellBook)" or nil
    if not list then
      list = safe(classicSpells)
      Scan.how.spells = list and "classic (GetSpellBookItemName)" or "not available on this client"
    end
    if list then
      local tips = 0
      for _, s in ipairs(list) do if s.tip then tips = tips + 1 end end
      Scan.how.spells = Scan.how.spells .. string.format(": %d spells, %d with a tooltip", #list, tips)
    end
    spellCache = list or false
  end
  return spellCache or nil
end

-- Combat numbers --------------------------------------------------------------------

local SCHOOLS = { [2] = "holy", [3] = "fire", [4] = "nature", [5] = "frost", [6] = "shadow", [7] = "arcane" }

local function sum3(a, b, c)
  a = num(a)
  if not a then return nil end
  return a + (num(b) or 0) + (num(c) or 0)
end

-- The highest value over the magic schools, and each school's when they differ.
local function bySchool(fn)
  if type(fn) ~= "function" then return nil end
  local best, each, differ = nil, {}, false
  for id, name in pairs(SCHOOLS) do
    local v = num(safe(fn, id))
    if v then
      each[name] = round(v, 2)
      if best and v ~= best then differ = true end
      if not best or v > best then best = v end
    end
  end
  return best and round(best, 2), differ and each or nil
end

local function weapon(min, max, speed)
  min, max, speed = num(min), num(max), num(speed)
  if not (min and max and speed) or max <= 0 or speed <= 0 then return nil end
  return { min = round(min, 1), max = round(max, 1), speed = round(speed, 2) }
end

function Scan.Combat()
  local c = {}
  put(c, "level", function() return num(UnitLevel("player")) end)
  put(c, "attackPower", function() return sum3(UnitAttackPower("player")) end)
  put(c, "rangedAttackPower", function() return sum3(UnitRangedAttackPower("player")) end)
  put(c, "critPct", function() return round(GetCritChance(), 2) end)
  put(c, "rangedCritPct", function() return round(GetRangedCritChance(), 2) end)
  put(c, "hitPct", function() return round(GetHitModifier(), 2) end)
  put(c, "spellHitPct", function() return round(GetSpellHitModifier(), 2) end)
  put(c, "hastePct", function() return round(GetHaste(), 2) end)
  put(c, "spellHastePct", function() return round(UnitSpellHaste("player"), 2) end)
  put(c, "healingPower", function() return num(GetSpellBonusHealing()) end)
  local power, powerBySchool = bySchool(GetSpellBonusDamage)
  c.spellPower, c.spellPowerBySchool = power, powerBySchool
  local crit, critBySchool = bySchool(GetSpellCritChance)
  c.spellCritPct, c.spellCritBySchool = crit, critBySchool
  -- Weapon damage as the character sheet shows it (attack power included).
  pcall(function()
    local lo, hi, offLo, offHi = UnitDamage("player")
    local main, off = UnitAttackSpeed("player")
    c.mainHand = weapon(lo, hi, main)
    c.offHand = off and weapon(offLo, offHi, off) or nil
  end)
  pcall(function()
    local speed, lo, hi = UnitRangedDamage("player")
    c.ranged = weapon(lo, hi, speed)
  end)
  put(c, "resource", function() return select(2, UnitPowerType("player")) end)
  put(c, "resourceMax", function() return num(UnitPowerMax("player")) end)
  pcall(function()
    local idle, casting = GetManaRegen()
    if num(idle) then c.regenPerSec = round(idle, 1) end
    if num(casting) then c.regenWhileCasting = round(casting, 1) end
  end)
  put(c, "armor", function() local base, eff = UnitArmor("player"); return num(eff) or num(base) end)
  put(c, "maxHealth", function() return num(UnitHealthMax("player")) end)
  local n = Util.count(c)
  Scan.how.combat = string.format("%d values", n)
  return n > 0 and c or nil
end

-- Items seen ------------------------------------------------------------------------

local QUALITY = { [0] = "poor", "common", "uncommon", "rare", "epic", "legendary" }
local described = {}

-- Items the addon has seen in the game that the character could wear now or
-- soon, best first, with their stats when the game still has them at hand.
function Scan.Seen()
  if not ns.db then return nil end
  local level = num(safe(UnitLevel, "player")) or 1
  local picked = {}
  for id, e in pairs(ns.db.seen) do
    local req = tonumber(e.r) or 0
    -- No level requirement (many quest rewards): placed by its item level.
    if req <= 0 then req = math.max((tonumber(e.l) or 0) - 5, 0) end
    if type(e.n) == "string" and req <= level + 5 and req >= level - 12 then
      picked[#picked + 1] = { id = id, e = e }
    end
  end
  table.sort(picked, function(a, b)
    local la, lb = tonumber(a.e.l) or 0, tonumber(b.e.l) or 0
    if la ~= lb then return la > lb end
    return a.id < b.id
  end)
  local api = ForeverAICompanionAPI
  local out = {}
  for i = 1, math.min(#picked, MAX_SEEN_SENT) do
    local id, e = picked[i].id, picked[i].e
    local item = { itemId = id, name = e.n, equipSlot = e.s, type = e.y, itemLevel = e.l, reqLevel = e.r, quality = QUALITY[e.q] or e.q, src = e.src }
    if described[id] == nil then
      local d = api and api.DescribeItem and api.DescribeItem("item:" .. id, true)
      described[id] = type(d) == "table" and d.name and { stats = d.stats, effects = d.effects, weaponDamage = d.weaponDamage, weaponSpeed = d.weaponSpeed } or false
    end
    local d = described[id]
    if d then item.stats, item.effects, item.weaponDamage, item.weaponSpeed = d.stats, d.effects, d.weaponDamage, d.weaponSpeed end
    out[#out + 1] = item
  end
  Scan.how.seen = string.format("%d of %d items remembered", #out, Util.count(ns.db.seen))
  return #out > 0 and out or nil
end

-- Changes and diagnosis -------------------------------------------------------------

-- Something changed in the game: read that part again next time.
function Scan.Changed(what)
  if what == "talents" or not what then talentCache = nil end
  if what == "spells" or not what then spellCache = nil end
end

-- What this client let the addon read, line by line (/armory debug).
function Scan.Diagnose()
  Scan.Changed()
  local talents, spells, combat = Scan.Talents(), Scan.Spells(), Scan.Combat()
  Scan.Seen()
  Scan.Specs()
  local ok, looked = pcall(ns.Items.SeenDiagnosis)
  looked = ok and tostring(looked) or ("items this session: " .. tostring(looked))
  local lines = {
    "talents: " .. tostring(Scan.how.talents),
    "specializations: " .. tostring(Scan.how.specs),
    "spells: " .. tostring(Scan.how.spells),
    "combat: " .. tostring(Scan.how.combat),
    "items seen: " .. tostring(Scan.how.seen),
    -- How the items were looked at this session, and why the last one was not kept.
    looked,
    "tooltips: " .. ((C_TooltipInfo and "C_TooltipInfo" or "") .. (scanTip() and " hidden tooltip" or "")),
  }
  local sample = talents and talents.trees[1] and talents.trees[1].talents[1]
  if sample then
    lines[#lines + 1] = string.format("first talent: %s %d/%d row %d: %s", sample.name, sample.rank, sample.max, sample.row,
      tostring(sample.desc or "(no description)"):sub(1, 120))
  end
  local spell = spells and spells[1]
  if spell then lines[#lines + 1] = string.format("first spell: %s (%s): %s", spell.name, tostring(spell.id), tostring(spell.tip or "(no tooltip)"):sub(1, 120)) end
  if combat and combat.mainHand then
    lines[#lines + 1] = string.format("main hand: %s-%s every %ss", tostring(combat.mainHand.min), tostring(combat.mainHand.max), tostring(combat.mainHand.speed))
  end
  return lines
end

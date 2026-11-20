-- Gathers a snapshot of the player's state for the AI.
-- Every section is wrapped in pcall: an API that is missing or behaves
-- differently on this client only drops that section, never the whole snapshot.
-- Both the modern (C_*) and the classic-style APIs are tried where they differ.
local _, ns = ...

local Collect = {}
ns.Collect = Collect

local floor, sqrt = math.floor, math.sqrt

local function safe(fn, ...)
  local ok, res = pcall(fn, ...)
  if ok then return res end
  return nil
end

-- Errors of the current snapshot, by section, so missing data can be diagnosed.
local errors

-- Like safe(), but remembers why a whole section failed.
local function section(name, fn, ...)
  local ok, res = pcall(fn, ...)
  if ok then return res end
  errors[name] = tostring(res):gsub("^.-:%d+: ", ""):sub(1, 120)
  return nil
end

-- Midnight-era clients can return "secret" values (e.g. unit health) that
-- addons may display but not compute with. Treat them as unknown.
local function secret(v)
  return issecretvalue and issecretvalue(v) or false
end

local function num(v)
  if v == nil or secret(v) or type(v) ~= "number" then return nil end
  return v
end

-- Sets t[key] = fn(), ignoring failures, so one bad field never drops the rest.
local function put(t, key, fn)
  local ok, v = pcall(fn)
  if ok and v ~= nil and not secret(v) then t[key] = v end
end

local function round(n, digits)
  n = num(n)
  if not n then return nil end
  local m = 10 ^ (digits or 0)
  return floor(n * m + 0.5) / m
end

local function pct(cur, max)
  cur, max = num(cur), num(max)
  if not cur or not max or max <= 0 then return nil end
  local ok, v = pcall(function() return floor(cur / max * 100 + 0.5) end)
  return ok and v or nil
end

local function money(copper)
  if type(copper) ~= "number" then return nil end
  return string.format("%dg %ds %dc", floor(copper / 10000), floor(copper / 100) % 100, copper % 100)
end

-- Strip WoW markup (colors, textures, hyperlinks) so the AI sees plain text.
local function clean(s)
  if type(s) ~= "string" then return s end
  s = s:gsub("|c%x%x%x%x%x%x%x%x", "")
  s = s:gsub("|cn[%w_]*:", "") -- newer clients color by name: "|cnIQ1:" = item quality 1
  s = s:gsub("|r", "")
  s = s:gsub("|T.-|t", "")
  s = s:gsub("|A.-|a", "")
  s = s:gsub("|H.-|h(.-)|h", "%1")
  s = s:gsub("|n", "\n")
  return s
end
Collect.Clean = clean

local GetItemInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
local GetDetailedItemLevelInfo = (C_Item and C_Item.GetDetailedItemLevelInfo) or GetDetailedItemLevelInfo
local GetItemStats = (C_Item and C_Item.GetItemStats) or GetItemStats
local GetItemCooldown = (C_Container and C_Container.GetItemCooldown) or GetItemCooldown

local QUALITY = { [0] = "poor", "common", "uncommon", "rare", "epic", "legendary", "artifact", "heirloom" }
local HEARTHSTONE = 6948

local SLOTS = {
  { 1, "head" }, { 2, "neck" }, { 3, "shoulder" }, { 15, "back" }, { 5, "chest" },
  { 9, "wrist" }, { 10, "hands" }, { 6, "waist" }, { 7, "legs" }, { 8, "feet" },
  { 11, "finger1" }, { 12, "finger2" }, { 13, "trinket1" }, { 14, "trinket2" },
  { 16, "mainHand" }, { 17, "offHand" }, { 18, "ranged" },
}

-- Item stats as { AGILITY = 5, STAMINA = 3, DAMAGE_PER_SECOND = 12.4, ... }.
local function itemStats(link)
  if not GetItemStats then return nil end
  local ok, stats = pcall(GetItemStats, link)
  if not ok or type(stats) ~= "table" then return nil end
  local out, any = {}, false
  for k, v in pairs(stats) do
    if type(k) == "string" and type(v) == "number" then
      local key = k:gsub("^ITEM_MOD_", "")
      key = key:gsub("_SHORT$", "")
      out[key] = round(v, 1)
      any = true
    end
  end
  return any and out or nil
end

-- What GetItemStats leaves out, read from the item's tooltip: its "Equip:",
-- "Use:", "Chance on hit:" and set bonus lines, and a weapon's damage and speed.
local TRIGGERS
local function triggers()
  if not TRIGGERS then
    TRIGGERS = {}
    for _, k in ipairs({ "ITEM_SPELL_TRIGGER_ONEQUIP", "ITEM_SPELL_TRIGGER_ONUSE", "ITEM_SPELL_TRIGGER_ONPROC" }) do
      if type(_G[k]) == "string" and _G[k] ~= "" then TRIGGERS[#TRIGGERS + 1] = _G[k] end
    end
    local set = type(ITEM_SET_BONUS) == "string" and ITEM_SET_BONUS:match("^(.-)%%s")
    if set and set ~= "" then TRIGGERS[#TRIGGERS + 1] = set end
  end
  return TRIGGERS
end

local MAX_EFFECTS = 4
local function tooltipDetails(link, item)
  if not (C_TooltipInfo and C_TooltipInfo.GetHyperlink) then return end
  local data = C_TooltipInfo.GetHyperlink(link)
  if type(data) ~= "table" or type(data.lines) ~= "table" then return end
  local effects = {}
  for _, line in ipairs(data.lines) do
    local left, right = line.leftText, line.rightText
    if type(left) == "string" and not secret(left) then
      left = clean(left)
      for _, prefix in ipairs(triggers()) do
        if #effects < MAX_EFFECTS and left:sub(1, #prefix) == prefix then
          effects[#effects + 1] = left:sub(1, 200)
          break
        end
      end
      if not item.weaponDamage and type(right) == "string" and not secret(right) then
        local damage = left:match("^(%d+ %- %d+)")
        local speed = right:match("(%d+[%.,]%d+)")
        if damage and speed then
          item.weaponDamage = damage
          item.weaponSpeed = tonumber((speed:gsub(",", ".")))
        end
      end
    end
  end
  if #effects > 0 then item.effects = effects end
end

-- Common description of an item link. `full` adds stats and requirements.
local function describeItem(link, full)
  local name, _, quality, itemLevel, reqLevel, itemType, itemSubType, _, equipLoc = GetItemInfo(link)
  local item = {
    name = name or link:match("%[(.-)%]"),
    itemId = tonumber(link:match("item:(%d+)")),
    quality = QUALITY[quality] or quality,
    type = itemSubType or itemType,
  }
  local equippable = equipLoc and equipLoc ~= "" and equipLoc ~= "INVTYPE_NON_EQUIP_IGNORE"
  if equippable then
    item.equipSlot = equipLoc
    item.itemLevel = (GetDetailedItemLevelInfo and GetDetailedItemLevelInfo(link)) or itemLevel
  end
  if reqLevel and reqLevel > 1 then item.reqLevel = reqLevel end
  if full and equippable then
    item.stats = itemStats(link)
    pcall(tooltipDetails, link, item)
  end
  return item
end
Collect.DescribeItem = describeItem

-- Gear slots (names as in "gear") an equippable item would go in.
local SLOTS_FOR = {
  INVTYPE_HEAD = { "head" }, INVTYPE_NECK = { "neck" }, INVTYPE_SHOULDER = { "shoulder" },
  INVTYPE_CLOAK = { "back" }, INVTYPE_CHEST = { "chest" }, INVTYPE_ROBE = { "chest" },
  INVTYPE_WRIST = { "wrist" }, INVTYPE_HAND = { "hands" }, INVTYPE_WAIST = { "waist" },
  INVTYPE_LEGS = { "legs" }, INVTYPE_FEET = { "feet" }, INVTYPE_FINGER = { "finger1", "finger2" },
  INVTYPE_TRINKET = { "trinket1", "trinket2" }, INVTYPE_WEAPON = { "mainHand", "offHand" },
  INVTYPE_2HWEAPON = { "mainHand", "offHand" }, INVTYPE_WEAPONMAINHAND = { "mainHand" },
  INVTYPE_WEAPONOFFHAND = { "offHand" }, INVTYPE_SHIELD = { "offHand" }, INVTYPE_HOLDABLE = { "offHand" },
  INVTYPE_RANGED = { "ranged" }, INVTYPE_RANGEDRIGHT = { "ranged" }, INVTYPE_THROWN = { "ranged" },
  INVTYPE_RELIC = { "ranged" },
}

-- An item with everything needed to judge it: stats, and for gear the slots
-- it would replace (to compare with "gear").
local function fullItem(link)
  local item = describeItem(link, true)
  item.slots = item.equipSlot and SLOTS_FOR[item.equipSlot]
  -- Not gear (a potion, a quest item...): what using it does.
  if not item.slots then pcall(tooltipDetails, link, item) end
  return item
end

-- Links the player put in the question (shift-click on an item, spell,
-- quest...). Items come with their stats and the gear slots they would
-- replace; anything else just with its kind and name.
local MAX_LINKS = 5
function Collect:Links(text)
  if type(text) ~= "string" then return nil end
  local out, seen = {}, {}
  for data, shown in text:gmatch("|H(.-)|h(.-)|h") do
    if #out >= MAX_LINKS then break end
    local kind = data:match("^(%a+):")
    local name = clean(shown):gsub("^%[", ""):gsub("%]$", "")
    if kind and not seen[data] then
      seen[data] = true
      if kind == "item" then
        local item = safe(fullItem, data) or {}
        item.name = item.name or name
        out[#out + 1] = item
      else
        local link = { kind = kind, name = name, id = tonumber(data:match("^%a+:(%d+)")) }
        -- A spell: what it does, as the game describes it.
        if kind == "spell" and link.id and C_Spell and C_Spell.GetSpellDescription then
          local desc = safe(C_Spell.GetSpellDescription, link.id)
          if type(desc) == "string" and not secret(desc) and desc ~= "" then link.description = clean(desc):sub(1, 400) end
        end
        out[#out + 1] = link
      end
    end
  end
  return #out > 0 and out or nil
end

-- Character -----------------------------------------------------------------

local function character()
  local c = {}
  put(c, "name", function() return UnitName("player") end)
  put(c, "realm", function() return GetRealmName() end)
  put(c, "level", function() return UnitLevel("player") end)
  put(c, "race", function() return UnitRace("player") end)
  put(c, "raceToken", function() return select(2, UnitRace("player")) end)
  put(c, "class", function() return (UnitClass("player")) end)
  put(c, "classToken", function() return select(2, UnitClass("player")) end)
  put(c, "faction", function() return UnitFactionGroup("player") end)
  put(c, "sex", function()
    local sex = UnitSex("player")
    return (sex == 2 and "male") or (sex == 3 and "female") or nil
  end)
  put(c, "xp", function() return num(UnitXP("player")) end)
  put(c, "xpMax", function() return num(UnitXPMax("player")) end)
  put(c, "xpPct", function() return pct(c.xp, c.xpMax) end)
  -- Rested XP comes in experience points, not percent: also send what share
  -- of this level it is, so nobody reads "76" as 76%.
  put(c, "restedXp", function() return num(GetXPExhaustion()) or 0 end)
  put(c, "restedPctOfLevel", function()
    local rested, max = c.restedXp, c.xpMax
    if rested and max and max > 0 then return round(rested / max * 100, 1) end
  end)
  put(c, "healthPct", function() return pct(UnitHealth("player"), UnitHealthMax("player")) end)
  put(c, "maxHealth", function() return num(UnitHealthMax("player")) end)
  put(c, "powerType", function() return select(2, UnitPowerType("player")) end)
  put(c, "maxPower", function() return num(UnitPowerMax("player")) end)
  put(c, "powerPct", function() return pct(UnitPower("player"), UnitPowerMax("player")) end)
  put(c, "money", function() return money(num(GetMoney())) end)
  put(c, "guild", function() return (GetGuildInfo("player")) end)
  put(c, "hearthstoneBind", function() return GetBindLocation() end)
  put(c, "hearthstoneCooldownMin", function()
    local start, duration = GetItemCooldown(HEARTHSTONE)
    start, duration = num(start), num(duration)
    if start and duration and duration > 0 then return round((start + duration - GetTime()) / 60, 1) end
  end)
  put(c, "pvpFlagged", function() return UnitIsPVP("player") or nil end)
  put(c, "dead", function() return UnitIsDeadOrGhost("player") or nil end)
  put(c, "inCombat", function() return UnitAffectingCombat("player") or nil end)
  put(c, "newMail", function() return HasNewMail() or nil end)
  put(c, "hardcore", function() return C_GameRules.IsHardcoreActive() or nil end)
  return c
end

-- Talents -------------------------------------------------------------------

-- Classic-style talent trees: points per tree and every talent with points.
local function classicTalents()
  if not (GetNumTalentTabs and GetTalentTabInfo and GetNumTalents and GetTalentInfo) then return nil end
  local trees = {}
  for tab = 1, GetNumTalentTabs() do
    local r = { GetTalentTabInfo(tab) }
    local tree = {}
    if type(r[1]) == "number" then
      tree.name, tree.points = r[2], r[5] -- id, name, description, icon, pointsSpent
    else
      tree.name, tree.points = r[1], r[3] -- name, icon, pointsSpent
    end
    local talents = {}
    for i = 1, GetNumTalents(tab) or 0 do
      local t = { GetTalentInfo(tab, i) }
      local name, rank, maxRank = t[1], t[5], t[6]
      if type(name) == "string" and type(rank) == "number" and rank > 0 then
        talents[#talents + 1] = string.format("%s %d/%d", name, rank, maxRank or rank)
      end
    end
    if #talents > 0 then tree.talents = talents end
    trees[#trees + 1] = tree
  end
  local out = { trees = trees }
  if UnitCharacterPoints then
    local unspent = UnitCharacterPoints("player")
    if unspent and unspent > 0 then out.unspentPoints = unspent end
  end
  return out
end

-- Modern talent loadout (C_ClassTalents / C_Traits): names of chosen talents.
local function modernTalents()
  if not (C_ClassTalents and C_ClassTalents.GetActiveConfigID and C_Traits) then return nil end
  local configID = C_ClassTalents.GetActiveConfigID()
  if not configID then return nil end
  local config = C_Traits.GetConfigInfo(configID)
  if not config or not config.treeIDs then return nil end
  local chosen = {}
  local getName = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  for _, treeID in ipairs(config.treeIDs) do
    for _, nodeID in ipairs(C_Traits.GetTreeNodes(treeID) or {}) do
      local node = C_Traits.GetNodeInfo(configID, nodeID)
      if node and node.activeRank and node.activeRank > 0 and node.activeEntry then
        local entry = C_Traits.GetEntryInfo(configID, node.activeEntry.entryID)
        local def = entry and entry.definitionID and C_Traits.GetDefinitionInfo(entry.definitionID)
        local spellName = def and def.spellID and getName(def.spellID)
        if spellName then
          chosen[#chosen + 1] = node.maxRanks and node.maxRanks > 1
            and string.format("%s %d/%d", spellName, node.activeRank, node.maxRanks) or spellName
        end
      end
    end
  end
  if #chosen == 0 then return nil end
  local out = { chosen = chosen }
  -- Talent points not spent yet.
  pcall(function()
    local unspent = 0
    for _, treeID in ipairs(config.treeIDs) do
      for _, c in ipairs(C_Traits.GetTreeCurrencyInfo(configID, treeID, false) or {}) do
        unspent = unspent + (num(c.quantity) or 0)
      end
    end
    if unspent > 0 then out.unspentPoints = unspent end
  end)
  return out
end

local function specialization()
  local s = {}
  if GetSpecialization and GetSpecializationInfo then
    local index = GetSpecialization()
    if index then
      local _, name, _, _, role = GetSpecializationInfo(index)
      s.spec, s.role = name, role
    end
  end
  s.talents = safe(classicTalents) or safe(modernTalents)
  return next(s) and s or nil
end

-- Stats ---------------------------------------------------------------------

local STAT_KEYS = { "strength", "agility", "stamina", "intellect", "spirit" }
local RESISTANCES = { [1] = "holy", [2] = "fire", [3] = "nature", [4] = "frost", [5] = "shadow", [6] = "arcane" }

local function sum3(a, b, c)
  a = num(a)
  if not a then return nil end
  return a + (num(b) or 0) + (num(c) or 0)
end

local function range(lo, hi)
  lo, hi = num(lo), num(hi)
  if lo and hi then return string.format("%d-%d", floor(lo), floor(hi)) end
end

local function resistances(unit)
  local res = {}
  for i, key in pairs(RESISTANCES) do
    local total = num(select(2, UnitResistance(unit, i)))
    if total and total > 0 then res[key] = total end
  end
  return next(res) and res or nil
end

-- A pet's combat stats.
local function petStats()
  local s = {}
  for i, key in ipairs(STAT_KEYS) do
    put(s, key, function() return num(select(2, UnitStat("pet", i))) end)
  end
  put(s, "armor", function() local base, eff = UnitArmor("pet"); return num(eff) or num(base) end)
  put(s, "attackPower", function() return sum3(UnitAttackPower("pet")) end)
  put(s, "damage", function() return range(UnitDamage("pet")) end)
  put(s, "attackSpeed", function() return round(UnitAttackSpeed("pet"), 2) end)
  put(s, "hitPct", function() return round(GetPetHitChanceModifier(), 2) end)
  put(s, "resistances", function() return resistances("pet") end)
  return next(s) and s or nil
end

local function stats()
  local s = {}
  for i, key in ipairs(STAT_KEYS) do
    put(s, key, function() return num(select(2, UnitStat("player", i))) end)
  end
  put(s, "armor", function() local base, eff = UnitArmor("player"); return num(eff) or num(base) end)
  put(s, "attackPower", function() return sum3(UnitAttackPower("player")) end)
  put(s, "rangedAttackPower", function() return sum3(UnitRangedAttackPower("player")) end)
  put(s, "meleeDamage", function() return range(UnitDamage("player")) end)
  put(s, "meleeSpeed", function() return round(UnitAttackSpeed("player"), 2) end)
  put(s, "rangedSpeed", function() local speed = num(UnitRangedDamage("player")); return speed and speed > 0 and round(speed, 2) or nil end)
  put(s, "rangedDamage", function() return range(select(2, UnitRangedDamage("player"))) end)
  put(s, "critPct", function() return round(GetCritChance(), 2) end)
  put(s, "rangedCritPct", function() return round(GetRangedCritChance(), 2) end)
  put(s, "spellCritPct", function() return round(GetSpellCritChance(2), 2) end)
  put(s, "hitPct", function() return round(GetHitModifier(), 2) end)
  put(s, "spellPower", function() return num(GetSpellBonusDamage(2)) end)
  put(s, "healingPower", function() return num(GetSpellBonusHealing()) end)
  put(s, "hastePct", function() return round(GetHaste(), 2) end)
  put(s, "masteryPct", function() return round(GetMasteryEffect(), 2) end)
  put(s, "dodgePct", function() return round(GetDodgeChance(), 2) end)
  put(s, "parryPct", function() return round(GetParryChance(), 2) end)
  put(s, "blockPct", function() return round(GetBlockChance(), 2) end)
  put(s, "manaRegenPerSec", function() return round(GetManaRegen(), 1) end)
  put(s, "manaRegenCasting", function() return round(select(2, GetManaRegen()), 1) end)
  put(s, "resistances", function() return resistances("player") end)
  put(s, "itemLevel", function()
    local overall, equipped = GetAverageItemLevel()
    return round(num(equipped) or overall, 1)
  end)
  return s
end

-- Items ---------------------------------------------------------------------

local function gear()
  local items, empty = {}, {}
  local lowest
  for _, slot in ipairs(SLOTS) do
    local id, slotName = slot[1], slot[2]
    local link = GetInventoryItemLink("player", id)
    if link then
      local item = describeItem(link, true)
      item.slot = slotName
      item.equipSlot = nil
      local enchant = link:match("item:%d+:(%d+)")
      if enchant and enchant ~= "0" and enchant ~= "" then item.enchanted = true end
      local cur, max = GetInventoryItemDurability(id)
      if cur and max and max > 0 then
        item.durabilityPct = floor(cur / max * 100)
        if not lowest or item.durabilityPct < lowest then lowest = item.durabilityPct end
      end
      items[#items + 1] = item
    else
      empty[#empty + 1] = slotName
    end
  end
  return items, empty, lowest
end

-- Classic-style ammo slot (0). Returns nil on clients without one.
local function ammo()
  local link = GetInventoryItemLink("player", 0)
  if not link then return nil end
  local name = GetItemInfo(link) or link:match("%[(.-)%]")
  return { name = name, equipped = GetInventoryItemCount("player", 0) }
end

local function lastBag()
  return NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4
end

local function playerBags()
  local ids = {}
  for bag = 0, lastBag() do ids[#ids + 1] = bag end
  return ids
end

local function bankBags()
  local ids = {}
  if Enum and Enum.BagIndex and Enum.BagIndex.CharacterBankTab_1 then
    for i = 1, 6 do
      local id = Enum.BagIndex["CharacterBankTab_" .. i]
      if id then ids[#ids + 1] = id end
    end
  else
    ids[1] = BANK_CONTAINER or -1
    local first = lastBag() + 1
    for bag = first, first + (NUM_BANKBAGSLOTS or 7) - 1 do ids[#ids + 1] = bag end
  end
  return ids
end
Collect.BankBags = bankBags

local function bagSpace()
  local getFree = (C_Container and C_Container.GetContainerNumFreeSlots) or GetContainerNumFreeSlots
  local getSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
  if not getFree or not getSlots then return nil end
  local free, total = 0, 0
  for _, bag in ipairs(playerBags()) do
    free = free + (getFree(bag) or 0)
    total = total + (getSlots(bag) or 0)
  end
  local out = { freeSlots = free, totalSlots = total }
  -- Which bags (a hunter's quiver or ammo pouch matters).
  put(out, "containers", function()
    local getName = (C_Container and C_Container.GetBagName) or GetBagName
    local names = {}
    for bag = 1, lastBag() do
      local name = getName(bag)
      if type(name) == "string" and name ~= "" then names[#names + 1] = name end
    end
    return #names > 0 and names or nil
  end)
  return out
end

-- Contents of the given containers, grouped by item with total counts.
-- `full` adds stats for equippable items.
local function containerItems(bagIDs, full)
  local C = C_Container
  local getSlots = (C and C.GetContainerNumSlots) or GetContainerNumSlots
  local getLink = (C and C.GetContainerItemLink) or GetContainerItemLink
  if not getSlots then return nil end
  local byId, list = {}, {}
  for _, bag in ipairs(bagIDs) do
    for slot = 1, getSlots(bag) or 0 do
      local link, count
      if C and C.GetContainerItemInfo then
        local info = C.GetContainerItemInfo(bag, slot)
        if info then link, count = info.hyperlink, info.stackCount end
      elseif GetContainerItemInfo then
        local _, c, _, _, _, _, l = GetContainerItemInfo(bag, slot)
        link, count = l, c
      end
      if not link and getLink then link = getLink(bag, slot) end
      if link then
        local key = link:match("item:(%d+)") or link
        local entry = byId[key]
        if entry then
          entry.count = entry.count + (count or 1)
        else
          entry = describeItem(link, full)
          entry.count = count or 1
          byId[key] = entry
          list[#list + 1] = entry
        end
      end
    end
  end
  return list
end
Collect.ContainerItems = containerItems

-- Spells, auras, reputation, currencies ---------------------------------------

-- Left out of the spell list: the auto attack ("Attack"), which every class
-- has, and the spellbook's groups (flyouts such as "Blessings" or "Auras",
-- whose spells are listed one by one anyway).
local AUTO_ATTACK = 6603
local function autoAttackName()
  local getName = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  return getName and safe(getName, AUTO_ATTACK)
end

local function spells()
  local tabs = {}
  if C_SpellBook and C_SpellBook.GetNumSpellBookSkillLines then
    local bank = Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Player or 0
    local FUTURE = Enum and Enum.SpellBookItemType and Enum.SpellBookItemType.FutureSpell
    local FLYOUT = Enum and Enum.SpellBookItemType and Enum.SpellBookItemType.Flyout
    for i = 1, C_SpellBook.GetNumSpellBookSkillLines() do
      local line = C_SpellBook.GetSpellBookSkillLineInfo(i)
      if line and not line.offSpecID and not line.shouldHide then
        local names, future, seen = {}, {}, {}
        for j = line.itemIndexOffset + 1, line.itemIndexOffset + line.numSpellBookItems do
          local info = C_SpellBook.GetSpellBookItemInfo(j, bank)
          if info and info.name and not info.isPassive and not seen[info.name]
            and not (FLYOUT and info.itemType == FLYOUT) and info.spellID ~= AUTO_ATTACK then
            seen[info.name] = true
            local name = (info.subName and info.subName ~= "") and (info.name .. " (" .. info.subName .. ")") or info.name
            if FUTURE and info.itemType == FUTURE then
              -- Shown in the book but not learned yet.
              local level = C_SpellBook.GetSpellBookItemLevelLearned and num(safe(C_SpellBook.GetSpellBookItemLevelLearned, j, bank))
              future[#future + 1] = level and level > 0 and string.format("%s (level %d)", name, level) or name
            else
              names[#names + 1] = name
            end
          end
        end
        if #names > 0 or #future > 0 then
          tabs[#tabs + 1] = { tab = line.name, spells = names, notLearned = #future > 0 and future or nil }
        end
      end
    end
  elseif GetNumSpellTabs and GetSpellTabInfo and GetSpellBookItemName then
    local attack = autoAttackName()
    for t = 1, GetNumSpellTabs() do
      local tabName, _, offset, num = GetSpellTabInfo(t)
      -- Keep the highest rank of each spell (ranks are listed in order).
      local order, best = {}, {}
      for i = offset + 1, offset + num do
        local name, rank = GetSpellBookItemName(i, BOOKTYPE_SPELL or "spell")
        local passive = IsPassiveSpell and IsPassiveSpell(i, BOOKTYPE_SPELL or "spell")
        local kind = GetSpellBookItemInfo and GetSpellBookItemInfo(i, BOOKTYPE_SPELL or "spell")
        if name and not passive and kind ~= "FLYOUT" and name ~= attack then
          if not best[name] then order[#order + 1] = name end
          best[name] = (rank and rank ~= "") and (name .. " (" .. rank .. ")") or name
        end
      end
      local names = {}
      for _, n in ipairs(order) do names[#names + 1] = best[n] end
      if #names > 0 then tabs[#tabs + 1] = { tab = tabName, spells = names } end
    end
  end
  return #tabs > 0 and tabs or nil
end

local function auras(filter)
  local list = {}
  for i = 1, 40 do
    local name, count, expires
    if C_UnitAuras and C_UnitAuras.GetAuraDataByIndex then
      local a = C_UnitAuras.GetAuraDataByIndex("player", i, filter)
      if not a then break end
      name, count, expires = a.name, a.applications, a.expirationTime
    elseif UnitAura then
      local n, _, c, _, _, e = UnitAura("player", i, filter)
      if not n then break end
      name, count, expires = n, c, e
    else
      break
    end
    local e = { name = name }
    if count and count > 1 then e.stacks = count end
    if expires and expires > 0 then e.minutesLeft = round((expires - GetTime()) / 60, 1) end
    list[#list + 1] = e
  end
  return #list > 0 and list or nil
end

local function standingLabel(id)
  return id and _G["FACTION_STANDING_LABEL" .. id] or id
end

local function reputations()
  local list = {}
  if C_Reputation and C_Reputation.GetNumFactions and C_Reputation.GetFactionDataByIndex then
    for i = 1, C_Reputation.GetNumFactions() do
      local f = C_Reputation.GetFactionDataByIndex(i)
      if f and (not f.isHeader or f.isHeaderWithRep) then
        list[#list + 1] = {
          name = f.name,
          standing = standingLabel(f.reaction),
          progress = f.nextReactionThreshold and string.format("%d/%d",
            (f.currentStanding or 0) - (f.currentReactionThreshold or 0),
            (f.nextReactionThreshold or 0) - (f.currentReactionThreshold or 0)) or nil,
          atWar = f.atWarWith or nil,
        }
      end
    end
  elseif GetNumFactions and GetFactionInfo then
    for i = 1, GetNumFactions() do
      local name, _, standingID, barMin, barMax, barValue, atWar, _, isHeader, _, hasRep = GetFactionInfo(i)
      if name and (not isHeader or hasRep) then
        list[#list + 1] = {
          name = name,
          standing = standingLabel(standingID),
          progress = barMax and string.format("%d/%d", (barValue or 0) - (barMin or 0), barMax - (barMin or 0)) or nil,
          atWar = atWar or nil,
        }
      end
    end
  end
  return #list > 0 and list or nil
end

local function currencies()
  if not (C_CurrencyInfo and C_CurrencyInfo.GetCurrencyListSize) then return nil end
  local list = {}
  for i = 1, C_CurrencyInfo.GetCurrencyListSize() do
    local c = C_CurrencyInfo.GetCurrencyListInfo(i)
    if c and not c.isHeader and c.quantity and c.quantity > 0 then
      list[#list + 1] = { name = c.name, quantity = c.quantity, max = (c.maxQuantity and c.maxQuantity > 0) and c.maxQuantity or nil }
    end
  end
  return #list > 0 and list or nil
end

-- The skill lines (weapons, armor, riding, languages, professions) as
-- { name, rank, max, group }. WoW Forever moved them to C_SkillInfo, which
-- may return a table per line; older clients have the global functions.
local MAX_SKILLS = 40
local function skillLines()
  local count = (C_SkillInfo and C_SkillInfo.GetNumSkillLines) or GetNumSkillLines
  local info = (C_SkillInfo and C_SkillInfo.GetSkillLineInfo) or GetSkillLineInfo
  if not (count and info) then return nil end
  local list, header, seen = {}, nil, {}
  for i = 1, num(count()) or 0 do
    local r = { info(i) }
    local name, isHeader, rank, maxRank
    if type(r[1]) == "table" then
      local t = r[1]
      name = t.skillName or t.name or t.skillLineName
      isHeader = t.isHeader
      rank = t.skillRank or t.rank or t.skillLineRank
      maxRank = t.skillMaxRank or t.maxRank or t.skillLineMaxRank
    else
      name, isHeader, rank, maxRank = r[1], r[2], r[4], r[7]
    end
    if isHeader then
      header = name
    elseif type(name) == "string" and name ~= "" and not seen[name] then
      -- Each skill once: WoW Forever lists professions and secondary skills twice.
      seen[name] = true
      list[#list + 1] = { name = name, rank = num(rank), max = num(maxRank), group = header }
    end
    if #list >= MAX_SKILLS then break end
  end
  return #list > 0 and list or nil
end

local function professions()
  local list = {}
  if GetProfessions and GetProfessionInfo then
    local slots = { GetProfessions() }
    for i = 1, 6 do
      local index = slots[i]
      if index then
        local name, _, rank, maxRank = GetProfessionInfo(index)
        list[#list + 1] = { name = name, rank = rank, max = maxRank }
      end
    end
  else
    -- Classic: professions, secondary skills and weapon skills.
    return skillLines()
  end
  return #list > 0 and list or nil
end

-- World -----------------------------------------------------------------------

local DIRECTIONS = { "N", "NO", "O", "SO", "S", "SE", "E", "NE" }

local function position()
  local p = {}
  p.zone = GetRealZoneText()
  p.subzone = GetSubZoneText()
  if C_Map and C_Map.GetBestMapForUnit then
    local mapID = C_Map.GetBestMapForUnit("player")
    if mapID then
      p.mapId = mapID
      local info = C_Map.GetMapInfo(mapID)
      if info then
        p.mapName = info.name
        -- Walk up to the continent.
        local continentType = Enum and Enum.UIMapType and Enum.UIMapType.Continent or 2
        local cur, guard = info, 0
        while cur and cur.parentMapID and cur.parentMapID > 0 and guard < 6 do
          cur = C_Map.GetMapInfo(cur.parentMapID)
          guard = guard + 1
          if cur and cur.mapType == continentType then p.continent = cur.name break end
        end
      end
      local pos = C_Map.GetPlayerMapPosition(mapID, "player")
      if pos then
        local x, y = pos:GetXY()
        if x and y then
          p.x = round(x * 100, 1)
          p.y = round(y * 100, 1)
        end
      end
    end
  end
  if GetPlayerFacing then
    local facing = GetPlayerFacing()
    if facing then p.facing = DIRECTIONS[floor(facing / (2 * math.pi) * 8 + 0.5) % 8 + 1] end
  end
  if GetZonePVPInfo then p.zonePvp = GetZonePVPInfo() end
  local inInstance, instanceType = IsInInstance()
  if inInstance then
    p.instanceType = instanceType
    local name, _, _, difficultyName = GetInstanceInfo()
    p.instanceName = name
    p.difficulty = difficultyName
  end
  p.resting = IsResting() or nil
  p.mounted = (IsMounted and IsMounted()) or nil
  p.swimming = (IsSwimming and IsSwimming()) or nil
  p.flying = (IsFlying and IsFlying()) or nil
  p.indoors = (IsIndoors and IsIndoors()) or nil
  return p
end

-- Quests ----------------------------------------------------------------------

local function questRewards(q, questID, logIndex)
  if GetQuestLogRewardXP then
    local xp = GetQuestLogRewardXP(questID)
    if xp and xp > 0 then q.rewardXp = xp end
  end
  if GetQuestLogRewardMoney then
    local m = GetQuestLogRewardMoney(questID)
    if m and m > 0 then q.rewardMoney = money(m) end
  end
  local function items(kind, numFn, infoFn)
    local n = numFn and safe(numFn, questID) or 0
    if not n or n == 0 then return nil end
    local list = {}
    for i = 1, n do
      local link = GetQuestLogItemLink and safe(GetQuestLogItemLink, kind, i, questID)
      if link then
        local it = describeItem(link, true)
        list[#list + 1] = it
      elseif infoFn then
        local name, _, count = infoFn(i, questID)
        if name then list[#list + 1] = { name = name, count = count } end
      end
    end
    return #list > 0 and list or nil
  end
  q.rewardItems = items("reward", GetNumQuestLogRewards, GetQuestLogRewardInfo)
  q.rewardChoices = items("choice", GetNumQuestLogChoices, GetQuestLogChoiceInfo)
end

-- Where a quest is done and where to go next, from the game's own map:
-- "where" = the quest's area on its zone map, "waypoint" = next stop (e.g. the
-- turn-in). Coordinates 0-100 like the game's map.
local mapNames = {}
local function mapName(id)
  if mapNames[id] == nil then
    local info = C_Map and C_Map.GetMapInfo and C_Map.GetMapInfo(id)
    mapNames[id] = info and info.name or false
  end
  return mapNames[id] or nil
end

local function spot(mapID, x, y)
  x, y = num(x), num(y)
  if not (mapID and x and y) or (x == 0 and y == 0) then return nil end
  return { zone = mapName(mapID), x = round(x * 100, 1), y = round(y * 100, 1) }
end

local function questLocation(q, questID, onMap)
  if C_QuestLog.GetNextWaypoint then
    local mapID, x, y = C_QuestLog.GetNextWaypoint(questID)
    q.waypoint = spot(mapID, x, y)
  end
  local uiMap = GetQuestUiMapID and GetQuestUiMapID(questID)
  if uiMap and uiMap > 0 and C_QuestLog.GetQuestsOnMap then
    if onMap[uiMap] == nil then onMap[uiMap] = C_QuestLog.GetQuestsOnMap(uiMap) or false end
    for _, info in ipairs(onMap[uiMap] or {}) do
      if info.questID == questID then
        q.where = spot(uiMap, info.x, info.y)
        break
      end
    end
  end
end

local function questsModern()
  local list = {}
  local header
  local onMap = {}
  for i = 1, C_QuestLog.GetNumQuestLogEntries() do
    local info = C_QuestLog.GetInfo(i)
    if info then
      if info.isHeader then
        header = info.title
      elseif not info.isHidden then
        local id = info.questID
        local q = { title = info.title, level = info.level, id = id, zone = header }
        if info.suggestedGroup and info.suggestedGroup > 1 then q.group = info.suggestedGroup end
        if C_QuestLog.IsComplete and C_QuestLog.IsComplete(id) then q.complete = true end
        if C_QuestLog.IsFailed and C_QuestLog.IsFailed(id) then q.failed = true end
        if C_QuestLog.GetQuestTagInfo then
          local tag = C_QuestLog.GetQuestTagInfo(id)
          if tag and tag.tagName then q.tag = tag.tagName end
        end
        local objectives = C_QuestLog.GetQuestObjectives and C_QuestLog.GetQuestObjectives(id)
        if objectives and #objectives > 0 then
          q.objectives = {}
          for _, o in ipairs(objectives) do
            q.objectives[#q.objectives + 1] = (o.finished and "[x] " or "[ ] ") .. clean(o.text or "")
          end
        end
        if GetQuestLogQuestText then
          local _, objectiveText = GetQuestLogQuestText(i)
          if objectiveText and objectiveText ~= "" then q.goal = clean(objectiveText) end
        end
        if C_QuestLog.GetNextWaypointText then
          local wp = C_QuestLog.GetNextWaypointText(id)
          if wp and wp ~= "" then q.nextStep = clean(wp) end
        end
        if C_QuestLog.GetDistanceSqToQuest then
          local distSq, onContinent = C_QuestLog.GetDistanceSqToQuest(id)
          if distSq and onContinent then q.distanceYards = floor(sqrt(distSq)) end
        end
        safe(questLocation, q, id, onMap)
        safe(questRewards, q, id, i)
        if ns.QuestHelp then q.next = safe(ns.QuestHelp.Next, ns.QuestHelp, id) end
        list[#list + 1] = q
      end
    end
  end
  return list
end

local function questsClassic()
  local list = {}
  local header
  local selected = GetQuestLogSelection and GetQuestLogSelection()
  for i = 1, GetNumQuestLogEntries() do
    local title, level, suggestedGroup, isHeader, _, isComplete, _, questID = GetQuestLogTitle(i)
    if isHeader then
      header = title
    elseif title then
      local q = { title = title, level = level, id = questID, zone = header }
      if type(suggestedGroup) == "number" and suggestedGroup > 1 then q.group = suggestedGroup end
      if isComplete == 1 or isComplete == true then q.complete = true end
      if isComplete == -1 then q.failed = true end
      local n = GetNumQuestLeaderBoards and GetNumQuestLeaderBoards(i) or 0
      if n > 0 then
        q.objectives = {}
        for j = 1, n do
          local text, _, finished = GetQuestLogLeaderBoard(j, i)
          q.objectives[#q.objectives + 1] = (finished and "[x] " or "[ ] ") .. clean(text or "")
        end
      end
      if SelectQuestLogEntry and GetQuestLogQuestText then
        SelectQuestLogEntry(i)
        local _, objectiveText = GetQuestLogQuestText()
        if objectiveText and objectiveText ~= "" then q.goal = clean(objectiveText) end
        if questID then safe(questRewards, q, questID, i) end
      end
      if questID and ns.QuestHelp then q.next = safe(ns.QuestHelp.Next, ns.QuestHelp, questID) end
      list[#list + 1] = q
    end
  end
  if selected and SelectQuestLogEntry then SelectQuestLogEntry(selected) end
  return list
end

local function quests()
  if C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo then
    return questsModern()
  elseif GetNumQuestLogEntries and GetQuestLogTitle then
    return questsClassic()
  end
  return nil
end

-- Dungeons and raids with an active lockout.
local raidInfoRequested = false
local function lockouts()
  if not (GetNumSavedInstances and GetSavedInstanceInfo) then return nil end
  if not raidInfoRequested and RequestRaidInfo then raidInfoRequested = true; pcall(RequestRaidInfo) end
  local list = {}
  for i = 1, GetNumSavedInstances() do
    local name, _, reset, _, locked, extended, _, isRaid, maxPlayers, difficultyName = GetSavedInstanceInfo(i)
    if name and (locked or extended) then
      list[#list + 1] = { name = name, raid = isRaid or nil, players = num(maxPlayers), difficulty = difficultyName,
        resetHours = num(reset) and round(reset / 3600, 1) or nil }
    end
  end
  return #list > 0 and list or nil
end

-- Weapon, armor, riding and language skills (when the client lists them;
-- professions have their own section).
local function skills()
  if not GetProfessions then return nil end -- otherwise "professions" already lists them
  return skillLines()
end

-- Others ----------------------------------------------------------------------

local HAPPINESS = { "unhappy", "content", "happy" }

-- WoW Forever moved the hunter pet functions to C_PetInfo; older clients
-- have them as globals.
local function petApi(name)
  return (C_PetInfo and C_PetInfo[name]) or _G[name]
end

-- The pet's action bar: its stance (aggressive / defensive / passive...) and
-- which abilities cast themselves.
local function petBar()
  local mode, autocast = nil, {}
  if not GetPetActionInfo then return mode, autocast end
  for i = 1, NUM_PET_ACTION_SLOTS or 10 do
    local name, _, isToken, isActive, autoAllowed, autoEnabled = GetPetActionInfo(i)
    if type(name) == "string" and not secret(name) then
      if isToken and name:find("^PET_MODE_") then
        if isActive then mode = _G[name] or name:gsub("^PET_MODE_", ""):lower() end
      elseif not isToken and autoAllowed then
        autocast[name] = autoEnabled and true or false
      end
    end
  end
  return mode, autocast
end

-- The abilities the pet knows (its spellbook), with rank and autocast.
local function petAbilities(autocast)
  local list = {}
  local function add(name, sub, auto, passive)
    if type(name) ~= "string" or name == "" then return end
    local s = (type(sub) == "string" and sub ~= "") and (name .. " (" .. sub .. ")") or name
    if passive then
      s = s .. " [passive]"
    else
      if auto == nil then auto = autocast[name] end
      if auto ~= nil then s = s .. (auto and " [autocast on]" or " [autocast off]") end
    end
    list[#list + 1] = s
  end
  local SB = C_SpellBook
  local bank = Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Pet
  if SB and SB.HasPetSpells and SB.GetSpellBookItemInfo and bank then
    local SPELL = Enum.SpellBookItemType and Enum.SpellBookItemType.Spell
    for i = 1, num(SB.HasPetSpells()) or 0 do
      local info = SB.GetSpellBookItemInfo(i, bank)
      -- Skip the pet's commands (Attack, Follow, stances): only abilities.
      if info and info.name and (not SPELL or info.itemType == SPELL) then
        local auto
        if SB.GetSpellBookItemAutoCast then
          local allowed, enabled = SB.GetSpellBookItemAutoCast(i, bank)
          if allowed then auto = enabled and true or false end
        end
        add(info.name, info.subName, auto, info.isPassive)
      end
    end
  elseif HasPetSpells and GetSpellBookItemName then
    local book = BOOKTYPE_PET or "pet"
    for i = 1, num(HasPetSpells()) or 0 do
      local name, sub = GetSpellBookItemName(i, book)
      local auto
      if GetSpellAutocast then
        local allowed, enabled = GetSpellAutocast(i, book)
        if allowed then auto = enabled and true or false end
      end
      add(name, sub, auto, IsPassiveSpell and IsPassiveSpell(i, book))
    end
  end
  return #list > 0 and list or nil
end

local function pet()
  if not UnitExists("pet") then return nil end
  local p = {}
  put(p, "name", function() return UnitName("pet") end)
  put(p, "level", function() return UnitLevel("pet") end)
  put(p, "family", function() return UnitCreatureFamily("pet") end)
  put(p, "healthPct", function() return pct(UnitHealth("pet"), UnitHealthMax("pet")) end)
  put(p, "xpPct", function() local cur, max = GetPetExperience(); return pct(cur, max) end)
  local happiness = petApi("GetPetHappiness")
  put(p, "happiness", function() local h = happiness(); return h and (HAPPINESS[h] or h) end)
  put(p, "damagePct", function() return num(select(2, happiness())) end)
  put(p, "loyaltyRate", function() return num(select(3, happiness())) end)
  put(p, "loyalty", function()
    local l = petApi("GetPetLoyalty")()
    return type(l) == "string" and clean(l) or num(l)
  end)
  put(p, "trainingPoints", function()
    local total, spent = petApi("GetPetTrainingPoints")()
    total, spent = num(total), num(spent) or 0
    if total then return { available = total - spent, spent = spent } end
  end)
  put(p, "diet", function()
    local r = { petApi("GetPetFoodTypes")() }
    local foods = type(r[1]) == "table" and r[1] or r
    local list = {}
    for _, f in ipairs(foods) do if type(f) == "string" then list[#list + 1] = f end end
    return #list > 0 and list or nil
  end)
  local ok, mode, autocast = pcall(petBar)
  if not ok then mode, autocast = nil, {} end
  p.mode = mode
  put(p, "abilities", function() return petAbilities(autocast) end)
  put(p, "stats", petStats)
  return p
end

local function group()
  local n = GetNumGroupMembers and GetNumGroupMembers() or 0
  if n == 0 then return { size = 1 } end
  local g = { size = n, raid = IsInRaid() or nil }
  if not IsInRaid() then
    g.members = {}
    for i = 1, n - 1 do
      local unit = "party" .. i
      if UnitExists(unit) then
        local className = UnitClass(unit)
        local role = UnitGroupRolesAssigned and UnitGroupRolesAssigned(unit) or nil
        local m = { level = UnitLevel(unit), class = className, role = role }
        put(m, "healthPct", function() return pct(UnitHealth(unit), UnitHealthMax(unit)) end)
        g.members[#g.members + 1] = m
      end
    end
  end
  return g
end

local function target()
  if not UnitExists("target") then return nil end
  local t = {}
  put(t, "name", function() return UnitName("target") end)
  put(t, "level", function() return UnitLevel("target") end)
  put(t, "classification", function() return UnitClassification("target") end)
  put(t, "creatureType", function() return UnitCreatureType("target") end)
  put(t, "healthPct", function() return pct(UnitHealth("target"), UnitHealthMax("target")) end)
  put(t, "hostile", function() return UnitIsEnemy("player", "target") or nil end)
  put(t, "canAttack", function() return UnitCanAttack("player", "target") or nil end)
  put(t, "isPlayer", function() return UnitIsPlayer("target") or nil end)
  put(t, "dead", function() return UnitIsDead("target") or nil end)
  if t.isPlayer then
    put(t, "class", function() return (UnitClass("target")) end)
    put(t, "race", function() return (UnitRace("target")) end)
  else
    -- NPC id, to look the creature up; family: a beast a hunter could tame.
    put(t, "npcId", function()
      local kind, id = UnitGUID("target"):match("^(%a+)%-[^-]+%-[^-]+%-[^-]+%-[^-]+%-(%d+)%-")
      return (kind == "Creature" or kind == "Vehicle") and tonumber(id) or nil
    end)
    put(t, "family", function() return UnitCreatureFamily("target") end)
    put(t, "questRelated", function() return C_QuestLog.UnitIsRelatedToActiveQuest("target") or nil end)
  end
  put(t, "reaction", function()
    local r = num(UnitReaction("target", "player"))
    return r and ((r <= 3 and "hostile") or (r == 4 and "neutral") or "friendly") or nil
  end)
  -- The lines of its tooltip under the name (title, quest progress, "Skinnable"...).
  put(t, "tooltip", function()
    local data = C_TooltipInfo.GetUnit("target")
    local lines = {}
    for i, line in ipairs(data and data.lines or {}) do
      local s = line.leftText
      if i > 1 and type(s) == "string" and not secret(s) then
        s = clean(s)
        if s ~= "" then lines[#lines + 1] = s:sub(1, 120) end
      end
      if #lines >= 6 then break end
    end
    return #lines > 0 and lines or nil
  end)
  return t
end

local function client()
  local version, build, _, interface = GetBuildInfo()
  return { version = version, build = build, interface = interface, locale = GetLocale() }
end


-- Windows open on screen ---------------------------------------------------------
-- What the player is looking at while asking: a quest being offered or turned
-- in, an NPC's dialogue, a vendor, a trainer, the loot window. Only sent while
-- that window is open, so it costs nothing the rest of the time.

local open = {} -- window -> true, from the game's open/close events
local OPEN_EVENTS = {
  MERCHANT_SHOW = { "merchant", true }, MERCHANT_CLOSED = { "merchant", false },
  TRAINER_SHOW = { "trainer", true }, TRAINER_CLOSED = { "trainer", false },
  GOSSIP_SHOW = { "gossip", true }, GOSSIP_CLOSED = { "gossip", false },
  LOOT_OPENED = { "loot", true }, LOOT_CLOSED = { "loot", false },
  QUEST_GREETING = { "quest", "greeting" }, QUEST_DETAIL = { "quest", "detail" },
  QUEST_PROGRESS = { "quest", "progress" }, QUEST_COMPLETE = { "quest", "complete" },
  QUEST_FINISHED = { "quest", false },
  TAXIMAP_OPENED = { "taxi", true }, TAXIMAP_CLOSED = { "taxi", false },
  AUCTION_HOUSE_SHOW = { "auction", true }, AUCTION_HOUSE_CLOSED = { "auction", false },
}
Collect.open = open
local openWatcher = CreateFrame and CreateFrame("Frame")
if openWatcher then
  for e in pairs(OPEN_EVENTS) do pcall(openWatcher.RegisterEvent, openWatcher, e) end
  openWatcher:SetScript("OnEvent", function(_, event)
    local w = OPEN_EVENTS[event]
    if w then open[w[1]] = w[2] or nil end
  end)
end

-- The window may have been closed without its event (e.g. a /reload).
local function shown(frameName)
  local f = _G[frameName]
  return not f or not f.IsShown or f:IsShown()
end

local MAX_TEXT = 700
local function text(s)
  s = clean(s)
  if type(s) ~= "string" or s == "" then return nil end
  return #s > MAX_TEXT and (s:sub(1, MAX_TEXT) .. "...") or s
end

-- Rewards shown in the quest window ("reward" items, "choice" items to pick one).
local function questWindowRewards()
  local r = {}
  put(r, "xp", function() local xp = num(GetRewardXP()); return xp and xp > 0 and xp or nil end)
  put(r, "money", function() local m = num(GetRewardMoney()); return m and m > 0 and money(m) or nil end)
  local function items(kind, count)
    local list = {}
    for i = 1, math.min(num(count) or 0, 10) do
      local link = GetQuestItemLink(kind, i)
      local _, _, n = GetQuestItemInfo(kind, i)
      local item = link and safe(fullItem, link) or { name = (GetQuestItemInfo(kind, i)) }
      if n and n > 1 then item.count = n end
      list[#list + 1] = item
    end
    return #list > 0 and list or nil
  end
  put(r, "items", function() return items("reward", GetNumQuestRewards()) end)
  put(r, "choices", function() return items("choice", GetNumQuestChoices()) end)
  return next(r) and r or nil
end

local function questWindow()
  local state = open.quest
  if not state or not shown("QuestFrame") then return nil end
  local q = { npc = safe(UnitName, "npc") }
  if state == "greeting" then
    local available, active = {}, {}
    for i = 1, num(GetNumAvailableQuests and GetNumAvailableQuests()) or 0 do available[#available + 1] = GetAvailableTitle(i) end
    for i = 1, num(GetNumActiveQuests and GetNumActiveQuests()) or 0 do active[#active + 1] = GetActiveTitle(i) end
    q.availableQuests = #available > 0 and available or nil
    q.activeQuests = #active > 0 and active or nil
    return { questGreeting = q }
  end
  put(q, "title", function() return clean(GetTitleText()) end)
  put(q, "questId", function() local id = num(GetQuestID()); return id and id > 0 and id or nil end)
  if state == "detail" then
    put(q, "text", function() return text(GetQuestText()) end)
    put(q, "objectives", function() return text(GetObjectiveText()) end)
    q.rewards = questWindowRewards()
    return { questOffer = q }
  elseif state == "progress" then
    put(q, "text", function() return text(GetProgressText()) end)
    put(q, "canComplete", function() return IsQuestCompletable() and true or false end)
    local needed = {}
    for i = 1, num(GetNumQuestItems and GetNumQuestItems()) or 0 do
      local name, _, count = GetQuestItemInfo("required", i)
      if name then needed[#needed + 1] = { name = name, count = count } end
    end
    q.requiredItems = #needed > 0 and needed or nil
    return { questProgress = q }
  elseif state == "complete" then
    put(q, "text", function() return text(GetRewardText()) end)
    q.rewards = questWindowRewards()
    return { questReward = q }
  end
end

local function gossipWindow()
  if not open.gossip or not shown("GossipFrame") or not C_GossipInfo then return nil end
  local g = { npc = safe(UnitName, "npc") }
  put(g, "text", function() return text(C_GossipInfo.GetText()) end)
  put(g, "options", function()
    local list = {}
    for _, o in ipairs(C_GossipInfo.GetOptions() or {}) do list[#list + 1] = clean(o.name) end
    return #list > 0 and list or nil
  end)
  put(g, "availableQuests", function()
    local list = {}
    for _, q in ipairs(C_GossipInfo.GetAvailableQuests() or {}) do
      list[#list + 1] = { title = q.title, level = q.questLevel, trivial = q.isTrivial or nil }
    end
    return #list > 0 and list or nil
  end)
  put(g, "activeQuests", function()
    local list = {}
    for _, q in ipairs(C_GossipInfo.GetActiveQuests() or {}) do
      list[#list + 1] = { title = q.title, complete = q.isComplete or nil }
    end
    return #list > 0 and list or nil
  end)
  return g
end

local MAX_MERCHANT = 60
local function merchantWindow()
  if not open.merchant or not shown("MerchantFrame") then return nil end
  local m = { npc = safe(UnitName, "npc"), items = {} }
  for i = 1, math.min(num(GetMerchantNumItems()) or 0, MAX_MERCHANT) do
    local name, price, stack, available, usable, extended
    if C_MerchantFrame and C_MerchantFrame.GetItemInfo then
      local info = C_MerchantFrame.GetItemInfo(i)
      if info then
        name, price, stack, available, usable, extended =
          info.name, info.price, info.stackCount, info.numAvailable, info.isUsable, info.hasExtendedCost
      end
    else
      local _
      name, _, price, stack, available, _, usable, extended = GetMerchantItemInfo(i)
    end
    local link = GetMerchantItemLink(i)
    local item = link and safe(fullItem, link) or { name = name }
    if name or item.name then
      item.price = (num(price) and price > 0) and money(price) or nil
      if extended then item.otherCost = true end
      if num(stack) and stack > 1 then item.stack = stack end
      if num(available) and available >= 0 then item.limited = available end
      if usable == false then item.usable = false end
      m.items[#m.items + 1] = item
    end
  end
  put(m, "canRepair", function() return CanMerchantRepair() and true or nil end)
  if m.canRepair then
    put(m, "repairAllCost", function() local c = num(GetRepairAllCost()); return c and c > 0 and money(c) or nil end)
  end
  return m
end

local MAX_TRAINER = 80

local function lootWindow()
  if not open.loot or not GetNumLootItems then return nil end
  local list = {}
  for i = 1, math.min(num(GetNumLootItems()) or 0, 20) do
    local link = GetLootSlotLink(i)
    local _, name, count = GetLootSlotInfo(i)
    local item = link and safe(fullItem, link) or { name = name }
    if num(count) and count > 1 then item.count = count end
    if item.name then list[#list + 1] = item end
  end
  return #list > 0 and list or nil
end

-- Flight points -------------------------------------------------------------------
-- Enum.FlightPathState: Current = 0, Reachable = 1, Unreachable = 2. On a
-- flight master's map the game lists the player's faction's and neutral flight
-- points of the continent: Unreachable ones aren't discovered yet (the map
-- hides them). The older API calls those "DISTANT".
local function flightStates()
  local S = Enum and Enum.FlightPathState or {}
  return S.Current or 0, S.Reachable or 1
end

local FLIGHT_CONTINENTS = { 1414, 1415 } -- Kalimdor, Eastern Kingdoms (uiMapID)

-- Flight points the game keeps but no longer uses ("zzOLDPowderfuse Port").
local function retiredFlight(name) return name:sub(1, 2):lower() == "zz" end

-- The continent a map is on: its uiMapID and name, or nil.
function Collect.ContinentOf(mapID)
  if not (C_Map and C_Map.GetMapInfo) then return nil end
  local continent = Enum and Enum.UIMapType and Enum.UIMapType.Continent or 2
  for _ = 1, 8 do
    local info = type(mapID) == "number" and safe(C_Map.GetMapInfo, mapID)
    if type(info) ~= "table" then return nil end
    if info.mapType == continent then return mapID, info.name end
    mapID = info.parentMapID
  end
end

-- Every flight point of a continent, without a flight master
-- (C_TaxiMap.GetTaxiNodesForMap): nodeID -> node and name -> node, with
-- "faction" (0 neutral, 1 Horde, 2 Alliance) and the name in the client's
-- language. It doesn't say which ones the player knows.
local function taxiNodes(continent)
  local byId, byName = {}, {}
  if C_TaxiMap and C_TaxiMap.GetTaxiNodesForMap and type(continent) == "number" and continent > 0 then
    for _, n in ipairs(safe(C_TaxiMap.GetTaxiNodesForMap, continent) or {}) do
      if type(n) == "table" and type(n.name) == "string" and not secret(n.name) then
        if num(n.nodeID) then byId[n.nodeID] = n end
        byName[n.name] = n
      end
    end
  end
  return byId, byName
end

-- The open flight master's map: which continent, the flight points the player
-- can fly to ("known") and the ones it lists but they haven't discovered
-- ("notKnown"), as { id = nodeID, name = name }. Core:RememberFlightPaths
-- keeps it per continent. nil when no flight map is open.
function Collect.FlightMapStatus()
  local known, notKnown = {}, {}
  local zone = C_Map and C_Map.GetBestMapForUnit and safe(C_Map.GetBestMapForUnit, "player")
  local taxiMap = GetTaxiMapID and safe(GetTaxiMapID)
  if C_TaxiMap and C_TaxiMap.GetAllTaxiNodes then
    local current, reachable = flightStates()
    for _, node in ipairs(safe(C_TaxiMap.GetAllTaxiNodes, taxiMap or zone) or {}) do
      if type(node) == "table" and type(node.name) == "string" and not secret(node.name) and not retiredFlight(node.name) then
        local e = { id = num(node.nodeID), name = node.name }
        if node.state == current or node.state == reachable then known[#known + 1] = e
        else notKnown[#notKnown + 1] = e end
      end
    end
  elseif NumTaxiNodes and TaxiNodeName and TaxiNodeGetType then
    for i = 1, num(safe(NumTaxiNodes)) or 0 do
      local kind, name = TaxiNodeGetType(i), TaxiNodeName(i)
      if type(name) == "string" and not secret(name) and not retiredFlight(name) then
        if kind == "CURRENT" or kind == "REACHABLE" then known[#known + 1] = { name = name }
        elseif kind == "DISTANT" then notKnown[#notKnown + 1] = { name = name } end
      end
    end
  end
  if #known == 0 then return nil end
  local continent, name = Collect.ContinentOf(zone)
  if not continent then continent, name = Collect.ContinentOf(taxiMap) end
  if not continent and known[1].id then
    -- Not on the map's continent chain: the continent that lists this flight point.
    for _, id in ipairs(FLIGHT_CONTINENTS) do
      if taxiNodes(id)[known[1].id] then continent = id; break end
    end
  end
  return { continent = continent or 0, name = name, known = known, notKnown = notKnown }
end

-- What the AI gets: per continent, the flight points the player can fly to and
-- those of their faction (or neutral) they can't fly to yet, from the last
-- flight master's map seen there, with today's names. A continent with no flight
-- map seen yet is "notChecked", with what the older list (names only, kept
-- before 1.16.7) had there.
local function flightPaths(data)
  local records = type(data.flights) == "table" and data.flights or {}
  local faction = UnitFactionGroup and safe(UnitFactionGroup, "player")
  local other = (faction == "Alliance" and 1) or (faction == "Horde" and 2) or nil
  local order, listed = {}, {}
  for _, id in ipairs(FLIGHT_CONTINENTS) do order[#order + 1] = id; listed[id] = true end
  local extra = {}
  for id in pairs(records) do if not listed[id] then extra[#extra + 1] = id end end
  table.sort(extra, function(a, b) return tostring(a) < tostring(b) end)
  for _, id in ipairs(extra) do order[#order + 1] = id end
  local out = {}
  for _, id in ipairs(order) do
    local byId, byName = taxiNodes(id)
    local rec = records[id]
    local info = type(id) == "number" and id > 0 and C_Map and C_Map.GetMapInfo and safe(C_Map.GetMapInfo, id)
    local entry = { continent = (type(info) == "table" and info.name) or (rec and rec.name) or "?" }
    local function names(list, skipOther)
      local res, seen = {}, {}
      for _, e in ipairs(type(list) == "table" and list or {}) do
        local n = e.id and byId[e.id]
        local name = (n and n.name) or e.name
        if type(name) == "string" and not seen[name] and not retiredFlight(name)
          and not (skipOther and n and other and n.faction == other) then
          seen[name] = true
          res[#res + 1] = name
        end
      end
      table.sort(res)
      return #res > 0 and res or nil
    end
    if type(rec) == "table" then
      entry.seenAt, entry.known, entry.notKnown = rec.seenAt, names(rec.known), names(rec.notKnown, true)
      out[#out + 1] = entry
    elseif next(byName) then
      entry.notChecked = true
      local old = {}
      for name in pairs(type(data.flightPaths) == "table" and data.flightPaths or {}) do
        if byName[name] then old[#old + 1] = { name = name } end
      end
      entry.known = names(old)
      out[#out + 1] = entry
    end
  end
  return #out > 0 and out or nil
end

-- The flight master's map: where the player can fly from here and for how much.
local MAX_FLIGHTS = 60
local function flightMapWindow()
  if not open.taxi then return nil end
  local f = { destinations = {} }
  local function add(name, slot)
    if #f.destinations >= MAX_FLIGHTS or type(name) ~= "string" then return end
    local d = { name = name }
    put(d, "cost", function() local c = num(TaxiNodeCost(slot)); return c and c > 0 and money(c) or nil end)
    put(d, "stops", function() local n = num(GetNumRoutes(slot)); return n and n > 1 and n or nil end)
    f.destinations[#f.destinations + 1] = d
  end
  if C_TaxiMap and C_TaxiMap.GetAllTaxiNodes then
    local current, reachable = flightStates()
    local mapID = (GetTaxiMapID and GetTaxiMapID()) or (C_Map and C_Map.GetBestMapForUnit("player"))
    for _, node in ipairs(C_TaxiMap.GetAllTaxiNodes(mapID) or {}) do
      if node.state == current then
        f.from = node.name
      elseif node.state == reachable then
        add(node.name, node.slotIndex)
      end
    end
  elseif NumTaxiNodes and TaxiNodeName then
    for i = 1, num(NumTaxiNodes()) or 0 do
      local kind = TaxiNodeGetType(i)
      if kind == "CURRENT" then f.from = TaxiNodeName(i)
      elseif kind == "REACHABLE" then add(TaxiNodeName(i), i) end
    end
  end
  if #f.destinations == 0 then f.destinations = nil end
  return (f.from or f.destinations) and f or nil
end

-- Auction house ---------------------------------------------------------------------
-- Only readable while it is open: what the player is browsing or searched, and
-- their own auctions. Prices seen are also remembered (Core:RememberPrices).
-- Both the modern (C_AuctionHouse) and the classic window are supported.

local MAX_AUCTIONS = 30
local AH = C_AuctionHouse

-- The item searched last (modern window), from the game's events.
local lastSearch
local searchWatcher = CreateFrame and CreateFrame("Frame")
if searchWatcher then
  pcall(searchWatcher.RegisterEvent, searchWatcher, "COMMODITY_SEARCH_RESULTS_UPDATED")
  pcall(searchWatcher.RegisterEvent, searchWatcher, "ITEM_SEARCH_RESULTS_UPDATED")
  searchWatcher:SetScript("OnEvent", function(_, event, arg)
    if event == "COMMODITY_SEARCH_RESULTS_UPDATED" then lastSearch = { itemID = arg }
    elseif type(arg) == "table" then lastSearch = { itemKey = arg } end
  end)
end

local function keyName(itemKey)
  local info = AH.GetItemKeyInfo and safe(AH.GetItemKeyInfo, itemKey)
  return (info and info.itemName) or (itemKey.itemID and GetItemInfo(itemKey.itemID))
end

-- Prices on screen as { itemId, name, unit (copper per item), quantity }.
local function modernBrowse()
  local list = {}
  for _, r in ipairs(AH.GetBrowseResults() or {}) do
    local key = r.itemKey
    local name = key and keyName(key)
    if name and num(r.minPrice) then
      list[#list + 1] = { itemId = key.itemID, name = name, unit = r.minPrice, quantity = num(r.totalQuantity) }
      if #list >= MAX_AUCTIONS then break end
    end
  end
  return list
end

-- The cheapest offers for the item searched last (modern window).
local function modernSearch()
  if not lastSearch then return nil end
  local offers, itemID, name = {}, nil, nil
  if lastSearch.itemID and AH.GetNumCommoditySearchResults then
    itemID = lastSearch.itemID
    name = GetItemInfo(itemID) or ("item " .. tostring(itemID))
    for i = 1, math.min(num(AH.GetNumCommoditySearchResults(itemID)) or 0, 5) do
      local r = AH.GetCommoditySearchResultInfo(itemID, i)
      if r and num(r.unitPrice) then offers[#offers + 1] = { unit = r.unitPrice, quantity = num(r.quantity) } end
    end
  elseif lastSearch.itemKey and AH.GetNumItemSearchResults then
    local key = lastSearch.itemKey
    itemID, name = key.itemID, keyName(key)
    for i = 1, math.min(num(AH.GetNumItemSearchResults(key)) or 0, 5) do
      local r = AH.GetItemSearchResultInfo(key, i)
      local qty = r and (num(r.quantity) or 1)
      if r and num(r.buyoutAmount) then offers[#offers + 1] = { unit = floor(r.buyoutAmount / qty), quantity = qty } end
    end
  end
  if not name or #offers == 0 then return nil end
  return { itemId = itemID, name = name, offers = offers }
end

-- Classic window: the page of results on screen.
local function classicList(kind)
  local list = {}
  for i = 1, math.min(num(GetNumAuctionItems(kind)) or 0, kind == "list" and 50 or MAX_AUCTIONS) do
    local r = { GetAuctionItemInfo(kind, i) }
    -- name, texture, count, quality, canUse, level, levelColHeader, minBid,
    -- minIncrement, buyoutPrice, bidAmount, highBidder, bidderFullName,
    -- owner, ownerFullName, saleStatus, itemId
    local name, count, minBid, buyout, saleStatus, itemId = r[1], num(r[3]) or 1, num(r[8]), num(r[10]), r[16], num(r[17])
    if name then
      list[#list + 1] = { itemId = itemId, name = name, quantity = count,
        unit = buyout and buyout > 0 and floor(buyout / math.max(count, 1)) or nil,
        bid = minBid and minBid > 0 and minBid or nil, sold = saleStatus == 1 or nil }
    end
  end
  return list
end

-- Every price on screen, for the price memory: { itemId, name, unit }.
function Collect:AuctionPrices()
  local list = {}
  if AH and AH.GetBrowseResults then
    for _, r in ipairs(safe(modernBrowse) or {}) do list[#list + 1] = r end
    local search = safe(modernSearch)
    if search then list[#list + 1] = { itemId = search.itemId, name = search.name, unit = search.offers[1].unit } end
  elseif GetNumAuctionItems then
    -- Keep the cheapest of each item on the page.
    local best = {}
    for _, r in ipairs(safe(classicList, "list") or {}) do
      if r.unit and r.itemId and (not best[r.itemId] or r.unit < best[r.itemId].unit) then best[r.itemId] = r end
    end
    for _, r in pairs(best) do list[#list + 1] = r end
  end
  return list
end

local function priced(entries)
  local out = {}
  for _, e in ipairs(entries or {}) do
    local c = { name = e.name, itemId = e.itemId, quantity = e.quantity, sold = e.sold }
    if e.unit then c.price = money(floor(e.unit)) end
    if e.bid then c.bid = money(e.bid) end
    out[#out + 1] = c
    if #out >= MAX_AUCTIONS then break end
  end
  return #out > 0 and out or nil
end

local function auctionWindow()
  if not open.auction then return nil end
  local a = {}
  if AH and AH.GetBrowseResults then
    put(a, "results", function() return priced(modernBrowse()) end)
    put(a, "search", function()
      local s = modernSearch()
      if not s then return nil end
      local offers = {}
      for _, o in ipairs(s.offers) do offers[#offers + 1] = money(floor(o.unit)) .. " x" .. tostring(o.quantity or 1) end
      return { name = s.name, itemId = s.itemId, cheapest = offers }
    end)
    put(a, "myAuctions", function()
      local list = {}
      for i = 1, math.min(num(AH.GetNumOwnedAuctions()) or 0, MAX_AUCTIONS) do
        local o = AH.GetOwnedAuctionInfo(i)
        if o and o.itemKey then
          local qty = num(o.quantity) or 1
          list[#list + 1] = { name = keyName(o.itemKey), itemId = o.itemKey.itemID, quantity = qty,
            unit = num(o.buyoutAmount) and floor(o.buyoutAmount / qty) or nil, sold = o.status == 1 or nil }
        end
      end
      return priced(list)
    end)
  elseif GetNumAuctionItems then
    put(a, "results", function() return priced(classicList("list")) end)
    put(a, "myAuctions", function() return priced(classicList("owner")) end)
  end
  return a
end

-- What Beast Training teaches, read while its window is open (the game lists
-- it nowhere else) and remembered (Core:RememberBeastTraining).
-- WoW Forever shows it as a trainer window with no NPC; older clients as a
-- "craft" window.
local BEAST_STATUS = { used = "known", available = "available", unavailable = "unavailable" }
local MAX_BEAST = 80

local function isBeastTrainer()
  if not open.trainer then return false end
  if UnitExists and UnitExists("npc") then return false end
  return select(2, UnitClass("player")) == "HUNTER"
end

-- Lists the trainer's services. `pet`: also the ones already known.
-- Categories the window shows collapsed are expanded first, or their
-- services would not be listed.
local function trainerServices(pet)
  local services, lines = {}, {}
  local function read()
    services, lines = {}, {}
    for i = 1, num(GetNumTrainerServices()) or 0 do
      local name, sub, status, expanded = GetTrainerServiceInfo(i)
      lines[#lines + 1] = tostring(status)
      if status == "header" then
        if expanded == false then lines.collapsed = true end
      elseif name and (status == "available" or status == "unavailable" or (pet and status == "used")) then
        local s = { name = name, rank = (type(sub) == "string" and sub ~= "" and sub) or nil,
          status = pet and BEAST_STATUS[status] or status }
        put(s, "cost", function()
          local copper, points = GetTrainerServiceCost(i)
          copper = num(copper)
          -- Beast Training costs training points, not money.
          if pet and num(points) and points > 0 then s.trainingPoints = points end
          return copper and copper > 0 and money(copper) or nil
        end)
        put(s, "level", function() local l = num(GetTrainerServiceLevelReq(i)); return l and l > 1 and l or nil end)
        put(s, "needsSkill", function()
          local skill, rank, has = GetTrainerServiceSkillReq(i)
          return (skill and not has) and (skill .. " " .. tostring(rank)) or nil
        end)
        services[#services + 1] = s
        if #services >= (pet and MAX_BEAST or MAX_TRAINER) then break end
      end
    end
  end
  read()
  if #services == 0 and lines.collapsed and ExpandTrainerSkillLine then
    pcall(ExpandTrainerSkillLine, 0)
    read()
  end
  -- Nothing readable: say why in the log (diagnostics), not to the AI.
  if #services == 0 and errors then
    errors.trainer = string.format("%d lines: %s", #lines, table.concat(lines, ","):sub(1, 100))
  end
  return services
end

-- Classic "craft" style Beast Training window.
local function beastCraft()
  if not (GetCraftName and GetNumCrafts and GetCraftInfo) then return nil end
  if GetCraftDisplaySkillLine and GetCraftDisplaySkillLine() then return nil end -- enchanting
  local list = {}
  for i = 1, num(GetNumCrafts()) or 0 do
    local name, rank, kind, _, _, points, level = GetCraftInfo(i)
    if name and kind ~= "header" then
      list[#list + 1] = { name = name, rank = (type(rank) == "string" and rank ~= "" and rank) or nil,
        status = BEAST_STATUS[kind] or kind, trainingPoints = num(points), level = num(level) }
      if #list >= MAX_BEAST then break end
    end
  end
  return #list > 0 and list or nil
end

-- { abilities, trainingPoints, pet } for the open Beast Training window, or nil.
function Collect:BeastTraining(kind)
  local abilities
  if kind == "craft" then
    abilities = safe(beastCraft)
  elseif safe(isBeastTrainer) then
    abilities = safe(trainerServices, true)
  end
  if not abilities or #abilities == 0 then return nil end
  local out = { abilities = abilities, pet = safe(UnitName, "pet") }
  put(out, "petTrainingPoints", function()
    local total, spent = petApi("GetPetTrainingPoints")()
    total, spent = num(total), num(spent) or 0
    if total then return total - spent end
  end)
  return out
end

-- The hunter's pets in the stable, read while the stable is open.
function Collect:StablePets()
  local list = {}
  local last = num(C_StableInfo and C_StableInfo.GetNumStableSlots and safe(C_StableInfo.GetNumStableSlots)) or 4
  for i = 0, math.min(last, 10) do
    local name, level, family, loyalty
    if C_StableInfo and C_StableInfo.GetStablePetInfo then
      local info = safe(C_StableInfo.GetStablePetInfo, i)
      if type(info) == "table" then name, level, family = info.name, info.level, info.familyName or info.type end
    end
    if not name and GetStablePetInfo then
      local r = { pcall(GetStablePetInfo, i) } -- ok, icon, name, level, family, loyalty
      if r[1] then name, level, family, loyalty = r[3], r[4], r[5], r[6] end
    end
    if type(name) == "string" and name ~= "" then
      list[#list + 1] = { name = name, level = num(level), family = family,
        loyalty = type(loyalty) == "string" and clean(loyalty) or nil, active = (i == 0) or nil }
    end
  end
  return #list > 0 and list or nil
end

-- The game window the player has open that questions can be about, for the
-- chat's suggestions: "auction", "merchant", "beastTraining", "trainer",
-- "questReward", "questOffer", "taxi", "loot" or nil.
function Collect:OpenWindow()
  if open.auction then return "auction" end
  if open.merchant and shown("MerchantFrame") then return "merchant" end
  if open.trainer then return safe(isBeastTrainer) and "beastTraining" or "trainer" end
  if open.quest == "complete" and shown("QuestFrame") then return "questReward" end
  if open.quest == "detail" and shown("QuestFrame") then return "questOffer" end
  if open.taxi then return "taxi" end
  if open.loot then return "loot" end
  return nil
end

-- The open trainer: a class or profession trainer, or Beast Training.
local function trainerWindow()
  if not open.trainer or not GetNumTrainerServices then return nil end
  local pet = safe(isBeastTrainer)
  local t = { npc = safe(UnitName, "npc"), services = trainerServices(pet) }
  if pet then t.beastTraining = true end
  return t
end

local function screen()
  local s = {}
  local quest = safe(questWindow)
  if quest then for k, v in pairs(quest) do s[k] = v end end
  s.gossip = safe(gossipWindow)
  s.merchant = safe(merchantWindow)
  s.trainer = safe(trainerWindow)
  s.loot = safe(lootWindow)
  s.flightMap = safe(flightMapWindow)
  s.auction = safe(auctionWindow)
  return next(s) and s or nil
end

-- Recipes ------------------------------------------------------------------------
-- The game only lists a profession's recipes while its window is open, so they
-- are read then and remembered (Core:RememberRecipes), like the bank.

-- Chance to skill up, from the color the game shows.
local DIFFICULTY = { optimal = "orange", medium = "yellow", easy = "green", trivial = "grey" }
local MAX_RECIPES = 250
Collect.DIFFICULTY = DIFFICULTY

local function reagentText(parts)
  return #parts > 0 and table.concat(parts, ", ") or nil
end

-- Classic-style window (GetTradeSkillInfo).
local function classicRecipes()
  local profession, rank, max = GetTradeSkillLine()
  if not profession or profession == "UNKNOWN" then return nil end
  local list = {}
  for i = 1, num(GetNumTradeSkills()) or 0 do
    local name, kind, available = GetTradeSkillInfo(i)
    if name and kind ~= "header" and kind ~= "subheader" then
      local r = { name = name, difficulty = DIFFICULTY[kind] or kind }
      if num(available) and available > 0 then r.canMake = available end
      if kind ~= "trivial" and GetTradeSkillNumReagents then
        local parts = {}
        for j = 1, num(GetTradeSkillNumReagents(i)) or 0 do
          local reagent, _, need = GetTradeSkillReagentInfo(i, j)
          if reagent then parts[#parts + 1] = (need or 1) .. "x " .. reagent end
        end
        r.reagents = reagentText(parts)
      end
      list[#list + 1] = r
      if #list >= MAX_RECIPES then break end
    end
  end
  return { profession = profession, rank = num(rank), max = num(max), recipes = list }
end

-- Classic enchanting-style window (GetCraftInfo).
local function classicCrafts()
  if not GetCraftDisplaySkillLine then return nil end
  local profession, rank, max = GetCraftDisplaySkillLine()
  if not profession then return nil end -- e.g. the hunter's beast training
  local list = {}
  for i = 1, num(GetNumCrafts()) or 0 do
    local name, _, kind, available = GetCraftInfo(i)
    if name and kind ~= "header" then
      local r = { name = name, difficulty = DIFFICULTY[kind] or kind }
      if num(available) and available > 0 then r.canMake = available end
      if kind ~= "trivial" and GetCraftNumReagents then
        local parts = {}
        for j = 1, num(GetCraftNumReagents(i)) or 0 do
          local reagent, _, need = GetCraftReagentInfo(i, j)
          if reagent then parts[#parts + 1] = (need or 1) .. "x " .. reagent end
        end
        r.reagents = reagentText(parts)
      end
      list[#list + 1] = r
      if #list >= MAX_RECIPES then break end
    end
  end
  return { profession = profession, rank = num(rank), max = num(max), recipes = list }
end

-- Modern window (C_TradeSkillUI).
local MODERN_DIFFICULTY = { [0] = "orange", "yellow", "green", "grey" }

-- The open window's profession: the first of the child (an expansion's part of
-- the profession) and the base profession info that has a name. WoW Forever
-- answers the child one with a blank name and skill 0, and the base one with
-- the profession and its skill ("Mining", 206, 300).
local function professionInfo(T)
  for _, fn in ipairs({ T.GetChildProfessionInfo or false, T.GetBaseProfessionInfo or false }) do
    if fn then
      local ok, info = pcall(fn)
      local name = ok and type(info) == "table" and info.professionName
      if type(name) == "string" and name ~= "" and not secret(name) then return info, name end
    end
  end
end

local function modernRecipes()
  local T = C_TradeSkillUI
  local info, profession = professionInfo(T)
  if not profession then return nil end
  local list = {}
  for _, id in ipairs(T.GetAllRecipeIDs() or {}) do
    local r = T.GetRecipeInfo(id)
    if r and r.learned and r.name then
      local entry = { name = r.name, difficulty = MODERN_DIFFICULTY[r.relativeDifficulty] }
      if num(r.numAvailable) and r.numAvailable > 0 then entry.canMake = r.numAvailable end
      if entry.difficulty ~= "grey" and T.GetRecipeSchematic then
        local parts = {}
        local schematic = safe(T.GetRecipeSchematic, id, false)
        for _, slot in ipairs(schematic and schematic.reagentSlotSchematics or {}) do
          local reagent = slot.reagents and slot.reagents[1]
          local itemName = reagent and reagent.itemID and GetItemInfo(reagent.itemID)
          if itemName then parts[#parts + 1] = (slot.quantityRequired or 1) .. "x " .. itemName end
        end
        entry.reagents = reagentText(parts)
      end
      list[#list + 1] = entry
      if #list >= MAX_RECIPES then break end
    end
  end
  return { profession = profession, rank = num(info.skillLevel), max = num(info.maxSkillLevel), recipes = list }
end

-- The profession whose window is open: { profession, rank, max, recipes }.
-- kind: "craft" for the classic enchanting-style window.
function Collect:Recipes(kind)
  if kind == "craft" then return safe(classicCrafts) end
  if C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs then
    local modern = safe(modernRecipes)
    if modern and #modern.recipes > 0 then return modern end
  end
  if GetTradeSkillLine and GetNumTradeSkills then return safe(classicRecipes) end
end

-- Action bars ------------------------------------------------------------------
-- What is on the bars (with its key) and the known abilities that are not:
-- WoW Forever no longer places newly learned spells on the bars by itself.

-- Action slot ranges and the binding of their buttons.
local BAR_BINDINGS = {
  { 1, 12, "ACTIONBUTTON" }, { 61, 72, "MULTIACTIONBAR1BUTTON" }, { 49, 60, "MULTIACTIONBAR2BUTTON" },
  { 25, 36, "MULTIACTIONBAR3BUTTON" }, { 37, 48, "MULTIACTIONBAR4BUTTON" },
}
local function bindingFor(slot)
  if not GetBindingKey then return nil end
  for _, b in ipairs(BAR_BINDINGS) do
    if slot >= b[1] and slot <= b[2] then
      local key = GetBindingKey(b[3] .. (slot - b[1] + 1))
      return type(key) == "string" and key or nil
    end
  end
end

local function spellName(id)
  local getName = (C_Spell and C_Spell.GetSpellName) or GetSpellInfo
  return getName and getName(id)
end

-- The spells a macro casts: the one the game shows for it (GetMacroSpell)
-- and the names after /cast, /use, /castsequence, /castrandom and
-- #showtooltip, without conditions ("[@mouseover]"), "reset=", "!" or ranks.
-- A spell used only through a macro is on the bars too.
local MACRO_COMMANDS = { cast = true, use = true, castsequence = true, castrandom = true, showtooltip = true, show = true }
local function macroSpells(index, body)
  local out = {}
  if GetMacroSpell then
    local ok, id = pcall(GetMacroSpell, index)
    local name = ok and (type(id) == "number" and spellName(id) or type(id) == "string" and id) or nil
    if type(name) == "string" and name ~= "" and not secret(name) then out[#out + 1] = name end
  end
  if type(body) ~= "string" or secret(body) then return out end
  for line in body:gmatch("[^\r\n]+") do
    local cmd, args = line:match("^%s*[/#](%a+)%s*(.*)$")
    if cmd and MACRO_COMMANDS[cmd:lower()] then
      args = args:gsub("%[.-%]", ""):gsub("reset=%S+", "")
      for part in args:gmatch("[^;,]+") do
        local name = part:gsub("^%s*!?%s*", ""):gsub("%s*%(.-%)%s*$", ""):gsub("%s+$", "")
        if name ~= "" then out[#out + 1] = name end
      end
    end
  end
  return out
end

-- A macro on a bar: its name and the spells it casts. Older clients give the
-- macro's index; newer ones give the spell (or item) the macro shows instead,
-- with subType "spell" ("item"). So that counts too, and the macro itself is
-- looked up by the name on its button.
local function macroOnBar(slot, id, subType)
  local inside = {}
  local function add(name)
    if type(name) == "string" and name ~= "" and not secret(name) then inside[#inside + 1] = name end
  end
  if subType == "spell" then add(spellName(id)) elseif subType == "item" then add(GetItemInfo(id)) end
  local text = GetActionText and GetActionText(slot)
  if type(text) ~= "string" or text == "" or secret(text) then text = nil end
  local index
  if text and GetMacroIndexByName then
    local i = tonumber(GetMacroIndexByName(text))
    if i and i > 0 then index = i end
  end
  if not index and subType ~= "spell" and subType ~= "item" then index = tonumber(id) end
  local macro, _, body
  if index and GetMacroInfo then macro, _, body = GetMacroInfo(index) end
  for _, spell in ipairs(macroSpells(index or text, body)) do add(spell) end
  return macro or text, inside
end

-- The stance bar (paladin auras, warrior stances, druid forms, stealth,
-- Shadowform...) isn't in the action slots, but what is on it is within reach
-- too. Newer clients give (icon, active, castable, spellID), older ones
-- (icon, name, active, castable).
local function stanceBar()
  local out = {}
  if not (GetNumShapeshiftForms and GetShapeshiftFormInfo) then return out end
  for i = 1, num(safe(GetNumShapeshiftForms)) or 0 do
    local ok, _, second, _, spellID = pcall(GetShapeshiftFormInfo, i)
    local name
    if ok and type(second) == "string" then name = second
    elseif ok and num(spellID) then name = spellName(spellID) end
    if type(name) == "string" and not secret(name) then out[#out + 1] = name end
  end
  return out
end

local MAX_ACTIONS = 72
local function actionBars()
  if not (GetActionInfo and HasAction) then return nil end
  local list, onBars, onBarsLower = {}, {}, {}
  for slot = 1, 180 do -- 120 on most clients; newer ones have more bars
    if HasAction(slot) then
      local kind, id, subType = GetActionInfo(slot)
      local name
      if kind == "spell" then
        name = spellName(id)
      elseif kind == "item" then
        name = GetItemInfo(id)
      elseif kind == "macro" then
        local macro, inside = macroOnBar(slot, id, subType)
        for _, spell in ipairs(inside) do onBarsLower[spell:lower()] = true end
        name = macro and ("macro " .. macro .. (inside[1] and (" (" .. inside[1] .. ")") or ""))
      elseif kind == "flyout" and GetFlyoutInfo then
        local flyout, _, slots = GetFlyoutInfo(id)
        name = flyout
        -- The spells inside a flyout (e.g. "Aspect") count as on the bars.
        for i = 1, num(slots) or 0 do
          local _, _, known, inside = GetFlyoutSlotInfo(id, i)
          if known and type(inside) == "string" then onBars[inside] = true end
        end
      end
      if type(name) == "string" and not secret(name) and #list < MAX_ACTIONS then
        onBars[name] = true
        local key = bindingFor(slot)
        list[#list + 1] = key and (name .. " [" .. key .. "]") or name
      end
    end
  end
  if #list == 0 then return nil end
  for _, name in ipairs(stanceBar()) do onBars[name] = true end
  local missing = {}
  for _, tab in ipairs(safe(spells) or {}) do
    for _, s in ipairs(tab.spells or {}) do
      local base = s:gsub(" %(.-%)$", "")
      if not onBars[base] and not onBars[s] and not onBarsLower[base:lower()] then missing[#missing + 1] = base end
    end
  end
  return { actionBars = list, spellsNotOnBars = #missing > 0 and missing or nil }
end

-- Recent errors and deaths ---------------------------------------------------------
-- The game's red error messages ("Your pet is dead", "Out of range"...) and the
-- player's deaths, kept for a while to answer "why can't I..." / "why do I die".
local recent = { errors = {}, deaths = {} }
Collect.recent = recent
local ERRORS_KEPT, ERROR_MINUTES = 5, 10
local DEATHS_KEPT, DEATH_MINUTES = 3, 120

local recentWatcher = CreateFrame and CreateFrame("Frame")
if recentWatcher then
  pcall(recentWatcher.RegisterEvent, recentWatcher, "UI_ERROR_MESSAGE")
  pcall(recentWatcher.RegisterEvent, recentWatcher, "PLAYER_DEAD")
  recentWatcher:SetScript("OnEvent", function(_, event, _, message)
    pcall(function()
      if event == "UI_ERROR_MESSAGE" then
        if type(message) ~= "string" or secret(message) or message == "" then return end
        message = clean(message)
        for i = #recent.errors, 1, -1 do
          if recent.errors[i].text == message then table.remove(recent.errors, i) end
        end
        table.insert(recent.errors, 1, { text = message, at = GetTime() })
        while #recent.errors > ERRORS_KEPT do table.remove(recent.errors) end
      elseif event == "PLAYER_DEAD" then
        local d = { at = GetTime() }
        put(d, "zone", function() return GetRealZoneText() end)
        put(d, "subzone", function() local s = GetSubZoneText(); return s ~= "" and s or nil end)
        put(d, "level", function() return UnitLevel("player") end)
        if UnitExists("target") and UnitCanAttack("player", "target") then
          put(d, "target", function() return UnitName("target") end)
          put(d, "targetLevel", function() return UnitLevel("target") end)
        end
        table.insert(recent.deaths, 1, d)
        while #recent.deaths > DEATHS_KEPT do table.remove(recent.deaths) end
      end
    end)
  end)
end

local function recentEvents()
  local now = GetTime()
  local function since(list, minutes)
    local out = {}
    for _, e in ipairs(list) do
      local ago = (now - e.at) / 60
      if ago <= minutes then
        local copy = { minutesAgo = round(ago, 0) }
        for k, v in pairs(e) do if k ~= "at" then copy[k] = v end end
        out[#out + 1] = copy
      end
    end
    return #out > 0 and out or nil
  end
  return { recentErrors = since(recent.errors, ERROR_MINUTES), recentDeaths = since(recent.deaths, DEATH_MINUTES) }
end

-- Auction prices the addon saw before (Core:RememberPrices), for the items the
-- player has in the bags or the bank: what they are worth, what to sell.
local MAX_PRICES_SENT = 40
local function auctionPricesForMe(data)
  local prices = ns.Core and ns.Core.Prices and ns.Core:Prices()
  if not prices or not next(prices) then return nil end
  local ids, order = {}, {}
  local function want(item)
    local id = item and item.itemId
    if id and prices[id] and not ids[id] then ids[id] = true; order[#order + 1] = id end
  end
  local inv = Collect.cache.inventory and Collect.cache.inventory.keys.inventory
  for _, item in ipairs(inv and inv.value or {}) do want(item) end
  for _, item in ipairs(data.bank and data.bank.items or {}) do want(item) end
  local out = {}
  for i = 1, math.min(#order, MAX_PRICES_SENT) do
    local p = prices[order[i]]
    out[#out + 1] = { name = p.name, itemId = order[i], price = money(p.unit), seenAt = p.seenAt }
  end
  return #out > 0 and out or nil
end

-- Data the addon remembers between sessions (bank, flight paths, quests turned in).
local function remembered()
  local out = {}
  local data = ns.Core and ns.Core:CharData()
  if not data then return out end
  if data.bank and data.bank.items then
    out.bank = { seenAt = data.bank.seenAt, items = data.bank.items }
  end
  out.flightPaths = safe(flightPaths, data)
  if data.turnedIn and #data.turnedIn > 0 then out.recentlyCompletedQuests = data.turnedIn end
  if data.recipes and next(data.recipes) then
    local list = {}
    for _, p in pairs(data.recipes) do list[#list + 1] = p end
    table.sort(list, function(a, b) return tostring(a.profession) < tostring(b.profession) end)
    out.knownRecipes = list
  end
  if data.beastTraining then out.beastTraining = data.beastTraining end
  if data.stable then out.stable = data.stable end
  out.auctionPrices = safe(auctionPricesForMe, data)
  return out
end

-- Sections, in order. Each returns { key = value, ... } for the snapshot.
-- `events`: the section is only recomputed after one of them fires (it is
-- cached otherwise, which keeps asking cheap). No `events`: always recomputed.
-- `once`: computed a single time per session.
local unpackArgs = unpack or table.unpack
local function one(key, fn, ...)
  local args = { ... }
  local n = select("#", ...)
  return function() return { [key] = fn(unpackArgs(args, 1, n)) } end
end

local SECTIONS = {
  { "client", one("client", client), once = true },
  { "character", one("character", character) },
  { "specialization", one("specialization", specialization), events = {
    "PLAYER_TALENT_UPDATE", "CHARACTER_POINTS_CHANGED", "TRAIT_CONFIG_UPDATED",
    "ACTIVE_TALENT_GROUP_CHANGED", "PLAYER_SPECIALIZATION_CHANGED", "PLAYER_LEVEL_UP" } },
  { "stats", one("stats", stats) },
  { "gear", function()
      local items, empty, lowest = gear()
      return { gear = items, emptySlots = (#empty > 0) and empty or nil, lowestDurabilityPct = lowest }
    end, events = { "PLAYER_EQUIPMENT_CHANGED", "UPDATE_INVENTORY_DURABILITY", "GET_ITEM_INFO_RECEIVED" } },
  { "ammo", one("ammo", ammo) },
  { "bags", one("bags", bagSpace) },
  { "inventory", one("inventory", containerItems, playerBags(), true), events = {
    "BAG_UPDATE_DELAYED", "GET_ITEM_INFO_RECEIVED" } },
  { "position", one("position", position) },
  { "quests", one("quests", quests), events = { "QUEST_LOG_UPDATE", "GET_ITEM_INFO_RECEIVED" } },
  -- Done and available quests (QuestHelp works them out in the background and
  -- marks this section dirty when they change).
  { "questHelp", function() return ns.QuestHelp and ns.QuestHelp:Snapshot() or {} end, events = {} },
  { "professions", one("professions", professions), events = { "SKILL_LINES_CHANGED", "PLAYER_LEVEL_UP" } },
  { "skills", one("skills", skills), events = { "SKILL_LINES_CHANGED", "PLAYER_LEVEL_UP" } },
  { "lockouts", one("lockouts", lockouts), events = { "UPDATE_INSTANCE_INFO", "PLAYER_ENTERING_WORLD" } },
  { "spells", one("spells", spells), events = { "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB" } },
  { "actionBars", actionBars, events = {
    "ACTIONBAR_SLOT_CHANGED", "UPDATE_BINDINGS", "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB" } },
  { "buffs", one("buffs", auras, "HELPFUL") },
  { "debuffs", one("debuffs", auras, "HARMFUL") },
  { "reputations", one("reputations", reputations), events = { "UPDATE_FACTION" } },
  { "currencies", one("currencies", currencies), events = { "CURRENCY_DISPLAY_UPDATE" } },
  { "pet", one("pet", pet) },
  { "group", one("group", group) },
  { "target", one("target", target) },
  { "screen", one("screen", screen) },
  { "recent", recentEvents },
  { "remembered", remembered },
}

-- cache[section] = { keys = { key = { value, json, hash } } }
Collect.cache = {}
Collect.dirty = {}

local watcher = CreateFrame and CreateFrame("Frame")
if watcher then
  local byEvent = {}
  for _, s in ipairs(SECTIONS) do
    for _, e in ipairs(s.events or {}) do
      byEvent[e] = byEvent[e] or {}
      table.insert(byEvent[e], s[1])
      pcall(watcher.RegisterEvent, watcher, e)
    end
  end
  watcher:SetScript("OnEvent", function(_, event)
    for _, name in ipairs(byEvent[event] or {}) do Collect.dirty[name] = true end
  end)
end

-- Reads every section (recomputing only what is needed), calling step()
-- between sections so the work can be spread over several frames.
-- Returns snap (key -> value), meta (key -> { json, hash }) and the errors.
function Collect:Gather(step)
  step = step or function() end
  errors = {}
  local snap, meta = {}, {}
  for _, s in ipairs(SECTIONS) do
    local name = s[1]
    local entry = self.cache[name]
    local fresh = entry and (s.once or (s.events and not self.dirty[name]))
    if not fresh then
      self.dirty[name] = nil
      local ok, res = pcall(s[2])
      if ok then
        entry = { keys = {} }
        for k, v in pairs(res or {}) do
          local json = ns.Json.Encode(v)
          entry.keys[k] = { value = v, json = json, hash = ns.Json.Hash(json) }
        end
      else
        errors[name] = tostring(res):gsub("^.-:%d+: ", ""):sub(1, 120)
        entry = nil
      end
      self.cache[name] = entry
      step()
    end
    if entry then
      for k, e in pairs(entry.keys) do
        snap[k] = e.value
        meta[k] = e
      end
    end
  end
  -- Why the quest lists may be missing (QuestHelp works in the background).
  if ns.QuestHelp and ns.QuestHelp.lastError then errors.questHelp = tostring(ns.QuestHelp.lastError):sub(1, 120) end
  snap.localTime = date("%Y-%m-%d %H:%M")
  put(snap, "serverTime", function() return string.format("%02d:%02d", GetGameTime()) end)
  return snap, meta, errors
end

-- Everything at once (for /ia datos and tests).
function Collect:Snapshot()
  local snap, _, errs = self:Gather()
  -- Why a section is missing (read by the companion's log, not by the AI).
  if next(errs) then snap.diagnostics = errs end
  return snap
end
-- Items: checking what the AI recommends against the game, scoring any item
-- with the build's stat weights, and remembering the items seen while playing.
--
--   Check     an item id from a gear plan is only trusted once the game itself
--             knows an item with that id (and, on an English client, with that
--             name). Anything else is shown as plain text, never as a link.
--   Score     sum of weight x stat over the item's stats as the game reports
--             them. The weights come from the gear plan; the numbers are the
--             game's, so a score is never the AI's claim about an item.
--   See       loot, vendors, quest rewards and auction listings are remembered
--             with where they were seen, and sent along with gear requests:
--             WoW Forever's items are newer than the AI's training.
local _, ns = ...
local Util = ns.Util
local safe, num = Util.safe, Util.num

local Items = {}
ns.Items = Items

local GetItemInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
local RequestLoad = C_Item and C_Item.RequestLoadItemDataByID

-- Gear slot names (as in the gear plan and the main addon's snapshot).
Items.SLOT_IDS = {
  head = 1, neck = 2, shoulder = 3, back = 15, chest = 5, wrist = 9, hands = 10, waist = 6, legs = 7, feet = 8,
  finger1 = 11, finger2 = 12, trinket1 = 13, trinket2 = 14, mainHand = 16, offHand = 17, ranged = 18,
}
Items.SLOT_ORDER = {
  "head", "neck", "shoulder", "back", "chest", "wrist", "hands", "waist", "legs", "feet",
  "finger1", "finger2", "trinket1", "trinket2", "mainHand", "offHand", "ranged",
}
-- Slots an item of each kind can go in.
Items.SLOTS_FOR = {
  INVTYPE_HEAD = { "head" }, INVTYPE_NECK = { "neck" }, INVTYPE_SHOULDER = { "shoulder" },
  INVTYPE_CLOAK = { "back" }, INVTYPE_CHEST = { "chest" }, INVTYPE_ROBE = { "chest" },
  INVTYPE_WRIST = { "wrist" }, INVTYPE_HAND = { "hands" }, INVTYPE_WAIST = { "waist" },
  INVTYPE_LEGS = { "legs" }, INVTYPE_FEET = { "feet" }, INVTYPE_FINGER = { "finger1", "finger2" },
  INVTYPE_TRINKET = { "trinket1", "trinket2" }, INVTYPE_WEAPON = { "mainHand", "offHand" },
  INVTYPE_2HWEAPON = { "mainHand" }, INVTYPE_WEAPONMAINHAND = { "mainHand" },
  INVTYPE_WEAPONOFFHAND = { "offHand" }, INVTYPE_SHIELD = { "offHand" }, INVTYPE_HOLDABLE = { "offHand" },
  INVTYPE_RANGED = { "ranged" }, INVTYPE_RANGEDRIGHT = { "ranged" }, INVTYPE_THROWN = { "ranged" },
  INVTYPE_RELIC = { "ranged" },
}

-- What the game knows about item ids ---------------------------------------------

-- id -> { state = "ok" | "bad" | "wait", name, link, equipLoc, level, req, quality, icon }
Items.known = {}

local function read(id)
  local r = { safe(GetItemInfo, id) }
  local name, link = r[1], r[2]
  if type(name) ~= "string" or type(link) ~= "string" then return nil end
  -- name, link, quality, itemLevel, reqLevel, type, subType, stack, equipLoc, icon
  local quality, level, req, equipLoc, icon
  local ok, all = pcall(function() return { GetItemInfo(id) } end)
  if ok and type(all) == "table" then quality, level, req, equipLoc, icon = all[3], all[4], all[5], all[9], all[10] end
  return { state = "ok", name = name, link = link, quality = num(quality), level = num(level), req = num(req), equipLoc = equipLoc, icon = icon }
end

-- The game's record of an item id. "wait": asked for, not here yet (the
-- window refreshes when it arrives, see Items.OnItemInfo).
function Items.Info(id)
  if type(id) ~= "number" then return nil end
  local known = Items.known[id]
  if known and known.state ~= "wait" then return known end
  local info = read(id)
  if info then
    Items.known[id] = info
    return info
  end
  if not known then
    Items.known[id] = { state = "wait", since = GetTime and GetTime() or 0 }
    if RequestLoad then pcall(RequestLoad, id) end
  end
  return Items.known[id]
end

-- GET_ITEM_INFO_RECEIVED: the game answered about an id (success false: no such item).
function Items.OnItemInfo(id, success)
  id = tonumber(id)
  local known = id and Items.known[id]
  if not known or known.state ~= "wait" then return false end
  if success == false then
    Items.known[id] = { state = "bad" }
  else
    Items.known[id] = read(id) or known
  end
  return true
end

-- An id still unanswered after a while is taken as not existing.
function Items.Expire(seconds)
  local now = GetTime and GetTime() or 0
  for id, known in pairs(Items.known) do
    if known.state == "wait" and now - (known.since or now) > (seconds or 20) then Items.known[id] = { state = "bad" } end
  end
end

local function englishClient()
  local locale = GetLocale and GetLocale() or "enUS"
  return locale:sub(1, 2) == "en"
end

-- How far a recommended item ({ name, itemId }) can be trusted:
--   "verified"  the game has an item with this id (and this name, in English)
--   "mismatch"  the id is another item: shown as plain text
--   "wait"      the game hasn't answered yet
--   "unknown"   no such id in this game
--   "none"      the AI gave no id
-- Returns the state and the game's record when verified.
function Items.Check(pick)
  if type(pick) ~= "table" or type(pick.itemId) ~= "number" then return "none" end
  local info = Items.Info(pick.itemId)
  if not info or info.state == "bad" then return "unknown" end
  if info.state == "wait" then return "wait" end
  -- The AI researches English names: only an English client can compare them.
  if englishClient() and type(pick.name) == "string" and not Util.sameName(pick.name, info.name) then return "mismatch", info end
  return "verified", info
end

-- Scores ----------------------------------------------------------------------------

local statCache = {}

-- An item's stats as the main addon reads them: { STRENGTH = 5, ... }, and
-- how many "Equip:" style effects it has that no stat weight can count.
function Items.Stats(link)
  if type(link) ~= "string" then return nil end
  local key = link:match("item:[%-%d:]+") or link
  local cached = statCache[key]
  if cached == nil then
    local api = ForeverAICompanionAPI
    local d = api and api.DescribeItem and api.DescribeItem(link, true)
    cached = type(d) == "table" and { stats = d.stats or {}, effects = type(d.effects) == "table" and #d.effects or 0, equipLoc = d.equipSlot } or false
    statCache[key] = cached
  end
  return cached or nil
end

-- weights: { STRENGTH = 2.2, ... }. Returns the score, or nil when the item
-- has nothing the weights count; and its number of uncounted effects.
function Items.Score(link, weights)
  local item = Items.Stats(link)
  if not item or type(weights) ~= "table" then return nil end
  local score, any = 0, false
  for stat, value in pairs(item.stats) do
    local w = weights[stat]
    if type(w) == "number" and type(value) == "number" then
      score = score + w * value
      any = true
    end
  end
  return any and score or nil, item.effects
end

function Items.Equipped(slot)
  local id = Items.SLOT_IDS[slot]
  return id and safe(GetInventoryItemLink, "player", id) or nil
end

-- The item id worn in a slot, or nil.
function Items.EquippedId(slot)
  local link = Items.Equipped(slot)
  local id = type(link) == "string" and not Util.secret(link) and tonumber(link:match("item:(%d+)"))
  if id then return id end
  local slotId = Items.SLOT_IDS[slot]
  return slotId and num(safe(GetInventoryItemID, "player", slotId)) or nil
end

-- The kind of item worn in a slot (its equipLoc), or nil when nothing is
-- worn there or the kind cannot be read.
local function wornKind(slot)
  local link = Items.Equipped(slot)
  if type(link) ~= "string" then return nil end
  local kind = (Items.Stats(link) or {}).equipLoc
  if type(kind) ~= "string" or kind == "" then
    local ok, all = pcall(function() return { GetItemInfo(link) } end)
    kind = ok and type(all) == "table" and all[9] or nil
  end
  return type(kind) == "string" and kind ~= "" and kind or nil
end

local OFF_HAND_KINDS = { INVTYPE_WEAPONOFFHAND = true, INVTYPE_SHIELD = true, INVTYPE_HOLDABLE = true }
local OFF_HAND_WEAPONS = { INVTYPE_WEAPON = true, INVTYPE_WEAPONOFFHAND = true }

-- A client without the function counts as "cannot": an empty off hand is
-- then never taken as a place for a one-hand weapon.
local function canDualWield()
  return safe(CanDualWield) and true or false
end

-- The slots a one-hand weapon would really go in. With a two-hander worn it
-- can only replace that two-hander. Otherwise the off hand is a place for it
-- only when it already holds a weapon, or is empty and the character can dual
-- wield: a shield or a held item stays where it is.
local function oneHandSlots()
  if wornKind("mainHand") == "INVTYPE_2HWEAPON" then return { "mainHand" } end
  local slots = { "mainHand" }
  local off = Items.Equipped("offHand")
  if off then
    if OFF_HAND_WEAPONS[wornKind("offHand") or ""] then slots[2] = "offHand" end
  elseif canDualWield() then
    slots[2] = "offHand"
  end
  return slots
end

-- A candidate against what is worn where it would go. Returns
-- { score, delta, slot } (delta against the weakest of its slots; a two-hander
-- against main hand and off hand together), or nil when it can't be scored.
-- An off-hand item while a two-hander is worn cannot be worn with it, so it
-- has no delta and says why: { score, slot, blocked = "twoHand" }.
function Items.Compare(link, weights, equipLoc)
  local score = Items.Score(link, weights)
  if not score then return nil end
  equipLoc = equipLoc or (Items.Stats(link) or {}).equipLoc
  local slots = Items.SLOTS_FOR[equipLoc or ""]
  if not slots then return { score = score } end
  if OFF_HAND_KINDS[equipLoc] and wornKind("mainHand") == "INVTYPE_2HWEAPON" then
    return { score = score, slot = "offHand", blocked = "twoHand" }
  end
  if equipLoc == "INVTYPE_WEAPON" then slots = oneHandSlots() end
  local best
  for _, slot in ipairs(slots) do
    local worn = Items.Equipped(slot)
    local wornScore = worn and Items.Score(worn, weights) or 0
    if equipLoc == "INVTYPE_2HWEAPON" then
      local off = Items.Equipped("offHand")
      wornScore = wornScore + (off and Items.Score(off, weights) or 0)
    end
    if not best or wornScore < best.worn then best = { worn = wornScore, slot = slot } end
  end
  return { score = score, delta = score - best.worn, slot = best.slot }
end

-- Something was equipped or learned: scores are read again.
function Items.Forget()
  statCache = {}
end

-- Items seen while playing ----------------------------------------------------------

local GetItemInfoInstant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
local MAX_WAITING = 60

-- What became of the items looked at this session, for /armory debug: the
-- owner's saved data once showed none kept after sessions of looting, and
-- without these numbers nobody could tell where they were lost.
Items.seenStats = { looked = 0, kept = 0, events = {} }
-- id -> { link, src, since }: items the game had not loaded yet when seen.
local waiting = {}

local function zone()
  local name = safe(GetInstanceInfo)
  local inInstance = safe(IsInInstance)
  if inInstance and type(name) == "string" and name ~= "" then return name end
  return safe(GetRealZoneText) or safe(GetZoneText)
end

local function skip(id, name, why)
  Items.seenStats.skipped = string.format("%s: %s", tostring(name or ("item " .. tostring(id or "?"))), why)
  return false
end

-- Where an item goes, known at once on clients that have it (no loading
-- needed): an item that is not worn is skipped without waiting for the rest.
local function instantEquipLoc(id)
  if type(GetItemInfoInstant) ~= "function" then return nil end
  local ok, all = pcall(function() return { GetItemInfoInstant(id) } end)
  return ok and type(all) == "table" and all[4] or nil
end

-- Remembers an equippable item of green quality or better. src: where it was
-- seen. An item the game has not loaded yet (it answers nothing the first
-- time) waits for GET_ITEM_INFO_RECEIVED, see Items.OnSeenInfo.
-- again: this is the second look at an item that was waiting (not counted twice).
function Items.See(link, src, again)
  if type(link) ~= "string" then return false end
  if not again then Items.seenStats.looked = Items.seenStats.looked + 1 end
  if Util.secret(link) then return skip(nil, nil, "hidden by the game (secret value)") end
  local id = tonumber(link:match("item:(%d+)"))
  if not id then return skip(nil, link, "no item id in the link") end
  local instant = instantEquipLoc(id)
  if type(instant) == "string" and not Items.SLOTS_FOR[instant] then return skip(id, link:match("%[(.-)%]"), "not something to wear") end
  local ok, all = pcall(function() return { GetItemInfo(link) } end)
  if not ok then return skip(id, nil, "the game's item function failed: " .. tostring(all)) end
  if type(all) ~= "table" or type(all[1]) ~= "string" then
    if again then return skip(id, link:match("%[(.-)%]"), "the game never described it") end
    -- Not loaded yet: asked for, and looked at again when it arrives.
    if not waiting[id] and Util.count(waiting) < MAX_WAITING then
      waiting[id] = { link = link, src = src, since = GetTime and GetTime() or 0 }
      if RequestLoad then pcall(RequestLoad, id) end
    end
    return skip(id, link:match("%[(.-)%]"), "waiting for the game to load it")
  end
  local quality, equipLoc = num(all[3]) or 0, all[9]
  if quality < 2 then return skip(id, all[1], string.format("quality %d, below uncommon", quality)) end
  if type(equipLoc) ~= "string" or not Items.SLOTS_FOR[equipLoc] then return skip(id, all[1], "not something to wear (" .. tostring(equipLoc) .. ")") end
  ns.Store:Remember(id, { n = all[1], s = equipLoc, l = num(all[4]), r = num(all[5]), q = quality, y = all[7] }, src)
  Items.seenStats.kept = Items.seenStats.kept + 1
  return true
end

-- GET_ITEM_INFO_RECEIVED for an item seen before the game had loaded it.
function Items.OnSeenInfo(id, success)
  id = tonumber(id)
  local w = id and waiting[id]
  if not w then return false end
  waiting[id] = nil
  if success == false then return skip(id, w.link:match("%[(.-)%]"), "the game has no such item") end
  if not ns.db then return false end
  return Items.See(w.link, w.src, true)
end

-- Items still waiting, after dropping those the game never answered for.
function Items.Waiting(seconds)
  local now = GetTime and GetTime() or 0
  for id, w in pairs(waiting) do
    if now - (w.since or now) > (seconds or 60) then waiting[id] = nil end
  end
  return Util.count(waiting)
end

-- An item link for a slot, from the link function or else from the item id.
local function linkOr(linkFn, idFn, ...)
  local link = safe(linkFn, ...)
  if type(link) == "string" then return link end
  local id = num(safe(idFn, ...))
  return id and id > 0 and ("item:" .. id) or nil
end

local function seeLootWindow()
  local where = zone()
  local from = safe(UnitExists, "target") and safe(UnitIsDead, "target") and safe(UnitName, "target") or nil
  local src = "loot: " .. tostring(from and (from .. ", " .. tostring(where)) or where)
  for i = 1, math.min(num(safe(GetNumLootItems)) or 0, 30) do Items.See(safe(GetLootSlotLink, i), src) end
end

local function seeMerchant()
  local npc = safe(UnitName, "npc") or safe(UnitName, "target")
  local src = "vendor: " .. (type(npc) == "string" and (npc .. ", ") or "") .. tostring(zone())
  for i = 1, math.min(num(safe(GetMerchantNumItems)) or 0, 120) do
    Items.See(linkOr(GetMerchantItemLink, GetMerchantItemID, i), src)
  end
end

-- A quest reward's link, or its id: the sixth answer of GetQuestItemInfo on
-- newer clients, there before the link is.
local function questItem(kind, i)
  local link = safe(GetQuestItemLink, kind, i)
  if type(link) == "string" then return link end
  local ok, all = pcall(function() return { GetQuestItemInfo(kind, i) } end)
  local id = ok and type(all) == "table" and num(all[6]) or nil
  return id and id > 0 and ("item:" .. id) or nil
end

local function seeQuest()
  local src = "quest: " .. tostring(safe(GetTitleText) or "?") .. ", " .. tostring(zone())
  for i = 1, math.min(num(safe(GetNumQuestChoices)) or 0, 10) do Items.See(questItem("choice", i), src) end
  for i = 1, math.min(num(safe(GetNumQuestRewards)) or 0, 10) do Items.See(questItem("reward", i), src) end
end

local function seeAuctions()
  local AH = C_AuctionHouse
  if AH and AH.GetBrowseResults then
    for _, r in ipairs(safe(AH.GetBrowseResults) or {}) do
      local id = type(r) == "table" and type(r.itemKey) == "table" and r.itemKey.itemID
      if id then Items.See("item:" .. id, "auction") end
    end
  elseif GetNumAuctionItems then
    for i = 1, math.min(num(safe(GetNumAuctionItems, "list")) or 0, 50) do Items.See(safe(GetAuctionItemLink, "list", i), "auction") end
  end
end

-- The modern client fires LOOT_READY before LOOT_OPENED (and the default
-- window may start taking the items with auto loot in between), a vendor's
-- list can fill after MERCHANT_SHOW, and a quest's rewards after its window
-- opens: each of these is looked at again.
local SEE = {
  LOOT_READY = seeLootWindow,
  LOOT_OPENED = seeLootWindow,
  MERCHANT_SHOW = seeMerchant,
  MERCHANT_UPDATE = seeMerchant,
  QUEST_DETAIL = seeQuest,
  QUEST_COMPLETE = seeQuest,
  QUEST_ITEM_UPDATE = seeQuest,
  AUCTION_HOUSE_BROWSE_RESULTS_UPDATED = seeAuctions,
  AUCTION_ITEM_LIST_UPDATE = seeAuctions,
}

-- Loot in the chat frame: the player's own ("You receive loot"), and what
-- others in the group link.
local function seeChatLoot(message)
  if type(message) ~= "string" or Util.secret(message) then return end
  local src = "loot: " .. tostring(zone())
  for link in message:gmatch("|Hitem:[^|]+|h%[[^%]]+%]|h") do Items.See(link, src) end
end

function Items.OnEvent(event, ...)
  if not ns.db then return end
  local stats = Items.seenStats
  stats.events[event] = (stats.events[event] or 0) + 1
  local ok, err
  if event == "CHAT_MSG_LOOT" then
    ok, err = pcall(seeChatLoot, ...)
  elseif SEE[event] then
    ok, err = pcall(SEE[event])
  end
  if ok == false then stats.error = event .. ": " .. tostring(err) end
end

-- One line for /armory debug: what was looked at this session, what was
-- kept, and why the last one was not.
function Items.SeenDiagnosis()
  local stats = Items.seenStats
  local events = {}
  for event, n in pairs(stats.events) do events[#events + 1] = event .. " " .. n end
  table.sort(events)
  local line = string.format("items this session: looked at %d, kept %d, %d waiting for the game", stats.looked, stats.kept, Items.Waiting())
  if stats.skipped then line = line .. "; last skipped: " .. stats.skipped end
  line = line .. "; events: " .. (#events > 0 and table.concat(events, ", ") or "none yet")
  if stats.error then line = line .. "; error: " .. stats.error end
  return line
end

Items.EVENTS = { "LOOT_READY", "LOOT_OPENED", "MERCHANT_SHOW", "MERCHANT_UPDATE", "QUEST_DETAIL", "QUEST_COMPLETE", "QUEST_ITEM_UPDATE",
                 "CHAT_MSG_LOOT", "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED", "AUCTION_ITEM_LIST_UPDATE" }

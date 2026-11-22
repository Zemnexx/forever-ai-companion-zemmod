-- At the auction house: looks up the buyable items of the gear plan, one
-- search per item, when the player clicks the button for it in the Gear tab.
-- Nothing is bought or bid on: the searches only read prices, the same ones
-- the player would see by typing each name into the auction window.
--
-- An item the AI named without an id gets its id here when a listing with
-- that exact name shows up: the game itself supplied it, so it can be linked
-- and scored like a verified item.
local _, ns = ...
local L = ns.L
local Util = ns.Util
local safe, num = Util.safe, Util.num

local Auction = {}
ns.Auction = Auction

local WAIT = 6       -- seconds to wait for a search's results
local PAUSE = 0.7    -- between searches (the game limits how fast they go)

function Auction:IsOpen()
  return self.open == true
end

-- What was found for an item name: { itemId, unit (copper), at } or nil.
function Auction:Found(name)
  local char = ns.Store:Char()
  local found = char and char.auction
  return type(found) == "table" and type(name) == "string" and found[name:lower()] or nil
end

local function remember(name, itemId, unit)
  local char = ns.Store:Char()
  if not char then return end
  char.auction = char.auction or {}
  char.auction[name:lower()] = { itemId = itemId, unit = unit, at = time() }
end

-- The names to look up: every buyable pick of the gear plan, once each.
local function wanted()
  local names, seen = {}, {}
  local gear = ns.Store:Result("gear")
  for _, slot in ipairs(gear and gear.data and gear.data.slots or {}) do
    for _, pick in ipairs(slot.picks or {}) do
      local key = type(pick.name) == "string" and pick.name:lower()
      if pick.auction and key and not seen[key] then
        seen[key] = true
        names[#names + 1] = pick.name
      end
    end
  end
  return names
end

-- Sends one search. False when the game isn't ready for another one yet.
local function send(name)
  local AH = C_AuctionHouse
  if AH and AH.SendBrowseQuery then
    if AH.IsThrottledMessageSystemReady and not safe(AH.IsThrottledMessageSystemReady) then return false end
    local sorts = {}
    if Enum and Enum.AuctionHouseSortOrder then sorts[1] = { sortOrder = Enum.AuctionHouseSortOrder.Price, reverseSort = false } end
    return pcall(AH.SendBrowseQuery, { searchString = name, sorts = sorts, filters = {}, itemClassFilters = {} })
  elseif QueryAuctionItems then
    if CanSendAuctionQuery and not safe(CanSendAuctionQuery) then return false end
    return pcall(QueryAuctionItems, name, nil, nil, 0, nil, nil, false, true, nil)
  end
  return nil
end

-- The cheapest listing whose name is exactly `name`: itemId, price per item.
local function cheapest(name)
  local AH = C_AuctionHouse
  local bestId, bestUnit
  local function consider(itemName, itemId, unit)
    if Util.sameName(itemName, name) and num(unit) and unit > 0 and (not bestUnit or unit < bestUnit) then bestId, bestUnit = itemId, unit end
  end
  if AH and AH.GetBrowseResults then
    for _, r in ipairs(safe(AH.GetBrowseResults) or {}) do
      local key = type(r) == "table" and r.itemKey
      if type(key) == "table" and key.itemID then
        local info = AH.GetItemKeyInfo and safe(AH.GetItemKeyInfo, key)
        local itemName = (type(info) == "table" and info.itemName) or safe((C_Item and C_Item.GetItemInfo) or GetItemInfo, key.itemID)
        consider(itemName, key.itemID, r.minPrice)
      end
    end
  elseif GetNumAuctionItems then
    for i = 1, math.min(num(safe(GetNumAuctionItems, "list")) or 0, 50) do
      -- name, texture, count, quality, canUse, level, levelColHeader, minBid,
      -- minIncrement, buyoutPrice, bidAmount, highBidder, bidderFullName,
      -- owner, ownerFullName, saleStatus, itemId
      local ok, r = pcall(function() return { GetAuctionItemInfo("list", i) } end)
      if ok and type(r) == "table" then
        local count, buyout = num(r[3]) or 1, num(r[10])
        if buyout and buyout > 0 then consider(r[1], num(r[17]), math.floor(buyout / math.max(count, 1))) end
      end
    end
  end
  return bestId, bestUnit
end

local function later(seconds, fn)
  if C_Timer and C_Timer.After then C_Timer.After(seconds, fn) else fn() end
end

local function redraw()
  if ns.UI and ns.UI.Touch then ns.UI:Touch() end
end

-- Starts looking up the gear plan's buyable items.
function Auction:Search()
  if not self.open or self.current or self.queue then return false end
  local names = wanted()
  if #names == 0 then return false end
  self.queue, self.total, self.done, self.hits, self.unavailable = names, #names, 0, 0, nil
  self:Next()
  return true
end

function Auction:Next()
  if not self.open then
    self.queue, self.current = nil, nil
    return redraw()
  end
  local name = self.queue and self.queue[1]
  if not name then
    self.queue, self.current = nil, nil
    self.finished = time()
    return redraw()
  end
  local sent = send(name)
  if sent == nil then
    -- This client has no way to search from an addon.
    self.queue, self.current, self.unavailable = nil, nil, true
    return redraw()
  end
  if not sent then return later(0.5, function() Auction:Next() end) end
  table.remove(self.queue, 1)
  self.current = name
  local token = {}
  self.token = token
  -- No results in time (nothing listed gives no event on some clients): move on.
  later(WAIT, function()
    if Auction.token == token and Auction.current == name then Auction:Finish(name) end
  end)
  redraw()
end

-- Results arrived for the search in progress.
function Auction:OnResults()
  local name = self.current
  if not name then return end
  local itemId, unit = cheapest(name)
  if unit then
    remember(name, itemId, unit)
    self.hits = (self.hits or 0) + 1
    -- The game named the id: the pick can now be checked, linked and scored.
    local gear = ns.Store:Result("gear")
    for _, slot in ipairs(gear and gear.data and gear.data.slots or {}) do
      for _, pick in ipairs(slot.picks or {}) do
        if itemId and not pick.itemId and Util.sameName(pick.name, name) then pick.itemId = itemId end
      end
    end
  end
  self:Finish(name)
end

function Auction:Finish(name)
  if self.current ~= name then return end
  self.current, self.token = nil, nil
  self.done = (self.done or 0) + 1
  redraw()
  later(PAUSE, function() Auction:Next() end)
end

-- A line for the Gear tab about the search, or nil.
function Auction:Status()
  if self.unavailable then return L.AH_UNAVAILABLE end
  if self.current or self.queue then return string.format(L.AH_SEARCHING, (self.done or 0) + 1, self.total or 0) end
  if self.finished and self.total then return string.format(L.AH_DONE, self.hits or 0, self.total) end
  return nil
end

function Auction:OnEvent(event)
  if event == "AUCTION_HOUSE_SHOW" then
    self.open = true
    redraw()
  elseif event == "AUCTION_HOUSE_CLOSED" then
    self.open, self.queue, self.current, self.token = false, nil, nil, nil
    redraw()
  elseif event == "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED" or event == "AUCTION_ITEM_LIST_UPDATE" then
    pcall(self.OnResults, self)
  end
end

Auction.EVENTS = { "AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED", "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED", "AUCTION_ITEM_LIST_UPDATE" }

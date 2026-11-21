local ADDON, ns = ...
local L = ns.L

local Core = {}
ns.Core = Core

local HISTORY_TURNS_SENT = 6      -- earlier Q&A of the same chat sent along
local HISTORY_ANSWER_CHARS = 600
local PENDING_TIMEOUT = 150       -- seconds

local function chat(msg)
  print("|cff66ccffForever AI:|r " .. msg)
end

function Core:FindEntry(id)
  return ns.Chats:FindEntry(id)
end

-- The request code ------------------------------------------------------------
-- Every request carries HMAC-SHA256(this PC's key, the request's id) instead
-- of the key itself (RequestKey.lua, written by the app): the app can tell the
-- addon's requests apart, while the key never leaves the game, not through the
-- voice and not on the on-screen line (which screenshots, recordings and
-- streams can see). A code fits only its own id, and the app answers an id
-- once. SHA-256 (FIPS 180-4) and HMAC (RFC 2104) with the game's bit library.
local K256 = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

-- The bit library's results as 0..2^32-1, whether it hands them back signed or not.
local function u32(x) return x % 4294967296 end
local function band(a, b) return u32(bit.band(a, b)) end
local function bxor(a, b) return u32(bit.bxor(a, b)) end
local function bnot(a) return u32(bit.bnot(a)) end
local function shr(a, n) return u32(bit.rshift(a, n)) end
local function rotr(x, n) return u32(bit.bor(bit.rshift(x, n), bit.lshift(x, 32 - n))) end

local function word(n) -- 4 bytes, big-endian
  return string.char(math.floor(n / 16777216) % 256, math.floor(n / 65536) % 256, math.floor(n / 256) % 256, n % 256)
end

local function sha256(msg)
  local len = #msg
  msg = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. word(math.floor(len * 8 / 4294967296)) .. word(len * 8 % 4294967296)
  local H = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }
  local w = {}
  for chunk = 1, #msg, 64 do
    for i = 0, 15 do
      local b1, b2, b3, b4 = msg:byte(chunk + i * 4, chunk + i * 4 + 3)
      w[i] = ((b1 * 256 + b2) * 256 + b3) * 256 + b4
    end
    for i = 16, 63 do
      local v15, v2 = w[i - 15], w[i - 2]
      local s0 = bxor(bxor(rotr(v15, 7), rotr(v15, 18)), shr(v15, 3))
      local s1 = bxor(bxor(rotr(v2, 17), rotr(v2, 19)), shr(v2, 10))
      w[i] = u32(w[i - 16] + s0 + w[i - 7] + s1)
    end
    local a, b, c, d, e, f, g, h = H[1], H[2], H[3], H[4], H[5], H[6], H[7], H[8]
    for i = 0, 63 do
      local S1 = bxor(bxor(rotr(e, 6), rotr(e, 11)), rotr(e, 25))
      local ch = bxor(band(e, f), band(bnot(e), g))
      local t1 = u32(h + S1 + ch + K256[i + 1] + w[i])
      local S0 = bxor(bxor(rotr(a, 2), rotr(a, 13)), rotr(a, 22))
      local maj = bxor(bxor(band(a, b), band(a, c)), band(b, c))
      h, g, f, e, d, c, b, a = g, f, e, u32(d + t1), c, b, a, u32(t1 + S0 + maj)
    end
    H[1], H[2], H[3], H[4] = u32(H[1] + a), u32(H[2] + b), u32(H[3] + c), u32(H[4] + d)
    H[5], H[6], H[7], H[8] = u32(H[5] + e), u32(H[6] + f), u32(H[7] + g), u32(H[8] + h)
  end
  local out = {}
  for i = 1, 8 do out[i] = word(H[i]) end
  return table.concat(out)
end
Core.Sha256 = sha256

local function hmacSha256(key, msg)
  if #key > 64 then key = sha256(key) end
  key = key .. string.rep("\0", 64 - #key)
  local ipad, opad = {}, {}
  for i = 1, 64 do
    local k = key:byte(i)
    ipad[i] = string.char(bxor(k, 0x36))
    opad[i] = string.char(bxor(k, 0x5c))
  end
  return sha256(table.concat(opad) .. sha256(table.concat(ipad) .. msg))
end

local function hex(s)
  return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

-- The code for request `id` (nil without a key: the app then explains to /reload).
function Core:AuthCode(id)
  if type(ns.requestKey) ~= "string" or ns.requestKey == "" then return nil end
  return hex(hmacSha256(ns.requestKey, tostring(id)))
end

-- A question sent through the invisible voice with no answer after this
-- long is also sent through the strip, as the same question (same id): the
-- app answers it once, whichever copy it got. A slow answer (the AI taking a
-- while, a first start) is not a lost question: the voice is only given up
-- for the session when no answer comes back at all (PENDING_TIMEOUT). Giving
-- it up after these 45 s left a Mac without the Screen Recording permission
-- (the strip can't be read there) with no answers until /reload.
local VOICE_TIMEOUT = 45

function Core:HasPending()
  local now = time()
  local any = false
  local resend
  ns.Chats:EachEntry(function(e, c)
    if e.status ~= "pending" then return end
    if now - (e.t or now) > PENDING_TIMEOUT then
      e.status = "error"
      e.answer = L.NO_ANSWER
      e.timedOut = true -- an answer that still arrives is shown (see ApplyInbox)
      -- Sent through the voice and nothing came back, not even after the strip:
      -- the voice isn't working this session. (Not for a voice question: it
      -- can't go through the strip, and recording and transcribing take time.)
      if e.viaVoice and not e.listen then ns.Voice.broken = true end
      ns.UI:Refresh()
      return
    end
    any = true
    -- (Voice questions can't be re-sent through the strip: there is no text yet.)
    if e.viaVoice and not e.listen and not e.resent and not resend and not self.working and now - (e.t or now) > VOICE_TIMEOUT then
      e.resent = true
      resend = { entry = e, question = e.shown or e.question, chatId = c.id }
    end
  end)
  if resend then
    C_Timer.After(0, function() Core:Ask(resend.question, nil, resend.chatId, resend.entry) end)
  end
  return any
end

-- Earlier answered turns of a chat (before the question being asked now).
function Core:RecentTurns(chatData, n)
  local turns = {}
  local messages = chatData and chatData.messages or {}
  for i = #messages, 1, -1 do
    local e = messages[i]
    if e.status == "done" then
      table.insert(turns, 1, { q = e.question, a = (e.answer or ""):sub(1, HISTORY_ANSWER_CHARS) })
      if #turns >= n then break end
    end
  end
  return turns
end

-- Sections that change on almost every question are always sent in full.
local ALWAYS_SEND = { localTime = true, serverTime = true, diagnostics = true }

-- Work allowed per frame while preparing a question, in milliseconds.
-- Spreading the work over several frames is what keeps the game from stuttering.
Core.BUDGET_MS = 4

local floor = math.floor
local function now()
  return debugprofilestop and debugprofilestop() or GetTime() * 1000
end

-- Pauses the preparation until the next frame once this frame's budget is used.
-- Only valid inside the preparation coroutine.
function Core.step()
  if now() > (Core.deadline or 0) then coroutine.yield() end
end

-- Copies of a list of tables without some keys (cached data is never modified).
local function without(list, keys, keep)
  if type(list) ~= "table" then return list end
  local out = {}
  for _, item in ipairs(list) do
    if type(item) == "table" then
      if not keep or keep(item) then
        local copy = {}
        for k, v in pairs(item) do copy[k] = v end
        for _, k in ipairs(keys) do copy[k] = nil end
        out[#out + 1] = copy
      end
    else
      out[#out + 1] = item
    end
  end
  return out
end

-- Successive reductions if a request does not fit. Each one replaces whole
-- sections with smaller copies.
-- Known recipes without the ones that no longer give skill, and without reagents.
local function slimRecipes(list)
  if type(list) ~= "table" then return list end
  local out = {}
  for _, p in ipairs(list) do
    local copy = {}
    for k, v in pairs(p) do copy[k] = v end
    copy.recipes = without(p.recipes, { "reagents" }, function(r) return r.difficulty ~= "grey" end)
    out[#out + 1] = copy
  end
  return out
end

-- Open windows with shorter lists: vendor and loot items without their stats,
-- and at most 25 vendor items / 30 trainer services.
local function slimScreen(screen)
  if type(screen) ~= "table" then return screen end
  local out = {}
  for k, v in pairs(screen) do out[k] = v end
  local function first(list, n)
    if type(list) ~= "table" then return list end
    local cut = {}
    for i = 1, math.min(#list, n) do cut[i] = list[i] end
    return cut
  end
  if type(screen.merchant) == "table" then
    local m = {}
    for k, v in pairs(screen.merchant) do m[k] = v end
    m.items = first(without(screen.merchant.items, { "stats", "effects" }), 25)
    out.merchant = m
  end
  if type(screen.trainer) == "table" then
    local t = {}
    for k, v in pairs(screen.trainer) do t[k] = v end
    t.services = first(screen.trainer.services, 30)
    out.trainer = t
  end
  out.loot = without(screen.loot, { "stats", "effects" })
  if type(screen.auction) == "table" then
    local a = {}
    for k, v in pairs(screen.auction) do a[k] = v end
    a.results = first(screen.auction.results, 15)
    a.myAuctions = first(screen.auction.myAuctions, 15)
    out.auction = a
  end
  if type(screen.flightMap) == "table" then
    out.flightMap = { from = screen.flightMap.from, destinations = without(screen.flightMap.destinations, { "stops" }) }
  end
  return out
end

-- Completed quests cut to 40 per zone (what the companion shows unless the
-- question is about quests), with how many more. Copies: the lists are cached.
local DONE_SHOWN = 40
local function fewerDone(t, listKey, moreKey)
  local l = type(t) == "table" and t[listKey]
  if type(l) ~= "table" or #l <= DONE_SHOWN then return t end
  local copy = {}
  for k, v in pairs(t) do copy[k] = v end
  local cut = {}
  for i = 1, DONE_SHOWN do cut[i] = l[i] end
  copy[listKey] = cut
  copy[moreKey] = (tonumber(t[moreKey]) or 0) + #l - DONE_SHOWN
  return copy
end

local TRIMS = {
  function(ctx)
    ctx.completedQuests = fewerDone(ctx.completedQuests, "inZone", "more")
    if type(ctx.availableQuestsAsked) == "table" then
      local zones = {}
      for i, z in ipairs(ctx.availableQuestsAsked) do zones[i] = fewerDone(z, "done", "doneMore") end
      ctx.availableQuestsAsked = zones
    end
  end,
  function(ctx) ctx.bank = nil end,
  function(ctx) ctx.knownRecipes = slimRecipes(ctx.knownRecipes) end,
  function(ctx) ctx.screen = slimScreen(ctx.screen) end,
  function(ctx, req) req.history = nil end,
  function(ctx) ctx.quests = without(ctx.quests, { "rewardItems", "rewardChoices" }) end,
  function(ctx)
    ctx.inventory = without(ctx.inventory, { "stats", "effects" }, function(it) return it.quality ~= "poor" end)
  end,
  function(ctx)
    ctx.spells, ctx.currencies, ctx.reputations = nil, nil, nil
    ctx.actionBars, ctx.spellsNotOnBars, ctx.stable, ctx.auctionPrices = nil, nil, nil, nil
  end,
  function(ctx) ctx.quests = without(ctx.quests, { "goal", "nextStep" }) end,
  function(ctx)
    ctx.gear = without(ctx.gear, { "stats", "effects" })
    ctx.quests = without(ctx.quests, { "objectives" })
  end,
  function(ctx) ctx.knownRecipes = nil end,
  function(ctx) ctx.quests, ctx.professions, ctx.inventory = nil, nil, nil end,
}

-- Request JSON from sections that are (mostly) already encoded.
local function assemble(req, ctx, encoded, step)
  local keys = {}
  for k in pairs(ctx) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for _, k in ipairs(keys) do
    parts[#parts + 1] = '"' .. k .. '":' .. (encoded[k] or ns.Json.Encode(ctx[k]))
    step()
  end
  local head = ns.Json.Encode(req) -- everything except the context
  return head:sub(1, -2) .. ',"context":{' .. table.concat(parts, ",") .. "}}"
end

-- Gathers the character data and turns it into the bytes to draw.
-- Only what changed is sent: sections whose hash the companion already
-- confirmed (it answered a request that carried them) go as { name = hash }
-- in `same`, and the companion fills them in from its cache.
-- maxBytes: size limit for channels without the screen's limits (voice).
-- extra: more context for this question only (e.g. the items linked in it).
function Core:BuildFrame(req, step, maxBytes, extra)
  local fits = maxBytes and function(len) return len <= maxBytes end
    or function(len) return ns.Uplink:Fits(len) end
  local t0 = now()
  local snap, meta, errors = ns.Collect:Gather(step)
  for k, v in pairs(extra or {}) do snap[k] = v end
  local t1 = now()
  local acked = self:CharData().acked or {}
  local ctx, encoded, hashes, same = {}, {}, {}, {}
  for k, v in pairs(snap) do
    local m = meta[k]
    if m and not ALWAYS_SEND[k] and acked[k] == m.hash then
      same[k] = m.hash
    else
      ctx[k] = v
      if m then encoded[k], hashes[k] = m.json, m.hash end
    end
  end
  if next(errors) then ctx.diagnostics = errors end
  req.hashes, req.same = hashes, same

  local frame, json
  for level = 0, #TRIMS do
    if level > 0 then
      local before = {}
      for k, v in pairs(ctx) do before[k] = v end
      TRIMS[level](ctx, req)
      -- Trimmed sections are re-encoded and not cached by the companion.
      for k, v in pairs(before) do
        if ctx[k] ~= v then encoded[k], hashes[k] = nil, nil end
      end
    end
    json = assemble(req, ctx, encoded, step)
    frame = ns.Uplink.Frame(json, step)
    if fits(#frame) then
      self.lastEncode = {
        level = level, bytes = #frame, json = #json,
        collectMs = floor(t1 - t0), encodeMs = floor(now() - t1),
      }
      return frame
    end
    step()
  end
  self.lastEncode = { failed = string.format(L.FRAME_TOO_BIG, #frame, #json) }
  return nil, self.lastEncode.failed
end


-- Per-character data remembered between sessions.
-- The character's key in the saved data: its unique id (the player GUID,
-- "Player-6932-005792F1"), which doesn't depend on the realm's name: WoW
-- Forever's build 71037 gives a blank one. Before the game knows the GUID, or
-- on a client without it: "Name-Realm", as it used to be.
function Core.CharKey()
  local guid = UnitGUID and UnitGUID("player")
  if type(guid) == "string" and guid:match("^Player%-") then return guid end
  return (UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?")
end

-- The latest date a store saw something (its "seenAt" and turn-in dates).
local function newestSeen(data)
  local newest = ""
  local function see(d) if type(d) == "string" and d > newest then newest = d end end
  for _, k in ipairs({ "bank", "beastTraining", "stable" }) do see(type(data[k]) == "table" and data[k].seenAt) end
  for _, k in ipairs({ "flights", "recipes" }) do
    for _, v in pairs(type(data[k]) == "table" and data[k] or {}) do see(type(v) == "table" and v.seenAt) end
  end
  for _, v in pairs(type(data.questsDone) == "table" and data.questsDone or {}) do see(type(v) == "table" and v.d) end
  return newest
end

-- Adds a store to the merged one, src being the newer: what has a date keeps
-- the newer copy, lists add up, the 10 last turn-ins keep the newer first.
local function mergeStore(dst, src)
  local function newer(a, b) return type(b) == "table" and (type(a) ~= "table" or (b.seenAt or "") >= (a.seenAt or "")) end
  for k, v in pairs(src) do
    if k == "bank" or k == "beastTraining" or k == "stable" then
      if newer(dst[k], v) then dst[k] = v end
    elseif k == "flights" or k == "recipes" then
      dst[k] = dst[k] or {}
      for sub, e in pairs(type(v) == "table" and v or {}) do
        if newer(dst[k][sub], e) then dst[k][sub] = e end
      end
    elseif k == "questsDone" or k == "flightPaths" then
      dst[k] = dst[k] or {}
      for id, e in pairs(type(v) == "table" and v or {}) do dst[k][id] = e end
    elseif k == "turnedIn" then
      local list = {}
      for _, t in ipairs(type(v) == "table" and v or {}) do list[#list + 1] = t end
      for _, t in ipairs(type(dst.turnedIn) == "table" and dst.turnedIn or {}) do list[#list + 1] = t end
      while #list > 10 do table.remove(list) end
      dst.turnedIn = list
    elseif k ~= "acked" and k ~= "resyncSeen" then
      dst[k] = v
    end
  end
end

-- First time a character is seen by its GUID: its stores under "Name-Realm"
-- (the old realm name, and the blank one since Forever's build 71037) are
-- merged into it, oldest first, and removed. The realms they came from are
-- kept in "oldRealms" (for the auction prices and the chosen assistant).
-- What the companion had cached ("acked") starts over: everything is sent once.
local function migrateCharacter(guid)
  local name = UnitName("player")
  local found = {}
  for key, data in pairs(ns.db.chars) do
    if type(key) == "string" and type(data) == "table" and name and not key:match("^Player%-")
      and key:sub(1, #name + 1) == name .. "-" and not data.guid then
      found[#found + 1] = { key = key, realm = key:sub(#name + 2), data = data, newest = newestSeen(data) }
    end
  end
  table.sort(found, function(a, b)
    if a.newest ~= b.newest then return a.newest < b.newest end
    return a.key < b.key
  end)
  local merged, realms = { guid = guid }, {}
  for _, f in ipairs(found) do
    mergeStore(merged, f.data)
    realms[#realms + 1] = f.realm
    ns.db.chars[f.key] = nil
  end
  merged.guid = guid
  merged.oldRealms = #realms > 0 and realms or nil
  ns.db.chars[guid] = merged
end

function Core:CharData()
  if not ns.db then return nil end
  local key = Core.CharKey()
  ns.db.chars = ns.db.chars or {}
  if not ns.db.chars[key] and key:match("^Player%-") then pcall(migrateCharacter, key) end
  ns.db.chars[key] = ns.db.chars[key] or {}
  return ns.db.chars[key]
end

-- allowEmpty: the bank is known to be open, so nothing in it means it is empty
-- (right after it opens, an empty read may just be the bank not loaded yet).
function Core:RememberBank(allowEmpty)
  local items = ns.Collect.ContainerItems(ns.Collect.BankBags(), false)
  if items and (#items > 0 or allowEmpty) then
    self:CharData().bank = { seenAt = date("%Y-%m-%d %H:%M"), items = items }
  end
end

-- At a flight master: which flight points of this continent the player can fly
-- to and which they haven't discovered, replacing what was seen here before
-- (Collect.FlightMapStatus). The older list of names (data.flightPaths) is
-- only read now, for continents not seen again yet.
function Core:RememberFlightPaths()
  local status = ns.Collect.FlightMapStatus()
  if not status then return end
  local data = self:CharData()
  data.flights = data.flights or {}
  data.flights[status.continent] = {
    name = status.name, seenAt = date("%Y-%m-%d %H:%M"), known = status.known, notKnown = status.notKnown,
  }
end

-- The open profession window's recipes, remembered per character and
-- profession (the game only lists them while the window is open).
-- kind: "craft" for the classic enchanting-style window.
function Core:RememberRecipes(kind)
  local p = ns.Collect:Recipes(kind)
  if not p or not p.profession or #p.recipes == 0 then return end
  p.seenAt = date("%Y-%m-%d %H:%M")
  local data = self:CharData()
  data.recipes = data.recipes or {}
  data.recipes[p.profession] = p
end

-- What Beast Training teaches and the pet already knows, remembered (the
-- game only lists it while the window is open).
function Core:RememberBeastTraining(kind)
  local b = ns.Collect:BeastTraining(kind)
  if not b then return false end
  b.seenAt = date("%Y-%m-%d %H:%M")
  self:CharData().beastTraining = b
  return true
end

-- Auction prices seen, per realm and faction (each has its own auction house):
-- itemId -> { name, unit = cheapest buyout per item in copper, seenAt }.
local MAX_PRICES = 1000
-- Per server (the number in the player GUID, as the realm's name can be blank)
-- and faction. The first time, the prices kept under the realm names this
-- character's data came from are merged in (the newer price per item wins).
function Core:Prices()
  if not ns.db then return nil end
  local faction = UnitFactionGroup and UnitFactionGroup("player") or "?"
  local server = Core.CharKey():match("^Player%-(%d+)%-")
  local key = (server or (GetRealmName and GetRealmName() or "?")) .. "-" .. faction
  ns.db.prices = ns.db.prices or {}
  if not ns.db.prices[key] and server then
    local merged = {}
    local data = self:CharData()
    local realms = {}
    for _, r in ipairs(type(data.oldRealms) == "table" and data.oldRealms or {}) do realms[#realms + 1] = r end
    realms[#realms + 1] = GetRealmName and GetRealmName() or ""
    for _, realm in ipairs(realms) do
      local old = ns.db.prices[realm .. "-" .. faction]
      for id, p in pairs(type(old) == "table" and old or {}) do
        if type(p) == "table" and (not merged[id] or (p.seenAt or "") >= (merged[id].seenAt or "")) then merged[id] = p end
      end
      ns.db.prices[realm .. "-" .. faction] = nil
    end
    ns.db.prices[key] = merged
  end
  ns.db.prices[key] = ns.db.prices[key] or {}
  return ns.db.prices[key]
end

function Core:RememberPrices()
  local prices = self:Prices()
  if not prices then return end
  local seenAt = date("%Y-%m-%d %H:%M")
  for _, p in ipairs(ns.Collect:AuctionPrices() or {}) do
    if p.itemId and p.unit and p.unit > 0 and p.name then
      prices[p.itemId] = { name = p.name, unit = math.floor(p.unit), seenAt = seenAt }
    end
  end
  -- Keep the most recent ones.
  local ids = {}
  for id in pairs(prices) do ids[#ids + 1] = id end
  if #ids > MAX_PRICES then
    table.sort(ids, function(a, b) return prices[a].seenAt > prices[b].seenAt end)
    for i = MAX_PRICES + 1, #ids do prices[ids[i]] = nil end
  end
end

function Core:RememberStable()
  local pets = ns.Collect:StablePets()
  if pets then self:CharData().stable = { seenAt = date("%Y-%m-%d %H:%M"), pets = pets } end
end

-- A quest turned in: the last 10 titles (recentlyCompletedQuests), and every
-- quest by id with its title and the zone the quest log listed it under
-- (QuestHelp: what was done where).
function Core:RememberTurnIn(questID)
  local entry = ns.QuestHelp and ns.QuestHelp:LogEntry(questID)
  local title = C_QuestLog and C_QuestLog.GetTitleForQuestID and C_QuestLog.GetTitleForQuestID(questID)
  title = title or (entry and entry.title)
  local data = self:CharData()
  if title then
    data.turnedIn = data.turnedIn or {}
    table.insert(data.turnedIn, 1, title)
    while #data.turnedIn > 10 do table.remove(data.turnedIn) end
  end
  if type(questID) == "number" then
    data.questsDone = data.questsDone or {}
    data.questsDone[questID] = { t = title, z = entry and entry.zone, d = date("%Y-%m-%d") }
  end
  if ns.QuestHelp then ns.QuestHelp:Refresh() end
end

-- `extra`: additional request fields (used by the channel probe).
-- `chatId`: chat the question belongs to (default: the open one).
-- `listen`: a voice question: no text yet, the app records what the player
-- says (see Core:Listen). Only through the invisible voice.
-- Returns the request id, or nil when nothing was sent.
-- `again`: a question already asked (its chat entry), sent once more through
-- the strip with the same id (see VOICE_TIMEOUT). Upstream passes it as the
-- 4th argument, so a table there is `again`, never `listen`: a resend must
-- never start a recording.
function Core:Ask(question, extra, chatId, listen, again)
  if type(listen) == "table" then listen, again = nil, listen end
  listen = listen == true or nil

  -- Items (and spells, quests...) linked with shift-click go along with their
  -- full description; the question itself keeps just their "[Name]".
  local linked = not listen and ns.Collect:Links(question) or nil
  local shown = linked and strtrim(question) or nil -- with the links, for the chat bubble
  question = listen and "" or strtrim(ns.Collect.Clean(question or "") or "")
  if question == "" and not listen then return end
  -- Compact answers (Compact.lua): asking with the window closed shows the
  -- small box instead of opening the window.
  local compact = ns.Compact and ns.Compact:Active()
  local function say(msg, bad)
    if compact then ns.Compact:Message(bad and ("|cffff6060" .. msg .. "|r") or msg)
    else ns.UI:SetStatus(bad and ("|cffff6060" .. msg .. "|r") or msg) end
  end
  -- Asking in combat is allowed, typed or by voice: the window then warns the
  -- player to keep an eye on the game, or dims, as chosen in the options (see
  -- Combat in UI.lua and Fade.lua). A resend never opens the window.
  if not compact and not again then ns.UI:Show() end

  if self.working or ns.Uplink.busy then
    say(L.WAIT_PREVIOUS)
    return
  end
  if listen and not ns.Voice:Available() then
    say(L.TALK_NEEDS_VOICE, true)
    return
  end

  -- Asking before choosing an assistant: keep the one of the character's faction.
  if not ns.Personas:Chosen() then ns.Personas:Set(ns.Personas:Suggested().id) end
  ns.UI.choosing = false

  -- The question belongs to the open chat (or to the given one, for resends).
  local chatData = ns.Chats:Get(chatId) or ns.Chats:Current()
  local id = again and again.id or string.format("%d%04d", time(), math.random(0, 9999))
  local sig, resetSignals = ns.Live:RequestFields()
  local req = {
    v = 2,
    id = id,
    question = question,
    sig = sig,
    resetSignals = resetSignals,
    charKey = Core.CharKey(),
    assistant = ns.Personas:Current().id,
    lang = L.code,                  -- the app writes its error messages in this language
    history = self:RecentTurns(chatData, HISTORY_TURNS_SENT),
    auth = self:AuthCode(id),       -- this PC's code for this request (see Core:AuthCode)
  }
  for k, v in pairs(extra or {}) do req[k] = v end
  if listen then req.listen = true end

  local entry = again or { id = id, question = question, shown = shown, status = "pending", t = time(), listen = listen }
  if not again then ns.Chats:AddMessage(chatData, entry) end

  req.chat = { id = chatData.id, title = chatData.title }
  if compact and not again then ns.Compact:Show(entry, chatData) end

  local function fail(msg)
    Core.working = false
    if listen then Core:EndListening() end
    entry.status = "error"
    entry.answer = msg
    ns.UI:SetStatus("")
    ns.UI:Refresh()
  end

  ns.UI:Refresh()
  ns.UI:SetStatus(L.PREPARING)
  self.working = true

  -- The preparation runs a few milliseconds per frame (see Core.step).
  -- Invisible voice channel when available; otherwise the strip on screen.
  local context = linked and { linkedItems = linked } or nil
  local co = coroutine.create(function()
    -- A zone named in the question: the quests available there (QuestHelp).
    -- In a coroutine of its own: it pauses with the preparation, and if it
    -- fails, the question still goes without it.
    if not listen and ns.QuestHelp then
      local sub = coroutine.create(function() return ns.QuestHelp:ForQuestion(question, Core.step, linked) end)
      local asked
      while true do
        local ok, res = coroutine.resume(sub)
        if not ok then break end
        if coroutine.status(sub) == "dead" then asked = res break end
        coroutine.yield()
      end
      if asked then
        context = context or {}
        context.availableQuestsAsked = asked.zones
        context.questsAsked = asked.quests
      end
    end
    if not again and ns.Voice:Available() then
      local frame = Core:BuildFrame(req, Core.step, ns.Voice.MAX_FRAME_BYTES, context)
      if frame and ns.Voice:Send(frame, req.id, Core.step) then
        Core.lastChannel = "voice"
        return true, "voice"
      end
    end
    if listen then return false, L.TALK_SEND_FAILED end -- never the strip: it can't stop in time
    Core.lastChannel = "strip"
    local frame, why = Core:BuildFrame(req, Core.step, nil, context)
    if not frame then return false, why end
    return ns.Uplink:Prepare(frame, Core.step)
  end)
  self.driver = self.driver or CreateFrame("Frame")
  local frames = 0
  self.driver:SetScript("OnUpdate", function(f)
    frames = frames + 1
    Core.deadline = now() + Core.BUDGET_MS
    local resumed, ok, err = coroutine.resume(co)
    if coroutine.status(co) ~= "dead" then return end
    f:SetScript("OnUpdate", nil)
    if not resumed then
      fail(string.format(L.PREP_ERROR, tostring(ok)))
      return
    end
    if not ok then
      fail(string.format(L.PREP_FAILED, tostring(err)))
      return
    end
    if Core.lastEncode then Core.lastEncode.frames = frames end
    entry.sent = req.hashes
    if err == "voice" then
      entry.viaVoice = true
      Core.working = false
      ns.UI:SetStatus(listen and L.TALK_LISTENING or string.format(L.SENT_TO, ns.Personas:Current().name))
      ns.Live:OnSent()
      if listen then Core:ListenSent(id) end
      return
    end
    ns.UI:SetStatus(string.format(L.SENDING, ns.Uplink.last.bytes / 1024))
    ns.Uplink:Reveal(function()
      Core.working = false
      ns.UI:SetStatus(string.format(L.SENT_TO, ns.Personas:Current().name))
      ns.Live:OnSent()
    end)
  end)
  return id
end


function Core:ApplyInbox(inbox)
  if type(inbox) ~= "table" or type(inbox.answers) ~= "table" then return end
  local arrived = 0
  local toNotify = {}
  local answered = {}
  local data = self:CharData()
  for _, a in ipairs(inbox.answers) do
    local entry, owner
    if type(a) == "table" then entry, owner = self:FindEntry(a.id) end
    -- Pending, or given up waiting: an answer that arrives late is still shown.
    if entry and (entry.status == "pending" or entry.timedOut) then
      entry.timedOut = nil
      -- It came back: the app got the question, so the voice works after all.
      if entry.viaVoice then ns.Voice.broken = nil end
      entry.status = a.ok and "done" or "error"
      entry.answer = a.answer
      -- Voice question: what the app heard becomes the question.
      if entry.listen and type(a.question) == "string" and a.question ~= "" then entry.question = a.question end
      if Core.listening and Core.listening.id == a.id then Core:EndListening() end
      -- Tokens the answer used (read, of which cached, written), if the AI said.
      if type(a.tokens) == "table" then
        entry.tokens = { i = tonumber(a.tokens.i) or 0, c = tonumber(a.tokens.c) or 0, o = tonumber(a.tokens.o) or 0 }
      end
      arrived = arrived + 1
      answered[#answered + 1] = { id = a.id, ok = a.ok and true or false }
      -- Chats with news the player is not looking at: mark and notify.
      owner.updated = time()
      if owner.id ~= ns.db.currentChat or not ns.UI:IsShown() then
        owner.unread = true
        toNotify[#toNotify + 1] = { entry = entry, chat = owner }
      end
      -- The companion has now cached these sections: next time, skip them.
      data.acked = data.acked or {}
      for k, h in pairs(entry.sent or {}) do data.acked[k] = h end
      entry.sent = nil
    end
  end
  -- The companion lost its cache: send everything next time.
  if inbox.resync and tonumber(inbox.resync) and tonumber(inbox.resync) > (data.resyncSeen or 0) then
    data.resyncSeen = tonumber(inbox.resync)
    data.acked = nil
  end
  -- The companion saw our screenshot but could not read it: fail the
  -- questions sent shortly before that instead of waiting forever.
  local failedAt = tonumber(inbox.failedAt)
  if failedAt then
    ns.Chats:EachEntry(function(e)
      if e.status == "pending" and e.t and e.t <= failedAt and e.t >= failedAt - 300 then
        e.status = "error"
        e.answer = (inbox.failMessage or L.READ_FAILED) .. " " .. L.TRY_AGAIN
        arrived = arrived + 1
      end
    end)
  end
  if arrived > 0 then
    ns.Live:OnAnswer()
    ns.UI:SetStatus("")
    ns.UI:Refresh()
    if ns.Button then ns.Button:Update() end
    if #toNotify > 0 and ns.Compact and ns.Compact:Active() then
      -- Compact answers: the newest in the box, any others as cards.
      local last = table.remove(toNotify)
      ns.Compact:Show(last.entry, last.chat)
      if ns.Notify then for _, n in ipairs(toNotify) do ns.Notify:Show(n.entry, n.chat) end end
    elseif #toNotify > 0 and ns.Notify then
      for _, n in ipairs(toNotify) do ns.Notify:Show(n.entry, n.chat) end
    elseif ns.Button and ns.Button.Celebrate then
      ns.Button:Celebrate() -- answer in the open chat: no card, just the hop
    end
  end
  -- The channel test waits for the app's answer before it starts.
  if ns.Probe and ns.Probe.OnAnswer then
    for _, a in ipairs(answered) do ns.Probe:OnAnswer(a.id, a.ok) end
  end
end

-- Voice questions -------------------------------------------------------------
-- The talk key (hold) or the Talk button (click to start, click to stop)
-- sends a "listen" request with the character data; the app records the
-- question until the key is released or the player stops talking, and answers
-- it with what it heard. Follow-up questions work the same way: they go to
-- the open chat with its earlier turns.
local LISTEN_TIMEOUT = 40 -- seconds: the app stops recording at 30 at the latest

function Core:Listen(chatId)
  if self.listening then return end
  local id = self:Ask(nil, nil, chatId, true)
  if not id then return end
  local l = { id = id }
  self.listening = l
  ns.UI:RefreshTalkButton()
  if ns.Compact then ns.Compact:Refresh() end
  C_Timer.After(LISTEN_TIMEOUT, function()
    if Core.listening == l then Core:EndListening() end
  end)
end

-- The listen request went out: if the key was already released, stop now.
function Core:ListenSent(id)
  local l = self.listening
  if not l or l.id ~= id then return end
  l.sent = true
  if l.stopWanted then self:StopListening() end
end

-- Tells the app the question is over (only needed before it hears a pause).
function Core:StopListening()
  local l = self.listening
  if not l then return end
  if not l.sent then
    l.stopWanted = true -- still being sent: stop right after
    return
  end
  local json = ns.Json.Encode({ v = 2, id = l.id .. "s", question = "", listenStop = l.id, auth = Core:AuthCode(l.id .. "s") })
  ns.Voice:Send(ns.Uplink.Frame(json), l.id .. "s")
  self:EndListening()
  ns.UI:SetStatus(string.format(L.SENT_TO, ns.Personas:Current().name))
end

function Core:EndListening()
  self.listening = nil
  ns.UI:RefreshTalkButton()
  if ns.Compact then ns.Compact:Refresh() end
end

function Core:ToggleListen()
  if self.listening then self:StopListening() else self:Listen() end
end

-- Key binding (Bindings.xml): down starts, up stops.
function Core:TalkKey(keystate)
  if keystate == "up" then self:StopListening() else self:Listen() end
end

function ForeverAICompanion_Talk(keystate)
  Core:TalkKey(keystate)
end

BINDING_NAME_FOREVERAICOMPANION_TALK = L.BINDING_TALK

-- Events ------------------------------------------------------------------

local events = CreateFrame("Frame")
for _, e in ipairs({ "ADDON_LOADED", "PLAYER_LOGIN", "BANKFRAME_OPENED", "BANKFRAME_CLOSED",
                     "PLAYERBANKSLOTS_CHANGED", "BAG_UPDATE_DELAYED", "TAXIMAP_OPENED", "QUEST_TURNED_IN",
                     "TRADE_SKILL_SHOW", "TRADE_SKILL_UPDATE", "TRADE_SKILL_LIST_UPDATE",
                     "CRAFT_SHOW", "CRAFT_UPDATE", "TRAINER_SHOW", "TRAINER_UPDATE",
                     "PET_STABLE_SHOW", "PET_STABLE_UPDATE",
                     "AUCTION_HOUSE_BROWSE_RESULTS_UPDATED", "AUCTION_HOUSE_BROWSE_RESULTS_ADDED",
                     "COMMODITY_SEARCH_RESULTS_UPDATED", "ITEM_SEARCH_RESULTS_UPDATED",
                     "AUCTION_ITEM_LIST_UPDATE" }) do
  pcall(events.RegisterEvent, events, e)
end

-- Profession windows fire their update events in bursts: read once it settles.
-- "trainer" is Beast Training (a trainer window in WoW Forever).
local RECIPE_EVENTS = {
  TRADE_SKILL_SHOW = "trade", TRADE_SKILL_UPDATE = "trade", TRADE_SKILL_LIST_UPDATE = "trade",
  CRAFT_SHOW = "craft", CRAFT_UPDATE = "craft", TRAINER_SHOW = "trainer", TRAINER_UPDATE = "trainer",
  -- Auction results on screen: remember their prices.
  AUCTION_HOUSE_BROWSE_RESULTS_UPDATED = "prices", AUCTION_HOUSE_BROWSE_RESULTS_ADDED = "prices",
  COMMODITY_SEARCH_RESULTS_UPDATED = "prices", ITEM_SEARCH_RESULTS_UPDATED = "prices",
  AUCTION_ITEM_LIST_UPDATE = "prices",
}
local recipesPending = {}
local function rememberRecipesSoon(kind)
  if recipesPending[kind] then return end
  recipesPending[kind] = true
  C_Timer.After(0.5, function()
    recipesPending[kind] = nil
    if kind == "prices" then
      pcall(Core.RememberPrices, Core)
    elseif kind == "trainer" then
      pcall(Core.RememberBeastTraining, Core)
    elseif kind == "craft" then
      -- A classic craft window is either enchanting or Beast Training.
      local ok, isBeast = pcall(Core.RememberBeastTraining, Core, "craft")
      if not (ok and isBeast) then pcall(Core.RememberRecipes, Core, kind) end
    else
      pcall(Core.RememberRecipes, Core, kind)
    end
  end)
end

events:SetScript("OnEvent", function(_, event, arg1)
  if event == "ADDON_LOADED" and arg1 == ADDON then
    ForeverAICompanion_DB = ForeverAICompanion_DB or {}
    ns.db = ForeverAICompanion_DB
    ns.Chats:Init()
    if ns.Options then pcall(ns.Options.Init, ns.Options) end
  elseif event == "PLAYER_LOGIN" then
    ns.Uplink:Init()
    ns.Live:Init()
    if ns.Button then pcall(ns.Button.Init, ns.Button) end
    -- Build the strip's textures in the background once the login rush is over.
    C_Timer.After(5, function() pcall(ns.Uplink.Warmup, ns.Uplink) end)
  elseif not ns.db then
    return
  elseif event == "BANKFRAME_OPENED" then
    -- Bank contents are only readable while it is open: remember them now and
    -- after every change during the visit, in its main slots
    -- (PLAYERBANKSLOTS_CHANGED) or in the bags inside it (BAG_UPDATE_DELAYED),
    -- so what is remembered is the bank as it was left.
    Core.bankOpen = true
    pcall(Core.RememberBank, Core)
  elseif event == "BANKFRAME_CLOSED" then
    Core.bankOpen = nil -- not readable any more: keep what was seen
  elseif event == "PLAYERBANKSLOTS_CHANGED" or (event == "BAG_UPDATE_DELAYED" and Core.bankOpen) then
    pcall(Core.RememberBank, Core, Core.bankOpen)
  elseif event == "TAXIMAP_OPENED" then
    pcall(Core.RememberFlightPaths, Core)
  elseif event == "QUEST_TURNED_IN" then
    pcall(Core.RememberTurnIn, Core, arg1)
  elseif RECIPE_EVENTS[event] then
    rememberRecipesSoon(RECIPE_EVENTS[event])
  elseif event == "PET_STABLE_SHOW" or event == "PET_STABLE_UPDATE" then
    pcall(Core.RememberStable, Core)
  end
end)

-- Slash commands -------------------------------------------------------------

-- Subcommands work in English and Spanish, whatever the game's language.
local COMMANDS = {
  new = "new", nuevo = "new",
  data = "data", datos = "data",
  inbox = "inbox", buzon = "inbox", ["buzón"] = "inbox",
  status = "status", estado = "status",
  probe = "probe", probar = "probe", ["probar-canales"] = "probe",
  ["test-voice"] = "voice", ["probar-voz"] = "voice",
  talk = "talk", hablar = "talk",
  options = "options", opciones = "options",
  compact = "compact", compacto = "compact",
  button = "button", boton = "button", ["botón"] = "button",
  sound = "sound", sonido = "sound",
  assistant = "assistant", asistente = "assistant",
  help = "help", ayuda = "help",
}
Core.COMMANDS = COMMANDS

SLASH_FOREVERAICOMPANION1 = "/ia"
SLASH_FOREVERAICOMPANION2 = "/azia"
SLASH_FOREVERAICOMPANION3 = "/ai"
SlashCmdList.FOREVERAICOMPANION = function(msg)
  msg = strtrim(msg or "")
  local lower = msg:lower()
  local word, rest = lower:match("^(%S+)%s*(.-)$")
  local cmd = COMMANDS[word or ""]
  if lower == "" then
    ns.UI:Toggle()
  elseif cmd == "data" and rest == "" then
    ns.UI:ShowContext()
  elseif cmd == "inbox" and rest == "" then
    ns.Live:LoadNextSlot()
  elseif cmd == "status" and rest == "" then
    chat(ns.Live:Status())
  elseif cmd == "probe" and rest == "" then
    ns.Probe:Run()
  elseif cmd == "voice" and rest == "" then
    ns.Voice:Diagnose()
  elseif cmd == "talk" and rest == "" then
    Core:ToggleListen()
  elseif cmd == "compact" and rest == "" then
    chat(ns.Compact:Toggle() and L.COMPACT_ON or L.COMPACT_OFF)
  elseif cmd == "options" and rest == "" then
    if not (ns.Options and ns.Options:Open()) then chat(L.OPTIONS_UNAVAILABLE) end
  elseif cmd == "button" and rest == "" then
    ns.Button:Toggle()
  elseif cmd == "button" and rest == "reset" then
    ns.Button:Reset()
    chat(L.BUTTON_RESET)
  elseif cmd == "sound" and rest == "" then
    chat(ns.Notify:ToggleSound() and L.SOUND_ON or L.SOUND_OFF)
  elseif cmd == "new" and rest == "" then
    ns.Chats:New()
    ns.UI:Show()
    ns.UI:Refresh()
  elseif cmd == "assistant" and rest == "" then
    ns.UI:ShowChooser()
  elseif cmd == "assistant" and (rest == "fizzi" or rest == "rizzik") then
    ns.Personas:Set(rest)
    chat(string.format(L.NOW_YOUR_ASSISTANT, ns.Personas:Current().name))
  elseif cmd == "help" and rest == "" then
    chat(L.HELP)
  else
    Core:Ask(msg)
  end
end

function ForeverAICompanion_Toggle()
  ns.UI:Toggle()
end

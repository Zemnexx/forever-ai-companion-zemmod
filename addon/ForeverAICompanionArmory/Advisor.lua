-- Asking the companion app for an analysis, and taking its answer.
--
-- The Armory has no way out of the game of its own: it sends through the
-- main addon (ForeverAICompanionAPI, Plugins.lua there), which adds this PC's
-- request code, picks the channel and brings the answer back. Each kind of
-- analysis sends the parts of the character it needs:
--   talents   the talent trees with descriptions
--   gear      what is worn and owned, the talents taken, items seen in the game
--   rotation  the spellbook with tooltips, combat numbers, talents, gear effects
--   discover  all of the above
-- What the AI is told to do with it is written in the app, not here.
local _, ns = ...
local L = ns.L
local Util = ns.Util

local Advisor = {}
ns.Advisor = Advisor

Advisor.PLUGIN = "armory"
Advisor.API_NEEDED = 1

local COMMON = { "client", "character", "specialization", "stats", "skills" }
local function with(...)
  local out = {}
  for _, k in ipairs(COMMON) do out[#out + 1] = k end
  for _, k in ipairs({ ... }) do out[#out + 1] = k end
  return out
end

-- How long an answer is waited for. The app gives the AI up to 10 minutes,
-- and once more when its first answer could not be used, so anything shorter
-- gives up while the app is still at work (seen on the live client: a gear
-- plan that took longer than the 7 minutes this used to be).
local WAIT = 1260

-- only: sections of the main addon's snapshot to send. sections: the
-- Armory's own data. timeout: seconds to wait for the answer.
local REQUESTS = {
  talents = {
    only = with("gear"), timeout = WAIT,
    sections = function() return { talents = ns.Scan.Talents() } end,
    needs = "talents",
  },
  gear = {
    only = with("gear", "emptySlots", "inventory", "bank", "professions", "reputations", "lockouts", "auctionPrices"), timeout = WAIT,
    sections = function() return { talents = ns.Scan.Talents(), seen = ns.Scan.Seen() } end,
  },
  rotation = {
    only = with("gear", "buffs", "pet"), timeout = WAIT,
    sections = function() return { talents = ns.Scan.Talents(), spells = ns.Scan.Spells(), combat = ns.Scan.Combat() } end,
    needs = "spells",
  },
  discover = {
    only = with("gear", "inventory", "bank", "buffs", "pet"), timeout = WAIT,
    sections = function()
      return { talents = ns.Scan.Talents(), spells = ns.Scan.Spells(), combat = ns.Scan.Combat(), seen = ns.Scan.Seen() }
    end,
  },
}
Advisor.REQUESTS = REQUESTS

local function api()
  local a = ForeverAICompanionAPI
  if type(a) == "table" and type(a.Request) == "function" and (tonumber(a.VERSION) or 0) >= Advisor.API_NEEDED then return a end
  return nil
end
Advisor.API = api

-- Why nothing can be asked right now, or nil.
function Advisor:Blocked()
  local a = api()
  if not a then return L.NEED_COMPANION end
  return nil
end

-- "ready", "closed"... as the main addon sees the app (nil without it).
function Advisor:AppState()
  local a = api()
  return a and a.AppState and a.AppState() or nil
end

function Advisor:IsAsking(kind)
  local asking = ns.Store:Asking(kind)
  return asking ~= nil and (asking.state == "preparing" or asking.state == "sent")
end

function Advisor:AnyAsking()
  for _, kind in ipairs(ns.Store.KINDS) do
    if self:IsAsking(kind) then return true end
  end
  return false
end

local function refresh()
  if ns.UI and ns.UI.Refresh then ns.UI:Refresh() end
end

-- Asks for an analysis. Returns true, or false and why not.
function Advisor:Ask(kind)
  local spec = REQUESTS[kind]
  if not spec then return false, "kind" end
  local a = api()
  if not a then return false, L.NEED_COMPANION end
  if self:IsAsking(kind) then return false, L.ALREADY_ASKING end
  if a.Busy and a.Busy() then return false, L.COMPANION_BUSY end
  local profile = ns.Store:Profile()
  if not profile.spec or profile.spec == "" then return false, L.PICK_SPEC end

  local sections = spec.sections()
  if spec.needs == "talents" and not sections.talents then return false, L.NO_TALENT_DATA end
  if spec.needs == "spells" and not sections.spells then return false, L.NO_SPELL_DATA end

  local started = time()
  -- The weapon in hand now: a result for another one is said to be out of date.
  ns.Store:SetAsking(kind, { state = "preparing", t = started, weapon = ns.Items.EquippedId("mainHand") or 0 })
  local input = { spec = profile.spec, goal = profile.goal, role = profile.role, notes = profile.notes }
  -- The gear plan stays away from what the player left out (dungeons, raids or questing).
  if kind == "gear" then input.without = ns.Store:GearWithout() end
  -- The rotation for fighting several enemies at once, when the player ticked it.
  if kind == "rotation" and ns.Store:Aoe() then input.aoe = true end
  local id, why = a.Request(self.PLUGIN, {
    kind = kind,
    input = input,
    sections = sections,
    only = spec.only,
    summary = string.format("%s: %s (%s, %s)", L.TITLE, L["KIND_" .. kind:upper()], profile.spec, L["GOAL_" .. profile.goal:upper()]),
    timeout = spec.timeout,
    onStatus = function(state, detail, requestId)
      local asking = ns.Store:Asking(kind)
      if not asking or asking.t ~= started then return end
      if state == "sent" then
        asking.state, asking.id = "sent", requestId
        asking.trimmed = type(detail) == "table" and (detail.trimmed or 0) > 0 or nil
      elseif state == "failed" then
        ns.Store:SetAsking(kind, { state = "error", t = time(), message = tostring(detail) })
      end
      refresh()
    end,
  })
  if not id then
    ns.Store:SetAsking(kind, nil)
    return false, why or L.COMPANION_BUSY
  end
  local asking = ns.Store:Asking(kind)
  if asking and asking.t == started then asking.id = id end
  refresh()
  return true
end

-- Seconds since a request was sent, and how long it may take.
function Advisor:Waited(kind)
  local asking = ns.Store:Asking(kind)
  if not asking or not self:IsAsking(kind) then return nil end
  return time() - (asking.t or time()), REQUESTS[kind].timeout
end

-- An answer from the app (also one that arrives after /reload).
function Advisor:OnResult(result)
  if type(result) ~= "table" or not REQUESTS[result.kind] then return end
  local kind = result.kind
  local asking = ns.Store:Asking(kind)
  -- An answer to an older request than the one being asked now: the newer
  -- one is still waited for. A result it brings is kept all the same (it is
  -- a real analysis, paid for, and newer than what is shown); its failure is
  -- not news any more.
  if asking and asking.id and result.id and asking.id ~= result.id and self:IsAsking(kind) then
    if result.ok and type(result.data) == "table" then
      ns.Store:SaveResult(kind, result)
      if kind == "gear" then
        ns.Items.Forget()
        self:PrimeItems()
      end
      Util.chat(string.format(L.READY_EARLIER, L["KIND_" .. kind:upper()]))
      refresh()
    end
    return
  end
  if result.ok and type(result.data) == "table" then
    ns.Store:SaveResult(kind, result, asking and asking.weapon)
    ns.Store:SetAsking(kind, nil)
    if kind == "gear" then
      ns.Items.Forget()
      self:PrimeItems()
    end
    Util.chat(string.format(L.READY, L["KIND_" .. kind:upper()]))
    if ns.Button and ns.Button.Notify then ns.Button:Notify() end
  else
    -- Given up waiting: said in the Armory's own words (the app may still be at work).
    local message = result.timedOut and string.format(L.TIMED_OUT, math.floor(REQUESTS[kind].timeout / 60)) or result.text or L.FAILED
    ns.Store:SetAsking(kind, { state = "error", t = time(), message = message, timedOut = result.timedOut })
  end
  if ns.UI and ns.UI.OnAnalysisDone then ns.UI:OnAnalysisDone(kind) end
  refresh()
end

-- Asks the game about every item id in the gear plan, so links and scores
-- are there when the tab is opened.
function Advisor:PrimeItems()
  local gear = ns.Store:Result("gear")
  for _, slot in ipairs(gear and gear.data and gear.data.slots or {}) do
    for _, pick in ipairs(slot.picks or {}) do
      if type(pick.itemId) == "number" then ns.Items.Info(pick.itemId) end
    end
  end
end

-- At login: requests the main addon no longer waits for (answered while the
-- Armory was off, or lost) stop showing as "waiting".
function Advisor:Reconcile()
  local a = api()
  local pending = a and a.Pending and a.Pending(self.PLUGIN) or {}
  for _, kind in ipairs(ns.Store.KINDS) do
    local asking = ns.Store:Asking(kind)
    if asking and (asking.state == "preparing" or (asking.state == "sent" and not pending[asking.id or ""])) then
      ns.Store:SetAsking(kind, nil)
    end
  end
end

function Advisor:Init()
  local a = api()
  if not a then return false end
  a.Register(self.PLUGIN, {
    onResult = function(result) Advisor:OnResult(result) end,
    onAppState = function() refresh() end,
  })
  self:Reconcile()
  self:PrimeItems()
  return true
end

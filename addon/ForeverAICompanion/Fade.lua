-- Dims the chat window while the character moves or is in combat, so it
-- hides less of the world, and brings it back a moment after stopping or
-- after the fight. Each has its own on/off, opacity and delay; when both
-- apply, the lower opacity wins.
--
-- It stays fully visible while the player is using it: mouse over it, typing
-- in it or asking by voice. Flight paths don't count as moving (a good time
-- to read). Opening it while moving or fighting shows it fully until the
-- character stops or the fight ends.
-- Settings: Options > AddOns > Forever AI Companion (Options.lua).
local _, ns = ...

local Fade = {}
ns.Fade = Fade

-- "enabled" / "opacity" / "delay": while moving (the names from before combat
-- was added, so saved settings keep working).
Fade.DEFAULTS = {
  enabled = true, opacity = 50, delay = 1,
  combat = true, combatOpacity = 30, combatDelay = 2,
}
-- Values test builds 1.12.0 to 1.13.0 saved without the player choosing them.
local SAVED_BY_TEST_BUILDS = { enabled = true, opacity = 60, delay = 1, combat = true, combatOpacity = 30, combatDelay = 2 }
local SAVED_VERSION = 2
Fade.MIN_OPACITY, Fade.MAX_OPACITY, Fade.OPACITY_STEP = 10, 95, 5
Fade.MAX_DELAY, Fade.DELAY_STEP = 10, 0.5

local CHECK = 0.1          -- seconds between checks
local SPEED = 4            -- opacity change per second (a full fade in ~0.25 s)
local PREVIEW = 1.5        -- seconds a changed opacity is shown in the options

local floor, min, max = math.floor, math.min, math.max
local function snap(v, step, lo, hi)
  v = tonumber(v) or lo
  return max(lo, min(hi, floor(v / step + 0.5) * step))
end

-- Only what the player changed is saved (account-wide), so a new default
-- reaches everyone who never changed that setting.
local function saved()
  ns.db.fade = ns.db.fade or {}
  local t = ns.db.fade
  if (t.v or 1) < SAVED_VERSION then
    -- Test builds saved every default: forget the ones still at that value.
    for k, v in pairs(SAVED_BY_TEST_BUILDS) do if t[k] == v then t[k] = nil end end
    t.v = SAVED_VERSION
  end
  return t
end

-- The settings in use: saved choices over the defaults, kept within range.
function Fade:Settings()
  local t = saved()
  local s = {}
  for k, v in pairs(self.DEFAULTS) do
    if t[k] == nil then s[k] = v else s[k] = t[k] end
  end
  s.enabled = s.enabled and true or false
  s.combat = s.combat and true or false
  for _, k in ipairs({ "opacity", "combatOpacity" }) do
    s[k] = snap(s[k], self.OPACITY_STEP, self.MIN_OPACITY, self.MAX_OPACITY)
  end
  for _, k in ipairs({ "delay", "combatDelay" }) do
    s[k] = snap(s[k], self.DELAY_STEP, 0, self.MAX_DELAY)
  end
  return s
end

function Fade:Set(key, value)
  local t = saved()
  t[key] = value
  local s = self:Settings()
  t[key] = s[key] -- saved within range
  if key == "opacity" or key == "combatOpacity" then
    self.previewUntil, self.previewAlpha = GetTime() + PREVIEW, s[key] / 100
  end
  self.next = 0 -- look again right away
end

-- Newer game clients hand some values to addons as "secrets" during combat
-- (the character's speed, for one): they can be passed around, but comparing
-- them or doing math with them is an error. Read them through these: nil
-- means "can't tell right now".
local function plain(fn, ...)
  if type(fn) ~= "function" then return nil end
  local ok, v = pcall(fn, ...)
  if not ok then return nil end
  if issecretvalue and issecretvalue(v) then return nil end
  return v
end

-- Same answer as `test(v)`, or nil if v can't be used (an older client
-- without issecretvalue: the test itself is protected).
local function check(v, test)
  if v == nil then return nil end
  local ok, result = pcall(test, v)
  if ok then return result end
  return nil
end

-- PLAYER_STARTED_MOVING / PLAYER_STOPPED_MOVING: how movement is known when
-- the speed is a secret (in combat).
Fade.movingByEvent = false
local events = CreateFrame and CreateFrame("Frame")
if events then
  pcall(events.RegisterEvent, events, "PLAYER_STARTED_MOVING")
  pcall(events.RegisterEvent, events, "PLAYER_STOPPED_MOVING")
  events:SetScript("OnEvent", function(_, event) Fade.movingByEvent = event == "PLAYER_STARTED_MOVING" end)
end

-- Moving: IsPlayerMoving first (what ForeverForge uses on this client, in
-- combat too), then the speed (a secret in combat on newer clients), then
-- the movement events.
local function moving()
  if check(plain(UnitOnTaxi, "player"), function(v) return v and true or false end) then return false end
  local m = check(plain(IsPlayerMoving), function(v) return v and true or false end)
  if m ~= nil then return m end
  m = check(plain(GetUnitSpeed, "player"), function(v) return v > 0 end)
  if m ~= nil then return m end
  return Fade.movingByEvent and true or false
end

local function fighting()
  -- InCombatLockdown is how addons know about combat, and is never a secret.
  if InCombatLockdown and InCombatLockdown() then return true end
  return check(plain(UnitAffectingCombat, "player"), function(v) return v and true or false end) or false
end

-- The mouse is really on `frame`. Turning the camera with a mouse button held
-- hides the cursor but leaves it where it was, often over the window (all the
-- time in combat): that doesn't count.
function Fade.Hovering(frame)
  if IsMouselooking and IsMouselooking() then return false end
  return frame ~= nil and frame.IsMouseOver ~= nil and frame:IsMouseOver() and true or false
end

-- The player is using the window: never dimmed.
function Fade:InUse()
  local f = self.frame
  if Fade.Hovering(f) then return true end
  local input = ns.UI and ns.UI.input
  if input and input.HasFocus and input:HasFocus() then return true end
  if ns.Core and ns.Core.listening then return true end
  return false
end

-- One reason to dim: its opacity while active, then for `delay` seconds after.
function Fade:Part(now, on, active, opacity, delay, key)
  if not on then
    self[key] = nil
    return 1
  end
  if active then
    self[key] = now
    return opacity / 100
  end
  if self[key] and now - self[key] < delay then return opacity / 100 end
  self[key] = nil
  return 1
end

-- How opaque the window should be right now (0-1).
function Fade:Target(now)
  local s = self:Settings()
  if self.previewUntil and now < self.previewUntil and self.frame and self.frame:IsShown() then return self.previewAlpha end
  if self:InUse() then
    self.movedAt, self.foughtAt = nil, nil
    return 1
  end
  local isMoving, inCombat = moving(), fighting()
  -- Opened on the move or in a fight: full until the character stops or the fight ends.
  if self.holdMove then
    if isMoving then isMoving = false else self.holdMove = nil end
  end
  if self.holdCombat then
    if inCombat then inCombat = false else self.holdCombat = nil end
  end
  return min(
    self:Part(now, s.enabled, isMoving, s.opacity, s.delay, "movedAt"),
    self:Part(now, s.combat, inCombat, s.combatOpacity, s.combatDelay, "foughtAt"))
end

function Fade:Update(elapsed)
  local f = self.frame
  if not f then return end
  local now = GetTime()
  if now >= (self.next or 0) then
    self.next = now + CHECK
    -- Something unexpected (another value the game made secret?): show the
    -- window fully rather than freeze it, and keep the error for /ia status.
    local ok, target = pcall(self.Target, self, now)
    if ok then
      self.target = target
    else
      self.target, self.lastError = 1, tostring(target)
    end
  end
  local target = self.target or 1
  local cur = self.current or 1
  if cur == target then return end
  local d = SPEED * (elapsed or 0)
  cur = cur < target and min(target, cur + d) or max(target, cur - d)
  self.current = cur
  f:SetAlpha(cur)
end

-- Opening the window always shows it fully.
function Fade:Reset()
  self.current, self.target, self.movedAt, self.foughtAt, self.next = 1, 1, nil, nil, 0
  self.holdMove = moving() or nil
  self.holdCombat = fighting() or nil
  if self.frame then self.frame:SetAlpha(1) end
end

function Fade:Attach(frame)
  self.frame = frame
  self:Reset()
  frame:HookScript("OnUpdate", function(_, elapsed) Fade:Update(elapsed) end)
  frame:HookScript("OnShow", function() Fade:Reset() end)
end

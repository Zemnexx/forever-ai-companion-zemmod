-- Dims the chat window while the character moves, so it hides less of the
-- world, and brings it back a moment after stopping.
--
-- It stays fully visible while the player is using it: mouse over it, typing
-- in it or asking by voice. Flight paths don't count as moving (a good time
-- to read), and opening it on the move shows it fully until the next stop.
-- Settings: Options > AddOns > Forever AI Companion (Options.lua).
local _, ns = ...

local Fade = {}
ns.Fade = Fade

Fade.DEFAULTS = { enabled = true, opacity = 60, delay = 1 }
Fade.MIN_OPACITY, Fade.MAX_OPACITY, Fade.OPACITY_STEP = 10, 95, 5
Fade.MAX_DELAY, Fade.DELAY_STEP = 10, 0.5

local CHECK = 0.1          -- seconds between movement checks
local SPEED = 4            -- opacity change per second (a full fade in ~0.25 s)
local PREVIEW = 1.5        -- seconds a changed opacity is shown in the options

local floor, min, max = math.floor, math.min, math.max
local function snap(v, step, lo, hi)
  v = tonumber(v) or lo
  return max(lo, min(hi, floor(v / step + 0.5) * step))
end

-- Saved settings (account-wide), filled in and kept within range.
function Fade:Settings()
  ns.db.fade = ns.db.fade or {}
  local s = ns.db.fade
  for k, v in pairs(self.DEFAULTS) do if s[k] == nil then s[k] = v end end
  s.enabled = s.enabled and true or false
  s.opacity = snap(s.opacity, self.OPACITY_STEP, self.MIN_OPACITY, self.MAX_OPACITY)
  s.delay = snap(s.delay, self.DELAY_STEP, 0, self.MAX_DELAY)
  return s
end

function Fade:Set(key, value)
  local s = self:Settings()
  s[key] = value
  self:Settings()
  if key == "opacity" then self.previewUntil = GetTime() + PREVIEW end
  self.next = 0 -- look again right away
end

local function moving()
  if UnitOnTaxi and UnitOnTaxi("player") then return false end
  local speed = GetUnitSpeed and GetUnitSpeed("player")
  return (tonumber(speed) or 0) > 0
end

-- The player is using the window: never dimmed.
function Fade:InUse()
  local f = self.frame
  if f and f.IsMouseOver and f:IsMouseOver() then return true end
  local input = ns.UI and ns.UI.input
  if input and input.HasFocus and input:HasFocus() then return true end
  if ns.Core and ns.Core.listening then return true end
  return false
end

-- How opaque the window should be right now (0-1).
function Fade:Target(now)
  local s = self:Settings()
  local dim = s.opacity / 100
  if self.previewUntil and now < self.previewUntil and self.frame and self.frame:IsShown() then return dim end
  if not s.enabled or self:InUse() then
    self.movedAt = nil
    return 1
  end
  local now_moving = moving()
  -- Opened on the move: full until the character stops once.
  if self.holdUntilStop then
    if now_moving then return 1 end
    self.holdUntilStop = nil
  end
  if now_moving then
    self.movedAt = now
    return dim
  end
  -- Stopped: back to full once the delay has passed.
  if self.movedAt and now - self.movedAt < s.delay then return dim end
  self.movedAt = nil
  return 1
end

function Fade:Update(elapsed)
  local f = self.frame
  if not f then return end
  local now = GetTime()
  if now >= (self.next or 0) then
    self.next = now + CHECK
    self.target = self:Target(now)
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
  self.current, self.target, self.movedAt, self.next = 1, 1, nil, 0
  self.holdUntilStop = moving() or nil
  if self.frame then self.frame:SetAlpha(1) end
end

function Fade:Attach(frame)
  self.frame = frame
  self:Reset()
  frame:HookScript("OnUpdate", function(_, elapsed) Fade:Update(elapsed) end)
  frame:HookScript("OnShow", function() Fade:Reset() end)
end

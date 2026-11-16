-- Minimap button: on the edge of the minimap, like other addons' buttons
-- (the LibDBIcon way): dragging slides it around the minimap, and its place
-- (an angle) is remembered.
--   Left click: open / close the chats.   Right click: new chat.
--   Shift + right click: hide it (/ia button brings it back).
-- Round, like the minimap buttons of other addons: the assistant's portrait
-- (Fizzi or Rizzik) inside a ring lit in its color, with its gadget (gear or
-- coin) on the side. The ring glows on hover, the gadget spins and the ring
-- pulses while the answer is on its way, the portrait hops when it arrives,
-- and a round badge counts chats with unread answers.
local _, ns = ...
local L = ns.L
local floor = math.floor

local Button = {}
ns.Button = Button

local min, max = math.min, math.max
local SIZE = 36                      -- clickable circle
local RING = SIZE * 1.62              -- MiniMap-TrackingBorder art is offset: scale like LibDBIcon
local DEFAULT_ANGLE = 200            -- degrees around the minimap (0 = right, 90 = top): left side
local RADIUS = 5                     -- how far out from the minimap's edge
local atan2 = math.atan2 or math.atan
-- Minimap shapes (GetMinimapShape, set by minimap addons): for each quarter
-- (1 bottom-right ... 4 top-left), whether that corner is round.
local SHAPES = {
  ROUND = { true, true, true, true },
  SQUARE = { false, false, false, false },
  ["CORNER-TOPLEFT"] = { false, false, false, true },
  ["CORNER-TOPRIGHT"] = { false, false, true, false },
  ["CORNER-BOTTOMLEFT"] = { false, true, false, false },
  ["CORNER-BOTTOMRIGHT"] = { true, false, false, false },
  ["SIDE-LEFT"] = { false, true, false, true },
  ["SIDE-RIGHT"] = { true, false, true, false },
  ["SIDE-TOP"] = { false, false, true, true },
  ["SIDE-BOTTOM"] = { true, true, false, false },
  ["TRICORNER-TOPLEFT"] = { false, true, true, true },
  ["TRICORNER-TOPRIGHT"] = { true, false, true, true },
  ["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
  ["TRICORNER-BOTTOMRIGHT"] = { true, true, true, false },
}
local CIRCLE_MASK = "Interface\\CharacterFrame\\TempPortraitAlphaMask"

-- Makes a texture round (when the client supports masks).
local function round(frame, texture)
  local mask = frame.CreateMaskTexture and frame:CreateMaskTexture()
  if not mask then return end
  mask:SetTexture(CIRCLE_MASK, "CLAMPTOBLACKADDITIVE", "CLAMPTOBLACKADDITIVE")
  mask:SetAllPoints(texture)
  texture:AddMaskTexture(mask)
end

local function settings()
  ns.db.button = ns.db.button or { shown = true }
  return ns.db.button
end

-- Puts the button on the minimap's edge at `angle` degrees (as LibDBIcon does).
local function place(b, angle)
  local s = settings()
  angle = angle or s.angle or DEFAULT_ANGLE
  b:ClearAllPoints()
  local map = _G.Minimap
  if not map then
    b:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", -230, -18) -- no minimap: its old corner
    return
  end
  local rad = math.rad(angle)
  local x, y, q = math.cos(rad), math.sin(rad), 1
  if x < 0 then q = q + 1 end
  if y > 0 then q = q + 2 end
  local shape = SHAPES[GetMinimapShape and GetMinimapShape() or "ROUND"] or SHAPES.ROUND
  local w = (map:GetWidth() / 2) + RADIUS
  local h = (map:GetHeight() / 2) + RADIUS
  if shape[q] then
    x, y = x * w, y * h
  else
    local dw, dh = math.sqrt(2 * w * w) - 10, math.sqrt(2 * h * h) - 10
    x = max(-w, min(x * dw, w))
    y = max(-h, min(y * dh, h))
  end
  b:SetPoint("CENTER", map, "CENTER", x, y)
end

-- The angle from the minimap's center to the mouse, in degrees.
local function cursorAngle()
  local map = _G.Minimap
  local mx, my = map:GetCenter()
  local px, py = GetCursorPosition()
  local scale = map:GetEffectiveScale()
  return math.deg(atan2(py / scale - my, px / scale - mx)) % 360
end

-- Ring light: the game's gold minimap ring; level 1 = normal, more = glowing.
local function setRing(ring, level)
  ring:SetVertexColor(min(1, level), min(1, level * 0.95), min(1, level * 0.8))
end

-- Turns a texture (when the client supports it).
local function rotate(texture, angle)
  if texture.SetRotation then pcall(texture.SetRotation, texture, angle) end
end

function Button:Init()
  if self.frame then return end
  local map = _G.Minimap
  local b = CreateFrame("Button", "ForeverAICompanionFloatingButton", map or UIParent)
  b:SetSize(SIZE, SIZE)
  b:SetFrameStrata("MEDIUM")
  b:SetFrameLevel(map and ((map:GetFrameLevel() or 0) + 8) or 20)
  b:SetClampedToScreen(true)
  b:EnableMouse(true)
  b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  b:RegisterForDrag("LeftButton")

  -- Dark disc, the assistant's round portrait, a lit ring. Proportions follow
  -- the ring art (as LibDBIcon does: ring anchored at the top-left, icon centered).
  local bg = b:CreateTexture(nil, "BACKGROUND")
  bg:SetTexture("Interface\\Minimap\\UI-Minimap-Background")
  bg:SetSize(SIZE * 0.72, SIZE * 0.72)
  bg:SetPoint("CENTER", 0, 0)
  bg:SetVertexColor(0.07, 0.08, 0.09, 1)

  local icon = b:CreateTexture(nil, "ARTWORK")
  icon:SetSize(SIZE * 0.62, SIZE * 0.62)
  icon:SetPoint("CENTER", 0, 0)
  if icon.SetTexCoord then icon:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
  round(b, icon)

  local ring = b:CreateTexture(nil, "OVERLAY")
  ring:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  ring:SetSize(RING, RING)
  ring:SetPoint("TOPLEFT", 0, 0)

  setRing(ring, 1)

  b:SetHighlightTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")

  -- The assistant's gadget (Fizzi's gear, Rizzik's coin): a small disc on the
  -- lower left that spins while the answer is on its way.
  local gadgetFrame = CreateFrame("Frame", nil, b)
  gadgetFrame:SetSize(16, 16)
  gadgetFrame:SetPoint("BOTTOMLEFT", -4, -4)
  gadgetFrame:SetFrameLevel((b:GetFrameLevel() or 20) + 4)
  local gadgetEdge = gadgetFrame:CreateTexture(nil, "BACKGROUND")
  gadgetEdge:SetAllPoints()
  gadgetEdge:SetColorTexture(0.067, 0.067, 0.082, 1)
  round(gadgetFrame, gadgetEdge)
  local gadget = gadgetFrame:CreateTexture(nil, "ARTWORK")
  gadget:SetPoint("TOPLEFT", 1.5, -1.5)
  gadget:SetPoint("BOTTOMRIGHT", -1.5, 1.5)
  if gadget.SetTexCoord then gadget:SetTexCoord(0.08, 0.92, 0.08, 0.92) end
  round(gadgetFrame, gadget)

  -- Unread badge: small blue disc with the count.
  local badge = CreateFrame("Frame", nil, b)
  badge:SetSize(17, 17)
  badge:SetPoint("TOPRIGHT", 5, 5)
  badge:SetFrameLevel((b:GetFrameLevel() or 20) + 5)
  local badgeEdge = badge:CreateTexture(nil, "BACKGROUND")
  badgeEdge:SetAllPoints()
  badgeEdge:SetColorTexture(0.067, 0.067, 0.082, 1)
  round(badge, badgeEdge)
  local badgeBg = badge:CreateTexture(nil, "BORDER")
  badgeBg:SetPoint("TOPLEFT", 2, -2)
  badgeBg:SetPoint("BOTTOMRIGHT", -2, 2)
  self.badgeBg = badgeBg
  round(badge, badgeBg)
  local badgeText = badge:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  badgeText:SetPoint("CENTER", 0, 0)
  badge:Hide()

  -- Dragging slides it around the minimap (OnUpdate follows the mouse).
  b:SetScript("OnDragStart", function(self)
    if not _G.Minimap then return end
    self.dragging = true
    self.moving = true
    if GameTooltip then GameTooltip:Hide() end
  end)
  b:SetScript("OnDragStop", function(self)
    if not self.moving then return end
    self.moving = false
    settings().angle = floor(cursorAngle() * 10 + 0.5) / 10
    place(self)
    -- The click that ends a drag must not open the window.
    C_Timer.After(0, function() self.dragging = false end)
  end)

  b:SetScript("OnClick", function(self, mouse)
    if self.dragging then return end
    if mouse == "RightButton" then
      if IsShiftKeyDown and IsShiftKeyDown() then
        Button:SetShown(false)
        print("|cff66ccffForever AI:|r " .. L.BUTTON_HIDDEN)
        return
      end
      ns.Chats:New()
      ns.UI:Show()
      ns.UI:Refresh()
      if ns.UI.input then ns.UI.input:SetFocus() end
    else
      ns.UI:Toggle()
    end
    if ns.Notify then ns.Notify:HideAll() end
    Button:Update()
  end)

  b:SetScript("OnEnter", function(self)
    self.hovered = true
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    local p = ns.Personas:Current()
    GameTooltip:AddLine(p.nameColor .. p.name .. "|r  |cff999999· " .. p.role .. "|r")
    local unread, pending = Button:Counts()
    if pending > 0 then GameTooltip:AddLine(p.tooltipThinking, 1, 0.82, 0.35) end
    if unread > 0 then
      GameTooltip:AddLine(string.format(unread == 1 and L.UNREAD_ONE or L.UNREAD_MANY, unread), 0.4, 0.75, 1)
    end
    GameTooltip:AddLine(" ")
    GameTooltip:AddDoubleLine(L.TIP_CLICK, L.TIP_OPEN_CHATS, 1, 1, 1, 0.7, 0.7, 0.7)
    GameTooltip:AddDoubleLine(L.TIP_RIGHT_CLICK, L.TIP_NEW_CHAT, 1, 1, 1, 0.7, 0.7, 0.7)
    GameTooltip:AddDoubleLine(L.TIP_DRAG, L.TIP_MOVE, 1, 1, 1, 0.7, 0.7, 0.7)
    GameTooltip:AddDoubleLine(L.TIP_SHIFT_RIGHT_CLICK, L.TIP_HIDE, 1, 1, 1, 0.7, 0.7, 0.7)
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function(self)
    self.hovered = false
    if GameTooltip then GameTooltip:Hide() end
  end)

  -- Animations: ring glow on hover; while thinking the gadget spins and the
  -- ring pulses; the portrait hops when an answer arrives.
  local t, angle = 0, 0
  b:SetScript("OnUpdate", function(self, elapsed)
    elapsed = elapsed or 0
    t = t + elapsed
    if self.moving then place(self, cursorAngle()) end
    if Button.thinking then
      local wave = math.abs(math.sin(t * 2.2))
      setRing(ring, 0.5 + 0.5 * wave)
      angle = (angle - elapsed * 3) % (2 * math.pi)
      rotate(gadget, angle)
    else
      setRing(ring, 1)
      if angle ~= 0 then angle = 0; rotate(gadget, 0) end
    end
    if Button.hopUntil then
      local left = Button.hopUntil - GetTime()
      icon:ClearAllPoints()
      if left <= 0 then
        Button.hopUntil = nil
        icon:SetPoint("CENTER", 0, 0)
      else
        icon:SetPoint("CENTER", 0, math.abs(math.sin(left * 9)) * 4 * left)
      end
    end
  end)

  b.hovered, b.dragging, b.moving = false, false, false
  self.frame, self.icon, self.ring, self.gadget = b, icon, ring, gadget
  self.badge, self.badgeText = badge, badgeText
  self:ApplyPersona()
  place(b)
  b:SetShown(settings().shown ~= false)
  self:Update()
  C_Timer.NewTicker(1, function() Button:Update() end)
end

-- Portrait, gadget and colors of the current assistant.
function Button:ApplyPersona()
  if not self.frame then return end
  local p = ns.Personas:Current()
  ns.Personas.SetPortrait(self.icon, p)
  self.gadget:SetTexture(p.gadget)
  local c = p.colors.badge
  self.badgeBg:SetColorTexture(c[1], c[2], c[3], c[4] or 1)
  setRing(self.ring, 1)
end

-- Chats with unread answers, and questions still waiting.
function Button:Counts()
  local unread, pending = 0, 0
  for _, chat in ipairs(ns.db and ns.db.chats or {}) do
    if chat.unread then unread = unread + 1 end
    for _, m in ipairs(chat.messages) do
      if m.status == "pending" then pending = pending + 1 end
    end
  end
  return unread, pending
end

function Button:Update()
  if not self.frame then return end
  local unread, pending = self:Counts()
  self.thinking = pending > 0
  if unread > 0 then
    self.badgeText:SetText(unread > 9 and "9+" or tostring(unread))
    self.badge:Show()
  else
    self.badge:Hide()
  end
end

-- A short hop when an answer arrives.
function Button:Celebrate()
  self.hopUntil = GetTime() + 0.6
  self:Update()
end

function Button:SetShown(shown)
  settings().shown = shown and true or false
  if self.frame then self.frame:SetShown(shown) end
end

function Button:Toggle()
  self:SetShown(not (self.frame and self.frame:IsShown()))
end

function Button:Reset()
  local s = settings()
  s.angle = nil
  s.point, s.relPoint, s.x, s.y = nil, nil, nil, nil -- free position from before 1.11.1
  if self.frame then place(self.frame) end
  self:SetShown(true)
end

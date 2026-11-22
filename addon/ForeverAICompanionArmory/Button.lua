-- A small button on the minimap's edge, a breastplate: click to open the
-- Armory, drag to slide it around the minimap. It can be hidden in the Build
-- tab (the window still opens with /armory and from the addon list next to
-- the minimap, which shows the same icon).
local _, ns = ...
local L = ns.L

local Button = {}
ns.Button = Button

local SIZE = 31
local ICON = "Interface\\Icons\\INV_Chest_Plate04"
local DEFAULT_ANGLE = 165
local atan2 = math.atan2 or math.atan

local function settings()
  ns.db.ui = ns.db.ui or {}
  return ns.db.ui
end

local function place(b)
  local angle = math.rad(tonumber(settings().angle) or DEFAULT_ANGLE)
  local radius = (Minimap:GetWidth() or 140) / 2 + 6
  b:ClearAllPoints()
  b:SetPoint("CENTER", Minimap, "CENTER", math.cos(angle) * radius, math.sin(angle) * radius)
end

function Button:Init()
  if self.frame or not Minimap or not ns.db then return end
  local b = CreateFrame("Button", "ForeverAICompanionArmoryButton", Minimap)
  self.frame = b
  b:SetSize(SIZE, SIZE)
  b:SetFrameStrata("MEDIUM")
  b:SetFrameLevel(8)
  b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  b:RegisterForDrag("LeftButton")
  local icon = b:CreateTexture(nil, "BACKGROUND")
  icon:SetTexture(ICON)
  icon:SetSize(19, 19)
  icon:SetPoint("CENTER", 0, 1)
  icon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
  local border = b:CreateTexture(nil, "OVERLAY")
  border:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  border:SetSize(52, 52)
  border:SetPoint("TOPLEFT")
  local glow = b:CreateTexture(nil, "HIGHLIGHT")
  glow:SetTexture("Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
  glow:SetAllPoints()
  if glow.SetBlendMode then glow:SetBlendMode("ADD") end
  -- A mark while a result waits to be looked at.
  local mark = b:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  mark:SetPoint("TOPRIGHT", 2, 2)
  mark:SetText("!")
  mark:Hide()
  self.mark = mark

  b:SetScript("OnClick", function()
    mark:Hide()
    ns.UI:Toggle()
  end)
  b:SetScript("OnDragStart", function(self)
    self:SetScript("OnUpdate", function(frame)
      local mx, my = Minimap:GetCenter()
      local px, py = GetCursorPosition()
      local scale = Minimap:GetEffectiveScale() or 1
      settings().angle = math.deg(atan2(py / scale - my, px / scale - mx))
      place(frame)
    end)
  end)
  b:SetScript("OnDragStop", function(self) self:SetScript("OnUpdate", nil) end)
  b:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_LEFT")
    GameTooltip:SetText(L.TITLE, 1, 1, 1)
    GameTooltip:AddLine(L.BUTTON_TIP, 0.8, 0.8, 0.8, true)
    GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  place(b)
  self:Update()
end

function Button:Update()
  if not self.frame then return end
  if settings().button then self.frame:Show() else self.frame:Hide() end
end

-- A result arrived while the window was closed.
function Button:Notify()
  if self.mark and not (ns.UI and ns.UI:IsShown()) then self.mark:Show() end
end

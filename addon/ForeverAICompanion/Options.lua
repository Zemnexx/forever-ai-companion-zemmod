-- The addon's page in Options > AddOns ("Forever AI Companion"), also opened
-- by the gear in the chat window and by /ia options. For now: dimming the
-- window while moving (Fade.lua).
--
-- Controls are built by hand (no option templates, which differ between game
-- versions), and the page is registered with the Settings API when the game
-- has it, or the older Interface Options otherwise.
local _, ns = ...
local L = ns.L

local Options = {}
ns.Options = Options

local WIDTH = 420

local function label(parent, font, text)
  local fs = parent:CreateFontString(nil, "ARTWORK", font)
  fs:SetJustifyH("LEFT")
  fs:SetText(text)
  return fs
end

-- A plain horizontal slider in the look of the game's option sliders.
local function slider(parent, lo, hi, step)
  local tpl = BackdropTemplateMixin and "BackdropTemplate" or nil
  local s = CreateFrame("Slider", nil, parent, tpl)
  s:SetOrientation("HORIZONTAL")
  s:SetSize(WIDTH - 40, 17)
  s:SetMinMaxValues(lo, hi)
  s:SetValueStep(step)
  if s.SetObeyStepOnDrag then s:SetObeyStepOnDrag(true) end
  s:SetThumbTexture("Interface\\Buttons\\UI-SliderBar-Button-Horizontal")
  if s.SetBackdrop then
    s:SetBackdrop({
      bgFile = "Interface\\Buttons\\UI-SliderBar-Background",
      edgeFile = "Interface\\Buttons\\UI-SliderBar-Border",
      tile = true, tileSize = 8, edgeSize = 8,
      insets = { left = 3, right = 3, top = 6, bottom = 6 },
    })
  end
  s:EnableMouse(true)
  local low = label(s, "GameFontHighlightSmall", "")
  low:SetPoint("TOPLEFT", s, "BOTTOMLEFT", 0, -2)
  local high = label(s, "GameFontHighlightSmall", "")
  high:SetPoint("TOPRIGHT", s, "BOTTOMRIGHT", 0, -2)
  s.low, s.high = low, high
  return s
end

local function checkbox(parent, text)
  local c = CreateFrame("CheckButton", nil, parent, "UICheckButtonTemplate")
  c:SetSize(26, 26)
  local fs = label(c, "GameFontHighlight", text)
  fs:SetPoint("LEFT", c, "RIGHT", 4, 1)
  c.label = fs
  return c
end

local function seconds(v)
  return (v == math.floor(v) and string.format("%d", v) or string.format("%.1f", v))
end

-- Fills `panel` with the page's controls.
function Options:Build(panel)
  local Fade = ns.Fade
  local title = label(panel, "GameFontNormalLarge", L.OPTIONS_TITLE)
  title:SetPoint("TOPLEFT", 16, -16)
  local intro = label(panel, "GameFontHighlightSmall", L.OPTIONS_INTRO)
  intro:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
  intro:SetWidth(WIDTH + 140)

  local heading = label(panel, "GameFontNormal", L.FADE_HEADING)
  heading:SetPoint("TOPLEFT", intro, "BOTTOMLEFT", 0, -22)

  local enabled = checkbox(panel, L.FADE_ENABLE)
  enabled:SetPoint("TOPLEFT", heading, "BOTTOMLEFT", -4, -8)
  local enabledTip = label(panel, "GameFontDisableSmall", L.FADE_ENABLE_TIP)
  enabledTip:SetPoint("TOPLEFT", enabled, "BOTTOMLEFT", 30, 0)
  enabledTip:SetWidth(WIDTH + 100)

  local opacityText = label(panel, "GameFontHighlight", "")
  opacityText:SetPoint("TOPLEFT", enabledTip, "BOTTOMLEFT", -26, -22)
  local opacity = slider(panel, Fade.MIN_OPACITY, Fade.MAX_OPACITY, Fade.OPACITY_STEP)
  opacity:SetPoint("TOPLEFT", opacityText, "BOTTOMLEFT", 4, -8)
  opacity.low:SetText(Fade.MIN_OPACITY .. "%")
  opacity.high:SetText(Fade.MAX_OPACITY .. "%")

  local delayText = label(panel, "GameFontHighlight", "")
  delayText:SetPoint("TOPLEFT", opacity, "BOTTOMLEFT", -4, -28)
  local delay = slider(panel, 0, Fade.MAX_DELAY, Fade.DELAY_STEP)
  delay:SetPoint("TOPLEFT", delayText, "BOTTOMLEFT", 4, -8)
  delay.low:SetText(string.format(L.SECONDS, "0"))
  delay.high:SetText(string.format(L.SECONDS, seconds(Fade.MAX_DELAY)))

  local note = label(panel, "GameFontDisableSmall", L.FADE_NOTE)
  note:SetPoint("TOPLEFT", delay, "BOTTOMLEFT", -4, -30)
  note:SetWidth(WIDTH + 140)

  local filling = false
  local function show()
    local s = Fade:Settings()
    filling = true
    enabled:SetChecked(s.enabled)
    opacity:SetValue(s.opacity)
    delay:SetValue(s.delay)
    filling = false
    opacityText:SetText(string.format(L.FADE_OPACITY, s.opacity))
    delayText:SetText(string.format(L.FADE_DELAY, seconds(s.delay)))
    local a = s.enabled and 1 or 0.45
    for _, w in ipairs({ opacity, delay, opacityText, delayText }) do w:SetAlpha(a) end
    if opacity.SetEnabled then opacity:SetEnabled(s.enabled) end
    if delay.SetEnabled then delay:SetEnabled(s.enabled) end
  end

  enabled:SetScript("OnClick", function(self)
    Fade:Set("enabled", self:GetChecked() and true or false)
    show()
  end)
  opacity:SetScript("OnValueChanged", function(_, v)
    if filling then return end
    Fade:Set("opacity", v)
    show()
  end)
  delay:SetScript("OnValueChanged", function(_, v)
    if filling then return end
    Fade:Set("delay", v)
    show()
  end)
  panel:SetScript("OnShow", show)
  panel.refresh = show -- older Interface Options call this
  self.controls = { enabled = enabled, opacity = opacity, delay = delay, opacityText = opacityText, delayText = delayText, show = show }
end

-- Registers the page (once the saved settings are loaded).
function Options:Init()
  if self.panel then return end
  local panel = CreateFrame("Frame")
  panel.name = L.WINDOW_TITLE
  panel:Hide()
  self.panel = panel
  self:Build(panel)
  if Settings and Settings.RegisterCanvasLayoutCategory and Settings.RegisterAddOnCategory then
    local ok, category = pcall(Settings.RegisterCanvasLayoutCategory, panel, L.WINDOW_TITLE)
    if ok and category then
      Settings.RegisterAddOnCategory(category)
      self.category = category
      return
    end
  end
  if InterfaceOptions_AddCategory then
    InterfaceOptions_AddCategory(panel)
    self.legacy = true
  end
end

function Options:Open()
  self:Init()
  local c = self.category
  if c and Settings and Settings.OpenToCategory then
    local id = (c.GetID and c:GetID()) or c.ID
    if pcall(Settings.OpenToCategory, id) then return true end
  end
  if self.legacy and InterfaceOptionsFrame_OpenToCategory then
    -- Called twice: the first call only opens the frame on some versions.
    InterfaceOptionsFrame_OpenToCategory(self.panel)
    InterfaceOptionsFrame_OpenToCategory(self.panel)
    return true
  end
  return false
end

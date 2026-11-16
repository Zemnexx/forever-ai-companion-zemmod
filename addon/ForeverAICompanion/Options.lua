-- The addon's page in Options > AddOns ("Forever AI Companion"), also opened
-- by the gear in the chat window and by /ia options: dimming the window while
-- moving and in combat (Fade.lua), or the combat warning instead (ns.Combat in
-- UI.lua), and compact answers (Compact.lua).
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

-- One dimming section: heading, on/off, opacity and delay sliders, laid out
-- under `anchor` (dx lines it up with the page's left edge). keys: the
-- settings it edits (see Fade.DEFAULTS); text: its locale keys. Returns the
-- section's widgets; .bottom is the last one.
local function section(panel, anchor, dx, keys, text, gap)
  local Fade = ns.Fade
  local heading = label(panel, "GameFontNormal", L[text.heading])
  heading:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", dx, -gap)

  local enabled = checkbox(panel, L[text.enable])
  enabled:SetPoint("TOPLEFT", heading, "BOTTOMLEFT", -4, -6)
  local tip = label(panel, "GameFontDisableSmall", L[text.tip])
  tip:SetPoint("TOPLEFT", enabled, "BOTTOMLEFT", 30, 0)
  tip:SetWidth(WIDTH + 100)

  local opacityText = label(panel, "GameFontHighlight", "")
  opacityText:SetPoint("TOPLEFT", tip, "BOTTOMLEFT", -26, -16)
  local opacity = slider(panel, Fade.MIN_OPACITY, Fade.MAX_OPACITY, Fade.OPACITY_STEP)
  opacity:SetPoint("TOPLEFT", opacityText, "BOTTOMLEFT", 4, -8)
  opacity.low:SetText(Fade.MIN_OPACITY .. "%")
  opacity.high:SetText(Fade.MAX_OPACITY .. "%")

  local delayText = label(panel, "GameFontHighlight", "")
  delayText:SetPoint("TOPLEFT", opacity, "BOTTOMLEFT", -4, -24)
  local delay = slider(panel, 0, Fade.MAX_DELAY, Fade.DELAY_STEP)
  delay:SetPoint("TOPLEFT", delayText, "BOTTOMLEFT", 4, -8)
  delay.low:SetText(string.format(L.SECONDS, "0"))
  delay.high:SetText(string.format(L.SECONDS, seconds(Fade.MAX_DELAY)))

  local filling = false
  local function show()
    local s = Fade:Settings()
    local on = s[keys.enabled]
    filling = true
    enabled:SetChecked(on)
    opacity:SetValue(s[keys.opacity])
    delay:SetValue(s[keys.delay])
    filling = false
    opacityText:SetText(string.format(L[text.opacity], s[keys.opacity]))
    delayText:SetText(string.format(L[text.delay], seconds(s[keys.delay])))
    local a = on and 1 or 0.45
    for _, w in ipairs({ opacity, delay, opacityText, delayText }) do w:SetAlpha(a) end
    if opacity.SetEnabled then opacity:SetEnabled(on) end
    if delay.SetEnabled then delay:SetEnabled(on) end
  end
  enabled:SetScript("OnClick", function(self)
    Fade:Set(keys.enabled, self:GetChecked() and true or false)
    show()
  end)
  opacity:SetScript("OnValueChanged", function(_, v)
    if filling then return end
    Fade:Set(keys.opacity, v)
    show()
  end)
  delay:SetScript("OnValueChanged", function(_, v)
    if filling then return end
    Fade:Set(keys.delay, v)
    show()
  end)
  return { enabled = enabled, opacity = opacity, delay = delay, opacityText = opacityText, delayText = delayText, show = show, bottom = delay }
end

-- The compact answers section: on/off and how long an answer stays up.
local function compactSection(parent, anchor)
  local Compact = ns.Compact
  local heading = label(parent, "GameFontNormal", L.COMPACT_HEADING)
  heading:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, -26)
  local enabled = checkbox(parent, L.COMPACT_ENABLE)
  enabled:SetPoint("TOPLEFT", heading, "BOTTOMLEFT", -4, -6)
  local tip = label(parent, "GameFontDisableSmall", L.COMPACT_TIP)
  tip:SetPoint("TOPLEFT", enabled, "BOTTOMLEFT", 30, 0)
  tip:SetWidth(WIDTH + 100)
  local secondsText = label(parent, "GameFontHighlight", "")
  secondsText:SetPoint("TOPLEFT", tip, "BOTTOMLEFT", -26, -16)
  local seconds = slider(parent, Compact.MIN_SECONDS, Compact.MAX_SECONDS, Compact.SECONDS_STEP)
  seconds:SetPoint("TOPLEFT", secondsText, "BOTTOMLEFT", 4, -8)
  seconds.low:SetText(string.format(L.SECONDS, Compact.MIN_SECONDS))
  seconds.high:SetText(string.format(L.SECONDS, Compact.MAX_SECONDS))

  local filling = false
  local function show()
    local s = Compact:Settings()
    filling = true
    enabled:SetChecked(s.enabled)
    seconds:SetValue(s.seconds)
    filling = false
    secondsText:SetText(string.format(L.COMPACT_SECONDS, s.seconds))
    local a = s.enabled and 1 or 0.45
    seconds:SetAlpha(a)
    secondsText:SetAlpha(a)
    if seconds.SetEnabled then seconds:SetEnabled(s.enabled) end
  end
  enabled:SetScript("OnClick", function(self)
    Compact:Set("enabled", self:GetChecked() and true or false)
    show()
  end)
  seconds:SetScript("OnValueChanged", function(_, v)
    if filling then return end
    Compact:Set("seconds", v)
    show()
  end)
  return { enabled = enabled, seconds = seconds, secondsText = secondsText, show = show, bottom = seconds }
end

-- Fills `panel` with the page's controls, in a scroll area so it fits any
-- screen size.
function Options:Build(panel)
  local scroll = CreateFrame("ScrollFrame", nil, panel, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 0, -4)
  scroll:SetPoint("BOTTOMRIGHT", -28, 4)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(WIDTH + 180, 900)
  scroll:SetScrollChild(content)

  local title = label(content, "GameFontNormalLarge", L.OPTIONS_TITLE)
  title:SetPoint("TOPLEFT", 16, -12)
  local intro = label(content, "GameFontHighlightSmall", L.OPTIONS_INTRO)
  intro:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
  intro:SetWidth(WIDTH + 140)

  local move = section(content, intro, 0, { enabled = "enabled", opacity = "opacity", delay = "delay" }, {
    heading = "FADE_HEADING", enable = "FADE_ENABLE", tip = "FADE_ENABLE_TIP", opacity = "FADE_OPACITY", delay = "FADE_DELAY",
  }, 20)
  local combat = section(content, move.bottom, -4, { enabled = "combat", opacity = "combatOpacity", delay = "combatDelay" }, {
    heading = "FADE_COMBAT_HEADING", enable = "FADE_COMBAT_ENABLE", tip = "FADE_COMBAT_TIP", opacity = "FADE_COMBAT_OPACITY", delay = "FADE_COMBAT_DELAY",
  }, 34)

  -- In combat it's one or the other: dimming (the box above) or the warning.
  local warn = checkbox(content, L.COMBAT_WARN_ENABLE)
  warn:SetPoint("TOPLEFT", combat.bottom, "BOTTOMLEFT", -8, -26)
  local warnTip = label(content, "GameFontDisableSmall", L.COMBAT_WARN_TIP)
  warnTip:SetPoint("TOPLEFT", warn, "BOTTOMLEFT", 30, 0)
  warnTip:SetWidth(WIDTH + 100)

  local note = label(content, "GameFontDisableSmall", L.FADE_NOTE)
  note:SetPoint("TOPLEFT", warnTip, "BOTTOMLEFT", -26, -20)
  note:SetWidth(WIDTH + 140)

  local compact = ns.Compact and compactSection(content, note)

  local function show()
    move.show()
    combat.show()
    warn:SetChecked(ns.Fade:Settings().combatWarn)
    if compact then compact.show() end
  end
  warn:SetScript("OnClick", function(self)
    ns.Fade:Set("combatWarn", self:GetChecked() and true or false)
    show()
  end)
  panel:SetScript("OnShow", show)
  panel.refresh = show -- older Interface Options call this
  self.controls = move
  self.combatControls = combat
  self.combatWarnControl = warn
  self.compactControls = compact
  self.show = show
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

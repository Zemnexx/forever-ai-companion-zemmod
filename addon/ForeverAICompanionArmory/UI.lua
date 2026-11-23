-- The Armory's window: a tab for the build the player is going for and one
-- per analysis (talents, gear, rotation, interactions). The analysis tabs are
-- drawn from the blocks Panels.lua makes, so this file only knows how to lay
-- out headings, paragraphs, rows, bars and buttons; it holds no game logic.
--
-- Built by hand from the plainest widgets (frames, textures, font strings,
-- the standard button and scroll templates), which exist on every client.
local _, ns = ...
local L = ns.L
local Util = ns.Util

local UI = {}
ns.UI = UI

UI.TABS = { "build", "talents", "gear", "rotation", "discover" }
-- The window's size when nothing else was chosen, and the smallest it may
-- be dragged to. 620 wide keeps the longest line about the app clear of the
-- version text at the bottom, and the "Gear from:" row with its three boxes
-- inside the page. 420 tall holds the five tabs of the side column (they
-- need about 275) and still leaves the gear and rotation tabs a body of
-- about 230 under their own row.
local WIDTH, HEIGHT = 760, 560
local MIN_WIDTH, MIN_HEIGHT = 620, 420
-- The largest it may be is the screen, or this when the screen's size cannot be read.
local CAP_WIDTH, CAP_HEIGHT = 1920, 1200
local SIDE = 150          -- the tab column
local PAD = 14
local GRIP = 16           -- the resize grip in the bottom right corner
-- How often the content is laid out again while the window is being resized.
local RELAYOUT = 0.08

-- What fits inside the page: the window, less the tab column, the margins
-- around and inside the page, and the scroll bar.
local function bodyWidth(width)
  return math.max(width, MIN_WIDTH) - SIDE - PAD * 5 - 22
end
local BACKDROP = BackdropTemplateMixin and "BackdropTemplate" or nil
local WHITE = "Interface\\Buttons\\WHITE8x8"

local COLORS = {
  window = { 0.067, 0.075, 0.09, 0.97 }, edge = { 0.2, 0.22, 0.26, 1 }, panel = { 0.09, 0.1, 0.12, 0.96 },
  chip = { 0.13, 0.145, 0.17, 1 }, chipOn = { 0.17, 0.45, 0.88, 1 }, hover = { 1, 1, 1, 0.06 },
  text = { 0.9, 0.92, 0.95 }, muted = { 0.58, 0.62, 0.68 }, warn = { 1, 0.62, 0.3 }, good = { 0.45, 0.9, 0.55 },
  gold = { 1, 0.82, 0 }, bar = { 0.17, 0.45, 0.88, 0.85 }, barBack = { 1, 1, 1, 0.07 }, highlight = { 0.17, 0.45, 0.88, 0.18 },
}

local function color(fs, name)
  local c = COLORS[name] or COLORS.text
  fs:SetTextColor(c[1], c[2], c[3])
end

local function fill(frame, bg, edge)
  if not frame.SetBackdrop then return end
  frame:SetBackdrop({ bgFile = WHITE, edgeFile = WHITE, edgeSize = 1, insets = { left = 1, right = 1, top = 1, bottom = 1 } })
  frame:SetBackdropColor(bg[1], bg[2], bg[3], bg[4] or 1)
  edge = edge or bg
  frame:SetBackdropBorderColor(edge[1], edge[2], edge[3], edge[4] or 1)
end

local function text(parent, font, justify)
  local fs = parent:CreateFontString(nil, "OVERLAY", font or "GameFontHighlight")
  fs:SetJustifyH(justify or "LEFT")
  fs:SetJustifyV("TOP")
  if fs.SetWordWrap then fs:SetWordWrap(true) end
  return fs
end

-- A tooltip whose text is worked out when it opens: texts() returns the
-- title and the body, or nothing for no tooltip at all.
local function hintWith(frame, texts)
  frame:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    local title, body = texts()
    if not title then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:SetText(title, 1, 1, 1)
    if body then GameTooltip:AddLine(body, 0.8, 0.8, 0.8, true) end
    GameTooltip:Show()
  end)
  frame:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
end

local function hint(frame, title, body)
  hintWith(frame, function() return title, body end)
end

-- What the last run of an analysis used: its tokens and how many of them
-- were cached, or nil when there is no earlier run that says.
local function cost(kind)
  local result = ns.Store:Result(kind)
  local tokens = result and result.tokens
  if type(tokens) ~= "table" then return nil end
  local total = (Util.num(tokens.i) or 0) + (Util.num(tokens.o) or 0)
  if total <= 0 then return nil end
  return total, Util.num(tokens.c) or 0
end

local function thousands(n)
  return Util.fmt(n / 1000, 1)
end

-- A flat toggle: a choice among a few (the goal, the role, a talent tree).
local function chip(parent, label, onClick)
  local b = CreateFrame("Button", nil, parent, BACKDROP)
  b:SetHeight(24)
  local fs = text(b, "GameFontHighlightSmall", "CENTER")
  fs:SetPoint("CENTER")
  fs:SetText(label)
  b:SetWidth(math.max(64, (fs:GetStringWidth() or 40) + 22))
  b.label = fs
  function b:SetOn(on)
    self.on = on
    fill(self, on and COLORS.chipOn or COLORS.chip, on and COLORS.chipOn or COLORS.edge)
  end
  b:SetOn(false)
  b:SetScript("OnClick", function(self) onClick(self) end)
  return b
end

-- One choice from a list that opens under it (the specialization). Made of
-- plain frames like everything else here: the game's own dropdowns are not
-- the same on every client.
local function dropdown(parent, width, placeholder, onPick)
  local d = CreateFrame("Button", nil, parent, BACKDROP)
  d:SetSize(width, 24)
  fill(d, COLORS.chip, COLORS.edge)
  local fs = text(d, "GameFontHighlightSmall")
  fs:SetPoint("LEFT", 9, 0)
  fs:SetPoint("RIGHT", -26, 0)
  fs:SetJustifyV("MIDDLE")
  if fs.SetWordWrap then fs:SetWordWrap(false) end
  d.label = fs
  -- The arrow: two thin bars that meet at the bottom, so it needs no artwork.
  for _, side in ipairs({ -1, 1 }) do
    local bar = d:CreateTexture(nil, "OVERLAY")
    bar:SetColorTexture(COLORS.muted[1], COLORS.muted[2], COLORS.muted[3], 1)
    bar:SetSize(7, 1.5)
    bar:SetPoint("CENTER", d, "RIGHT", -13 + side * 2.5, 0)
    if bar.SetRotation then bar:SetRotation(side * math.pi / 4) end
  end

  local list = CreateFrame("Frame", nil, d, BACKDROP)
  list:SetPoint("TOPLEFT", d, "BOTTOMLEFT", 0, -2)
  list:SetWidth(width)
  list:SetFrameStrata("DIALOG")
  list:EnableMouse(true)
  fill(list, COLORS.window, COLORS.edge)
  list:Hide()
  d.list, d.rows, d.options = list, {}, {}

  local function row(i)
    local r = d.rows[i]
    if r then return r end
    r = CreateFrame("Button", nil, list)
    r:SetHeight(24)
    r:SetPoint("TOPLEFT", 1, -1 - (i - 1) * 24)
    r:SetPoint("TOPRIGHT", -1, -1 - (i - 1) * 24)
    local back = r:CreateTexture(nil, "BACKGROUND")
    back:SetAllPoints()
    back:SetColorTexture(COLORS.chipOn[1], COLORS.chipOn[2], COLORS.chipOn[3], 1)
    r.back = back
    local hover = r:CreateTexture(nil, "HIGHLIGHT")
    hover:SetAllPoints()
    hover:SetColorTexture(COLORS.hover[1], COLORS.hover[2], COLORS.hover[3], COLORS.hover[4])
    local label = text(r, "GameFontHighlightSmall")
    label:SetPoint("LEFT", 8, 0)
    label:SetPoint("RIGHT", -8, 0)
    label:SetJustifyV("MIDDLE")
    if label.SetWordWrap then label:SetWordWrap(false) end
    r.label = label
    r:SetScript("OnClick", function(self)
      list:Hide()
      onPick(self.value)
    end)
    d.rows[i] = r
    return r
  end

  -- The current choice. One that is not in the list (typed in an earlier
  -- version) is still shown, until another is chosen.
  function d:SetValue(value)
    self.value = value
    self.label:SetText(value or placeholder)
    color(self.label, value and "text" or "muted")
    for i, r in ipairs(self.rows) do
      if i <= #self.options and r.value == value then r.back:Show() else r.back:Hide() end
    end
  end

  function d:SetOptions(options)
    self.options = options
    for _, r in ipairs(self.rows) do r:Hide() end
    for i, name in ipairs(options) do
      local r = row(i)
      r.value = name
      r.label:SetText(name)
      r:Show()
    end
    list:SetHeight(#options * 24 + 2)
    if #options == 0 then list:Hide() end
    self:SetValue(self.value)
  end

  d:SetScript("OnClick", function(self)
    if list:IsShown() or #self.options == 0 then list:Hide() else list:Show() end
  end)
  -- A click anywhere else closes the list, on clients that tell addons about
  -- clicks; on the others it closes on a choice or on the button.
  list:SetScript("OnShow", function(self) pcall(self.RegisterEvent, self, "GLOBAL_MOUSE_DOWN") end)
  list:SetScript("OnHide", function(self)
    pcall(self.UnregisterEvent, self, "GLOBAL_MOUSE_DOWN")
    -- Hidden with the window or the tab: closed, not waiting to come back with it.
    self:Hide()
  end)
  list:SetScript("OnEvent", function(self)
    if not (self:IsMouseOver() or d:IsMouseOver()) then self:Hide() end
  end)
  return d
end

local function button(parent, label, width, onClick)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width, 24)
  b:SetText(label)
  b:SetScript("OnClick", onClick)
  return b
end

local function editBox(parent, width, maxLetters, onChange)
  local e = CreateFrame("EditBox", nil, parent, BACKDROP)
  e:SetSize(width, 24)
  e:SetAutoFocus(false)
  if GameFontHighlightSmall then e:SetFontObject(GameFontHighlightSmall) end
  e:SetMaxLetters(maxLetters)
  e:SetTextInsets(7, 7, 2, 2)
  fill(e, { 0.05, 0.056, 0.068, 1 }, COLORS.edge)
  local function done(self)
    self:ClearFocus()
    onChange(Util.trim(self:GetText() or ""))
  end
  e:SetScript("OnEnterPressed", done)
  e:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  e:SetScript("OnEditFocusLost", function(self) onChange(Util.trim(self:GetText() or "")) end)
  return e
end

-- The window -------------------------------------------------------------------------

local function settings()
  ns.db.ui = ns.db.ui or {}
  return ns.db.ui
end

local function sane(n)
  return type(n) == "number" and n == n and n > 0 and n < math.huge
end

local function clamp(v, lo, hi)
  return math.min(math.max(v, lo), hi)
end

-- The largest the window may be: the screen, in the window's own units.
local function screen()
  local ok, w, h = pcall(function() return UIParent:GetWidth(), UIParent:GetHeight() end)
  if not (ok and sane(w)) then w = CAP_WIDTH end
  if not (ok and sane(h)) then h = CAP_HEIGHT end
  return math.max(w, MIN_WIDTH), math.max(h, MIN_HEIGHT)
end

-- Within the bounds whatever the client did: some cannot be told them.
local function clampSize(w, h)
  local maxW, maxH = screen()
  return clamp(w, MIN_WIDTH, maxW), clamp(h, MIN_HEIGHT, maxH)
end

-- The size the player left the window at, on a screen that may be smaller now.
local function savedSize()
  local size = settings().size
  if type(size) == "table" and sane(size[1]) and sane(size[2]) then return clampSize(size[1], size[2]) end
  return clampSize(WIDTH, HEIGHT)
end

local function savePlace(f)
  local point, _, relative, x, y = f:GetPoint(1)
  settings().place = { point, relative, x, y }
end

-- Lets the window be resized, on a client that can: true when it can. The
-- bounds are set again each time, as the screen may have changed.
local function resizable(f)
  if not (f.StartSizing and f.SetResizable) then return false end
  if not pcall(f.SetResizable, f, true) then return false end
  local maxW, maxH = screen()
  if f.SetResizeBounds then
    pcall(f.SetResizeBounds, f, MIN_WIDTH, MIN_HEIGHT, maxW, maxH)
  else
    if f.SetMinResize then pcall(f.SetMinResize, f, MIN_WIDTH, MIN_HEIGHT) end
    if f.SetMaxResize then pcall(f.SetMaxResize, f, maxW, maxH) end
  end
  return true
end

function UI:Build()
  if self.frame then return end
  local f = CreateFrame("Frame", "ForeverAICompanionArmoryFrame", UIParent, BACKDROP)
  self.frame = f
  local width, height = savedSize()
  f:SetSize(width, height)
  self.bodyWidth = bodyWidth(width)
  local bw = self.bodyWidth
  f:SetFrameStrata("HIGH")
  f:SetClampedToScreen(true)
  f:EnableMouse(true)
  f:SetMovable(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    savePlace(self)
  end)
  fill(f, COLORS.window, COLORS.edge)
  local place = settings().place
  if type(place) == "table" and place[1] then
    f:SetPoint(place[1], UIParent, place[2] or place[1], place[3] or 0, place[4] or 0)
  else
    f:SetPoint("CENTER")
  end
  if UISpecialFrames then table.insert(UISpecialFrames, "ForeverAICompanionArmoryFrame") end
  f:SetScript("OnShow", function() UI:OnShow() end)
  f:SetScript("OnHide", function() UI:OnHide() end)
  f:Hide()

  local title = text(f, "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", PAD, -PAD)
  title:SetText(L.TITLE)
  local who = text(f, "GameFontHighlightSmall")
  who:SetPoint("LEFT", title, "RIGHT", 10, -1)
  color(who, "muted")
  self.who = who
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function() f:Hide() end)

  -- The tab column.
  local side = CreateFrame("Frame", nil, f, BACKDROP)
  side:SetPoint("TOPLEFT", PAD, -44)
  side:SetPoint("BOTTOMLEFT", PAD, 36)
  side:SetWidth(SIDE)
  fill(side, COLORS.panel, COLORS.edge)
  self.tabs = {}
  for i, name in ipairs(self.TABS) do
    local b = CreateFrame("Button", nil, side, BACKDROP)
    b:SetHeight(34)
    b:SetPoint("TOPLEFT", 4, -4 - (i - 1) * 38)
    b:SetPoint("TOPRIGHT", -4, -4 - (i - 1) * 38)
    local fs = text(b, "GameFontHighlight")
    fs:SetPoint("LEFT", 10, 0)
    fs:SetText(L["TAB_" .. name:upper()])
    local dot = text(b, "GameFontHighlightSmall", "RIGHT")
    dot:SetPoint("RIGHT", -8, 0)
    b.label, b.dot = fs, dot
    b:SetScript("OnClick", function() UI:Select(name) end)
    self.tabs[name] = b
  end

  -- The tab's page: a title, a status line, the action button and the body.
  local page = CreateFrame("Frame", nil, f, BACKDROP)
  page:SetPoint("TOPLEFT", side, "TOPRIGHT", PAD, 0)
  page:SetPoint("BOTTOMRIGHT", -PAD, 36)
  fill(page, COLORS.panel, COLORS.edge)
  self.page = page
  local heading = text(page, "GameFontNormalLarge")
  heading:SetPoint("TOPLEFT", PAD, -PAD)
  self.heading = heading
  local status = text(page, "GameFontHighlightSmall")
  status:SetPoint("TOPLEFT", heading, "BOTTOMLEFT", 0, -5)
  status:SetWidth(bw - 150)
  self.status = status
  self.analyze = button(page, L.ANALYZE, 140, function() UI:Analyze() end)
  self.analyze:SetPoint("TOPRIGHT", -PAD, -PAD)
  hintWith(self.analyze, function()
    local tab = UI:Current()
    if tab == "build" then return nil end
    local total, cached = cost(tab)
    if not total then return nil end
    return L.COST_TITLE, string.format(L.COST_LAST, thousands(total), thousands(cached))
  end)

  -- The gear tab's own row, above its plan: what the plan may send the player to do.
  local sources = CreateFrame("Frame", nil, page)
  sources:SetPoint("TOPLEFT", PAD, -64)
  sources:SetSize(bw, 24)
  local from = text(sources, "GameFontHighlightSmall")
  from:SetPoint("LEFT", 0, 0)
  from:SetJustifyV("MIDDLE")
  from:SetText(L.GEAR_FROM)
  color(from, "muted")
  self.sourceChecks = {}
  local x = (from:GetStringWidth() or 60) + 8
  for _, source in ipairs(ns.Store.GEAR_SOURCES) do
    local name = L["GEAR_FROM_" .. source:upper()]
    local c = CreateFrame("CheckButton", nil, sources, "UICheckButtonTemplate")
    c:SetSize(24, 24)
    c:SetPoint("LEFT", x, 0)
    local fs = text(c, "GameFontHighlightSmall")
    fs:SetPoint("LEFT", c, "RIGHT", 1, 0)
    fs:SetJustifyV("MIDDLE")
    fs:SetText(name)
    local width = fs:GetStringWidth() or 50
    -- The name is part of the checkbox: a click on it ticks it too.
    if c.SetHitRectInsets then c:SetHitRectInsets(0, -width, 0, 0) end
    c:SetScript("OnClick", function(self)
      -- The last one that is ticked stays ticked.
      if not ns.Store:SetGearSource(source, self:GetChecked() and true or false) then self:SetChecked(true) end
      UI:Refresh()
    end)
    hint(c, name, L.GEAR_FROM_TIP)
    self.sourceChecks[source] = c
    x = x + 24 + width + 16
  end
  sources:Hide()
  self.sources = sources

  -- The rotation tab's own row, in the same place: one enemy or several.
  local aoeRow = CreateFrame("Frame", nil, page)
  aoeRow:SetPoint("TOPLEFT", PAD, -64)
  aoeRow:SetSize(bw, 24)
  local aoe = CreateFrame("CheckButton", nil, aoeRow, "UICheckButtonTemplate")
  aoe:SetSize(24, 24)
  aoe:SetPoint("LEFT", -3, 0)
  local aoeLabel = text(aoe, "GameFontHighlightSmall")
  aoeLabel:SetPoint("LEFT", aoe, "RIGHT", 1, 0)
  aoeLabel:SetJustifyV("MIDDLE")
  aoeLabel:SetText(L.AOE)
  if aoe.SetHitRectInsets then aoe:SetHitRectInsets(0, -((aoeLabel:GetStringWidth() or 120)), 0, 0) end
  aoe:SetScript("OnClick", function(self)
    ns.Store:SetAoe(self:GetChecked() and true or false)
    UI:Refresh()
  end)
  hint(aoe, L.AOE, L.AOE_TIP)
  aoeRow:Hide()
  self.aoeRow, self.aoeCheck = aoeRow, aoe

  local scroll = CreateFrame("ScrollFrame", "ForeverAICompanionArmoryScroll", page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", PAD, -64)
  scroll:SetPoint("BOTTOMRIGHT", -PAD - 22, PAD)
  local body = CreateFrame("Frame", nil, scroll)
  body:SetSize(bw, 10)
  scroll:SetScrollChild(body)
  self.scroll, self.body = scroll, body
  self.pools = { text = {}, row = {}, bar = {}, action = {} }
  self.used = { text = 0, row = 0, bar = 0, action = 0 }

  -- The build tab has its own controls, on top of the same page.
  self:BuildProfile(page)

  -- The line at the bottom: is the companion app there?
  local app = text(f, "GameFontHighlightSmall")
  app:SetPoint("BOTTOMLEFT", PAD, 12)
  self.app = app
  local version = text(f, "GameFontDisableSmall", "RIGHT")
  -- The app's stamp after the version tells one test build from another.
  version:SetText(L.TITLE .. " " .. tostring(ns.version or "") .. (ns.build and (" · " .. ns.build) or ""))
  self.version = version

  -- The corner to resize it by, on a client that lets frames be resized.
  -- The version text moves left of it.
  if resizable(f) then
    version:SetPoint("BOTTOMRIGHT", -(PAD + GRIP - 4), 12)
    local grip = CreateFrame("Button", nil, f)
    grip:SetSize(GRIP, GRIP)
    grip:SetPoint("BOTTOMRIGHT", -3, 3)
    grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
    grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
    grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
    grip:SetScript("OnMouseDown", function(_, mouse)
      if mouse == nil or mouse == "LeftButton" then UI:StartResize() end
    end)
    grip:SetScript("OnMouseUp", function() UI:StopResize() end)
    self.grip = grip
  else
    version:SetPoint("BOTTOMRIGHT", -PAD, 12)
  end
  f:SetScript("OnSizeChanged", function() UI:OnSizeChanged() end)
  self:Layout()
end

-- Resizing ------------------------------------------------------------------------------

function UI:StartResize()
  local f = self.frame
  if not f or self.sizing or not resizable(f) then return end
  self.specDrop.list:Hide()
  self.sizing = pcall(f.StartSizing, f, "BOTTOMRIGHT")
end

-- The drag ended: the size is kept, and the place too, as the game may have
-- anchored the window by another corner to size it.
function UI:StopResize()
  local f = self.frame
  if not f or not self.sizing then return end
  self.sizing = false
  pcall(f.StopMovingOrSizing, f)
  local ok, w, h = pcall(function() return f:GetWidth(), f:GetHeight() end)
  if ok and sane(w) and sane(h) then
    local cw, ch = clampSize(w, h)
    if cw ~= w or ch ~= h then f:SetSize(cw, ch) end
    settings().size = { math.floor(cw + 0.5), math.floor(ch + 0.5) }
  end
  pcall(savePlace, f)
  self:Layout()
end

-- While the corner is dragged the size changes on every frame: the content
-- follows a few times a second, and exactly once the drag ends.
function UI:OnSizeChanged()
  if not self.sizing or not (C_Timer and C_Timer.After) then
    self:Layout()
    return
  end
  if self.layoutDue then return end
  self.layoutDue = true
  C_Timer.After(RELAYOUT, function()
    UI.layoutDue = nil
    if UI.sizing then UI:Layout() end
  end)
end

-- Everything whose width comes from the window's, and the open tab drawn
-- again at that width.
function UI:Layout()
  local f = self.frame
  if not f or not self.profileChild then return end
  local ok, w = pcall(f.GetWidth, f)
  local bw = bodyWidth(ok and sane(w) and w or WIDTH)
  self.bodyWidth = bw
  self.status:SetWidth(bw - 150)
  self.sources:SetWidth(bw)
  self.aoeRow:SetWidth(bw)
  self.body:SetWidth(bw)
  self.profileChild:SetWidth(bw)
  self.specRow:SetWidth(bw - 4)
  self.notesBox:SetWidth(bw - 14)
  for _, fs in ipairs(self.profileTexts) do fs:SetWidth(bw - 4) end
  -- The list would stay where it opened.
  self.specDrop.list:Hide()
  if not self:IsShown() then return end
  local drawn, why = pcall(function()
    if self:Current() == "build" then self:RefreshProfile()
    elseif self.blocks then self:Render(self.blocks) end
  end)
  if not drawn then UI.lastError = "resizing: " .. tostring(why) end
end

-- Back in the middle at the size it started with (/armory resetwindow).
function UI:ResetWindow()
  local f = self.frame
  if f and self.sizing then self:StopResize() end
  settings().place, settings().size = nil, nil
  if not f then return end
  f:ClearAllPoints()
  f:SetPoint("CENTER")
  f:SetSize(clampSize(WIDTH, HEIGHT))
  self:Layout()
end

-- The build tab ---------------------------------------------------------------------

-- The build tab's page: its fixed parts (labels, chips, boxes, buttons and
-- the gaps between them) and its texts as tall as they wrap at this width,
-- so a narrow window can still be scrolled to the bottom.
local PROFILE_HEIGHT, PROFILE_FIXED = 450, 360
function UI:ProfileHeight()
  local h = PROFILE_FIXED
  for _, fs in ipairs(self.profileTexts) do h = h + (fs:GetStringHeight() or 14) end
  return math.max(PROFILE_HEIGHT, h)
end

function UI:BuildProfile(page)
  -- In a scroll frame of its own: the controls stay inside the page whatever
  -- the font size.
  local holder = CreateFrame("ScrollFrame", "ForeverAICompanionArmoryProfileScroll", page, "UIPanelScrollFrameTemplate")
  holder:SetPoint("TOPLEFT", PAD, -64)
  holder:SetPoint("BOTTOMRIGHT", -PAD - 22, PAD)
  local p = CreateFrame("Frame", nil, holder)
  p:SetSize(self.bodyWidth, PROFILE_HEIGHT)
  holder:SetScrollChild(p)
  self.profile, self.profileChild = holder, p
  local width = self.bodyWidth - 4

  local intro = text(p, "GameFontHighlight")
  intro:SetPoint("TOPLEFT", 0, 0)
  intro:SetWidth(width)
  intro:SetText(L.PROFILE_INTRO)
  color(intro, "muted")

  local function label(textValue, anchor, gap)
    local fs = text(p, "GameFontNormal")
    fs:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, -(gap or 12))
    fs:SetText(textValue)
    return fs
  end

  -- Specialization: one of the class's own (Scan.Specs). Only for a class
  -- with none known is there a box to type it in instead.
  local specLabel = label(L.SPEC, intro)
  local specRow = CreateFrame("Frame", nil, p)
  specRow:SetPoint("TOPLEFT", specLabel, "BOTTOMLEFT", 0, -6)
  specRow:SetSize(width, 24)
  self.specRow = specRow
  local function setSpec(value)
    if ns.Store:SetProfile("spec", value ~= "" and value or nil) then UI:Refresh() end
  end
  self.specDrop = dropdown(specRow, 230, L.SPEC_CHOOSE, setSpec)
  self.specDrop:SetPoint("TOPLEFT")
  self.specBox = editBox(specRow, 230, 60, setSpec)
  self.specBox:SetPoint("TOPLEFT")
  self.specBox:Hide()

  local function choice(title, anchor, values, field, prefix)
    local fs = label(title, anchor)
    local chips, x = {}, 0
    for _, value in ipairs(values) do
      local c = chip(p, L[prefix .. value:upper()], function()
        ns.Store:SetProfile(field, value)
        UI:Refresh()
      end)
      c:SetPoint("TOPLEFT", fs, "BOTTOMLEFT", x, -6)
      x = x + c:GetWidth() + 6
      chips[value] = c
    end
    return fs, chips
  end
  local goalLabel
  goalLabel, self.goalChips = choice(L.GOAL, specRow, ns.Store.GOALS, "goal", "GOAL_")
  local roleAnchor = CreateFrame("Frame", nil, p)
  roleAnchor:SetPoint("TOPLEFT", goalLabel, "BOTTOMLEFT", 0, -28)
  roleAnchor:SetSize(1, 1)
  local roleLabel
  roleLabel, self.roleChips = choice(L.ROLE, roleAnchor, ns.Store.ROLES, "role", "ROLE_")

  local notesAnchor = CreateFrame("Frame", nil, p)
  notesAnchor:SetPoint("TOPLEFT", roleLabel, "BOTTOMLEFT", 0, -28)
  notesAnchor:SetSize(1, 1)
  local notesLabel = label(L.NOTES_LABEL, notesAnchor)
  self.notesBox = editBox(p, width - 10, 200, function(value)
    ns.Store:SetProfile("notes", value ~= "" and value or nil)
  end)
  self.notesBox:SetPoint("TOPLEFT", notesLabel, "BOTTOMLEFT", 0, -6)
  local notesHint = text(p, "GameFontDisableSmall")
  notesHint:SetPoint("TOPLEFT", self.notesBox, "BOTTOMLEFT", 0, -4)
  notesHint:SetWidth(width)
  notesHint:SetText(L.NOTES_HINT)
  -- The texts that wrap: they follow the width, and the page's height follows them.
  self.profileTexts = { intro, notesHint }

  -- Everything at once, and where each analysis stands.
  self.all = button(p, L.ANALYZE_ALL, 190, function() UI:AnalyzeAll() end)
  self.all:SetPoint("TOPLEFT", notesHint, "BOTTOMLEFT", 0, -12)
  hintWith(self.all, function()
    -- With what the last run of each analysis used, added up.
    local total, cached, runs = 0, 0, 0
    for _, kind in ipairs(ns.Store.KINDS) do
      local t, c = cost(kind)
      if t then total, cached, runs = total + t, cached + c, runs + 1 end
    end
    if runs == 0 then return L.ANALYZE_ALL, L.ANALYZE_ALL_TIP end
    return L.ANALYZE_ALL, L.ANALYZE_ALL_TIP .. "\n\n" .. string.format(L.COST_ALL, runs, thousands(total), thousands(cached))
  end)
  self.summary = {}
  local last = self.all
  for i, kind in ipairs(ns.Store.KINDS) do
    local line = text(p, "GameFontHighlightSmall")
    line:SetPoint("TOPLEFT", last, "BOTTOMLEFT", 0, i == 1 and -12 or -5)
    line:SetWidth(width)
    self.summary[kind] = line
    table.insert(self.profileTexts, line)
    last = line
  end

  -- Options, kept for the whole account.
  local function option(labelText, key, anchor, onChange)
    local c = CreateFrame("CheckButton", nil, p, "UICheckButtonTemplate")
    c:SetSize(24, 24)
    c:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", anchor == last and -2 or 0, anchor == last and -12 or 0)
    local fs = text(c, "GameFontHighlightSmall")
    fs:SetPoint("LEFT", c, "RIGHT", 2, 0)
    fs:SetText(labelText)
    c:SetScript("OnClick", function(self)
      settings()[key] = self:GetChecked() and true or false
      if onChange then onChange() end
    end)
    return c
  end
  self.optTooltip = option(L.OPTION_TOOLTIP, "tooltip", last)
  self.optButton = option(L.OPTION_BUTTON, "button", self.optTooltip, function() if ns.Button then ns.Button:Update() end end)
end

-- The class's specializations as the choices. Filled again when the game
-- names them differently (the talents were not readable yet, say).
function UI:FillSpecs()
  local names = ns.Scan.Specs()
  local key = table.concat(names, "|")
  if key ~= self.specKey then
    self.specKey = key
    self.specDrop:SetOptions(names)
    if #names > 0 then
      self.specBox:Hide()
      self.specDrop:Show()
    else
      self.specDrop:Hide()
      self.specBox:Show()
    end
  end
  local spec = ns.Store:Profile().spec
  -- An earlier test build offered the class's own name as the only choice on
  -- Forever's client. It is not a specialization: the choice is open again.
  local class = UnitClass and Util.clean((UnitClass("player")))
  if spec and class and spec == class and #names > 0 then
    local listed = false
    for _, name in ipairs(names) do listed = listed or name == spec end
    if not listed then
      ns.Store:SetProfile("spec", nil)
      spec = nil
    end
  end
  self.specDrop:SetValue(spec)
  if not self.specBox:HasFocus() then self.specBox:SetText(spec or "") end
end

function UI:RefreshProfile()
  local profile = ns.Store:Profile()
  self:FillSpecs()
  for value, c in pairs(self.goalChips) do c:SetOn(value == profile.goal) end
  for value, c in pairs(self.roleChips) do c:SetOn(value == profile.role) end
  if not self.notesBox:HasFocus() then self.notesBox:SetText(profile.notes or "") end
  for _, kind in ipairs(ns.Store.KINDS) do
    local status, tone = ns.Panels.Status(kind)
    self.summary[kind]:SetText(L["KIND_" .. kind:upper()] .. ": " .. status)
    color(self.summary[kind], tone)
  end
  self.optTooltip:SetChecked(settings().tooltip and true or false)
  self.optButton:SetChecked(settings().button and true or false)
  local blocked = ns.Advisor:Blocked()
  if blocked or ns.Advisor:AnyAsking() or self.queue then self.all:Disable() else self.all:Enable() end
  self.profileChild:SetHeight(self:ProfileHeight())
end

-- Laying out blocks -------------------------------------------------------------------

local function take(self, kind, make)
  self.used[kind] = self.used[kind] + 1
  local pool = self.pools[kind]
  local w = pool[self.used[kind]]
  if not w then
    w = make()
    pool[self.used[kind]] = w
  end
  w:Show()
  return w
end

local function newRow(body)
  local r = CreateFrame("Button", nil, body)
  local back = r:CreateTexture(nil, "BACKGROUND")
  back:SetAllPoints()
  r.back = back
  local hover = r:CreateTexture(nil, "HIGHLIGHT")
  hover:SetAllPoints()
  hover:SetColorTexture(COLORS.hover[1], COLORS.hover[2], COLORS.hover[3], COLORS.hover[4])
  local icon = r:CreateTexture(nil, "ARTWORK")
  icon:SetSize(22, 22)
  icon:SetPoint("TOPLEFT", 4, -4)
  icon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
  r.icon = icon
  r.right = text(r, "GameFontHighlightSmall", "RIGHT")
  r.right:SetPoint("TOPRIGHT", -6, -6)
  r.title = text(r, "GameFontHighlight")
  r.title:SetPoint("TOPLEFT", 32, -5)
  r.sub = text(r, "GameFontHighlightSmall")
  r.sub:SetPoint("TOPLEFT", r.title, "BOTTOMLEFT", 0, -2)
  color(r.sub, "muted")
  r:SetScript("OnEnter", function(self)
    if not GameTooltip or not (self.link or self.spell or self.hint) then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    local ok
    if self.link then ok = pcall(GameTooltip.SetHyperlink, GameTooltip, self.link)
    elseif self.spell then ok = pcall(GameTooltip.SetSpellByID, GameTooltip, self.spell)
    else
      -- No item behind this row for the game to show: why, in a tooltip of our own.
      ok = true
      GameTooltip:SetText(self.title:GetText() or "", 1, 1, 1)
      GameTooltip:AddLine(self.hint, 0.8, 0.8, 0.8, true)
    end
    if ok then GameTooltip:Show() else GameTooltip:Hide() end
  end)
  r:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  r:SetScript("OnClick", function(self)
    -- Shift-click to link it in chat, ctrl-click to try it on: as any item link.
    if self.link and HandleModifiedItemClick then pcall(HandleModifiedItemClick, self.link) end
  end)
  return r
end

local function newBar(body)
  local b = CreateFrame("Frame", nil, body)
  b:SetHeight(20)
  local back = b:CreateTexture(nil, "BACKGROUND")
  back:SetAllPoints()
  back:SetColorTexture(COLORS.barBack[1], COLORS.barBack[2], COLORS.barBack[3], COLORS.barBack[4])
  local bar = b:CreateTexture(nil, "ARTWORK")
  bar:SetPoint("TOPLEFT")
  bar:SetPoint("BOTTOMLEFT")
  bar:SetColorTexture(COLORS.bar[1], COLORS.bar[2], COLORS.bar[3], COLORS.bar[4])
  b.bar = bar
  b.label = text(b, "GameFontHighlightSmall")
  b.label:SetPoint("LEFT", 6, 0)
  b.right = text(b, "GameFontHighlightSmall", "RIGHT")
  b.right:SetPoint("RIGHT", -6, 0)
  return b
end

local FONTS = { h = "GameFontNormal", p = "GameFontHighlight", note = "GameFontHighlight" }
local ACTIONS = {
  auction = function() if ns.Auction then ns.Auction:Search() end end,
}

-- Draws `blocks` in the scrolling body, top to bottom.
function UI:Render(blocks)
  for kind, pool in pairs(self.pools) do
    for _, w in ipairs(pool) do w:Hide() end
    self.used[kind] = 0
  end
  local body, y = self.body, 0
  local bw = self.bodyWidth
  for _, block in ipairs(blocks) do
    local kind = block.t
    if kind == "h" or kind == "p" or kind == "note" then
      local fs = take(self, "text", function() return text(body) end)
      fs:SetFontObject(_G[FONTS[kind]] or GameFontHighlight)
      local indent = kind == "note" and 12 or 0
      if kind == "h" then y = y + 8 end
      fs:ClearAllPoints()
      fs:SetPoint("TOPLEFT", body, "TOPLEFT", indent, -y)
      fs:SetWidth(bw - indent)
      fs:SetText((kind == "note" and "- " or "") .. tostring(block.text or ""))
      color(fs, kind == "h" and "gold" or block.color or "text")
      y = y + (fs:GetStringHeight() or 14) + (kind == "h" and 6 or 7)
    elseif kind == "row" then
      local r = take(self, "row", function() return newRow(body) end)
      r:SetWidth(bw)
      r.link, r.spell, r.hint = block.link, block.spell, block.hint
      if block.icon then
        r.icon:SetTexture(block.icon)
        r.icon:Show()
      else
        r.icon:Hide()
      end
      r.title:ClearAllPoints()
      r.title:SetPoint("TOPLEFT", block.icon and 32 or 6, -5)
      r.right:SetText(block.right or "")
      color(r.right, block.rightColor or "text")
      local rightWidth = block.right and ((r.right:GetStringWidth() or 0) + 14) or 0
      local textWidth = bw - (block.icon and 32 or 6) - 8 - rightWidth
      r.title:SetWidth(textWidth)
      -- An item link draws in the color of its quality.
      r.title:SetText(block.link and block.link:find("|H") and block.link or tostring(block.title or ""))
      color(r.title, block.dim and "muted" or "text")
      r.sub:SetWidth(bw - (block.icon and 32 or 6) - 8)
      r.sub:SetText(block.sub or "")
      local back = block.highlight and COLORS.highlight or { 0, 0, 0, 0 }
      r.back:SetColorTexture(back[1], back[2], back[3], back[4])
      local height = 8 + (r.title:GetStringHeight() or 14) + ((block.sub and block.sub ~= "") and ((r.sub:GetStringHeight() or 12) + 2) or 0) + 4
      r:SetHeight(math.max(height, 30))
      r:ClearAllPoints()
      r:SetPoint("TOPLEFT", body, "TOPLEFT", 0, -y)
      y = y + r:GetHeight() + 2
    elseif kind == "bar" then
      local b = take(self, "bar", function() return newBar(body) end)
      b:ClearAllPoints()
      b:SetPoint("TOPLEFT", body, "TOPLEFT", 0, -y)
      b:SetWidth(bw)
      b.bar:SetWidth(math.max(1, bw * math.min(math.max(tonumber(block.value) or 0, 0), 100) / 100))
      b.label:SetText(tostring(block.label or ""))
      b.right:SetText(tostring(block.right or ""))
      y = y + 23
    elseif kind == "action" then
      local a = take(self, "action", function() return button(body, "", 260, function(self) if self.run then self.run() end end) end)
      a:ClearAllPoints()
      a:SetPoint("TOPLEFT", body, "TOPLEFT", 0, -y - 4)
      a:SetText(tostring(block.text or ""))
      a:SetWidth(math.max(160, (a:GetTextWidth() or 120) + 30))
      a.run = ACTIONS[block.id]
      if block.disabled then a:Disable() else a:Enable() end
      y = y + 34
    elseif kind == "gap" then
      y = y + 10
    end
  end
  body:SetHeight(math.max(y, 10))
end

-- Showing, switching, refreshing --------------------------------------------------------

function UI:IsShown()
  return self.frame ~= nil and self.frame:IsShown()
end

function UI:Select(name)
  settings().tab = name
  if self.scroll and self.scroll.SetVerticalScroll then self.scroll:SetVerticalScroll(0) end
  self:Refresh()
end

function UI:Current()
  local tab = ns.db and settings().tab or "build"
  for _, name in ipairs(self.TABS) do
    if name == tab then return tab end
  end
  return "build"
end

local APP_TEXT = {
  ready = "APP_READY", checking = "APP_CHECKING", closed = "APP_CLOSED", stuck = "APP_STUCK",
  ["need-ai"] = "APP_NEED_AI", ["need-login"] = "APP_NEED_LOGIN", problem = "APP_PROBLEM",
  restart = "APP_RESTART", nosound = "APP_NOSOUND", unknown = "APP_UNKNOWN",
}

-- "Fury, raids, damage" or a nudge to choose.
local function profileLine()
  local profile = ns.Store:Profile()
  if not profile.spec or profile.spec == "" then return L.PICK_SPEC end
  return ns.Panels.ProfileText(profile)
end

function UI:Refresh()
  if not self:IsShown() then return end
  local tab = self:Current()
  for name, b in pairs(self.tabs) do
    local on = name == tab
    fill(b, on and COLORS.chipOn or COLORS.panel, on and COLORS.chipOn or COLORS.panel)
    local asking = name ~= "build" and ns.Advisor:IsAsking(name)
    b.dot:SetText(asking and "..." or "")
  end
  local name, level, class = UnitName and UnitName("player"), UnitLevel and UnitLevel("player"), UnitClass and UnitClass("player")
  self.who:SetText(string.format("%s · %s %s", tostring(name or "?"), tostring(level or "?"), tostring(class or "")))

  -- The line about the app before anything else on the page.
  local state = ns.Advisor:AppState()
  self.app:SetText(L.APP .. ": " .. (state and L[APP_TEXT[state] or "APP_UNKNOWN"] or L.APP_MISSING))
  color(self.app, state == "ready" and "good" or (state == "checking" and "muted" or "warn"))

  local blocked = ns.Advisor:Blocked()
  if tab == "build" then
    self.heading:SetText(L.TAB_BUILD)
    self.status:SetText(blocked or profileLine())
    color(self.status, blocked and "warn" or "muted")
    self.analyze:Hide()
    self.scroll:Hide()
    self.sources:Hide()
    self.aoeRow:Hide()
    self.profile:Show()
    self:RefreshProfile()
  else
    self.profile:Hide()
    -- The gear tab has its row of sources between the status and the plan,
    -- the rotation tab its choice of one enemy or several.
    local gear, rotation = tab == "gear", tab == "rotation"
    self.scroll:SetPoint("TOPLEFT", PAD, (gear or rotation) and -94 or -64)
    if gear then
      local on = ns.Store:GearSources()
      for source, c in pairs(self.sourceChecks) do c:SetChecked(on[source] and true or false) end
      self.sources:Show()
    else
      self.sources:Hide()
    end
    if rotation then
      self.aoeCheck:SetChecked(ns.Store:Aoe())
      self.aoeRow:Show()
    else
      self.aoeRow:Hide()
    end
    self.scroll:Show()
    self.analyze:Show()
    self.heading:SetText(L["TAB_" .. tab:upper()])
    local status, tone = ns.Panels.Status(tab)
    self.status:SetText(blocked or status)
    color(self.status, blocked and "warn" or tone)
    local asking = ns.Advisor:IsAsking(tab)
    self.analyze:SetText(asking and L.ANALYZING or (ns.Store:Result(tab) and L.ANALYZE_AGAIN or L.ANALYZE))
    if asking or blocked then self.analyze:Disable() else self.analyze:Enable() end
    local ok, blocks = pcall(ns.Panels.BY_KIND[tab])
    if not ok then
      UI.lastError = tab .. " tab: " .. tostring(blocks)
      blocks = { { t = "p", text = tostring(blocks), color = "warn" } }
    end
    -- Kept to be drawn again at another width while the window is resized.
    self.blocks = blocks
    -- A block that cannot be drawn must not leave the rest of the window as it was.
    local drawn, why = pcall(self.Render, self, blocks)
    if not drawn then UI.lastError = tab .. " tab, drawing: " .. tostring(why) end
  end
end

function UI:Analyze()
  local tab = self:Current()
  if tab == "build" then return end
  local ok, why = ns.Advisor:Ask(tab)
  if not ok and why then
    ns.Store:SetAsking(tab, { state = "error", t = time(), message = why })
    if why == L.PICK_SPEC then self:Select("build") end
  end
  self:Refresh()
end

-- Every analysis, one after the other: the rotation before the gear plan (its
-- measured stat weights go into it) and before the interactions (measured
-- against its model). Each is asked when the one before has its answer, so
-- none of them spends its waiting time in the app's line.
local ALL = { "talents", "rotation", "gear", "discover" }
function UI:AnalyzeAll()
  if self.queue then return end
  self.queue = {}
  for i, kind in ipairs(ALL) do self.queue[i] = kind end
  self:NextInQueue()
end

local function later(seconds, fn)
  if C_Timer and C_Timer.After then C_Timer.After(seconds, fn) else fn() end
end

function UI:NextInQueue()
  local kind = self.queue and self.queue[1]
  if not kind then
    self.queue, self.queued = nil, nil
    self:Refresh()
    return
  end
  local ok, why = ns.Advisor:Ask(kind)
  if ok then
    table.remove(self.queue, 1)
    self.queued = kind -- the next one follows its answer (OnAnalysisDone)
  elseif why == L.COMPANION_BUSY then
    -- The main addon is still sending something: try again in a moment.
    later(1.5, function() UI:NextInQueue() end)
  elseif why == L.PICK_SPEC then
    self.queue, self.queued = nil, nil
    ns.Store:SetAsking(kind, { state = "error", t = time(), message = why })
  else
    -- This one can't be asked (already on its way, or no data for it): the rest still can.
    table.remove(self.queue, 1)
    later(0.5, function() UI:NextInQueue() end)
  end
  self:Refresh()
end

-- An analysis got its answer, or failed (Advisor:OnResult).
function UI:OnAnalysisDone(kind)
  if self.queue and self.queued == kind then
    self.queued = nil
    later(0.5, function() UI:NextInQueue() end)
  end
end

function UI:OnShow()
  local api = ns.Advisor.API()
  if api and api.WatchApp then api.WatchApp(ns.Advisor.PLUGIN, true) end
  if not self.ticker and C_Timer and C_Timer.NewTicker then
    -- Keeps the waiting time and the item checks moving while the window is open.
    self.ticker = C_Timer.NewTicker(1, function()
      if not UI:IsShown() then return end
      -- Guarded: the game stops calling a ticker whose function failed once.
      local ok, err = pcall(function()
        ns.Items.Expire(20)
        -- The app's state is redrawn while it is still being worked out, too.
        if ns.Advisor:AnyAsking() or UI.dirty or ns.Advisor:AppState() ~= UI.shownAppState then
          UI.dirty = nil
          UI.shownAppState = ns.Advisor:AppState()
          UI:Refresh()
        end
      end)
      if not ok then UI.lastError = "window timer: " .. tostring(err) end
    end)
  end
  self:Refresh()
end

function UI:OnHide()
  -- Closed in the middle of a resize (Escape): the size so far is kept.
  if self.sizing then self:StopResize() end
  local api = ns.Advisor.API()
  if api and api.WatchApp then api.WatchApp(ns.Advisor.PLUGIN, false) end
end

-- Something the open tab shows changed: redraw on the next tick, once.
function UI:Touch()
  self.dirty = true
end

function UI:Show(tab)
  self:Build()
  if tab then settings().tab = tab end
  self.frame:Show()
  self:Refresh()
end

function UI:Toggle()
  self:Build()
  if self.frame:IsShown() then self.frame:Hide() else self:Show() end
end

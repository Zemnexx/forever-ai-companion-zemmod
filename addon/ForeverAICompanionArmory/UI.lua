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
local WIDTH, HEIGHT = 760, 560
local SIDE = 150          -- the tab column
local PAD = 14
-- What fits inside the page: the window, less the tab column, the margins
-- around and inside the page, and the scroll bar.
local BODY_WIDTH = WIDTH - SIDE - PAD * 5 - 22
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

local function hint(frame, title, body)
  frame:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:SetText(title, 1, 1, 1)
    if body then GameTooltip:AddLine(body, 0.8, 0.8, 0.8, true) end
    GameTooltip:Show()
  end)
  frame:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
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

function UI:Build()
  if self.frame then return end
  local f = CreateFrame("Frame", "ForeverAICompanionArmoryFrame", UIParent, BACKDROP)
  self.frame = f
  f:SetSize(WIDTH, HEIGHT)
  f:SetFrameStrata("HIGH")
  f:SetClampedToScreen(true)
  f:EnableMouse(true)
  f:SetMovable(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", f.StartMoving)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, relative, x, y = self:GetPoint(1)
    settings().place = { point, relative, x, y }
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
  status:SetWidth(BODY_WIDTH - 150)
  self.status = status
  self.analyze = button(page, L.ANALYZE, 140, function() UI:Analyze() end)
  self.analyze:SetPoint("TOPRIGHT", -PAD, -PAD)

  local scroll = CreateFrame("ScrollFrame", "ForeverAICompanionArmoryScroll", page, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", PAD, -64)
  scroll:SetPoint("BOTTOMRIGHT", -PAD - 22, PAD)
  local body = CreateFrame("Frame", nil, scroll)
  body:SetSize(BODY_WIDTH, 10)
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
  version:SetPoint("BOTTOMRIGHT", -PAD, 12)
  version:SetText(L.TITLE .. " " .. tostring(ns.version or ""))
end

-- The build tab ---------------------------------------------------------------------

function UI:BuildProfile(page)
  -- In a scroll frame of its own: the controls stay inside the page whatever
  -- the font size.
  local holder = CreateFrame("ScrollFrame", "ForeverAICompanionArmoryProfileScroll", page, "UIPanelScrollFrameTemplate")
  holder:SetPoint("TOPLEFT", PAD, -64)
  holder:SetPoint("BOTTOMRIGHT", -PAD - 22, PAD)
  local p = CreateFrame("Frame", nil, holder)
  p:SetSize(BODY_WIDTH, 480)
  holder:SetScrollChild(p)
  self.profile = holder
  local width = BODY_WIDTH - 4

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

  -- Specialization: the class's talent trees, or the player's own words.
  local specLabel = label(L.SPEC, intro)
  local specRow = CreateFrame("Frame", nil, p)
  specRow:SetPoint("TOPLEFT", specLabel, "BOTTOMLEFT", 0, -6)
  specRow:SetSize(width, 24)
  self.specRow, self.specChips = specRow, {}
  self.specBox = editBox(p, 230, 60, function(value)
    if ns.Store:SetProfile("spec", value ~= "" and value or nil) then UI:Refresh() end
  end)
  self.specBox:SetPoint("TOPLEFT", specRow, "BOTTOMLEFT", 0, -6)
  local specHint = text(p, "GameFontDisableSmall")
  specHint:SetPoint("LEFT", self.specBox, "RIGHT", 8, 0)
  specHint:SetText(L.SPEC_HINT)

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
  goalLabel, self.goalChips = choice(L.GOAL, self.specBox, ns.Store.GOALS, "goal", "GOAL_")
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
  notesHint:SetText(L.NOTES_HINT)

  -- Everything at once, and where each analysis stands.
  self.all = button(p, L.ANALYZE_ALL, 190, function() UI:AnalyzeAll() end)
  self.all:SetPoint("TOPLEFT", notesHint, "BOTTOMLEFT", 0, -12)
  hint(self.all, L.ANALYZE_ALL, L.ANALYZE_ALL_TIP)
  self.summary = {}
  local last = self.all
  for i, kind in ipairs(ns.Store.KINDS) do
    local line = text(p, "GameFontHighlightSmall")
    line:SetPoint("TOPLEFT", last, "BOTTOMLEFT", 0, i == 1 and -12 or -5)
    line:SetWidth(width)
    self.summary[kind] = line
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

-- The class's trees as choices. Rebuilt when the talents were read differently.
function UI:FillSpecs()
  local section = ns.Scan.Talents()
  local names = {}
  for _, tree in ipairs(section and section.trees or {}) do
    if section.api == "classic" then names[#names + 1] = tree.name end
  end
  local key = table.concat(names, "|")
  if key ~= self.specKey then
    self.specKey = key
    for _, c in ipairs(self.specChips) do c:Hide() end
    local x = 0
    for i, name in ipairs(names) do
      local c = self.specChips[i]
      if not c then
        c = chip(self.specRow, name, function(self)
          ns.Store:SetProfile("spec", self.value)
          UI:Refresh()
        end)
        self.specChips[i] = c
      end
      c.value = name
      c.label:SetText(name)
      c:SetWidth(math.max(64, (c.label:GetStringWidth() or 40) + 22))
      c:ClearAllPoints()
      c:SetPoint("TOPLEFT", self.specRow, "TOPLEFT", x, 0)
      c:Show()
      x = x + c:GetWidth() + 6
    end
  end
  local spec = ns.Store:Profile().spec
  for _, c in ipairs(self.specChips) do c:SetOn(c:IsShown() and c.value == spec) end
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
  r:SetWidth(BODY_WIDTH)
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
    if not GameTooltip or not (self.link or self.spell) then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    local ok
    if self.link then ok = pcall(GameTooltip.SetHyperlink, GameTooltip, self.link)
    else ok = pcall(GameTooltip.SetSpellByID, GameTooltip, self.spell) end
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
  b:SetSize(BODY_WIDTH, 20)
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
  for _, block in ipairs(blocks) do
    local kind = block.t
    if kind == "h" or kind == "p" or kind == "note" then
      local fs = take(self, "text", function() return text(body) end)
      fs:SetFontObject(_G[FONTS[kind]] or GameFontHighlight)
      local indent = kind == "note" and 12 or 0
      if kind == "h" then y = y + 8 end
      fs:ClearAllPoints()
      fs:SetPoint("TOPLEFT", body, "TOPLEFT", indent, -y)
      fs:SetWidth(BODY_WIDTH - indent)
      fs:SetText((kind == "note" and "- " or "") .. tostring(block.text or ""))
      color(fs, kind == "h" and "gold" or block.color or "text")
      y = y + (fs:GetStringHeight() or 14) + (kind == "h" and 6 or 7)
    elseif kind == "row" then
      local r = take(self, "row", function() return newRow(body) end)
      r.link, r.spell = block.link, block.spell
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
      local textWidth = BODY_WIDTH - (block.icon and 32 or 6) - 8 - rightWidth
      r.title:SetWidth(textWidth)
      -- An item link draws in the color of its quality.
      r.title:SetText(block.link and block.link:find("|H") and block.link or tostring(block.title or ""))
      color(r.title, block.dim and "muted" or "text")
      r.sub:SetWidth(BODY_WIDTH - (block.icon and 32 or 6) - 8)
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
      b.bar:SetWidth(math.max(1, BODY_WIDTH * math.min(math.max(tonumber(block.value) or 0, 0), 100) / 100))
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

  local blocked = ns.Advisor:Blocked()
  if tab == "build" then
    self.heading:SetText(L.TAB_BUILD)
    self.status:SetText(blocked or profileLine())
    color(self.status, blocked and "warn" or "muted")
    self.analyze:Hide()
    self.scroll:Hide()
    self.profile:Show()
    self:RefreshProfile()
  else
    self.profile:Hide()
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
    if not ok then blocks = { { t = "p", text = tostring(blocks), color = "warn" } } end
    self:Render(blocks)
  end

  local state = ns.Advisor:AppState()
  self.app:SetText(L.APP .. ": " .. (state and L[APP_TEXT[state] or "APP_UNKNOWN"] or L.APP_MISSING))
  color(self.app, state == "ready" and "good" or (state == "checking" and "muted" or "warn"))
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
      ns.Items.Expire(20)
      if ns.Advisor:AnyAsking() or UI.dirty then
        UI.dirty = nil
        UI:Refresh()
      end
    end)
  end
  self:Refresh()
end

function UI:OnHide()
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

-- Forever AI Companion window, home of the player's assistant (Fizzi the gnome or Rizzik
-- the goblin, see Personas.lua). Built from the game's own art so it looks
-- like part of the real UI: gold dialog border over dark rock, the classic
-- title banner, a round portrait with a gold ring in the corner, the red close
-- button and red panel buttons. Chats on the left; on the right the
-- conversation as messages with avatars, like the in-game messengers.
-- A second look, "flat" (dark, flat and minimal, with blue highlights), is a
-- choice in Options > AddOns: see "Themes" below.
local _, ns = ...
local L = ns.L

local UI = {}
ns.UI = UI

local floor, max, min = math.floor, math.max, math.min

local function persona() return ns.Personas:Current() end

-- Game art ---------------------------------------------------------------------

local function fileExists(path)
  if not GetFileIDFromPath then return true end
  local ok, id = pcall(GetFileIDFromPath, path)
  return ok and id ~= nil
end

local ART = {
  border    = "Interface\\DialogFrame\\UI-DialogBox-Gold-Border",
  rock      = "Interface\\FrameGeneral\\UI-Background-Rock",
  banner    = "Interface\\DialogFrame\\UI-DialogBox-Header",
  edge      = "Interface\\Tooltips\\UI-Tooltip-Border",
  white     = "Interface\\Buttons\\WHITE8X8",
  ring      = "Interface\\Minimap\\MiniMap-TrackingBorder",
  disc      = "Interface\\Minimap\\UI-Minimap-Background",
  mask      = "Interface\\CharacterFrame\\TempPortraitAlphaMask",
  rowLight  = "Interface\\QuestFrame\\UI-QuestLogTitleHighlight",
  delete    = "Interface\\Buttons\\UI-GroupLoot-Pass-Up",
  grip      = "Interface\\ChatFrame\\UI-ChatIM-SizeGrabber",
}
if not fileExists(ART.border) then ART.border = "Interface\\DialogFrame\\UI-DialogBox-Border" end
if not fileExists(ART.rock) then ART.rock = nil end

local BACKDROP_TEMPLATE = BackdropTemplateMixin and "BackdropTemplate" or nil

-- Gold for frames and titles, like the default UI.
local GOLD = { 1, 0.82, 0 }
local EDGE_GOLD = { 0.78, 0.64, 0.38, 0.95 }
local EDGE_DIM = { 0.45, 0.4, 0.33, 0.9 }

-- Theme ------------------------------------------------------------------------
-- C holds the assistant's colors (bubbles, highlights). Its tables are updated
-- in place when the assistant changes and painted textures are repainted.

local C = {
  error = { 0.3, 0.07, 0.06, 0.9 },
  ok    = { 0.25, 0.95, 0.3, 1 },
  warn  = { 1, 0.75, 0.2, 1 },
  bad   = { 0.95, 0.3, 0.25, 1 },
  idle  = { 0.6, 0.6, 0.6, 1 },
  panel = { 0, 0, 0, 0.45 },
}
UI.COLORS = C

local function loadPalette(p)
  for k, v in pairs(p.colors) do
    local t = C[k] or {}
    t[1], t[2], t[3], t[4] = v[1], v[2], v[3], v[4] or 1
    C[k] = t
  end
end
loadPalette(ns.Personas.list.fizzi)

local painted = setmetatable({}, { __mode = "k" })

local DEFAULTS = { width = 860, height = 600, fontSize = 13, sidebar = true, theme = "wow" }
local MIN_W, MIN_H = 600, 430
local SIDEBAR_W = 220
local TOP_H = 64          -- room for the banner, the portrait and the tools
local ROW_H = 44
local AVATAR = 28

local SUGGESTIONS = L.SUGGESTIONS

local function settings()
  ns.db.ui = ns.db.ui or {}
  local s = ns.db.ui
  for k, v in pairs(DEFAULTS) do if s[k] == nil then s[k] = v end end
  return s
end

-- "|" is WoW's escape character: double it so AI text is shown literally.
local function escape(s)
  return (tostring(s or ""):gsub("|", "||"))
end

-- The player's question with its links working (colored, hover and click as
-- in the chat); everything else escaped like escape().
local function withLinks(s)
  s = tostring(s or "")
  local out, pos = {}, 1
  while true do
    local a, b, data, shown = s:find("|H(.-)|h(.-)|h", pos)
    if not a then break end
    local before = s:sub(pos, a - 1)
    -- The link's color code sits right before it: "|cffRRGGBB" or, on newer
    -- clients, "|cnIQ1:" (the color of item quality 1).
    local color = before:match("|c%x%x%x%x%x%x%x%x$") or before:match("|cn[%w_]*:$") or ""
    before = before:sub(1, #before - #color)
    local after = b + 1
    if s:sub(after, after + 1) == "|r" then after = after + 2 end
    out[#out + 1] = escape(before)
    out[#out + 1] = color .. "|H" .. data .. "|h" .. shown:gsub("|", "") .. "|h" .. (color ~= "" and "|r" or "")
    pos = after
  end
  out[#out + 1] = escape(s:sub(pos))
  return table.concat(out)
end
UI.WithLinks = withLinks

-- Items in the AI's answers: it writes {{item:ID|Name}} for items it saw in
-- the character data, and they become real item links (color, tooltip, click).
-- The id must really be that item (same name in the game), so a mistaken id
-- never shows the wrong item: then, or while the game hasn't loaded the item
-- yet, just the name is shown.
local ITEM_TOKEN = "{{item:(%d+)|(.-)}}"
local GetItemInfoFn = (C_Item and C_Item.GetItemInfo) or GetItemInfo

local function sameName(a, b)
  local function norm(s) return (tostring(s or ""):lower():gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")) end
  return norm(a) == norm(b)
end

-- link, false (that id is another item) or nil (not loaded yet: asked for it).
local function answerItemLink(id, name)
  if not GetItemInfoFn then return false end
  local ok, realName, link = pcall(GetItemInfoFn, tonumber(id))
  if not ok then return false end
  if not realName then
    if C_Item and C_Item.RequestLoadItemDataByID then pcall(C_Item.RequestLoadItemDataByID, tonumber(id)) end
    UI.waitingItems = true
    return nil
  end
  return sameName(realName, name) and link or false
end

-- The answer as shown in its bubble: item links working, the rest escaped.
local function renderAnswer(s)
  s = tostring(s or "")
  local out, pos = {}, 1
  while true do
    local a, b, id, name = s:find(ITEM_TOKEN, pos)
    if not a then break end
    out[#out + 1] = escape(s:sub(pos, a - 1))
    out[#out + 1] = answerItemLink(id, name) or escape(name)
    pos = b + 1
  end
  out[#out + 1] = escape(s:sub(pos))
  return table.concat(out)
end
UI.RenderAnswer = renderAnswer

-- The answer as plain text (copy window, notifications): "[Name]" for items.
function UI.PlainAnswer(s)
  return (tostring(s or ""):gsub(ITEM_TOKEN, "[%2]"))
end

-- Items the game was still loading: show them as links once they arrive.
local itemWatcher = CreateFrame and CreateFrame("Frame")
if itemWatcher then
  pcall(itemWatcher.RegisterEvent, itemWatcher, "GET_ITEM_INFO_RECEIVED")
  itemWatcher:SetScript("OnEvent", function()
    if not UI.waitingItems or UI.itemRefreshQueued then return end
    UI.itemRefreshQueued = true
    C_Timer.After(0.3, function()
      UI.itemRefreshQueued = nil
      UI.waitingItems = nil
      if UI:IsShown() then UI:RefreshConversation() end
    end)
  end)
end

local function fill(region, color)
  region:SetColorTexture(color[1], color[2], color[3], color[4] or 1)
  painted[region] = color
end

-- A colored texture (anchors are up to the caller: used for lines).
local function rect(parent, color, layer)
  local t = parent:CreateTexture(nil, layer or "BACKGROUND")
  fill(t, color)
  return t
end

-- A round texture (when the client supports masks).
local function round(frame, texture)
  local mask = frame.CreateMaskTexture and frame:CreateMaskTexture()
  if not mask then return end
  mask:SetTexture(ART.mask, "CLAMPTOBLACKADDITIVE", "CLAMPTOBLACKADDITIVE")
  mask:SetAllPoints(texture)
  texture:AddMaskTexture(mask)
end

local function newFrame(kind, name, parent, template)
  local tpl = BACKDROP_TEMPLATE
  if template then tpl = tpl and (template .. "," .. tpl) or template end
  return CreateFrame(kind, name, parent, tpl)
end

-- Thin tooltip-style border with a translucent dark fill: inset panels,
-- message boxes, the text box.
local function panel(frame, edge, bg, edgeSize)
  if not frame.SetBackdrop then return end
  frame:SetBackdrop({
    bgFile = ART.white, edgeFile = ART.edge, tile = false,
    edgeSize = edgeSize or 14, insets = { left = 3, right = 3, top = 3, bottom = 3 },
  })
  bg = bg or C.panel
  frame:SetBackdropColor(bg[1], bg[2], bg[3], bg[4] or 1)
  edge = edge or EDGE_DIM
  frame:SetBackdropBorderColor(edge[1], edge[2], edge[3], edge[4] or 1)
end

-- Themes -----------------------------------------------------------------------
-- Two looks, picked in Options > AddOns (Options.lua) and saved with the
-- window's settings: "wow" (the default), the game's own art described at the
-- top, and "flat": dark, flat and minimal, with blue highlights. Switching
-- repaints the window at once. Each part registers how it paints itself in
-- each look (onTheme); the parts drawn on every refresh (chat rows, messages)
-- look at flat() as they draw. Only the look changes: every feature stays.

local FLAT = {
  window    = { 0.067, 0.075, 0.09, 0.97 },
  border    = { 0.18, 0.2, 0.24, 1 },
  panel     = { 0.09, 0.1, 0.12, 0.96 },
  input     = { 0.05, 0.056, 0.068, 1 },
  chip      = { 0.12, 0.135, 0.16, 1 },
  user      = { 0.12, 0.27, 0.48, 0.95 },
  ai        = { 0.13, 0.145, 0.17, 0.95 },
  error     = { 0.3, 0.085, 0.085, 0.92 },
  errorEdge = { 0.62, 0.22, 0.2, 1 },
  line      = { 0.2, 0.22, 0.26, 1 },
  accent    = { 0.24, 0.58, 1, 1 },
  select    = { 0.24, 0.58, 1, 0.16 },
  hover     = { 1, 1, 1, 0.06 },
  button    = { 0.16, 0.175, 0.21, 1 },
  primary   = { 0.17, 0.45, 0.88, 1 },
  text      = { 0.9, 0.92, 0.95, 1 },
  muted     = { 0.56, 0.6, 0.66, 1 },
}
UI.FLAT = FLAT
UI.THEMES = { "wow", "flat" }
local ACCENT_TEXT = "|cff3d94ff" -- FLAT.accent, as a text color code

local themers = {}
local function flat() return settings().theme == "flat" end

-- Registers how fn(isFlat) paints a part, and paints it now.
local function onTheme(fn)
  themers[#themers + 1] = fn
  fn(flat())
end

-- A solid fill with a 1-pixel edge (the fill's own color without `edge`).
local function flatPanel(frame, bg, edge)
  if not frame.SetBackdrop then return end
  frame:SetBackdrop({ bgFile = ART.white, edgeFile = ART.white, edgeSize = 1, insets = { left = 1, right = 1, top = 1, bottom = 1 } })
  frame:SetBackdropColor(bg[1], bg[2], bg[3], bg[4] or 1)
  edge = edge or bg
  frame:SetBackdropBorderColor(edge[1], edge[2], edge[3], edge[4] or 1)
end

-- Each kind of panel in the flat look: its fill, and its edge if it has one.
local FLAT_PANELS = {
  panel = { "panel", "border" }, input = { "input", "border" }, chip = { "chip" }, card = { "chip", "border" },
  user = { "user" }, ai = { "ai" }, error = { "error", "errorEdge" },
}
local function paintPanel(frame, isFlat, role, edge, bg, edgeSize)
  if isFlat then
    local look = FLAT_PANELS[role] or FLAT_PANELS.panel
    flatPanel(frame, FLAT[look[1]], look[2] and FLAT[look[2]])
  else
    panel(frame, edge, bg, edgeSize)
  end
end

-- panel() in both looks: the WoW look with these colors, the flat one of `role`.
local function themedPanel(frame, role, edge, bg, edgeSize)
  onTheme(function(isFlat) paintPanel(frame, isFlat, role, edge, bg, edgeSize) end)
end

local function textColor(fs, c) fs:SetTextColor(c[1], c[2], c[3]) end

-- The big window look: dark base, rock texture and the gold dialog border.
-- Flat: one solid color inside a 1-pixel edge.
local function dialog(frame)
  local base = frame:CreateTexture(nil, "BACKGROUND", nil, -8)
  local rock
  if ART.rock then
    rock = frame:CreateTexture(nil, "BACKGROUND", nil, -7)
    rock:SetPoint("TOPLEFT", 6, -6)
    rock:SetPoint("BOTTOMRIGHT", -6, 6)
    rock:SetTexture(ART.rock, "REPEAT", "REPEAT")
    if rock.SetHorizTile then rock:SetHorizTile(true); rock:SetVertTile(true) end
    rock:SetVertexColor(0.55, 0.55, 0.55, 1)
  end
  onTheme(function(isFlat)
    local inset = isFlat and 1 or 6
    base:ClearAllPoints()
    base:SetPoint("TOPLEFT", inset, -inset)
    base:SetPoint("BOTTOMRIGHT", -inset, inset)
    local c = isFlat and FLAT.window or { 0.06, 0.055, 0.05, 0.97 }
    base:SetColorTexture(c[1], c[2], c[3], c[4])
    if rock then rock:SetShown(not isFlat) end
    if frame.SetBackdrop then
      if isFlat then
        frame:SetBackdrop({ edgeFile = ART.white, edgeSize = 1 })
        frame:SetBackdropBorderColor(FLAT.border[1], FLAT.border[2], FLAT.border[3], FLAT.border[4])
      else
        frame:SetBackdrop({ edgeFile = ART.border, edgeSize = 26, insets = { left = 6, right = 6, top = 6, bottom = 6 } })
        frame:SetBackdropBorderColor(1, 1, 1, 1)
      end
    end
  end)
end

-- Round picture inside the gold minimap ring (proportions as LibDBIcon).
local function ringedPortrait(parent, size)
  local h = CreateFrame("Button", nil, parent)
  h:SetSize(size, size)
  local disc = h:CreateTexture(nil, "BACKGROUND")
  disc:SetTexture(ART.disc)
  disc:SetSize(size * 0.74, size * 0.74)
  disc:SetPoint("CENTER")
  disc:SetVertexColor(0.04, 0.04, 0.04, 1)
  local icon = h:CreateTexture(nil, "ARTWORK")
  icon:SetSize(size * 0.64, size * 0.64)
  icon:SetPoint("CENTER")
  round(h, icon)
  local ring = h:CreateTexture(nil, "OVERLAY")
  ring:SetTexture(ART.ring)
  ring:SetSize(size * 1.62, size * 1.62)
  ring:SetPoint("TOPLEFT")
  h.icon, h.ring, h.disc = icon, ring, disc
  -- Flat: just the round picture.
  onTheme(function(isFlat)
    ring:SetShown(not isFlat)
    disc:SetShown(not isFlat)
  end)
  return h
end

-- Small round avatar (chat list, messages).
local function avatar(parent, size)
  local t = parent:CreateTexture(nil, "ARTWORK")
  t:SetSize(size, size)
  round(parent, t)
  return t
end

-- The game's red button with gold text. Flat: a plain dark button, or blue
-- for the main action (`primary`), lighter under the mouse.
local function panelButton(parent, label, width, height, primary)
  local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
  b:SetSize(width, height)
  b:SetText(label)
  local bg = b:CreateTexture(nil, "BACKGROUND", nil, -8)
  bg:SetAllPoints()
  local hl = b:CreateTexture(nil, "HIGHLIGHT")
  hl:SetAllPoints()
  b.flatBg = bg
  -- The template's own art (its three pieces and state textures).
  local art = {}
  for _, key in ipairs({ "Left", "Middle", "Right" }) do
    if type(b[key]) == "table" then art[#art + 1] = b[key] end
  end
  for _, get in ipairs({ "GetNormalTexture", "GetPushedTexture", "GetDisabledTexture", "GetHighlightTexture" }) do
    local t = b[get] and b[get](b)
    if t then art[#art + 1] = t end
  end
  onTheme(function(isFlat)
    for _, t in ipairs(art) do t:SetAlpha(isFlat and 0 or 1) end
    local c = primary and FLAT.primary or FLAT.button
    bg:SetColorTexture(c[1], c[2], c[3], c[4])
    bg:SetShown(isFlat)
    hl:SetColorTexture(1, 1, 1, isFlat and 0.08 or 0)
    if b.SetNormalFontObject and GameFontNormal then
      b:SetNormalFontObject(isFlat and GameFontHighlight or GameFontNormal)
      b:SetHighlightFontObject(GameFontHighlight)
    end
  end)
  return b
end

-- Text-only button: gold, brightens on hover. Flat: grey, blue on hover.
local function linkColors()
  if flat() then return FLAT.muted, FLAT.accent end
  return GOLD, { 1, 1, 1 }
end
local function linkButton(parent, label, width, height, font)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(width, height)
  local fs = b:CreateFontString(nil, "OVERLAY", font or "GameFontNormalSmall")
  fs:SetPoint("CENTER")
  fs:SetText(label)
  b.label = fs
  local function paint(over)
    local normal, hover = linkColors()
    textColor(fs, over and hover or normal)
  end
  b:SetScript("OnEnter", function() paint(true) end)
  b:SetScript("OnLeave", function() paint(false) end)
  onTheme(function() paint(false) end)
  return b
end

-- The red close button; flat: a plain "x" (`flatY`: its distance from the top).
local function closeButtons(frame, onClick, flatY)
  local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -3, -3)
  local x = linkButton(frame, "x", 24, 24, "GameFontHighlightLarge")
  x:SetPoint("TOPRIGHT", -8, -(flatY or 8))
  local function hide() frame:Hide() end
  close:SetScript("OnClick", onClick or hide)
  x:SetScript("OnClick", onClick or hide)
  onTheme(function(isFlat)
    close:SetShown(not isFlat)
    x:SetShown(isFlat)
  end)
  return close, x
end

-- Scroll bars, flat: a thin grey thumb and no arrow buttons (the mouse wheel
-- and dragging still work). Left alone where the game builds them differently.
local unpackArgs = unpack or table.unpack
local function child(t, key, globalName)
  local v = type(t) == "table" and t[key] or nil
  if type(v) ~= "table" and globalName then v = _G[globalName] end
  return type(v) == "table" and v or nil
end
local function themedScroll(scroll)
  local name = scroll.GetName and scroll:GetName()
  local bar = child(scroll, "ScrollBar", name and (name .. "ScrollBar"))
  if not bar then return end
  local barName = bar.GetName and bar:GetName()
  local up = child(bar, "ScrollUpButton", barName and (barName .. "ScrollUpButton"))
  local down = child(bar, "ScrollDownButton", barName and (barName .. "ScrollDownButton"))
  local thumb = child(bar, "ThumbTexture", barName and (barName .. "ThumbTexture"))
  local orig
  if thumb then
    pcall(function()
      local coords = { thumb:GetTexCoord() }
      orig = { file = thumb:GetTexture(), coords = #coords > 0 and coords or nil, w = thumb:GetWidth() }
    end)
  end
  onTheme(function(isFlat)
    pcall(function()
      if up then up:SetAlpha(isFlat and 0 or 1) end
      if down then down:SetAlpha(isFlat and 0 or 1) end
      if not thumb then return end
      if isFlat then
        thumb:SetColorTexture(FLAT.muted[1], FLAT.muted[2], FLAT.muted[3], 0.5)
        thumb:SetWidth(5)
      elseif orig and orig.file then
        thumb:SetTexture(orig.file)
        if orig.coords then thumb:SetTexCoord(unpackArgs(orig.coords)) end
        if orig.w and orig.w > 0 then thumb:SetWidth(orig.w) end
      end
    end)
  end)
end

-- Resizing from a corner grip. The top-left corner stays where it is and the
-- size follows the mouse from where it was pressed, so a click without moving
-- changes nothing (the game's StartSizing made the window jump to a larger
-- size on the click). bounds = { minW, minH, maxW, maxH }, and never past the
-- right or bottom edge of the screen. onSize(w, h) while dragging;
-- onDone(button, changed) when the button is let go, and after a right-click
-- (which doesn't resize). grip.sizing is true while dragging.
function UI.Resizer(grip, frame, bounds, onSize, onDone)
  local huge = math.huge
  local function cursor()
    local x, y = GetCursorPosition()
    local scale = frame.GetEffectiveScale and frame:GetEffectiveScale()
    if type(scale) ~= "number" or scale <= 0 then scale = 1 end
    return (x or 0) / scale, (y or 0) / scale
  end
  local start -- while dragging: where the mouse and the size started, and the limits
  grip.sizing = false
  local function finish(button)
    grip:SetScript("OnUpdate", nil)
    local was = start
    start, grip.sizing = nil, false
    local changed = was ~= nil and (frame:GetWidth() ~= was.w or frame:GetHeight() ~= was.h)
    if onDone then onDone(button, changed) end
  end
  local function follow()
    -- Let go somewhere the grip didn't hear it (the window was hidden): stop.
    if IsMouseButtonDown and not IsMouseButtonDown(start.button) then return finish(start.button) end
    local x, y = cursor()
    if not start.moved then
      -- Pressed and not moved yet: nothing changes (not even a size outside
      -- the bounds, such as the compact box's automatic size).
      if x == start.x and y == start.y then return end
      start.moved = true
    end
    local w = max(bounds[1], min(start.maxW, start.w + x - start.x))
    local h = max(bounds[2], min(start.maxH, start.h + start.y - y))
    if w ~= frame:GetWidth() or h ~= frame:GetHeight() then
      frame:SetSize(w, h)
      if onSize then onSize(w, h) end
    end
  end
  grip:SetScript("OnMouseDown", function(_, button)
    if button == "RightButton" or start or not GetCursorPosition then return end
    local left, top = frame:GetLeft(), frame:GetTop()
    if not (left and top) then return end
    frame:ClearAllPoints()
    frame:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", left, top)
    local x, y = cursor()
    local w, h = frame:GetWidth(), frame:GetHeight()
    local right = UIParent.GetRight and UIParent:GetRight()
    start = {
      button = button, x = x, y = y, w = w, h = h,
      maxW = max(w, min(bounds[3] or huge, right and (right - left) or huge)),
      maxH = max(h, min(bounds[4] or huge, top)),
    }
    grip.sizing = true
    grip:SetScript("OnUpdate", follow)
  end)
  grip:SetScript("OnMouseUp", function(_, button)
    if start then
      if button == start.button then finish(button) end
    elseif button == "RightButton" and onDone then
      onDone(button, false)
    end
  end)
end

local function tooltip(frame, title, text)
  frame:HookScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
    GameTooltip:AddLine(title)
    if text then GameTooltip:AddLine(text, 1, 1, 1, true) end
    GameTooltip:Show()
  end)
  frame:HookScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
end

local function stamp(t)
  if not t then return "" end
  return date("%H:%M", t)
end

-- Tokens ---------------------------------------------------------------------
-- What each answer cost (sent by the app: i = read, c = of which from the
-- cache, o = written), as Claude Code and Codex show it.

-- 950 -> "950", 18234 -> "18.2k" ("18,2k" in Spanish), 250000 -> "250k".
local function shortNumber(n)
  n = tonumber(n) or 0
  if n < 1000 then return tostring(floor(n)) end
  local s
  if n < 100000 then s = string.format("%.1fk", n / 1000)
  elseif n < 1000000 then s = string.format("%dk", floor(n / 1000 + 0.5))
  else s = string.format("%.1fM", n / 1000000) end
  s = s:gsub("%.0([kM])", "%1")
  return (s:gsub("%.", L.DECIMAL))
end
UI.ShortNumber = shortNumber

-- 18234 -> "18,234" ("18.234" in Spanish).
local function longNumber(n)
  local s = tostring(floor(tonumber(n) or 0))
  local sep = L.DECIMAL == "," and "." or ","
  local k
  repeat s, k = s:gsub("^(%d+)(%d%d%d)", "%1" .. sep .. "%2") until k == 0
  return s
end

local function tokenTotal(t)
  return t and ((t.i or 0) + (t.o or 0)) or 0
end

function UI:ShowTokensTip(owner, t, title)
  if not GameTooltip or not t then return end
  GameTooltip:SetOwner(owner, "ANCHOR_TOP")
  GameTooltip:AddLine(title)
  GameTooltip:AddLine(string.format(L.TOKENS_READ, longNumber(t.i), longNumber(t.c)), 1, 1, 1)
  GameTooltip:AddLine(string.format(L.TOKENS_WRITTEN, longNumber(t.o)), 1, 1, 1)
  GameTooltip:AddLine(L.TOKENS_TIP, 0.8, 0.8, 0.8, true)
  GameTooltip:Show()
end

local function dayGroup(t)
  t = t or 0
  local today = date("%Y-%m-%d")
  if date("%Y-%m-%d", t) == today then return L.TODAY end
  if date("%Y-%m-%d", t + 86400) == today then return L.YESTERDAY end
  if time() - t < 7 * 86400 then return L.THIS_WEEK end
  return L.OLDER
end

-- The player's own face (for their messages).
local function setPlayerPortrait(texture)
  if SetPortraitTexture then
    pcall(SetPortraitTexture, texture, "player")
  else
    texture:SetTexture("Interface\\Icons\\INV_Misc_QuestionMark")
  end
end

-- Fonts that follow the size setting.
local function makeFonts(size)
  UI.fonts = UI.fonts or {}
  local function font(name, base, delta)
    local f = UI.fonts[name] or CreateFont("ForeverAICompanionFont" .. name)
    UI.fonts[name] = f
    if base and base.GetFont then
      local file, _, flags = base:GetFont()
      if file then f:SetFont(file, size + delta, flags or "") end
    end
    return f
  end
  font("Body", GameFontHighlight, 0)
  font("Small", GameFontHighlightSmall, -2)
  font("Title", GameFontNormalLarge, 3)
end

-- Window ------------------------------------------------------------------------

function UI:Build()
  if self.frame then return end
  local s = settings()
  makeFonts(s.fontSize)
  loadPalette(persona())

  local f = newFrame("Frame", "ForeverAICompanionFrame", UIParent)
  f:SetSize(s.width, s.height)
  if s.point then
    f:SetPoint(s.point, UIParent, s.relPoint or s.point, s.x or 0, s.y or 0)
  else
    f:SetPoint("CENTER")
  end
  f:SetFrameStrata("DIALOG")
  f:SetToplevel(true)
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:SetResizable(true)
  if f.SetResizeBounds then f:SetResizeBounds(MIN_W, MIN_H) elseif f.SetMinResize then f:SetMinResize(MIN_W, MIN_H) end
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:Hide()
  dialog(f)
  tinsert(UISpecialFrames, "ForeverAICompanionFrame")

  local function savePosition()
    local point, _, relPoint, x, y = f:GetPoint(1)
    s.point, s.relPoint, s.x, s.y = point, relPoint, x, y
    s.width, s.height = floor(f:GetWidth()), floor(f:GetHeight())
  end
  f:SetScript("OnDragStart", function() f:StartMoving() end)
  f:SetScript("OnDragStop", function() f:StopMovingOrSizing(); savePosition() end)

  -- Title banner on the top edge, like the classic option windows. Flat: just
  -- the name, small and grey, at the top.
  local banner = f:CreateTexture(nil, "ARTWORK")
  banner:SetTexture(ART.banner)
  banner:SetSize(300, 64)
  banner:SetPoint("TOP", 0, 12)
  local bannerTitle = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  bannerTitle:SetText(L.WINDOW_TITLE)
  onTheme(function(isFlat)
    banner:SetShown(not isFlat)
    bannerTitle:ClearAllPoints()
    if isFlat then
      bannerTitle:SetPoint("TOP", 0, -10)
      textColor(bannerTitle, FLAT.muted)
    else
      bannerTitle:SetPoint("TOP", banner, "TOP", 0, -14)
      textColor(bannerTitle, GOLD)
    end
  end)

  local close, flatClose = closeButtons(f, function() f:Hide() end, 19)

  -- The assistant: round portrait with a gold ring over the corner, name and
  -- role beside it. Click either to change assistant.
  local portrait = ringedPortrait(f, 84)
  portrait:SetPoint("TOPLEFT", -22, 20)
  portrait:SetFrameLevel((f:GetFrameLevel() or 1) + 10)
  portrait:SetScript("OnClick", function() UI:ShowChooser() end)
  tooltip(portrait, L.CHANGE_ASSISTANT, L.CHANGE_ASSISTANT_TIP)
  local who = CreateFrame("Button", nil, f)
  who:SetPoint("TOPLEFT", 66, -26)
  who:SetSize(240, 32)
  local appName = who:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  appName:SetPoint("TOPLEFT", 0, 0)
  local tagline = who:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  tagline:SetPoint("TOPLEFT", appName, "BOTTOMLEFT", 0, -2)
  who:SetScript("OnClick", function() UI:ShowChooser() end)
  tooltip(who, L.CHANGE_ASSISTANT, L.CHANGE_ASSISTANT_TIP)
  self.logo, self.appName, self.tagline = portrait.icon, appName, tagline
  -- Flat: a small round portrait inside the top bar, the name beside it.
  onTheme(function(isFlat)
    local size = isFlat and 36 or 84
    local icon = isFlat and 36 or 84 * 0.64
    portrait:SetSize(size, size)
    portrait.icon:SetSize(icon, icon)
    portrait:ClearAllPoints()
    who:ClearAllPoints()
    if isFlat then
      portrait:SetPoint("TOPLEFT", 14, -14)
      who:SetPoint("TOPLEFT", 60, -16)
    else
      portrait:SetPoint("TOPLEFT", -22, 20)
      who:SetPoint("TOPLEFT", 66, -26)
    end
  end)

  -- Tools on the right of the top bar.
  local bigger = panelButton(f, "A+", 34, 22)
  bigger:SetPoint("TOPRIGHT", -36, -32)
  bigger:SetScript("OnClick", function() UI:SetFontSize(s.fontSize + 1) end)
  tooltip(bigger, L.FONT_BIGGER)
  local smaller = panelButton(f, "A-", 34, 22)
  smaller:SetPoint("RIGHT", bigger, "LEFT", -2, 0)
  smaller:SetScript("OnClick", function() UI:SetFontSize(s.fontSize - 1) end)
  tooltip(smaller, L.FONT_SMALLER)
  local toggleSide = panelButton(f, L.CHATS, 70, 22)
  toggleSide:SetPoint("RIGHT", smaller, "LEFT", -8, 0)
  toggleSide:SetScript("OnClick", function() UI:SetSidebar(not s.sidebar) end)
  tooltip(toggleSide, L.CHATS_TIP)
  -- Gear: the addon's page in Options > AddOns (dimming while moving...).
  local gear = CreateFrame("Button", nil, f)
  gear:SetSize(22, 22)
  gear:SetPoint("RIGHT", toggleSide, "LEFT", -6, 0)
  gear:SetNormalTexture("Interface\\Icons\\INV_Misc_Gear_01")
  gear:SetHighlightTexture("Interface\\Buttons\\ButtonHilight-Square", "ADD")
  gear:SetScript("OnClick", function()
    if not (ns.Options and ns.Options:Open()) then UI:SetStatus(L.OPTIONS_UNAVAILABLE) end
  end)
  tooltip(gear, L.OPTIONS_TITLE, L.OPTIONS_TIP)
  -- Flat: the tools line up with the plain close button, the gear in grey.
  onTheme(function(isFlat)
    bigger:ClearAllPoints()
    if isFlat then bigger:SetPoint("TOPRIGHT", -38, -20) else bigger:SetPoint("TOPRIGHT", -36, -32) end
    local t = gear.GetNormalTexture and gear:GetNormalTexture()
    if t then
      if t.SetDesaturated then t:SetDesaturated(isFlat) end
      local v = isFlat and 0.8 or 1
      t:SetVertexColor(v, v, v, 1)
    end
  end)

  -- Sidebar --------------------------------------------------------------------
  local side = newFrame("Frame", nil, f)
  side:SetPoint("TOPLEFT", 12, -TOP_H)
  side:SetPoint("BOTTOMLEFT", 12, 12)
  side:SetWidth(SIDEBAR_W)
  themedPanel(side, "panel")

  local newChat = panelButton(side, L.NEW_CHAT_BUTTON, SIDEBAR_W - 20, 26)
  newChat:SetPoint("TOP", 0, -10)
  newChat:SetScript("OnClick", function()
    ns.Chats:New()
    UI.choosing = false
    UI:Refresh()
    UI.input:SetFocus()
  end)

  local listScroll = CreateFrame("ScrollFrame", "ForeverAICompanionChatList", side, "UIPanelScrollFrameTemplate")
  listScroll:SetPoint("TOPLEFT", 6, -44)
  listScroll:SetPoint("BOTTOMRIGHT", -26, 34)
  local list = CreateFrame("Frame", nil, listScroll)
  list:SetSize(SIDEBAR_W - 34, 10)
  listScroll:SetScrollChild(list)
  themedScroll(listScroll)

  local myData = linkButton(side, L.MY_DATA, SIDEBAR_W - 20, 22)
  myData:SetPoint("BOTTOM", 0, 8)
  myData:SetScript("OnClick", function() UI:ShowContext() end)
  tooltip(myData, L.MY_DATA_TIP_TITLE, L.MY_DATA_TIP)

  -- Main area ------------------------------------------------------------------
  local main = newFrame("Frame", nil, f)
  main:SetPoint("TOPRIGHT", -12, -TOP_H)
  main:SetPoint("BOTTOMRIGHT", -12, 12)
  themedPanel(main, "panel")

  -- Chat header: title (click to rename), connection line, delete.
  local titleBtn = CreateFrame("Button", nil, main)
  titleBtn:SetPoint("TOPLEFT", 14, -8)
  titleBtn:SetPoint("TOPRIGHT", -112, -8)
  titleBtn:SetHeight(24)
  local title = titleBtn:CreateFontString(nil, "OVERLAY")
  title:SetFontObject(UI.fonts.Title)
  title:SetPoint("LEFT")
  title:SetPoint("RIGHT")
  title:SetJustifyH("LEFT")
  if title.SetWordWrap then title:SetWordWrap(false) end
  local titleHl = titleBtn:CreateTexture(nil, "HIGHLIGHT")
  titleHl:SetAllPoints()
  onTheme(function(isFlat)
    if isFlat then titleHl:SetColorTexture(FLAT.accent[1], FLAT.accent[2], FLAT.accent[3], 0.08)
    else titleHl:SetColorTexture(1, 0.82, 0, 0.06) end
  end)
  tooltip(titleBtn, L.RENAME_CHAT, L.RENAME_CHAT_TIP)

  local renameBox = newFrame("EditBox", nil, main)
  renameBox:SetAllPoints(titleBtn)
  renameBox:SetFontObject(UI.fonts.Title)
  renameBox:SetAutoFocus(false)
  renameBox:SetMaxLetters(60)
  renameBox:SetTextInsets(6, 6, 0, 0)
  themedPanel(renameBox, "input", EDGE_GOLD, { 0, 0, 0, 0.8 }, 12)
  renameBox:Hide()
  local function finishRename(save)
    if save then ns.Chats:Rename(ns.db.currentChat, renameBox:GetText()) end
    renameBox:Hide()
    titleBtn:Show()
    UI:Refresh()
  end
  renameBox:SetScript("OnEnterPressed", function() finishRename(true) end)
  renameBox:SetScript("OnEscapePressed", function() finishRename(false) end)
  renameBox:SetScript("OnEditFocusLost", function() if renameBox:IsShown() then finishRename(true) end end)
  titleBtn:SetScript("OnClick", function()
    local current = ns.Chats:Get(ns.db.currentChat)
    if not current then return end
    titleBtn:Hide()
    renameBox:SetText(current.title or "")
    renameBox:Show()
    renameBox:SetFocus()
    renameBox:HighlightText()
  end)

  local dot = main:CreateTexture(nil, "OVERLAY")
  dot:SetSize(8, 8)
  dot:SetPoint("TOPLEFT", 16, -38)
  round(main, dot)
  local channel = main:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  channel:SetPoint("LEFT", dot, "RIGHT", 6, 0)
  channel:SetPoint("RIGHT", main, "TOPRIGHT", -14, -38)
  channel:SetJustifyH("LEFT")
  if channel.SetWordWrap then channel:SetWordWrap(false) end
  -- Hovering the line explains the app's status (and what to do about it).
  local channelHover = CreateFrame("Frame", nil, main)
  channelHover:SetPoint("TOPLEFT", dot, "TOPLEFT", -4, 1) -- below the title and Delete
  channelHover:SetPoint("BOTTOMRIGHT", main, "TOPRIGHT", -14, -48)
  channelHover:EnableMouse(true)
  channelHover:SetScript("OnEnter", function(self)
    local title, text = UI:AppStatusHelp()
    if not GameTooltip or not title then return end
    GameTooltip:SetOwner(self, "ANCHOR_BOTTOM")
    GameTooltip:AddLine(title)
    if text then GameTooltip:AddLine(text, 1, 1, 1, true) end
    GameTooltip:Show()
  end)
  channelHover:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)

  local deleteChat = panelButton(main, L.DELETE_CHAT, 96, 22)
  deleteChat:SetPoint("TOPRIGHT", -10, -10)
  deleteChat:SetScript("OnClick", function(self) UI:ConfirmDelete(self, ns.db.currentChat) end)

  local headerLine = main:CreateTexture(nil, "BORDER")
  headerLine:SetPoint("TOPLEFT", 8, -54)
  headerLine:SetPoint("TOPRIGHT", -8, -54)
  headerLine:SetHeight(1)
  onTheme(function(isFlat)
    if isFlat then headerLine:SetColorTexture(FLAT.line[1], FLAT.line[2], FLAT.line[3], 1)
    else headerLine:SetColorTexture(EDGE_GOLD[1], EDGE_GOLD[2], EDGE_GOLD[3], 0.35) end
  end)

  -- Messages.
  local scroll = CreateFrame("ScrollFrame", "ForeverAICompanionScroll", main, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 8, -60)
  scroll:SetPoint("BOTTOMRIGHT", -28, 66)
  local content = CreateFrame("Frame", nil, scroll)
  content:SetSize(400, 10)
  scroll:SetScrollChild(content)
  themedScroll(scroll)
  scroll:SetScript("OnSizeChanged", function() UI:RefreshConversation() end)

  -- Composer: gold-edged text box and the red "Send" button (flat: a dark box
  -- edged in blue while typing, and a blue Send).
  local composer = newFrame("Frame", nil, main)
  composer:SetPoint("BOTTOMLEFT", 10, 28)
  composer:SetPoint("BOTTOMRIGHT", -100, 28)
  composer:SetHeight(32)
  themedPanel(composer, "input", EDGE_GOLD, { 0, 0, 0, 0.65 }, 12)

  local send = panelButton(main, L.SEND, 84, 28, true)
  send:SetPoint("LEFT", composer, "RIGHT", 6, 0)
  send:SetScript("OnClick", function() UI:Submit() end)

  -- "Talk": ask with your voice (click, speak, click again or just stop).
  local talk = linkButton(composer, L.TALK, 58, 26)
  talk:SetPoint("RIGHT", -4, 0)
  talk:SetScript("OnClick", function() ns.Core:ToggleListen() end)
  tooltip(talk, L.TALK_TIP_TITLE, L.TALK_TIP)
  self.talk = talk

  local input = CreateFrame("EditBox", "ForeverAICompanionInput", composer)
  input:SetPoint("LEFT", 10, 0)
  input:SetPoint("RIGHT", talk, "LEFT", -4, 0)
  input:SetHeight(28)
  input:SetFontObject(UI.fonts.Body)
  input:SetAutoFocus(false)
  input:SetMaxLetters(1000) -- room for a few item links (each is ~100 characters)
  -- Shift-click on an item (bags, gear, a vendor, a quest reward...) while
  -- typing puts its link in the question, as in the chat box.
  local function insertLink(link)
    if type(link) == "string" and input:HasFocus() then input:Insert(link) end
  end
  if hooksecurefunc then
    if ChatEdit_InsertLink then pcall(hooksecurefunc, "ChatEdit_InsertLink", insertLink) end
    if ChatFrameUtil and ChatFrameUtil.InsertLink then pcall(hooksecurefunc, ChatFrameUtil, "InsertLink", insertLink) end
  end
  local placeholder = input:CreateFontString(nil, "OVERLAY", "GameFontDisable")
  placeholder:SetPoint("LEFT", 2, 0)
  self.placeholder = placeholder
  input:SetScript("OnTextChanged", function(self)
    placeholder:SetShown(self:GetText() == "")
  end)
  input:SetScript("OnEnterPressed", function() UI:Submit() end)
  input:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  input:HookScript("OnEditFocusGained", function()
    if flat() and composer.SetBackdropBorderColor then composer:SetBackdropBorderColor(FLAT.accent[1], FLAT.accent[2], FLAT.accent[3], 1) end
  end)
  input:HookScript("OnEditFocusLost", function()
    if flat() and composer.SetBackdropBorderColor then composer:SetBackdropBorderColor(FLAT.border[1], FLAT.border[2], FLAT.border[3], 1) end
  end)
  composer:EnableMouse(true)
  composer:SetScript("OnMouseDown", function() input:SetFocus() end)

  -- Under the text box and Send, on the right: the tokens this chat has used
  -- (as Claude shows it). Hover for what was read, cached and written.
  local usage = main:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  usage:SetPoint("BOTTOMRIGHT", -26, 10)
  usage:SetJustifyH("RIGHT")
  if usage.SetWordWrap then usage:SetWordWrap(false) end
  local usageHover = CreateFrame("Frame", nil, main)
  usageHover:SetAllPoints(usage)
  usageHover:EnableMouse(false)
  usageHover:SetScript("OnEnter", function(self) UI:ShowTokensTip(self, self.tokens, L.TOKENS_CHAT_TIP_TITLE) end)
  usageHover:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  self.usage, self.usageHover = usage, usageHover

  local status = main:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  status:SetPoint("BOTTOMLEFT", 14, 10)
  status:SetPoint("RIGHT", usage, "LEFT", -12, 0)
  status:SetJustifyH("LEFT")
  onTheme(function(isFlat) textColor(status, isFlat and FLAT.text or GOLD) end)

  -- Resize grip.
  local grip = CreateFrame("Button", nil, f)
  grip:SetSize(16, 16)
  grip:SetPoint("BOTTOMRIGHT", -6, 6)
  grip:SetFrameLevel((f:GetFrameLevel() or 1) + 12)
  grip:SetNormalTexture(ART.grip .. "-Up")
  grip:SetHighlightTexture(ART.grip .. "-Highlight")
  grip:SetPushedTexture(ART.grip .. "-Down")
  UI.Resizer(grip, f, { MIN_W, MIN_H }, nil, function() savePosition(); UI:Refresh() end)
  self.grip = grip

  f:SetScript("OnShow", function()
    local current = ns.Chats:Get(ns.db.currentChat)
    if current then current.unread = nil end
    if PlaySound and SOUNDKIT then PlaySound(SOUNDKIT.IG_CHARACTER_INFO_OPEN or 839) end
    if ns.Live.CheckApp then pcall(ns.Live.CheckApp, ns.Live) end
    if ns.Combat then pcall(ns.Combat.Update, ns.Combat) end -- the "in combat" bar
    UI:Refresh()
    if ns.Button then ns.Button:Update() end
  end)
  f:SetScript("OnHide", function()
    if PlaySound and SOUNDKIT then PlaySound(SOUNDKIT.IG_CHARACTER_INFO_CLOSE or 840) end
  end)

  -- "Thinking" animation: animated dots and what the assistant "is doing".
  local elapsedTotal, ticks = 0, 0
  f:SetScript("OnUpdate", function(_, elapsed)
    elapsedTotal = elapsedTotal + (elapsed or 0)
    if elapsedTotal < 0.45 then return end
    elapsedTotal = 0
    ticks = ticks + 1
    local phrase = ns.Personas:ThinkingText(ticks)
    for _, b in ipairs(UI.bubbles or {}) do
      if b:IsShown() and b.pending then b.text:SetText(phrase) end
    end
    UI:RefreshStatusBar()
  end)

  self.frame, self.side, self.main = f, side, main
  self.banner, self.closeButton, self.flatClose, self.portrait = banner, close, flatClose, portrait
  self.headerLine, self.composer, self.sendButton = headerLine, composer, send
  self.scroll, self.content, self.input = scroll, content, input
  self.list, self.listScroll = list, listScroll
  self.title, self.titleBtn, self.renameBox, self.deleteButton = title, titleBtn, renameBox, deleteChat
  self.dot, self.channel, self.status = dot, channel, status
  self.rows, self.headings, self.bubbles = {}, {}, {}
  -- Dimmed while the character moves (Fade.lua).
  if ns.Fade then ns.Fade:Attach(f) end
  -- The window shows everything the compact box would: it goes away.
  if ns.Compact then f:HookScript("OnShow", function() ns.Compact:Hide() end) end
  self:SetSidebar(s.sidebar, true)
  self:ApplyPersona(true)
end

-- Portrait, name and colors of the current assistant.
function UI:ApplyPersona(silent)
  if not self.frame then return end
  local p = persona()
  loadPalette(p)
  for region, color in pairs(painted) do
    region:SetColorTexture(color[1], color[2], color[3], color[4] or 1)
  end
  ns.Personas.SetPortrait(self.logo, p)
  self.appName:SetText(p.nameColor .. p.name .. "|r")
  self.tagline:SetText(p.role)
  self.placeholder:SetText(p.placeholder)
  if self.welcome then
    ns.Personas.SetPortrait(self.welcome.portrait.icon, p)
    self.welcome.online:SetText(p.nameColor .. p.online .. "|r")
    self.welcome.sub:SetText(p.sub)
  end
  if not silent then self:Refresh() end
end

-- The window's look: "wow" (the default) or "flat". Switching repaints at once.
function UI:Theme()
  return flat() and "flat" or "wow"
end

function UI:SetTheme(name)
  settings().theme = name == "flat" and "flat" or "wow"
  local isFlat = flat()
  for _, fn in ipairs(themers) do fn(isFlat) end
  self:Refresh()
end

function UI:SetSidebar(shown, silent)
  local s = settings()
  s.sidebar = shown and true or false
  self.side:SetShown(s.sidebar)
  self.main:ClearAllPoints()
  self.main:SetPoint("TOPRIGHT", self.frame, "TOPRIGHT", -12, -TOP_H)
  self.main:SetPoint("BOTTOMRIGHT", self.frame, "BOTTOMRIGHT", -12, 12)
  if s.sidebar then
    self.main:SetPoint("TOPLEFT", self.side, "TOPRIGHT", 6, 0)
  else
    self.main:SetPoint("TOPLEFT", self.frame, "TOPLEFT", 12, -TOP_H)
  end
  if not silent then self:Refresh() end
end

function UI:SetFontSize(size)
  local s = settings()
  s.fontSize = max(10, min(20, size))
  makeFonts(s.fontSize)
  self:Refresh()
end

-- Two clicks to delete: the first one asks.
function UI:ConfirmDelete(btn, chatId)
  if btn.confirmFor == chatId then
    btn.confirmFor = nil
    btn:SetText(L.DELETE_CHAT)
    ns.Chats:Delete(chatId)
    self:Refresh()
    return
  end
  btn.confirmFor = chatId
  btn:SetText(L.CONFIRM_DELETE)
  C_Timer.After(3, function()
    if btn.confirmFor == chatId then
      btn.confirmFor = nil
      btn:SetText(L.DELETE_CHAT)
    end
  end)
end

-- Sidebar list ---------------------------------------------------------------

function UI:Heading(i)
  local h = self.headings[i]
  if h then return h end
  h = self.list:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  h:SetJustifyH("LEFT")
  self.headings[i] = h
  return h
end

function UI:Row(i)
  local row = self.rows[i]
  if row then return row end
  row = CreateFrame("Button", nil, self.list)
  row:SetHeight(ROW_H - 4)
  -- Selected: the gold quest-log highlight.
  local selected = row:CreateTexture(nil, "BACKGROUND")
  selected:SetAllPoints()
  selected:SetTexture(ART.rowLight)
  if selected.SetBlendMode then selected:SetBlendMode("ADD") end
  selected:SetVertexColor(1, 0.82, 0.3, 0.75)
  row.selected = selected
  local hl = row:CreateTexture(nil, "HIGHLIGHT")
  hl:SetAllPoints()
  hl:SetTexture(ART.rowLight)
  if hl.SetBlendMode then hl:SetBlendMode("ADD") end
  hl:SetVertexColor(1, 0.82, 0.3, 0.35)
  row.hl = hl
  -- Flat: selected is a light blue fill with a blue bar on the left; the
  -- mouse brings a faint highlight (shown by RefreshList for the look in use).
  local flatSel = row:CreateTexture(nil, "BACKGROUND")
  flatSel:SetAllPoints()
  flatSel:SetColorTexture(FLAT.select[1], FLAT.select[2], FLAT.select[3], FLAT.select[4])
  row.flatSel = flatSel
  local flatBar = row:CreateTexture(nil, "ARTWORK")
  flatBar:SetPoint("TOPLEFT")
  flatBar:SetPoint("BOTTOMLEFT")
  flatBar:SetWidth(2)
  flatBar:SetColorTexture(FLAT.accent[1], FLAT.accent[2], FLAT.accent[3], 1)
  row.flatBar = flatBar
  local flatHl = row:CreateTexture(nil, "HIGHLIGHT")
  flatHl:SetAllPoints()
  flatHl:SetColorTexture(FLAT.hover[1], FLAT.hover[2], FLAT.hover[3], FLAT.hover[4])
  row.flatHl = flatHl

  local face = avatar(row, AVATAR)
  face:SetPoint("LEFT", 4, 0)
  row.face = face
  local name = row:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  name:SetPoint("TOPLEFT", face, "TOPRIGHT", 8, 0)
  name:SetPoint("RIGHT", -22, 0)
  name:SetJustifyH("LEFT")
  if name.SetWordWrap then name:SetWordWrap(false) end
  row.name = name
  -- One line under the title: a long status ("Fizzi is typing...") is cut
  -- with "..." instead of wrapping up over the title.
  local info = row:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  info:SetPoint("TOPLEFT", name, "BOTTOMLEFT", 0, -3)
  info:SetPoint("RIGHT", -22, 0)
  info:SetJustifyH("LEFT")
  if info.SetWordWrap then info:SetWordWrap(false) end
  if info.SetMaxLines then info:SetMaxLines(1) end
  row.info = info
  -- Unread: a green light on the avatar, like an online friend.
  local dot = row:CreateTexture(nil, "OVERLAY")
  dot:SetSize(9, 9)
  dot:SetPoint("BOTTOMRIGHT", face, "BOTTOMRIGHT", 2, -1)
  dot:SetColorTexture(C.ok[1], C.ok[2], C.ok[3], 1)
  round(row, dot)
  row.dot = dot

  -- Delete (x) shown on hover; a second click confirms.
  local x = CreateFrame("Button", nil, row)
  x:SetSize(16, 16)
  x:SetPoint("RIGHT", -2, 0)
  x:SetNormalTexture(ART.delete)
  x:SetHighlightTexture(ART.delete)
  x:Hide()
  x:SetScript("OnClick", function(self)
    if self.confirm then
      ns.Chats:Delete(row.chatId)
      UI:Refresh()
      return
    end
    self.confirm = true
    row.info:SetText("|cffff6060" .. L.CLICK_AGAIN_DELETE .. "|r")
    C_Timer.After(3, function() self.confirm = nil; UI:RefreshList() end)
  end)
  tooltip(x, L.DELETE_CHAT)
  row.deleteBtn = x
  local function hover(on)
    x:SetShown(on or x.confirm)
  end
  row:SetScript("OnEnter", function() hover(true) end)
  row:SetScript("OnLeave", function() if not x:IsMouseOver() then hover(false) end end)
  x:HookScript("OnLeave", function() if not row:IsMouseOver() then hover(false) end end)

  row:SetScript("OnClick", function(self)
    ns.Chats:Select(self.chatId)
    UI.choosing = false
    UI.renameBox:Hide()
    UI.titleBtn:Show()
    if PlaySound and SOUNDKIT then PlaySound(SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON or 856) end
    UI:Refresh()
  end)
  self.rows[i] = row
  return row
end

function UI:RefreshList()
  local width = self.list:GetWidth()
  local p = persona()
  local isFlat = flat()
  local y, rowIndex, headIndex, lastGroup = 0, 0, 0, nil
  for _, c in ipairs(ns.Chats:All()) do
    local group = dayGroup(c.updated)
    if group ~= lastGroup then
      lastGroup = group
      headIndex = headIndex + 1
      local h = self:Heading(headIndex)
      h:ClearAllPoints()
      h:SetPoint("TOPLEFT", 6, -(y + 8))
      h:SetText(group)
      h:Show()
      y = y + 26
    end
    rowIndex = rowIndex + 1
    local row = self:Row(rowIndex)
    row:ClearAllPoints()
    row:SetPoint("TOPLEFT", 0, -y)
    row:SetWidth(width)
    row.chatId = c.id
    row.unread = c.unread
    ns.Personas.SetPortrait(row.face, p)
    row.name:SetText(escape(c.title))
    local pending = false
    for _, m in ipairs(c.messages) do if m.status == "pending" then pending = true break end end
    if not row.deleteBtn.confirm then
      row.info:SetText(pending and ((isFlat and ACCENT_TEXT or "|cffffd100") .. string.format(L.IS_TYPING, p.name) .. "|r")
        or string.format("%s · %d %s", stamp(c.updated), #c.messages, #c.messages == 1 and L.MESSAGE_ONE or L.MESSAGE_MANY))
    end
    local isCurrent = c.id == ns.db.currentChat
    row.selected:SetShown(isCurrent and not isFlat)
    row.flatSel:SetShown(isCurrent and isFlat)
    row.flatBar:SetShown(isCurrent and isFlat)
    row.hl:SetAlpha(isFlat and 0 or 1)
    row.flatHl:SetAlpha(isFlat and 1 or 0)
    textColor(row.name, isCurrent and { 1, 1, 1 } or isFlat and FLAT.text or GOLD)
    row.dot:SetShown(c.unread and true or false)
    row:Show()
    y = y + ROW_H
  end
  for i = rowIndex + 1, #self.rows do self.rows[i]:Hide() end
  for i = headIndex + 1, #self.headings do self.headings[i]:Hide() end
  self.list:SetHeight(max(10, y))
end

-- Conversation ---------------------------------------------------------------
-- A message: avatar, a "name · time" line (with Copy / Retry) and the
-- text in a tooltip-style box. The player's messages go on the right.

function UI:Bubble(i)
  local b = self.bubbles[i]
  if b then return b end
  b = CreateFrame("Frame", nil, self.content)
  local face = avatar(b, AVATAR)
  b.face = face
  local who = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  b.who = who
  local meta = b:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  b.meta = meta
  -- Hovering "time · N tokens" of an answer shows what it read and wrote.
  local metaHover = CreateFrame("Frame", nil, b)
  metaHover:SetAllPoints(meta)
  metaHover:EnableMouse(false)
  metaHover:SetScript("OnEnter", function(self) UI:ShowTokensTip(self, self.tokens, L.TOKENS_TIP_TITLE) end)
  metaHover:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  b.metaHover = metaHover
  local box = newFrame("Frame", nil, b)
  b.box = box
  -- Links in the player's questions work as in the chat: hover shows the
  -- item's tooltip, click opens it (shift-click pastes it, ctrl-click previews).
  if box.SetHyperlinksEnabled then
    pcall(box.SetHyperlinksEnabled, box, true)
    box:SetScript("OnHyperlinkClick", function(self, link, linkText, button)
      if SetItemRef then pcall(SetItemRef, link, linkText, button, self) end
    end)
    box:SetScript("OnHyperlinkEnter", function(self, link)
      if not GameTooltip then return end
      GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
      if pcall(GameTooltip.SetHyperlink, GameTooltip, link) then GameTooltip:Show() else GameTooltip:Hide() end
    end)
    box:SetScript("OnHyperlinkLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  end
  local text = box:CreateFontString(nil, "OVERLAY")
  text:SetJustifyH("LEFT")
  text:SetJustifyV("TOP")
  text:SetSpacing(3)
  if text.SetWordWrap then text:SetWordWrap(true) end
  b.text = text
  local action = linkButton(b, L.COPY, 70, 16)
  b.action = action
  self.bubbles[i] = b
  return b
end

-- Lays out one message at height y. kind: "user", "ai", "pending", "error".
function UI:PlaceBubble(i, y, kind, textValue, metaValue, onAction, actionLabel, tokens)
  local b = self:Bubble(i)
  local p = persona()
  local width = self.content:GetWidth()
  local mine = kind == "user"
  local maxText = floor(width * (mine and 0.66 or 0.78)) - 20
  b.text:SetFontObject(self.fonts.Body)
  b.text:ClearAllPoints()
  b.text:SetPoint("TOPLEFT", 10, -8)
  b.text:SetWidth(maxText)
  -- The "thinking" bubble cycles through phrases of different lengths (see the
  -- OnUpdate animation): size it for the longest one, with all three dots, so
  -- none of them spills out of the box.
  local texts = { textValue }
  if kind == "pending" then
    texts = {}
    for _, phrase in ipairs(p.thinking or {}) do texts[#texts + 1] = phrase .. "..." end
    if #texts == 0 then texts[1] = textValue end
  end
  local function naturalWidth()
    return (b.text.GetUnboundedStringWidth and b.text:GetUnboundedStringWidth()) or b.text:GetStringWidth() or maxText
  end
  -- Short messages get a snug box.
  local natural = 0
  for _, s in ipairs(texts) do
    b.text:SetText(s)
    natural = max(natural, naturalWidth())
  end
  local textW = min(maxText, max(30, floor(natural + 2)))
  b.text:SetWidth(textW)
  local textH = 0
  for _, s in ipairs(texts) do
    b.text:SetText(s)
    textH = max(textH, b.text:GetStringHeight() or 14)
  end
  b.text:SetText(textValue)
  local boxH = textH + 16
  local boxW = textW + 20

  -- Avatar and name line.
  b.face:ClearAllPoints()
  b.who:ClearAllPoints()
  b.meta:ClearAllPoints()
  b.box:ClearAllPoints()
  b.action:ClearAllPoints()
  if mine then
    setPlayerPortrait(b.face)
    b.face:SetPoint("TOPRIGHT", b, "TOPRIGHT", -2, -2)
    b.who:SetPoint("TOPRIGHT", b.face, "TOPLEFT", -8, 0)
    b.who:SetText(L.YOU)
    b.meta:SetPoint("RIGHT", b.who, "LEFT", -6, 0)
    b.box:SetPoint("TOPRIGHT", b.face, "TOPLEFT", -6, -16)
    b.action:SetPoint("RIGHT", b.meta, "LEFT", -6, 0)
  else
    ns.Personas.SetPortrait(b.face, p)
    b.face:SetPoint("TOPLEFT", b, "TOPLEFT", 2, -2)
    b.who:SetPoint("TOPLEFT", b.face, "TOPRIGHT", 8, 0)
    b.who:SetText(p.nameColor .. p.name .. "|r")
    b.meta:SetPoint("LEFT", b.who, "RIGHT", 6, 0)
    b.box:SetPoint("TOPLEFT", b.face, "TOPRIGHT", 6, -16)
    b.action:SetPoint("LEFT", b.meta, "RIGHT", 6, 0)
  end
  b.box:SetSize(boxW, boxH)
  if flat() then
    -- Flat: borderless boxes, blue for the player, grey for the assistant.
    flatPanel(b.box, mine and FLAT.user or kind == "error" and FLAT.error or FLAT.ai, kind == "error" and FLAT.errorEdge or nil)
    textColor(b.who, FLAT.text)
  else
    local bg = mine and C.user or kind == "error" and C.error or { 0.02, 0.02, 0.02, 0.75 }
    panel(b.box, kind == "error" and { 0.8, 0.3, 0.25, 0.9 } or EDGE_GOLD, bg, 12)
    textColor(b.who, GOLD)
  end
  b.text:SetTextColor(1, 1, 1)
  if kind == "pending" then b.text:SetTextColor(0.75, 0.75, 0.75) end
  b.pending = kind == "pending"
  b.meta:SetText(metaValue or "")
  b.metaHover.tokens = tokens
  b.metaHover:EnableMouse(tokens ~= nil)
  b.action:SetShown(onAction ~= nil)
  if onAction then
    b.action.label:SetText(actionLabel)
    b.action:SetScript("OnClick", onAction)
  end

  local h = 16 + boxH + 6
  b:SetSize(width - 4, h)
  b:ClearAllPoints()
  b:SetPoint("TOPLEFT", self.content, "TOPLEFT", 2, -y)
  b:Show()
  return h
end

-- A suggested question, like a quest dialog option.
local function makeChip(w)
  local chip = newFrame("Button", nil, w)
  themedPanel(chip, "chip", EDGE_DIM, { 0, 0, 0, 0.55 }, 12)
  local icon = chip:CreateTexture(nil, "ARTWORK")
  icon:SetSize(14, 14)
  icon:SetPoint("LEFT", 10, 0)
  icon:SetTexture("Interface\\GossipFrame\\GossipGossipIcon")
  local fs = chip:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  fs:SetPoint("LEFT", icon, "RIGHT", 8, 0)
  fs:SetPoint("RIGHT", -10, 0)
  fs:SetJustifyH("LEFT")
  if fs.SetWordWrap then fs:SetWordWrap(true) end
  chip.label = fs
  local hl = chip:CreateTexture(nil, "HIGHLIGHT")
  hl:SetPoint("TOPLEFT", 3, -3)
  hl:SetPoint("BOTTOMRIGHT", -3, 3)
  hl:SetTexture(ART.rowLight)
  if hl.SetBlendMode then hl:SetBlendMode("ADD") end
  hl:SetVertexColor(1, 0.82, 0.3, 0.4)
  -- Flat: a blue tint under the mouse, a blue icon and light text.
  local flatHl = chip:CreateTexture(nil, "HIGHLIGHT")
  flatHl:SetAllPoints()
  onTheme(function(isFlat)
    hl:SetAlpha(isFlat and 0 or 1)
    flatHl:SetColorTexture(FLAT.accent[1], FLAT.accent[2], FLAT.accent[3], isFlat and 0.12 or 0)
    if icon.SetDesaturated then icon:SetDesaturated(isFlat) end
    local ic = isFlat and FLAT.accent or { 1, 1, 1 }
    icon:SetVertexColor(ic[1], ic[2], ic[3], 1)
    textColor(fs, isFlat and FLAT.text or GOLD)
  end)
  chip:SetScript("OnClick", function(self) if self.question then ns.Core:Ask(self.question) end end)
  return chip
end

-- The suggested questions for a new chat, and a title when they are about a
-- game window the player has open (vendor, auction house, trainer...): those
-- go first, then a couple of the usual ones.
local GENERAL_AFTER_CONTEXT = 2
function UI.Suggestions()
  local ok, window = pcall(function() return ns.Collect and ns.Collect:OpenWindow() end)
  local list = ok and window and L.CONTEXT_SUGGESTIONS and L.CONTEXT_SUGGESTIONS[window]
  if not list then return SUGGESTIONS, nil end
  local out = {}
  for _, q in ipairs(list) do out[#out + 1] = q end
  for i = 1, min(GENERAL_AFTER_CONTEXT, #SUGGESTIONS) do out[#out + 1] = SUGGESTIONS[i] end
  return out, list.title
end

function UI:ShowWelcome()
  if not self.welcome then
    local w = CreateFrame("Frame", nil, self.content)
    local portrait = ringedPortrait(w, 70)
    portrait:SetPoint("TOP", 0, -10)
    portrait:SetScript("OnClick", function() UI:ShowChooser() end)
    w.portrait = portrait
    local online = w:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    online:SetPoint("TOP", 0, -88)
    w.online = online
    local hello = w:CreateFontString(nil, "OVERLAY", "GameFontNormalHuge")
    hello:SetPoint("TOP", online, "BOTTOM", 0, -8)
    w.hello = hello
    local sub = w:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    sub:SetPoint("TOP", hello, "BOTTOM", 0, -10)
    sub:SetJustifyH("CENTER")
    w.sub = sub
    -- Suggestions look like quest dialog options. Chips are made as needed
    -- (the list changes with the window the player has open).
    w.chips = {}
    -- "You have a vendor open...": shown above the suggestions about it.
    local context = w:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    context:SetJustifyH("CENTER")
    if context.SetWordWrap then context:SetWordWrap(true) end
    w.context = context
    local hint = w:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
    hint:SetText(L.WELCOME_HINT)
    w.hint = hint
    onTheme(function(isFlat)
      textColor(hello, isFlat and FLAT.text or GOLD)
      textColor(context, isFlat and FLAT.accent or { 1, 0.82, 0.3 })
    end)
    self.welcome = w
    self:ApplyPersona(true)
  end
  local w = self.welcome
  local p = persona()
  local width = self.content:GetWidth()
  local name = UnitName and UnitName("player") or nil
  w.hello:SetText(name and string.format(p.hello, name) or p.helloNoName)
  local cols = width > 520 and 2 or 1
  local chipW = floor((min(width, 640) - (cols - 1) * 10) / cols)
  local left = floor((width - (chipW * cols + (cols - 1) * 10)) / 2)
  local top = 186
  local questions, title = UI.Suggestions()
  w.context:SetShown(title ~= nil)
  if title then
    w.context:SetText(title)
    w.context:SetWidth(min(width, 640) - 20)
    w.context:ClearAllPoints()
    w.context:SetPoint("TOP", w, "TOP", 0, -top)
    top = top + max(18, floor(w.context:GetStringHeight() or 18)) + 10
  end
  for i, text in ipairs(questions) do
    local chip = w.chips[i] or makeChip(w)
    w.chips[i] = chip
    chip.label:SetText(text)
    chip.question = text
    local col, rowN = (i - 1) % cols, floor((i - 1) / cols)
    chip:SetSize(chipW, 40)
    chip:ClearAllPoints()
    chip:SetPoint("TOPLEFT", w, "TOPLEFT", left + col * (chipW + 10), -(top + rowN * 46))
    chip:Show()
  end
  for i = #questions + 1, #w.chips do w.chips[i]:Hide() end
  local rows = math.ceil(#questions / cols)
  w.hint:ClearAllPoints()
  w.hint:SetPoint("TOP", w, "TOP", 0, -(top + 8 + rows * 46))
  w:ClearAllPoints()
  w:SetPoint("TOPLEFT")
  w:SetSize(width, top + 36 + rows * 46)
  w:Show()
  return top + 36 + rows * 46
end

-- Assistant chooser ------------------------------------------------------------
-- Shown the first time a character opens the window, and when clicking the
-- assistant's portrait or name.

function UI:ShowChooser()
  self.choosing = true
  self:Show()
  self:Refresh()
end

local CARD_H = 262

local function chooserCard(parent, p)
  local card = newFrame("Frame", nil, parent)
  themedPanel(card, "card", EDGE_GOLD, { 0, 0, 0, 0.55 }, 14)
  local top = card:CreateTexture(nil, "BORDER")
  top:SetPoint("TOPLEFT", 4, -4)
  top:SetPoint("TOPRIGHT", -4, -4)
  top:SetHeight(3)
  top:SetColorTexture(p.colors.accent[1], p.colors.accent[2], p.colors.accent[3], 0.9)

  local portrait = ringedPortrait(card, 76)
  portrait:SetPoint("TOP", 0, -12)
  ns.Personas.SetPortrait(portrait.icon, p)
  portrait:SetScript("OnClick", function() UI:PickPersona(p.id) end)

  local name = card:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  name:SetPoint("TOP", 0, -96)
  name:SetText(p.nameColor .. p.fullName .. "|r")
  local role = card:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  role:SetPoint("TOP", name, "BOTTOM", 0, -3)
  card.role = role
  local pitch = card:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  pitch:SetPoint("TOP", role, "BOTTOM", 0, -10)
  pitch:SetJustifyH("CENTER")
  if pitch.SetWordWrap then pitch:SetWordWrap(true) end
  pitch:SetText(p.pitch)
  card.pitch = pitch
  local sample = card:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  sample:SetPoint("TOP", pitch, "BOTTOM", 0, -8)
  sample:SetJustifyH("CENTER")
  if sample.SetWordWrap then sample:SetWordWrap(true) end
  sample:SetText(p.sample)
  card.sample = sample

  local pick = panelButton(card, string.format(L.PICK_PERSONA, p.name), 150, 26, true)
  pick:SetPoint("BOTTOM", 0, 14)
  pick:SetScript("OnClick", function() UI:PickPersona(p.id) end)
  card.pick = pick
  return card
end

function UI:PickPersona(id)
  self.choosing = false
  ns.Personas:Set(id)
  local p = persona()
  if PlaySound and SOUNDKIT then PlaySound(SOUNDKIT.IG_QUEST_LIST_SELECT or 875) end
  self:SetStatus(string.format(L.NOW_YOUR_ASSISTANT, p.nameColor .. p.name .. "|r"))
  self:Refresh()
  if self.input then self.input:SetFocus() end
end

function UI:LayoutChooser()
  if not self.chooser then
    local ch = CreateFrame("Frame", nil, self.content)
    local title = ch:CreateFontString(nil, "OVERLAY", "GameFontNormalHuge")
    title:SetPoint("TOP", 0, -14)
    title:SetText(L.CHOOSER_TITLE)
    onTheme(function(isFlat) textColor(title, isFlat and FLAT.text or GOLD) end)
    local sub = ch:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    sub:SetPoint("TOP", title, "BOTTOM", 0, -8)
    sub:SetJustifyH("CENTER")
    sub:SetText(L.CHOOSER_SUB)
    ch.cards = {}
    for i, id in ipairs(ns.Personas.ORDER) do
      ch.cards[i] = chooserCard(ch, ns.Personas.list[id])
      ch.cards[i].persona = ns.Personas.list[id]
    end
    local back = linkButton(ch, L.BACK_TO_CHAT, 120, 22, "GameFontNormal")
    back:SetScript("OnClick", function() UI.choosing = false; UI:Refresh() end)
    ch.back = back
    self.chooser = ch
  end
  local ch = self.chooser
  local width = self.content:GetWidth()
  local cols = width >= 480 and 2 or 1
  local cardW = floor((min(width, 620) - (cols - 1) * 14) / cols)
  local left = floor((width - (cardW * cols + (cols - 1) * 14)) / 2)
  local suggested = ns.Personas:Suggested().id
  for i, card in ipairs(ch.cards) do
    local col, rowN = (i - 1) % cols, floor((i - 1) / cols)
    card:SetSize(cardW, CARD_H)
    card:ClearAllPoints()
    card:SetPoint("TOPLEFT", ch, "TOPLEFT", left + col * (cardW + 14), -(84 + rowN * (CARD_H + 14)))
    card.pitch:SetWidth(cardW - 28)
    card.sample:SetWidth(cardW - 28)
    local p = card.persona
    card.role:SetText(p.role .. " · " .. p.factionLabel
      .. (p.id == suggested and ("  |cff66dd66" .. L.YOUR_FACTION .. "|r") or ""))
  end
  local rows = math.ceil(#ch.cards / cols)
  local h = 84 + rows * (CARD_H + 14)
  ch.back:ClearAllPoints()
  ch.back:SetPoint("TOP", ch, "TOP", 0, -h)
  ch.back:SetShown(ns.Personas:Chosen())
  ch:ClearAllPoints()
  ch:SetPoint("TOPLEFT")
  ch:SetSize(width, h + 34)
  ch:Show()
  return h + 34
end

function UI:RefreshConversation()
  if not self.frame or not self.frame:IsShown() then return end
  local width = max(200, (self.scroll:GetWidth() or 400) - 4)
  self.content:SetWidth(width)
  local current = ns.Chats:Get(ns.db.currentChat)

  -- First time on this character (or the player asked): pick an assistant.
  if self.choosing or not ns.Personas:Chosen() then
    self.title:SetText(L.YOUR_ASSISTANT)
    self.deleteButton:Hide()
    if self.welcome then self.welcome:Hide() end
    for i = 1, #self.bubbles do self.bubbles[i]:Hide() end
    self.content:SetHeight(max(10, self:LayoutChooser()))
    self.scroll:SetVerticalScroll(0)
    return
  end
  if self.chooser then self.chooser:Hide() end

  self.title:SetText(escape(current and current.title or ns.Chats.DEFAULT_TITLE))
  self.deleteButton:SetShown(current ~= nil and #current.messages > 0)

  local messages = current and current.messages or {}
  local p = persona()
  local y, n = 8, 0
  local spent = { i = 0, c = 0, o = 0 }
  if #messages == 0 then
    y = y + self:ShowWelcome()
  elseif self.welcome then
    self.welcome:Hide()
  end
  for _, e in ipairs(messages) do
    n = n + 1
    local said = e.shown and withLinks(e.shown) or escape(e.question)
    if e.listen and (e.question or "") == "" then
      said = "|cffaaaaaa" .. (e.status == "pending" and L.TALK_BUBBLE_LISTENING or L.TALK_BUBBLE) .. "|r"
    end
    y = y + self:PlaceBubble(n, y, "user", said, stamp(e.t)) + 6
    n = n + 1
    if e.status == "pending" then
      y = y + self:PlaceBubble(n, y, "pending", ns.Personas:ThinkingText(0), nil) + 12
    elseif e.status == "done" then
      local answer = e.answer
      local meta = stamp(e.t)
      if e.tokens then
        meta = meta .. "  ·  " .. string.format(L.TOKENS, shortNumber(tokenTotal(e.tokens)))
        spent.i, spent.c, spent.o = spent.i + (e.tokens.i or 0), spent.c + (e.tokens.c or 0), spent.o + (e.tokens.o or 0)
      end
      y = y + self:PlaceBubble(n, y, "ai", renderAnswer(answer), meta,
        function() UI:ShowCopy(UI.PlainAnswer(answer)) end, L.COPY, e.tokens) + 12
    else
      y = y + self:PlaceBubble(n, y, "error",
        p.errorIntro .. "\n|cffffb0b0" .. escape(e.answer or L.SOMETHING_WRONG) .. "|r", stamp(e.t),
        function() UI:Retry(e, current) end, L.RETRY) + 12
    end
  end
  for i = n + 1, #self.bubbles do self.bubbles[i]:Hide() end
  -- The whole chat's tokens, on the right of the line under the title.
  if self.usage then
    local total = tokenTotal(spent)
    self.usage:SetText(total > 0 and string.format(L.TOKENS_CHAT, shortNumber(total)) or "")
    self.usageHover.tokens = total > 0 and spent or nil
    self.usageHover:EnableMouse(total > 0)
  end
  self.content:SetHeight(max(10, y))
  C_Timer.After(0, function()
    UI.scroll:SetVerticalScroll(UI.scroll:GetVerticalScrollRange())
  end)
end

function UI:Retry(entry, chatData)
  if ns.Core.working or ns.Uplink.busy then
    self:SetStatus(L.WAIT_OTHER)
    return
  end
  for i, m in ipairs(chatData.messages) do
    if m == entry then table.remove(chatData.messages, i) break end
  end
  -- A voice question the app never heard: listen again.
  if entry.listen and (entry.question or "") == "" then
    ns.Core:Listen(chatData.id)
    return
  end
  ns.Core:Ask(entry.shown or entry.question, nil, chatData.id)
end

-- The Talk button says "Stop" while the app is listening.
function UI:RefreshTalkButton()
  local b = self.talk
  if not b then return end
  if ns.Core.listening then
    b.label:SetText("|cffff6060" .. L.TALK_STOP .. "|r")
  else
    b.label:SetText(L.TALK)
  end
end

-- What the line under the chat title shows for each state of the app (see
-- Live:CheckApp). Red: questions won't be answered until the player fixes it.
local APP_LINE = {
  closed       = { "bad",  "APP_CLOSED",       "APP_CLOSED_TIP" },
  stuck        = { "bad",  "APP_STUCK",        "APP_STUCK_TIP" },
  ["need-ai"]    = { "bad",  "APP_NEED_AI",      "APP_NEED_AI_TIP" },
  ["need-login"] = { "bad",  "APP_NEED_LOGIN",   "APP_NEED_LOGIN_TIP" },
  problem      = { "bad",  "APP_PROBLEM",      "APP_PROBLEM_TIP" },
  restart      = { "warn", "APP_RESTART_GAME", "APP_RESTART_GAME_TIP" },
  checking     = { "idle", "APP_CHECKING",     nil },
  nosound      = { "idle", "APP_NO_SOUND",     "APP_NO_SOUND_TIP" },
}

-- Tooltip of the line: title and explanation of the app's current status.
function UI:AppStatusHelp()
  local state = ns.Live:AppState()
  local line = APP_LINE[state]
  if line then return L[line[2]], line[3] and L[line[3]] end
  if state == "ready" then return L.APP_READY, L.APP_READY_TIP end
  return L.APP_UNKNOWN, L.APP_UNKNOWN_TIP
end

-- Connection line under the chat title: whether the app is open and ready,
-- how questions travel, and whether the app is answering.
function UI:RefreshStatusBar()
  if not self.dot then return end
  local waitingLong = false
  ns.Chats:EachEntry(function(e)
    if e.status == "pending" and time() - (e.t or time()) > 30 then waitingLong = true end
  end)
  local p = persona()
  local line = APP_LINE[ns.Live:AppState()]
  if line then
    fill(self.dot, C[line[1]])
    local color = line[1] == "bad" and "|cffff6060" or line[1] == "warn" and "|cffffc040" or "|cffaaaaaa"
    self.channel:SetText(color .. L[line[2]] .. "|r")
  elseif waitingLong then
    fill(self.dot, C.warn)
    self.channel:SetText(L.NO_SIGNAL)
  elseif ns.Voice and ns.Voice:Find() and not ns.Voice.broken then
    fill(self.dot, C.ok)
    self.channel:SetText(p.name .. " · " .. p.statusOnline .. " · " .. L.VIA_VOICE)
  else
    fill(self.dot, C.ok)
    self.channel:SetText(p.name .. " · " .. p.statusOnline .. " · " .. L.VIA_STRIP)
  end
end

function UI:Refresh()
  if not self.frame or not self.frame:IsShown() then return end
  if self.side:IsShown() then self:RefreshList() end
  self:RefreshConversation()
  self:RefreshStatusBar()
end

function UI:Submit()
  local q = self.input:GetText()
  if q and q:match("%S") then
    self.input:SetText("")
    ns.Core:Ask(q)
  end
end

function UI:SetStatus(msg)
  self:Build()
  self.status:SetText(msg or "")
end

function UI:Show()
  self:Build()
  self.frame:Show()
end

function UI:Toggle()
  self:Build()
  self.frame:SetShown(not self.frame:IsShown())
end

function UI:IsShown()
  return self.frame and self.frame:IsShown()
end

-- Copyable text window (answers, character data), same dialog look.
function UI:ShowCopy(text, heading)
  if not self.copyFrame then
    local f = newFrame("Frame", "ForeverAICompanionCopyFrame", UIParent)
    f:SetSize(580, 420)
    f:SetPoint("CENTER", 40, -30)
    f:SetFrameStrata("FULLSCREEN_DIALOG")
    f:SetMovable(true)
    f:EnableMouse(true)
    f:RegisterForDrag("LeftButton")
    f:SetScript("OnDragStart", f.StartMoving)
    f:SetScript("OnDragStop", f.StopMovingOrSizing)
    f:SetClampedToScreen(true)
    dialog(f)
    tinsert(UISpecialFrames, "ForeverAICompanionCopyFrame")
    local banner = f:CreateTexture(nil, "ARTWORK")
    banner:SetTexture(ART.banner)
    banner:SetSize(360, 64)
    banner:SetPoint("TOP", 0, 12)
    local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    f.title = title
    onTheme(function(isFlat)
      banner:SetShown(not isFlat)
      title:ClearAllPoints()
      if isFlat then
        title:SetPoint("TOPLEFT", 16, -12)
        textColor(title, FLAT.text)
      else
        title:SetPoint("TOP", banner, "TOP", 0, -14)
        textColor(title, GOLD)
      end
    end)
    local hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
    hint:SetPoint("TOPLEFT", 18, -30)
    hint:SetText(L.COPY_HINT)
    closeButtons(f, nil, 8)
    local inset = newFrame("Frame", nil, f)
    inset:SetPoint("TOPLEFT", 12, -48)
    inset:SetPoint("BOTTOMRIGHT", -12, 12)
    themedPanel(inset, "panel")
    local scroll = CreateFrame("ScrollFrame", "ForeverAICompanionCopyScroll", inset, "UIPanelScrollFrameTemplate")
    scroll:SetPoint("TOPLEFT", 10, -10)
    scroll:SetPoint("BOTTOMRIGHT", -30, 10)
    themedScroll(scroll)
    local edit = CreateFrame("EditBox", nil, scroll)
    edit:SetMultiLine(true)
    edit:SetFontObject(ChatFontNormal)
    edit:SetWidth(500)
    edit:SetAutoFocus(false)
    edit:SetScript("OnEscapePressed", function() f:Hide() end)
    scroll:SetScrollChild(edit)
    f.edit = edit
    self.copyFrame = f
  end
  local f = self.copyFrame
  f.title:SetText(heading or L.COPY_ANSWER)
  f.edit:SetText(text or "")
  f:Show()
  f.edit:SetFocus()
  f.edit:HighlightText()
end

-- The JSON the AI receives (also handy to paste into any AI chat).
function UI:ShowContext()
  local ok, snap = pcall(ns.Collect.Snapshot, ns.Collect)
  local json = ok and ns.Json.Encode(snap) or (L.ERROR .. ": " .. tostring(snap))
  self:ShowCopy(json, string.format(L.CONTEXT_TITLE, persona().name))
end

-- A game window opened or closed (vendor, auction house, trainer...): a new
-- chat's suggestions change to questions about it.
local WINDOW_EVENTS = {
  "MERCHANT_SHOW", "MERCHANT_CLOSED", "AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED",
  "TRAINER_SHOW", "TRAINER_CLOSED", "QUEST_DETAIL", "QUEST_COMPLETE", "QUEST_FINISHED",
  "TAXIMAP_OPENED", "TAXIMAP_CLOSED", "LOOT_OPENED", "LOOT_CLOSED",
}
function UI:OnGameWindow()
  if not (self.frame and self.frame:IsShown() and ns.db) then return end
  local current = ns.Chats:Get(ns.db.currentChat)
  if current and #current.messages > 0 then return end -- only a new chat shows suggestions
  self:RefreshConversation()
end

local windowWatcher = CreateFrame and CreateFrame("Frame")
if windowWatcher then
  for _, e in ipairs(WINDOW_EVENTS) do pcall(windowWatcher.RegisterEvent, windowWatcher, e) end
  -- Next frame: after Collect has noted which window is open.
  windowWatcher:SetScript("OnEvent", function()
    C_Timer.After(0, function() pcall(UI.OnGameWindow, UI) end)
  end)
end

-- Combat ----------------------------------------------------------------------
-- (Kept in this file, not a new one: WoW only loads files that existed when
-- the game started, so a new file would need a full restart after updating.)
-- Questions can be asked in combat, but the chat window makes sure the player
-- keeps an eye on the game:
--   - in combat, a red bar above the text box: "In combat: keep an eye on the
--     game", with the player's health bar on its right;
--   - on each hit taken, the window glows red at its edges for a moment
--     (the game's low-health vignette, soft and inside the window's frame),
--     the bar lights up and says "You're being hit!".
-- What WoW Forever lets addons see in combat (measured in the game): entering
-- and leaving combat (PLAYER_REGEN_*); every hit (UNIT_COMBAT "WOUND"), with
-- the amount hidden; health changes (UNIT_HEALTH) with the values hidden
-- ("secret values"). Hidden values can't be read or compared, but the game's
-- own widgets can still draw them: the health bar is a StatusBar fed straight
-- from UnitHealth, like the game's unit frames.
local Combat = {}
ns.Combat = Combat

Combat.BAR_H = 26
local HIT_HOLD = 4        -- seconds "You're being hit!" stays after the last hit
local FLASH_TIME = 0.8    -- seconds the red glow takes to fade out
local FLASH_PEAK = 0.45   -- how strong the glow is right after a hit (discreet)
local FLASH_GAP = 0.35    -- at most one flash this often
local INSET = 4           -- the glow stays inside the window's frame: no square edge of its own
local VIGNETTE = "Interface\\FullScreenTextures\\LowHealth"
local SWORDS = "Interface\\CharacterFrame\\UI-StateIcon" -- crossed swords (lower right of the sheet)
local BAR_TEX = "Interface\\TargetingFrame\\UI-StatusBar"
local BAR_BG = { 0.45, 0.04, 0.04, 0.9 }
local BAR_LIT = { 0.62, 0.07, 0.05, 0.92 }

-- A value the addon may use (not hidden from it by the game). Asked first:
-- comparing a hidden value, even with nil, can raise an error.
local function plain(v)
  if issecretvalue and issecretvalue(v) then return false end
  return v ~= nil
end

-- The player chose the warning (Options: "Show the combat warning instead")
-- rather than dimming the window in combat (Fade.lua).
function Combat:Wanted()
  local ok, s = pcall(function() return ns.Fade and ns.Fade:Settings() end)
  if not (ok and s) then return true end
  return s.combatStyle == "warn"
end

function Combat:InCombat()
  local ok, v = pcall(UnitAffectingCombat, "player")
  return ok and plain(v) and v and true or false
end

-- The player's health in percent when the game shares it (nil in combat on
-- WoW Forever: there the health bar shows it instead).
function Combat:HealthPct()
  local ok, pct = pcall(function()
    local h, m = UnitHealth("player"), UnitHealthMax("player")
    if not plain(h) or not plain(m) or m <= 0 then return nil end
    return floor(h / m * 100 + 0.5)
  end)
  return ok and pct or nil
end

-- The bar, the health bar and the red border, inside the chat window.
function Combat:Build()
  local UI = ns.UI
  if self.bar or not (UI and UI.frame and UI.main) then return end
  local bar = CreateFrame("Frame", nil, UI.main)
  bar:SetPoint("BOTTOMLEFT", 10, 64)
  bar:SetPoint("BOTTOMRIGHT", -10, 64)
  bar:SetHeight(self.BAR_H)
  local bg = bar:CreateTexture(nil, "BACKGROUND")
  bg:SetAllPoints()
  bg:SetColorTexture(BAR_BG[1], BAR_BG[2], BAR_BG[3], BAR_BG[4])
  local line = bar:CreateTexture(nil, "BORDER")
  line:SetPoint("TOPLEFT")
  line:SetPoint("TOPRIGHT")
  line:SetHeight(1)
  line:SetColorTexture(1, 0.25, 0.2, 0.9)
  local icon = bar:CreateTexture(nil, "ARTWORK")
  icon:SetSize(20, 20)
  icon:SetPoint("LEFT", 6, 0)
  icon:SetTexture(SWORDS)
  icon:SetTexCoord(0.5, 1, 0, 0.49)

  -- The player's health, drawn by the game itself (works with hidden values).
  local hp = CreateFrame("StatusBar", nil, bar)
  hp:SetSize(90, 12)
  hp:SetPoint("RIGHT", -8, 0)
  if hp.SetStatusBarTexture then pcall(hp.SetStatusBarTexture, hp, BAR_TEX) end
  if hp.SetStatusBarColor then pcall(hp.SetStatusBarColor, hp, 0.15, 0.85, 0.2) end
  local hpBg = hp:CreateTexture(nil, "BACKGROUND")
  hpBg:SetAllPoints()
  hpBg:SetColorTexture(0, 0, 0, 0.7)
  local hpText = hp:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  hpText:SetPoint("CENTER", 0, 0)

  local text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  text:SetPoint("LEFT", icon, "RIGHT", 6, 0)
  text:SetPoint("RIGHT", hp, "LEFT", -8, 0)
  text:SetJustifyH("LEFT")
  if text.SetWordWrap then text:SetWordWrap(false) end
  bar:Hide()

  -- A soft red glow at the window's edges, over everything (not catching the
  -- mouse). Inside the frame, so it ends at the window's own border.
  local over = CreateFrame("Frame", nil, UI.frame)
  over:SetPoint("TOPLEFT", INSET, -INSET)
  over:SetPoint("BOTTOMRIGHT", -INSET, INSET)
  over:SetFrameLevel((UI.frame:GetFrameLevel() or 1) + 40)
  local glow = over:CreateTexture(nil, "OVERLAY")
  glow:SetAllPoints()
  glow:SetTexture(VIGNETTE)
  if glow.SetBlendMode then glow:SetBlendMode("ADD") end
  glow:SetVertexColor(1, 0.2, 0.15)
  glow:SetAlpha(0)
  over:SetScript("OnUpdate", function(_, elapsed) Combat:Fade(elapsed or 0) end)

  self.bar, self.bg, self.text, self.icon = bar, bg, text, icon
  self.hp, self.hpText, self.glow = hp, hpText, glow
end

-- The health bar (and its percent, when the game shares it or can format it).
function Combat:UpdateHealth()
  if not self.hp then return end
  pcall(function()
    self.hp:SetMinMaxValues(0, UnitHealthMax("player"))
    self.hp:SetValue(UnitHealth("player"))
  end)
  local pct = self:HealthPct()
  if pct then
    self.hpText:SetText(pct .. "%")
  elseif not pcall(function()
    -- A hidden value can still be written by the game's own text widgets.
    self.hpText:SetFormattedText("%d%%", UnitHealthPercent("player", true, CurveConstants.ScaleTo100))
  end) then
    self.hpText:SetText("")
  end
end

-- Shows or hides the bar, says what is going on, and makes room for it.
function Combat:Update()
  self:Build()
  if not self.bar then return end
  local now = GetTime()
  local hit = self.hitAt and now - self.hitAt < HIT_HOLD
  local show = self:Wanted() and (self:InCombat() or hit) or false
  self.text:SetText(hit and ("|cffffd0c8" .. L.COMBAT_HIT .. "|r") or L.COMBAT_ON)
  self:UpdateHealth()
  if show ~= self.bar:IsShown() then
    self.bar:SetShown(show)
    -- The messages end above the bar while it shows.
    local scroll = ns.UI.scroll
    if scroll then
      scroll:SetPoint("BOTTOMRIGHT", -28, 66 + (show and self.BAR_H + 4 or 0))
      if ns.UI.RefreshConversation then pcall(ns.UI.RefreshConversation, ns.UI) end
    end
  end
end

-- A hit taken: the glow and the bar light up (not more often than FLASH_GAP).
function Combat:Hit()
  if not self:Wanted() then return end
  local now = GetTime()
  if self.hitAt and now - self.hitAt < FLASH_GAP then return end
  self.hitAt = now
  self.flash = FLASH_TIME
  self:Update()
end

function Combat:Fade(elapsed)
  if self.flash and self.flash > 0 then
    self.flash = math.max(0, self.flash - elapsed)
    local k = self.flash / FLASH_TIME
    k = k * k -- eases out: fades fast, then lingers softly
    self.glow:SetAlpha(FLASH_PEAK * k)
    local r, g, b = BAR_BG[1] + (BAR_LIT[1] - BAR_BG[1]) * k, BAR_BG[2] + (BAR_LIT[2] - BAR_BG[2]) * k, BAR_BG[3] + (BAR_LIT[3] - BAR_BG[3]) * k
    self.bg:SetColorTexture(r, g, b, BAR_BG[4])
  end
  -- "You're being hit!" goes back to "In combat" after a while.
  if self.hitAt and GetTime() - self.hitAt >= HIT_HOLD then
    self.hitAt = nil
    self:Update()
  end
end

function Combat:OnEvent(event, unit, action, _, amount)
  if event == "UNIT_COMBAT" then
    -- "WOUND": the player took damage (its amount may be hidden).
    if unit == "player" and plain(action) and action == "WOUND" and (not plain(amount) or (tonumber(amount) or 0) > 0) then
      self:Hit()
    end
    return
  end
  if event == "UNIT_HEALTH" or event == "UNIT_MAXHEALTH" then
    if unit == "player" and self.bar and self.bar:IsShown() then self:UpdateHealth() end
    return
  end
  -- Entering or leaving combat, or a loading screen.
  self:Update()
end

local events = CreateFrame and CreateFrame("Frame")
if events then
  for _, e in ipairs({ "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "UNIT_COMBAT", "UNIT_HEALTH", "UNIT_MAXHEALTH", "PLAYER_ENTERING_WORLD" }) do
    pcall(events.RegisterEvent, events, e)
  end
  events:SetScript("OnEvent", function(_, event, ...)
    pcall(Combat.OnEvent, Combat, event, ...)
  end)
end

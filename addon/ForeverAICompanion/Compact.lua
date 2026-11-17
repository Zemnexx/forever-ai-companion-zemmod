-- Compact answers: with this mode on, asking while the chat window is closed
-- (the talk key, /ia talk, /ia <question>) doesn't open the window. A small,
-- slightly see-through box shows "Listening...", then "Thinking...", then the
-- answer for a while (20 s by default, set in Options) and goes away by itself.
-- Hovering it keeps it up, item links in it work like in the chat, and it
-- can be dragged anywhere and resized from its corner (right-click the corner
-- to go back to the automatic size). The answer is in the chat as usual: the
-- minimap button (or "Open in chat") shows it there.
local _, ns = ...
local L = ns.L

local Compact = {}
ns.Compact = Compact

Compact.DEFAULTS = { enabled = false, seconds = 20 }
Compact.MIN_SECONDS, Compact.MAX_SECONDS, Compact.SECONDS_STEP = 5, 60, 5

local WIDTH = 380           -- until the player resizes it
local MAX_TEXT = 240        -- tallest the answer gets before it scrolls (automatic size)
local MIN_W, MIN_H = 240, 110
local MAX_W, MAX_H = 900, 700
local ALPHA = 0.85          -- see-through while the mouse is elsewhere
local FADE = 0.6            -- seconds of fading out at the end
local AFTER_HOVER = 5       -- seconds it stays at least, after the mouse leaves
local MESSAGE_SECONDS = 6   -- short notes ("Leave combat to ask")
local CHECK = 0.2           -- seconds between looks at the question's state
local THINK = 0.45          -- "thinking" animation step

local floor, min, max, ceil = math.floor, math.min, math.max, math.ceil
local function escape(s) return (tostring(s or ""):gsub("|", "||")) end

-- Only what the player changed is saved (account-wide), like Fade.lua.
local function saved()
  ns.db.compact = ns.db.compact or {}
  return ns.db.compact
end

function Compact:Settings()
  local t = saved()
  local s = {}
  for k, v in pairs(self.DEFAULTS) do
    if t[k] == nil then s[k] = v else s[k] = t[k] end
  end
  s.enabled = s.enabled and true or false
  local n = tonumber(s.seconds) or self.DEFAULTS.seconds
  s.seconds = max(self.MIN_SECONDS, min(self.MAX_SECONDS, floor(n / self.SECONDS_STEP + 0.5) * self.SECONDS_STEP))
  return s
end

function Compact:Set(key, value)
  local t = saved()
  t[key] = value
  t[key] = self:Settings()[key]
  if key == "enabled" and not t[key] then self:Hide() end
end

function Compact:Toggle()
  self:Set("enabled", not self:Settings().enabled)
  return self:Settings().enabled
end

-- The size the player gave the box by dragging its corner, or nil: then it is
-- WIDTH wide and as tall as the answer, up to MAX_TEXT before it scrolls.
local function chosenSize()
  local size = saved().size
  if type(size) ~= "table" or not tonumber(size.w) or not tonumber(size.h) then return nil end
  return max(MIN_W, min(MAX_W, floor(size.w))), max(MIN_H, min(MAX_H, floor(size.h)))
end

-- Asking right now goes to the box instead of opening the window.
function Compact:Active()
  return self:Settings().enabled and not (ns.UI and ns.UI:IsShown())
end

local function textButton(parent, label)
  local b = CreateFrame("Button", nil, parent)
  b:SetSize(110, 16)
  local fs = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  fs:SetPoint("LEFT")
  fs:SetText(label)
  b:SetScript("OnEnter", function() fs:SetTextColor(1, 1, 1) end)
  b:SetScript("OnLeave", function() fs:SetTextColor(1, 0.82, 0) end)
  b.label = fs
  return b
end

function Compact:Build()
  if self.frame then return end
  if ns.UI then ns.UI:Build() end -- fonts, and the window this box stands in for
  local tpl = BackdropTemplateMixin and "BackdropTemplate" or nil
  local f = CreateFrame("Frame", "ForeverAICompanionCompact", UIParent, tpl)
  f:SetSize(WIDTH, 120)
  f:SetFrameStrata("HIGH")
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:SetResizable(true)
  if f.SetResizeBounds then f:SetResizeBounds(MIN_W, MIN_H, MAX_W, MAX_H)
  elseif f.SetMinResize then f:SetMinResize(MIN_W, MIN_H); if f.SetMaxResize then f:SetMaxResize(MAX_W, MAX_H) end end
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) self:StartMoving() end)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, rel, x, y = self:GetPoint(1)
    saved().pos = { point = point, rel = rel, x = x, y = y }
  end)
  if f.SetBackdrop then
    f:SetBackdrop({
      bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
      edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      tile = true, tileSize = 16, edgeSize = 16,
      insets = { left = 4, right = 4, top = 4, bottom = 4 },
    })
    f:SetBackdropColor(0.03, 0.03, 0.03, 0.92)
    f:SetBackdropBorderColor(1, 0.82, 0.3, 1)
  end

  -- Header: the assistant's portrait, name and the chat.
  local icon = f:CreateTexture(nil, "ARTWORK")
  icon:SetSize(22, 22)
  icon:SetPoint("TOPLEFT", 10, -9)
  local mask = f.CreateMaskTexture and f:CreateMaskTexture()
  if mask then
    mask:SetTexture("Interface\\CharacterFrame\\TempPortraitAlphaMask", "CLAMPTOBLACKADDITIVE", "CLAMPTOBLACKADDITIVE")
    mask:SetAllPoints(icon)
    icon:AddMaskTexture(mask)
  end
  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("LEFT", icon, "RIGHT", 6, 0)
  title:SetPoint("RIGHT", -28, 0)
  title:SetJustifyH("LEFT")
  if title.SetWordWrap then title:SetWordWrap(false) end
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetSize(24, 24)
  close:SetPoint("TOPRIGHT", -2, -2)
  close:SetScript("OnClick", function() Compact:Hide() end)

  -- What was asked (for voice questions: what the app heard).
  local question = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  question:SetPoint("TOPLEFT", 12, -36)
  question:SetWidth(WIDTH - 24)
  question:SetJustifyH("LEFT")
  if question.SetWordWrap then question:SetWordWrap(true) end
  if question.SetMaxLines then question:SetMaxLines(2) end

  -- The answer, scrolling when long. Its links work as in the chat.
  local scroll = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
  local child = CreateFrame("Frame", nil, scroll)
  child:SetSize(WIDTH - 44, 10)
  scroll:SetScrollChild(child)
  if child.SetHyperlinksEnabled then
    pcall(child.SetHyperlinksEnabled, child, true)
    child:SetScript("OnHyperlinkClick", function(self, link, linkText, button)
      if SetItemRef then pcall(SetItemRef, link, linkText, button, self) end
    end)
    child:SetScript("OnHyperlinkEnter", function(self, link)
      if not GameTooltip then return end
      GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
      if pcall(GameTooltip.SetHyperlink, GameTooltip, link) then GameTooltip:Show() else GameTooltip:Hide() end
    end)
    child:SetScript("OnHyperlinkLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  end
  local text = child:CreateFontString(nil, "OVERLAY")
  text:SetFontObject((ns.UI and ns.UI.fonts and ns.UI.fonts.Body) or GameFontHighlight)
  text:SetPoint("TOPLEFT")
  text:SetWidth(WIDTH - 44)
  text:SetJustifyH("LEFT")
  text:SetJustifyV("TOP")
  text:SetSpacing(2)
  if text.SetWordWrap then text:SetWordWrap(true) end

  -- Footer: open the chat, and how long until it goes away.
  local open = textButton(f, L.COMPACT_OPEN)
  open:SetPoint("BOTTOMLEFT", 12, 9)
  open:SetScript("OnClick", function() Compact:OpenChat() end)
  local countdown = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  countdown:SetPoint("BOTTOMRIGHT", -24, 10)
  countdown:SetJustifyH("RIGHT")

  -- Resize corner: drag it to set the box's size, kept for next time.
  -- Right-click: back to the automatic size.
  local grip = CreateFrame("Button", nil, f)
  grip:SetSize(16, 16)
  grip:SetPoint("BOTTOMRIGHT", -3, 3)
  grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
  grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
  grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")
  grip:SetScript("OnMouseDown", function(_, button)
    if button == "RightButton" then return end
    Compact.sizing = true
    f:StartSizing("BOTTOMRIGHT")
  end)
  grip:SetScript("OnMouseUp", function(_, button)
    if button == "RightButton" then
      saved().size = nil
    elseif Compact.sizing then
      Compact.sizing = false
      f:StopMovingOrSizing()
      saved().size = { w = floor(f:GetWidth() + 0.5), h = floor(f:GetHeight() + 0.5) }
      local point, _, rel, x, y = f:GetPoint(1)
      saved().pos = { point = point, rel = rel, x = x, y = y }
    end
    Compact:Render()
  end)
  grip:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
    GameTooltip:AddLine(L.COMPACT_RESIZE, 1, 1, 1, true)
    GameTooltip:Show()
  end)
  grip:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  -- While the corner is dragged, the answer follows the new size.
  f:SetScript("OnSizeChanged", function() if Compact.sizing then Compact:Render(true) end end)

  f:SetScript("OnUpdate", function(_, elapsed) Compact:Update(elapsed) end)
  f:Hide()
  self.frame, self.icon, self.title, self.question = f, icon, title, question
  self.scroll, self.child, self.text, self.countdown, self.grip = scroll, child, text, countdown, grip
  self:Place()
end

-- Where the player last dragged it, or the top of the screen.
function Compact:Place()
  local f = self.frame
  f:ClearAllPoints()
  local pos = saved().pos
  if type(pos) == "table" and pos.point then
    f:SetPoint(pos.point, UIParent, pos.rel or pos.point, pos.x or 0, pos.y or 0)
  else
    f:SetPoint("TOP", UIParent, "TOP", 0, -140)
  end
end

-- What the box says right now: { state, body, asked }.
function Compact:View()
  local e = self.entry
  if not e then return { state = "message", body = escape(self.message) } end
  local asked
  if e.shown and ns.UI and ns.UI.WithLinks then asked = ns.UI.WithLinks(e.shown)
  elseif (e.question or "") ~= "" then asked = escape(e.question) end
  if e.status == "pending" then
    local listening = ns.Core.listening and ns.Core.listening.id == e.id
    return {
      state = listening and "listening" or "pending",
      body = "|cffaaaaaa" .. (listening and L.TALK_LISTENING or ns.Personas:ThinkingText(self.ticks or 0)) .. "|r",
      asked = asked,
    }
  elseif e.status == "done" then
    return { state = "done", body = ns.UI.RenderAnswer(e.answer), asked = asked }
  end
  return { state = "error", body = "|cffff6060" .. escape(e.answer or L.SOMETHING_WRONG) .. "|r", asked = asked }
end

-- live: the corner is being dragged, so the text follows the frame's size
-- instead of setting it.
function Compact:Render(live)
  local f = self.frame
  if not f then return end
  local v = self:View()
  self.view = v
  local p = ns.Personas:Current()
  if ns.Personas.SetPortrait then ns.Personas.SetPortrait(self.icon, p) end
  local chatTitle = self.chat and self.chat.title
  self.title:SetText((p.nameColor or "") .. (p.name or "") .. "|r"
    .. (chatTitle and ("  |cff999999" .. escape(chatTitle) .. "|r") or ""))
  local chosenW, chosenH = chosenSize()
  local w = live and floor(f:GetWidth() + 0.5) or chosenW or WIDTH
  local boxH = live and floor(f:GetHeight() + 0.5) or chosenH
  local top = 36
  self.question:SetWidth(w - 24)
  if v.asked then
    self.question:SetText(string.format(L.COMPACT_ASKED, v.asked))
    self.question:Show()
    top = top + (self.question:GetStringHeight() or 12) + 6
  else
    self.question:Hide()
  end
  self.text:SetWidth(w - 44)
  self.child:SetWidth(w - 44)
  self.text:SetText(v.body)
  local h = max(14, self.text:GetStringHeight() or 14)
  self.child:SetHeight(h)
  local shown
  if boxH then
    -- A size the player chose: the answer fills it and scrolls when longer.
    shown = max(14, boxH - top - 34)
  else
    shown = min(h, MAX_TEXT)
    boxH = top + shown + 34
  end
  self.scroll:ClearAllPoints()
  self.scroll:SetPoint("TOPLEFT", 12, -top)
  self.scroll:SetSize(w - 40, shown)
  if not live then f:SetSize(w, boxH) end
  if f.SetBackdropBorderColor then
    if v.state == "error" then f:SetBackdropBorderColor(0.9, 0.25, 0.2, 1) else f:SetBackdropBorderColor(1, 0.82, 0.3, 1) end
  end
end

-- How the question stands (to redraw only when it changes).
function Compact:StateKey()
  local e = self.entry
  if not e then return "message" end
  local listening = ns.Core.listening and ns.Core.listening.id == e.id
  return table.concat({ e.status or "", tostring(e.question), tostring(listening) }, "|")
end

function Compact:StartTimer(seconds)
  self.expires = GetTime() + (seconds or self:Settings().seconds)
end

function Compact:Update(elapsed)
  local f = self.frame
  if not f or not f:IsShown() then return end
  local now = GetTime()
  self.acc = (self.acc or 0) + (elapsed or 0)
  if self.acc >= CHECK then
    self.acc = 0
    local key = self:StateKey()
    if key ~= self.key then
      self.key = key
      self:Render()
      if self.entry and self.entry.status ~= "pending" and not self.expires then self:StartTimer() end
    end
  end
  if self.entry and self.entry.status == "pending" then
    self.think = (self.think or 0) + (elapsed or 0)
    if self.think >= THINK then
      self.think = 0
      self.ticks = (self.ticks or 0) + 1
      self:Render()
    end
  end
  -- The mouse on it keeps it up; after it leaves, a few more seconds. (Not
  -- while turning the camera with the mouse: the hidden cursor stays put.)
  local mouselook = IsMouselooking and IsMouselooking()
  if not mouselook and f:IsMouseOver() then
    self.hovered = true
    f:SetAlpha(1)
    if self.expires then self.countdown:SetText(L.COMPACT_HELD) end
    return
  end
  if self.hovered then
    self.hovered = false
    if self.expires then self.expires = max(self.expires, now + AFTER_HOVER) end
  end
  if not self.expires then
    f:SetAlpha(ALPHA)
    self.countdown:SetText("")
    return
  end
  local left = self.expires - now
  if left <= 0 then
    self:Hide()
    return
  end
  f:SetAlpha(left < FADE and ALPHA * left / FADE or ALPHA)
  self.countdown:SetText(string.format(L.COMPACT_CLOSES, ceil(left)))
end

-- Shows a question (pending or answered). Called when asking in compact mode
-- and when an answer arrives with the window closed.
function Compact:Show(entry, chatData)
  self:Build()
  local fresh = self.entry ~= entry
  self.entry, self.chat, self.message = entry, chatData, nil
  if fresh then self.expires, self.ticks, self.think = nil, 0, 0 end
  self.key = self:StateKey()
  self:Render()
  if entry.status ~= "pending" then
    if not self.expires then self:StartTimer() end
    if ns.Notify and ns.Notify.Chime then ns.Notify:Chime(entry.status == "done") end
    if ns.Button and ns.Button.Celebrate then ns.Button:Celebrate() end
  end
  self.frame:SetAlpha(ALPHA)
  self.frame:Show()
end

-- A short note instead of a question (e.g. "Leave combat to ask").
function Compact:Message(text)
  self:Build()
  self.entry, self.chat, self.message = nil, nil, text
  self.key = "message"
  self:Render()
  self:StartTimer(MESSAGE_SECONDS)
  self.frame:SetAlpha(ALPHA)
  self.frame:Show()
end

-- The question's state changed outside the box (e.g. the talk key was released).
function Compact:Refresh()
  if self.frame and self.frame:IsShown() then self.key = nil end
end

function Compact:OpenChat()
  local id = self.chat and self.chat.id
  self:Hide()
  if id then ns.Chats:Select(id) end
  ns.UI:Show()
  ns.UI:Refresh()
end

function Compact:Hide()
  if self.frame then self.frame:Hide() end
  self.entry, self.chat, self.message, self.expires, self.hovered = nil, nil, nil, nil, false
end

function Compact:IsShown()
  return self.frame ~= nil and self.frame:IsShown()
end

-- Items the game was still loading: show them as links once they arrive.
local items = CreateFrame and CreateFrame("Frame")
if items then
  pcall(items.RegisterEvent, items, "GET_ITEM_INFO_RECEIVED")
  items:SetScript("OnEvent", function()
    if Compact:IsShown() and Compact.entry and Compact.entry.status == "done" then Compact:Render() end
  end)
end

-- Notification cards: "Fizzi has an answer!" (or Rizzik's) with the chat name and a preview of
-- the answer, next to the floating button (or at the top of the screen).
-- Click a card to open that chat. Cards fade out after a few seconds and
-- stack when several answers arrive.
local _, ns = ...
local L = ns.L

local Notify = {}
ns.Notify = Notify

local WIDTH, HEIGHT = 300, 74
local SHOW_SECONDS = 10
local FADE_SECONDS = 0.6
local MAX_CARDS = 3

local function settings()
  ns.db.ui = ns.db.ui or {}
  if ns.db.ui.sound == nil then ns.db.ui.sound = true end
  return ns.db.ui
end

-- Plain one-paragraph preview of an answer.
local function preview(text, chars)
  if ns.UI and ns.UI.PlainAnswer then text = ns.UI.PlainAnswer(text) end
  text = tostring(text or ""):gsub("\n+", " "):gsub("%s+", " ")
  text = text:gsub("|", "||")
  if #text <= chars then return text end
  return text:sub(1, chars):gsub("[\192-\255][\128-\191]*$", "") .. "…"
end

local function card(i)
  Notify.cards = Notify.cards or {}
  local c = Notify.cards[i]
  if c then return c end
  -- Looks like a game tooltip: dark fill and the tooltip border, gold when
  -- the answer is ready, red when it failed.
  c = CreateFrame("Button", nil, UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  c:SetSize(WIDTH, HEIGHT)
  c:SetFrameStrata("HIGH")
  c:SetClampedToScreen(true)
  c:RegisterForClicks("LeftButtonUp", "RightButtonUp")
  if c.SetBackdrop then
    c:SetBackdrop({
      bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
      edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      tile = true, tileSize = 16, edgeSize = 16,
      insets = { left = 4, right = 4, top = 4, bottom = 4 },
    })
    c:SetBackdropColor(0.03, 0.03, 0.03, 0.94)
  end
  local hl = c:CreateTexture(nil, "HIGHLIGHT")
  hl:SetPoint("TOPLEFT", 4, -4)
  hl:SetPoint("BOTTOMRIGHT", -4, 4)
  hl:SetTexture("Interface\\QuestFrame\\UI-QuestLogTitleHighlight")
  if hl.SetBlendMode then hl:SetBlendMode("ADD") end
  hl:SetVertexColor(1, 0.82, 0.3, 0.25)

  -- The assistant's round portrait inside the gold minimap ring.
  local holder = CreateFrame("Frame", nil, c)
  holder:SetSize(44, 44)
  holder:SetPoint("TOPLEFT", 8, -8)
  local icon = holder:CreateTexture(nil, "ARTWORK")
  icon:SetSize(28, 28)
  icon:SetPoint("CENTER")
  local mask = holder.CreateMaskTexture and holder:CreateMaskTexture()
  if mask then
    mask:SetTexture("Interface\\CharacterFrame\\TempPortraitAlphaMask", "CLAMPTOBLACKADDITIVE", "CLAMPTOBLACKADDITIVE")
    mask:SetAllPoints(icon)
    icon:AddMaskTexture(mask)
  end
  local ring = holder:CreateTexture(nil, "OVERLAY")
  ring:SetTexture("Interface\\Minimap\\MiniMap-TrackingBorder")
  ring:SetSize(44 * 1.62, 44 * 1.62)
  ring:SetPoint("TOPLEFT")
  c.icon = icon

  local title = c:CreateFontString(nil, "OVERLAY", "GameFontNormal")
  title:SetPoint("TOPLEFT", 58, -12)
  title:SetPoint("RIGHT", -26, 0)
  title:SetJustifyH("LEFT")
  if title.SetWordWrap then title:SetWordWrap(false) end
  c.title = title
  local body = c:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  body:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -4)
  body:SetPoint("RIGHT", -12, 0)
  body:SetJustifyH("LEFT")
  body:SetJustifyV("TOP")
  if body.SetWordWrap then body:SetWordWrap(true) end
  if body.SetMaxLines then body:SetMaxLines(2) end
  c.body = body
  local hint = c:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  hint:SetPoint("BOTTOMRIGHT", -10, 6)
  hint:SetText(L.CLICK_TO_OPEN)


  c:SetScript("OnClick", function(self, mouse)
    if mouse ~= "RightButton" and self.chatId then
      ns.Chats:Select(self.chatId)
      ns.UI:Show()
      ns.UI:Refresh()
    end
    Notify:Dismiss(self)
  end)
  c:SetScript("OnEnter", function(self) self.hovered = true; self:SetAlpha(1) end)
  c:SetScript("OnLeave", function(self) self.hovered = false end)
  c:SetScript("OnUpdate", function(self)
    if not self.expires or self.hovered then return end
    local left = self.expires - GetTime()
    if left <= 0 then
      Notify:Dismiss(self)
    elseif left < FADE_SECONDS then
      self:SetAlpha(left / FADE_SECONDS)
    end
  end)
  -- Initial values (false, not nil: some fields are checked before first use).
  c.expires, c.hovered, c.order, c.chatId = false, false, 0, false
  c:Hide()
  Notify.cards[i] = c
  return c
end

-- Where cards go: beside the floating button, growing away from the screen
-- edge it is closest to; otherwise at the top center of the screen.
function Notify:Layout()
  local visible = {}
  for _, c in ipairs(self.cards or {}) do
    if c:IsShown() then visible[#visible + 1] = c end
  end
  table.sort(visible, function(a, b) return (a.order or 0) > (b.order or 0) end)
  local anchor = ns.Button and ns.Button.frame
  local cx, cy = nil, nil
  if anchor and anchor:IsShown() and anchor.GetCenter then cx, cy = anchor:GetCenter() end
  local sw, sh = UIParent:GetWidth() or 0, UIParent:GetHeight() or 0
  for i, c in ipairs(visible) do
    c:ClearAllPoints()
    local offset = (i - 1) * (HEIGHT + 6)
    if cx and cy and sw > 0 and sh > 0 then
      local right, top = cx > sw / 2, cy > sh / 2
      local point = (top and "TOP" or "BOTTOM") .. (right and "RIGHT" or "LEFT")
      local rel = (top and "BOTTOM" or "TOP") .. (right and "RIGHT" or "LEFT")
      c:SetPoint(point, anchor, rel, 0, top and -(8 + offset) or (8 + offset))
    else
      c:SetPoint("TOP", UIParent, "TOP", 0, -(120 + offset))
    end
  end
end

-- entry: the answered message; chatData: its chat.
function Notify:Show(entry, chatData)
  local ok = entry.status == "done"
  -- Reuse a hidden card, or the oldest one.
  local chosen, oldest
  for i = 1, MAX_CARDS do
    local c = card(i)
    if not c:IsShown() then chosen = c break end
    if not oldest or (c.order or 0) < (oldest.order or 0) then oldest = c end
  end
  local c = chosen or oldest
  self.counter = (self.counter or 0) + 1
  c.order = self.counter
  c.chatId = chatData and chatData.id or false
  local p = ns.Personas:Current()
  ns.Personas.SetPortrait(c.icon, p)
  if c.SetBackdropBorderColor then
    if ok then c:SetBackdropBorderColor(1, 0.82, 0.3, 1) else c:SetBackdropBorderColor(0.9, 0.25, 0.2, 1) end
  end
  c.title:SetText((ok and (p.nameColor .. p.notifyOk .. "|r") or ("|cffff6060" .. p.notifyFail .. "|r"))
    .. (chatData and ("  |cff999999" .. preview(chatData.title, 22) .. "|r") or ""))
  c.body:SetText(preview(ok and entry.answer or (entry.answer or L.ERROR), 110))

  c.expires = GetTime() + SHOW_SECONDS
  c.hovered = false
  c:SetAlpha(1)
  c:Show()
  self:Layout()
  self:Chime(ok)
  if ns.Button and ns.Button.Celebrate then ns.Button:Celebrate() end
end

-- The answer sound (unless the player turned it off with /ia sound).
function Notify:Chime(ok)
  if settings().sound and PlaySound and SOUNDKIT then
    PlaySound(ok and (SOUNDKIT.TELL_MESSAGE or 3081) or (SOUNDKIT.IG_PLAYER_INVITE_DECLINE or 3082))
  end
end

function Notify:Dismiss(c)
  c.expires = false
  c:Hide()
  self:Layout()
end

function Notify:HideAll()
  for _, c in ipairs(self.cards or {}) do c.expires = false; c:Hide() end
end

function Notify:ToggleSound()
  local s = settings()
  s.sound = not s.sound
  return s.sound
end

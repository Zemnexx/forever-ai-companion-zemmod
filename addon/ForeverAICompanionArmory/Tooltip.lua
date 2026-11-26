-- A line on item tooltips: the item's score with the build's stat weights,
-- and how it compares with what is worn in its slot. The weights come from the
-- gear plan; the stats are read from the game, so the line works for any item
-- the player hovers (loot, vendors, quest rewards, the auction house) without
-- asking the AI again. Turned off in the Build tab.
local _, ns = ...
local L = ns.L
local Util = ns.Util

local Tooltip = {}
ns.Tooltip = Tooltip

local function wanted(tooltip)
  return tooltip == GameTooltip or tooltip == ItemRefTooltip
end

-- The line for an item link, or nil when there is nothing to say.
function Tooltip.Line(link)
  if not ns.db or not ns.db.ui or not ns.db.ui.tooltip then return nil end
  local weights = ns.Store:Weights()
  if not weights or type(link) ~= "string" then return nil end
  local stats = ns.Items.Stats(link)
  if not stats or not ns.Items.SLOTS_FOR[stats.equipLoc or ""] then return nil end
  local cmp = ns.Items.Compare(link, weights, stats.equipLoc)
  if not cmp then return nil end
  local text = string.format(L.TOOLTIP_SCORE, Util.fmt(cmp.score, 1))
  local r, g, b = 0.6, 0.8, 1
  -- Against what is worn (nothing to add when it is the worn item itself).
  -- An off-hand item while a two-hander is worn: nothing to compare with.
  if cmp.blocked == "twoHand" then
    text = text .. "  " .. L.TOOLTIP_TWO_HAND
  elseif cmp.delta and math.abs(cmp.delta) >= 0.05 then
    text = text .. "  " .. string.format(L.TOOLTIP_DELTA, (cmp.delta > 0 and "+" or "") .. Util.fmt(cmp.delta, 1))
    if cmp.delta > 0 then r, g, b = 0.45, 0.9, 0.55 else r, g, b = 1, 0.62, 0.3 end
  end
  if stats.effects and stats.effects > 0 then
    text = text .. "  " .. (stats.effects == 1 and L.TOOLTIP_EFFECT or string.format(L.TOOLTIP_EFFECTS, stats.effects))
  end
  return text, r, g, b
end

local function onItem(tooltip, link)
  if not wanted(tooltip) then return end
  local ok, text, r, g, b = pcall(Tooltip.Line, link)
  if ok and text then
    tooltip:AddLine(text, r, g, b)
    tooltip:Show()
  end
end

-- Talents in the window ----------------------------------------------------------------
--
-- A talent row of the Talents tab shows the talent's tooltip. The modern
-- trees are drawn from the game's own lines for the rank (C_TooltipInfo),
-- since no method of GameTooltip is known to show a trait entry by itself on
-- Forever's client; without those lines the talent's spell is shown, and the
-- classic trees have the game's own talent tooltip.

local WHITE = { 1, 1, 1 }
-- The game's usual tooltip text (NORMAL_FONT_COLOR), for a description line.
local GOLD = { 1, 0.82, 0 }

local function rankText(fmt, rank, max)
  if type(fmt) == "string" and fmt ~= "" then
    local ok, s = pcall(string.format, fmt, rank, max)
    if ok and s then return s end
  end
  return string.format(L.TALENT_RANK, rank, max)
end

-- The heading over another rank's lines: the game's "Next rank:" when it is
-- simply the next one, else "Rank 3/5:".
local function otherRankHeading(rank, other, max)
  if other == rank + 1 and type(TOOLTIP_TALENT_NEXT_RANK) == "string" and TOOLTIP_TALENT_NEXT_RANK ~= "" then
    return TOOLTIP_TALENT_NEXT_RANK
  end
  return string.format(L.TALENT_RANK_AT, other, max)
end

local function addLines(lines, skip)
  for _, line in ipairs(lines) do
    if not (skip and skip[line.text]) then
      if line.right then
        local lc, rc = line.leftColor or WHITE, line.rightColor or WHITE
        GameTooltip:AddDoubleLine(line.left, line.right, lc[1], lc[2], lc[3], rc[1], rc[2], rc[3])
      else
        local c = line.leftColor or GOLD
        GameTooltip:AddLine(line.left, c[1], c[2], c[3], true)
      end
    end
  end
end

-- The rank worth showing after the current one: the rank the plan takes the
-- talent to on that row when that is higher, else the next one; nil when
-- there is none or it is the rank already shown.
local function otherRank(rank, shown, to, max)
  local other = (to and to > rank) and to or rank + 1
  other = math.min(other, max)
  if other <= shown then return nil end
  return other
end

-- Fills GameTooltip from the game's lines for the talent's ranks. False when
-- the game gives no lines for it.
local function traitTip(how, to)
  local max = how.max or 1
  local rank = ns.Scan.TalentRank(how.nodeID) or how.rank or 0
  -- No point in it yet: rank 1 is described, as the game's talent window does.
  local shown = math.max(rank, 1)
  local lines = ns.Scan.TraitLines(how.entryID, shown, how.name)
  if not lines then return false end
  GameTooltip:SetText(how.name or "", 1, 1, 1)
  GameTooltip:AddLine(rankText(TOOLTIP_TALENT_RANK, rank, max), 1, 1, 1)
  addLines(lines)
  local other = otherRank(rank, shown, to, max)
  local more = other and ns.Scan.TraitLines(how.entryID, other, how.name)
  if more then
    -- Cost, range and cast time repeat; what changes is the description.
    local seen, differ = {}, {}
    for _, line in ipairs(lines) do seen[line.text] = true end
    for _, line in ipairs(more) do
      if not seen[line.text] then differ[#differ + 1] = line end
    end
    if #differ > 0 then
      GameTooltip:AddLine(" ")
      GameTooltip:AddLine(otherRankHeading(rank, other, max), 1, 1, 1)
      addLines(differ)
    end
  end
  return true
end

-- Something the game was asked to show: false when it left the tooltip
-- empty (a spell it does not know). A client without NumLines is trusted.
local function filled(set)
  if not pcall(set) then return false end
  local n = Util.num(Util.safe(GameTooltip.NumLines, GameTooltip))
  return n == nil or n > 0
end

local function showTalent(owner, id, to)
  local how = ns.Scan.shows[id]
  if not how or not GameTooltip then return false end
  GameTooltip:SetOwner(owner, "ANCHOR_RIGHT")
  if how.entryID then
    local ok, done = pcall(traitTip, how, to)
    if ok and done then return true end
    -- Lines added before a failure are not left behind under the spell's.
    pcall(GameTooltip.ClearLines, GameTooltip)
  end
  if how.spellID and GameTooltip.SetSpellByID then
    if filled(function() GameTooltip:SetSpellByID(how.spellID) end) then return true end
  end
  if how.tab and GameTooltip.SetTalent then
    if filled(function() GameTooltip:SetTalent(how.tab, how.index) end) then return true end
  end
  return false
end

-- Shows talent `id`'s tooltip for a row. to: the rank the plan takes it to
-- on that row, or nil. Never throws: whatever fails leaves no tooltip.
function Tooltip.ShowTalent(owner, id, to)
  if not GameTooltip then return false end
  local ok, done = pcall(showTalent, owner, id, to)
  if ok and done then
    pcall(GameTooltip.Show, GameTooltip)
    return true
  end
  pcall(GameTooltip.Hide, GameTooltip)
  return false
end

-- Which way talent tooltips are shown on this client, for /armory debug.
function Tooltip.TalentWay(id)
  local how = ns.Scan.shows[id]
  if not how then return "none (talent not known)" end
  if how.entryID then
    local rank = math.max(how.rank or 0, 1)
    local lines = ns.Scan.TraitLines(how.entryID, rank, how.name)
    if lines then return string.format("trait entry lines (%s at rank %d: %d lines)", tostring(how.name), rank, #lines) end
  end
  local has = GameTooltip and GameTooltip.SetSpellByID
  if how.spellID and has then
    return how.entryID and "spell tooltip (SetSpellByID; the trait entry gave 0 lines)" or "spell tooltip (SetSpellByID)"
  end
  if how.tab and GameTooltip and GameTooltip.SetTalent then return "the game's talent tooltip (SetTalent)" end
  return "none"
end

function Tooltip:Init()
  if self.hooked then return end
  self.hooked = true
  -- Newer clients hand tooltips their data; older ones fire a script.
  if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType and Enum.TooltipDataType.Item then
    pcall(TooltipDataProcessor.AddTooltipPostCall, Enum.TooltipDataType.Item, function(tooltip, data)
      local link
      if tooltip.GetItem then
        local ok, _, l = pcall(tooltip.GetItem, tooltip)
        if ok then link = l end
      end
      if not link and type(data) == "table" and data.id then link = "item:" .. tostring(data.id) end
      onItem(tooltip, link)
    end)
  else
    for _, tooltip in ipairs({ GameTooltip, ItemRefTooltip }) do
      if tooltip and tooltip.HookScript then
        pcall(tooltip.HookScript, tooltip, "OnTooltipSetItem", function(self)
          local ok, _, link = pcall(self.GetItem, self)
          if ok then onItem(self, link) end
        end)
      end
    end
  end
end

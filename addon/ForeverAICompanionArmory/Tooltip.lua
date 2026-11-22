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
  if cmp.delta and math.abs(cmp.delta) >= 0.05 then
    text = text .. "  " .. string.format(L.TOOLTIP_DELTA, (cmp.delta > 0 and "+" or "") .. Util.fmt(cmp.delta, 1))
    if cmp.delta > 0 then r, g, b = 0.45, 0.9, 0.55 else r, g, b = 1, 0.62, 0.3 end
  end
  if stats.effects and stats.effects > 0 then text = text .. "  " .. string.format(L.TOOLTIP_EFFECTS, stats.effects) end
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

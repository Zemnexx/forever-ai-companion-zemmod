-- What each tab shows, as a list of blocks the window lays out top to bottom
-- (UI.lua). Kept apart from the frames so it can be tested without the game:
-- every function here turns stored results and the character's current state
-- into plain tables.
--
-- Blocks:
--   { t = "h", text }                          a heading
--   { t = "p", text, color }                   a paragraph ("muted", "warn", "good" or nil)
--   { t = "note", text }                       a bullet
--   { t = "row", icon, title, right, sub,      an entry with an icon: link = item link (hover and click),
--     link, spell, quality }                   spell = spell id (hover)
--   { t = "bar", label, value, right }         a bar filled to value (0-100)
--   { t = "action", text, id }                 a button; UI.lua knows what each id does
--   { t = "gap" }
local _, ns = ...
local L = ns.L
local Util = ns.Util

local Panels = {}
ns.Panels = Panels

local function add(blocks, block)
  blocks[#blocks + 1] = block
end

local function notes(blocks, list, heading)
  if type(list) ~= "table" or #list == 0 then return end
  if heading then add(blocks, { t = "h", text = heading }) end
  for _, text in ipairs(list) do add(blocks, { t = "note", text = tostring(text) }) end
end

-- "Fury, raids, damage" for the profile a result was made for.
local function profileText(p)
  if type(p) ~= "table" then return "" end
  local parts = {}
  if p.spec and p.spec ~= "" then parts[#parts + 1] = p.spec end
  if p.goal then parts[#parts + 1] = L["GOAL_" .. tostring(p.goal):upper()] end
  if p.role then parts[#parts + 1] = L["ROLE_" .. tostring(p.role):upper()] end
  return table.concat(parts, ", ")
end
Panels.ProfileText = profileText

-- The line under a tab's title: what is being asked, what went wrong, or
-- when the result shown was made and for which build.
function Panels.Status(kind)
  local asking = ns.Store:Asking(kind)
  if asking then
    if asking.state == "preparing" then return L.STATUS_PREPARING, "muted" end
    if asking.state == "sent" then
      local waited, limit = ns.Advisor:Waited(kind)
      local text = string.format(L.STATUS_WAITING, math.floor((waited or 0) / 60), (waited or 0) % 60, math.floor((limit or 0) / 60))
      if asking.trimmed then text = text .. " " .. L.STATUS_TRIMMED end
      return text, "muted"
    end
    if asking.state == "error" then return tostring(asking.message or L.FAILED), "warn" end
  end
  local result = ns.Store:Result(kind)
  if not result then return L["EMPTY_" .. kind:upper()], "muted" end
  local text = string.format(L.STATUS_DONE, Util.ago(result.at, L), profileText(result.data and result.data.asked or result.profile))
  if type(result.tokens) == "table" then
    text = text .. " · " .. string.format(L.TOKENS, Util.fmt(((result.tokens.i or 0) + (result.tokens.o or 0)) / 1000, 1))
  end
  return text, "muted"
end

-- A result made for another build than the one chosen now, or in test mode.
local function caveats(blocks, result)
  local data = result.data
  if data.test then add(blocks, { t = "p", text = L.TEST_MODE, color = "warn" }) end
  local now, was = ns.Store:Profile(), data.asked or result.profile or {}
  if (was.spec and now.spec and was.spec ~= now.spec) or (was.goal and was.goal ~= now.goal) or (was.role and was.role ~= now.role) then
    add(blocks, { t = "p", text = string.format(L.OTHER_BUILD, profileText(was)), color = "warn" })
  end
end

-- Talents ---------------------------------------------------------------------------

local function talentRow(index, id, right, sub)
  local talent = index[id] or {}
  return { t = "row", icon = ns.Scan.icons[id], title = talent.name or ("#" .. tostring(id)), right = right, sub = sub }
end

function Panels.Talents()
  local blocks = {}
  local result = ns.Store:Result("talents")
  if not result or type(result.data) ~= "table" then return blocks end
  local data = result.data
  caveats(blocks, result)
  add(blocks, { t = "h", text = string.format("%s  (%s)", data.name ~= "" and data.name or L.KIND_TALENTS, tostring(data.spec or "?")) })
  if data.summary and data.summary ~= "" then add(blocks, { t = "p", text = data.summary }) end

  -- Where the character stands in the build, from the game right now.
  local ranks, section = ns.Scan.Ranks()
  local index = ns.Build.Index(section)
  local progress = ns.Build.Progress(data.order, ranks)
  local available = section and section.available or 0
  add(blocks, { t = "h", text = L.NEXT_POINTS })
  if #progress.next == 0 then
    add(blocks, { t = "p", text = L.BUILD_COMPLETE, color = "good" })
  else
    add(blocks, { t = "p", text = string.format(L.BUILD_PROGRESS, progress.matched, progress.total)
      .. (available > 0 and (" " .. string.format(L.POINTS_TO_SPEND, available)) or ""), color = available > 0 and "good" or "muted" })
    local classic = not section or section.api ~= "traits"
    for i, step in ipairs(ns.Build.Steps(progress.next, 8)) do
      local talent = index[step.id] or {}
      local right = string.format("%d/%d > %d/%d", step.from, talent.max or step.to, step.to, talent.max or step.to)
      local sub = talent.tree or ""
      if classic then
        local first, last = ns.Build.LevelOf(step.n), ns.Build.LevelOf(step.n + step.count - 1)
        sub = sub .. " · " .. (first == last and string.format(L.AT_LEVEL, first) or string.format(L.AT_LEVELS, first, last))
      end
      local row = talentRow(index, step.id, right, sub)
      -- The points that can be spent right now stand out.
      if i == 1 and available > 0 then row.highlight = true end
      add(blocks, row)
    end
  end

  if #progress.misplaced > 0 then
    add(blocks, { t = "h", text = L.MISPLACED })
    add(blocks, { t = "p", text = L.MISPLACED_HINT, color = "warn" })
    for _, m in ipairs(progress.misplaced) do
      add(blocks, talentRow(index, m.id, string.format(L.POINTS, m.extra)))
    end
  end
  if data.respec then add(blocks, { t = "p", text = data.respec, color = "warn" }) end

  if type(data.keyTalents) == "table" and #data.keyTalents > 0 then
    add(blocks, { t = "h", text = L.KEY_TALENTS })
    for _, k in ipairs(data.keyTalents) do
      local row = talentRow(index, k.id, nil, k.why)
      if not index[k.id] and k.name then row.title = k.name end
      add(blocks, row)
    end
  end
  notes(blocks, data.notes, L.NOTES)

  -- The whole order, one line per run of points in the same talent.
  local lines = {}
  for _, run in ipairs(ns.Build.Runs(data.order)) do
    local talent = index[run.id] or {}
    local levels = run.first == run.last and tostring(ns.Build.LevelOf(run.first))
      or (ns.Build.LevelOf(run.first) .. "-" .. ns.Build.LevelOf(run.last))
    lines[#lines + 1] = string.format("%s  %s %d/%d", levels, talent.name or ("#" .. run.id), run.to, talent.max or run.to)
  end
  if #lines > 0 then
    add(blocks, { t = "h", text = L.FULL_ORDER })
    add(blocks, { t = "p", text = table.concat(lines, "\n"), color = "muted" })
  end
  return blocks
end

-- Gear ------------------------------------------------------------------------------

local function signed(n)
  return (n >= 0 and "+" or "") .. Util.fmt(n, 1)
end

-- "Dungeon: Scarlet Monastery, Herod (15% drop)"
local function sourceText(source)
  if type(source) ~= "table" then return "" end
  local text = L["SOURCE_" .. tostring(source.type or "world"):upper()]
  local where = {}
  if source.where then where[#where + 1] = source.where end
  if source.from then where[#where + 1] = source.from end
  if #where > 0 then text = text .. ": " .. table.concat(where, ", ") end
  if source.note then text = text .. " (" .. source.note .. ")" end
  return text
end

-- A recommended item: a real link and a score when the game confirms its id.
local function pickRow(pick, weights)
  local state, info = ns.Items.Check(pick)
  local row = { t = "row", title = pick.name, pick = pick }
  local sub = { sourceText(pick.source) }
  if pick.level then sub[#sub + 1] = string.format(L.NEEDS_LEVEL, pick.level) end
  if state == "verified" then
    row.link, row.icon, row.quality, row.title = info.link, info.icon, info.quality, info.name
    local cmp = weights and ns.Items.Compare(info.link, weights, info.equipLoc)
    if cmp and cmp.delta then
      row.right = signed(cmp.delta)
      row.rightColor = cmp.delta > 0 and "good" or "warn"
    end
    local api = ns.Advisor.API()
    local price = api and api.AuctionPrice and api.AuctionPrice(pick.itemId)
    local found = ns.Auction and ns.Auction:Found(pick.name)
    if type(price) == "table" and price.unit then
      sub[#sub + 1] = string.format(L.AH_PRICE, Util.money(price.unit) or "?", tostring(price.seenAt or ""))
    elseif found and found.unit then
      sub[#sub + 1] = string.format(L.AH_PRICE, Util.money(found.unit) or "?", Util.ago(found.at, L))
    elseif pick.auction then
      sub[#sub + 1] = L.AH_CHECK
    end
  else
    -- Not confirmed by the game: the name as plain text, and why.
    row.right = L["CONFIDENCE_" .. tostring(pick.confidence or "low"):upper()]
    row.rightColor = "muted"
    if state == "wait" then sub[#sub + 1] = L.ITEM_CHECKING
    elseif state == "mismatch" or state == "unknown" then sub[#sub + 1] = L.ITEM_UNCONFIRMED
    elseif pick.auction then sub[#sub + 1] = L.AH_CHECK end
  end
  if pick.why and pick.why ~= "" then sub[#sub + 1] = pick.why end
  row.sub = table.concat(sub, " · ")
  return row
end

-- Stat weights as "Strength 2.2 · Agility 1.4", heaviest first.
function Panels.WeightsText(weights)
  local keys = {}
  for k in pairs(weights or {}) do keys[#keys + 1] = k end
  table.sort(keys, function(a, b)
    if weights[a] ~= weights[b] then return weights[a] > weights[b] end
    return a < b
  end)
  local parts = {}
  for _, k in ipairs(keys) do
    local label = _G["ITEM_MOD_" .. k .. "_SHORT"] or _G[k] or k:lower():gsub("_", " ")
    parts[#parts + 1] = string.format("%s %s", tostring(label), Util.fmt(weights[k], 2))
  end
  return table.concat(parts, " · ")
end

function Panels.Gear()
  local blocks = {}
  local result = ns.Store:Result("gear")
  if not result or type(result.data) ~= "table" then return blocks end
  local data = result.data
  caveats(blocks, result)
  if data.summary and data.summary ~= "" then add(blocks, { t = "p", text = data.summary }) end
  local weights = ns.Store:Weights()
  if weights then
    add(blocks, { t = "p", text = L.WEIGHTS .. ": " .. Panels.WeightsText(weights) .. (data.weightsNote and ("\n" .. data.weightsNote) or ""), color = "muted" })
  end
  notes(blocks, data.next, L.GO_FOR_FIRST)

  local buyable = 0
  for _, slot in ipairs(data.slots or {}) do
    for _, pick in ipairs(slot.picks or {}) do
      if pick.auction then buyable = buyable + 1 end
    end
  end
  if buyable > 0 then
    local open = ns.Auction and ns.Auction:IsOpen()
    add(blocks, { t = "action", id = "auction", text = open and string.format(L.AH_SEARCH, buyable) or string.format(L.AH_SEARCH_CLOSED, buyable), disabled = not open })
    local status = ns.Auction and ns.Auction:Status()
    if status then add(blocks, { t = "p", text = status, color = "muted" }) end
  end

  for _, slot in ipairs(data.slots or {}) do
    add(blocks, { t = "h", text = L["SLOT_" .. tostring(slot.slot):upper()] })
    local worn = ns.Items.Equipped(slot.slot)
    if worn then
      local score = weights and ns.Items.Score(worn, weights)
      add(blocks, { t = "row", link = worn, title = Util.clean(worn) or "?", sub = L.WEARING, right = score and Util.fmt(score, 1) or nil, rightColor = "muted", dim = true })
    else
      add(blocks, { t = "p", text = L.SLOT_EMPTY, color = "muted" })
    end
    for _, pick in ipairs(slot.picks or {}) do add(blocks, pickRow(pick, weights)) end
  end
  notes(blocks, data.notes, L.NOTES)
  return blocks
end

-- Rotation --------------------------------------------------------------------------

local STAT_LABELS = {
  attackPower = "STAT_ATTACK_POWER", rangedAttackPower = "STAT_RANGED_AP", spellPower = "STAT_SPELL_POWER",
  healingPower = "STAT_HEALING", critPct = "STAT_CRIT", rangedCritPct = "STAT_RANGED_CRIT", spellCritPct = "STAT_SPELL_CRIT",
  hitPct = "STAT_HIT", spellHitPct = "STAT_SPELL_HIT", hastePct = "STAT_HASTE", strength = "STAT_STRENGTH",
  agility = "STAT_AGILITY", intellect = "STAT_INTELLECT", spirit = "STAT_SPIRIT", stamina = "STAT_STAMINA",
}

function Panels.Rotation()
  local blocks = {}
  local result = ns.Store:Result("rotation")
  if not result or type(result.data) ~= "table" then return blocks end
  local data = result.data
  caveats(blocks, result)
  local unit = data.metric == "hps" and L.HPS or L.DPS
  local best = data.rotations and data.rotations[1]
  if data.summary and data.summary ~= "" then add(blocks, { t = "p", text = data.summary }) end
  if best then
    add(blocks, { t = "h", text = string.format("%s: %s %s", best.name, Util.fmt(best.value, 1), unit) })
    for i, step in ipairs(best.steps or {}) do
      local icon = step.spellId and ns.Panels.SpellIcon(step.spellId) or nil
      add(blocks, { t = "row", icon = icon, spell = step.spellId, title = string.format("%d. %s", i, step.spell), sub = step.when })
    end
    if #(best.steps or {}) == 0 then add(blocks, { t = "p", text = L.AUTO_ONLY, color = "muted" }) end
    local facts = {}
    if best.idle and best.idle >= 1 then facts[#facts + 1] = string.format(L.IDLE, Util.fmt(best.idle, 0)) end
    if best.starved and best.starved >= 1 then facts[#facts + 1] = string.format(L.STARVED, Util.fmt(best.starved, 0)) end
    if best.emptyAt then facts[#facts + 1] = string.format(L.EMPTY_AT, Util.fmt(best.emptyAt, 0)) end
    if #facts > 0 then add(blocks, { t = "p", text = table.concat(facts, " · "), color = "muted" }) end
  end

  if data.rotations and #data.rotations > 1 then
    add(blocks, { t = "h", text = L.COMPARED })
    local top = best.value > 0 and best.value or 1
    for _, r in ipairs(data.rotations) do
      add(blocks, { t = "bar", label = r.name, value = r.value / top * 100, right = string.format("%s %s", Util.fmt(r.value, 1), unit) })
    end
  end

  if best and type(best.breakdown) == "table" and #best.breakdown > 0 then
    add(blocks, { t = "h", text = data.metric == "hps" and L.BREAKDOWN_HEALING or L.BREAKDOWN_DAMAGE })
    for _, b in ipairs(best.breakdown) do
      add(blocks, { t = "bar", label = b.name, value = b.share, right = Util.fmt(b.share, 1) .. "%" })
    end
  end

  local w = data.weights
  if type(w) == "table" and type(w.perPoint) == "table" and next(w.perPoint) then
    add(blocks, { t = "h", text = L.STAT_WEIGHTS })
    local stats = {}
    for stat in pairs(w.perPoint) do stats[#stats + 1] = stat end
    table.sort(stats, function(a, b)
      if w.perPoint[a] ~= w.perPoint[b] then return w.perPoint[a] > w.perPoint[b] end
      return a < b
    end)
    local function statName(stat)
      local key = STAT_LABELS[stat]
      return key and L[key] or tostring(stat)
    end
    local reference = statName(w.reference)
    for _, stat in ipairs(stats) do
      local label = statName(stat)
      local pct = stat:sub(-3) == "Pct"
      local line = string.format(pct and L.WEIGHT_PCT or L.WEIGHT_POINT, label, Util.fmt(w.perPoint[stat], 2), unit)
      if w.normalized and w.normalized[stat] and stat ~= w.reference then
        line = line .. "  " .. string.format(L.WEIGHT_EQUALS, Util.fmt(w.normalized[stat], 2), reference)
      end
      add(blocks, { t = "note", text = line })
    end
    add(blocks, { t = "p", text = L.WEIGHTS_HINT, color = "muted" })
  end

  if type(data.table) == "table" and #data.table > 0 then
    add(blocks, { t = "h", text = L.ABILITY_TABLE })
    for _, row in ipairs(data.table) do
      local parts = { string.format(L.PER_USE, Util.fmt(row.perUse, 0)), string.format(L.PER_SECOND, Util.fmt(row.perSecond, 1)) }
      if row.perResource then parts[#parts + 1] = string.format(L.PER_RESOURCE, Util.fmt(row.perResource, 2)) end
      add(blocks, { t = "note", text = row.name .. ": " .. table.concat(parts, " · ") })
    end
  end

  local f = data.fight
  if type(f) == "table" then
    add(blocks, { t = "p", text = string.format(L.FIGHT, tostring(f.duration or "?"), tostring(f.targetLevel or "?"), tostring(f.targetArmor or 0), tostring(f.targets or 1)), color = "muted" })
  end
  if data.modelIssues then add(blocks, { t = "p", text = string.format(L.MODEL_ISSUES, data.modelIssues), color = "warn" }) end
  notes(blocks, data.assumptions, L.ASSUMPTIONS)
  notes(blocks, data.notes, L.NOTES)
  return blocks
end

function Panels.SpellIcon(spellId)
  local get = (C_Spell and C_Spell.GetSpellTexture) or GetSpellTexture
  return Util.safe(get, spellId)
end

-- Interactions ("the lab") ----------------------------------------------------------

function Panels.Discover()
  local blocks = {}
  local result = ns.Store:Result("discover")
  if not result or type(result.data) ~= "table" then return blocks end
  local data = result.data
  caveats(blocks, result)
  if data.summary and data.summary ~= "" then add(blocks, { t = "p", text = data.summary }) end
  if not data.baseline and not data.test then add(blocks, { t = "p", text = L.NO_BASELINE, color = "muted" }) end
  for i, idea in ipairs(data.ideas or {}) do
    local title = string.format("%d. %s", i, idea.title)
    add(blocks, { t = "h", text = title })
    local tags = { L["CONFIDENCE_" .. tostring(idea.confidence or "low"):upper()] }
    local color = "muted"
    if type(idea.measured) == "table" then
      tags[#tags + 1] = string.format(L.MEASURED, signed(idea.measured.pct or 0), Util.fmt(idea.measured.base, 1), Util.fmt(idea.measured.value, 1))
      color = (idea.measured.pct or 0) > 0 and "good" or "warn"
    end
    add(blocks, { t = "p", text = table.concat(tags, " · "), color = color })
    add(blocks, { t = "p", text = idea.mechanism })
    local needs = {}
    for _, key in ipairs({ "talents", "items", "spells" }) do
      for _, name in ipairs(type(idea.needs) == "table" and idea.needs[key] or {}) do needs[#needs + 1] = name end
    end
    if #needs > 0 then add(blocks, { t = "note", text = L.NEEDS .. ": " .. table.concat(needs, ", ") }) end
    if idea.gain and idea.gain ~= "" then add(blocks, { t = "note", text = L.GAIN .. ": " .. idea.gain }) end
    if idea.test and idea.test ~= "" then add(blocks, { t = "note", text = L.HOW_TO_TEST .. ": " .. idea.test }) end
    if idea.risks and idea.risks ~= "" then add(blocks, { t = "note", text = L.RISKS .. ": " .. idea.risks }) end
  end
  if #(data.ideas or {}) == 0 then add(blocks, { t = "p", text = L.NO_IDEAS, color = "muted" }) end
  return blocks
end

Panels.BY_KIND = { talents = Panels.Talents, gear = Panels.Gear, rotation = Panels.Rotation, discover = Panels.Discover }

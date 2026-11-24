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
--     link, spell, quality,                    spell = spell id (hover), talent = talent id (hover;
--     talent, talentTo, compact }              talentTo = the rank planned there), compact = one tight line
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
    -- Most of a long analysis is the AI reading again what it already read, which counts for far less.
    local cached = result.tokens.c or 0
    if cached >= 1000 then text = text .. " " .. string.format(L.TOKENS_CACHED, Util.fmt(cached / 1000, 1)) end
  end
  return text, "muted"
end

-- Levels a character may gain before a result is said to be out of date.
local STALE_LEVELS = 2
-- The tabs whose numbers depend on the weapon in hand.
local BY_WEAPON = { rotation = true, gear = true }

-- Why a result no longer fits the character, one line per reason: levels
-- gained since it was made, or another main-hand weapon (rotation and gear).
local function stale(blocks, result, kind)
  local data = result.data
  if data.test then return end
  local asked = type(data.asked) == "table" and tonumber(data.asked.level)
  local level = Util.num(Util.safe(UnitLevel, "player"))
  if asked and level and level - asked >= STALE_LEVELS then
    add(blocks, { t = "p", text = string.format(L.STALE_LEVEL, asked, level), color = "warn" })
  end
  -- Results saved before the weapon was remembered say nothing about it.
  if BY_WEAPON[kind] and result.weapon ~= nil and (ns.Items.EquippedId("mainHand") or 0) ~= result.weapon then
    add(blocks, { t = "p", text = L.STALE_WEAPON, color = "warn" })
  end
end

-- A result made for another build than the one chosen now, or in test mode,
-- or one the character has outgrown.
local function caveats(blocks, result, kind)
  local data = result.data
  if data.test then add(blocks, { t = "p", text = L.TEST_MODE, color = "warn" }) end
  stale(blocks, result, kind)
  local now, was = ns.Store:Profile(), data.asked or result.profile or {}
  if (was.spec and now.spec and was.spec ~= now.spec) or (was.goal and was.goal ~= now.goal) or (was.role and was.role ~= now.role) then
    add(blocks, { t = "p", text = string.format(L.OTHER_BUILD, profileText(was)), color = "warn" })
  end
end

-- Talents ---------------------------------------------------------------------------

-- A talent's row. Hovering it shows the talent's tooltip (Tooltip.lua) when
-- the game has that talent; to: the rank the plan takes it to there.
local function talentRow(index, id, right, sub, to)
  local talent = index[id]
  return { t = "row", icon = ns.Scan.icons[id], title = talent and talent.name or ("#" .. tostring(id)), right = right, sub = sub,
    talent = talent and id or nil, talentTo = talent and to or nil }
end

-- How many points the build puts in talent `id` in all.
local function plannedRank(order, id)
  local n = 0
  for _, v in ipairs(order or {}) do
    if v == id then n = n + 1 end
  end
  return n > 0 and n or nil
end

function Panels.Talents()
  local blocks = {}
  local result = ns.Store:Result("talents")
  if not result or type(result.data) ~= "table" then return blocks end
  local data = result.data
  caveats(blocks, result, "talents")
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
      local row = talentRow(index, step.id, right, sub, step.to)
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
      local row = talentRow(index, k.id, nil, k.why, plannedRank(data.order, k.id))
      if not index[k.id] and k.name then row.title = k.name end
      add(blocks, row)
    end
  end
  notes(blocks, data.notes, L.NOTES)

  -- The whole order, one compact row per run of points in the same talent,
  -- so every talent of the build can be hovered for its tooltip.
  local runs = ns.Build.Runs(data.order)
  if #runs > 0 then add(blocks, { t = "h", text = L.FULL_ORDER }) end
  for _, run in ipairs(runs) do
    local talent = index[run.id] or {}
    local levels = run.first == run.last and tostring(ns.Build.LevelOf(run.first))
      or (ns.Build.LevelOf(run.first) .. "-" .. ns.Build.LevelOf(run.last))
    local row = talentRow(index, run.id, nil, nil, run.to)
    row.icon, row.compact, row.dim = nil, true, true
    row.title = string.format("%s  %s %d/%d", levels, talent.name or ("#" .. run.id), run.to, talent.max or run.to)
    add(blocks, row)
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
    -- Not confirmed by the game: the name as plain text, and why. Without
    -- the item there is no tooltip of the game's to show; the row says so.
    row.right = L["CONFIDENCE_" .. tostring(pick.confidence or "low"):upper()]
    row.rightColor = "muted"
    if state == "wait" then sub[#sub + 1] = L.ITEM_CHECKING
    elseif state == "mismatch" or state == "unknown" then
      sub[#sub + 1] = L.ITEM_UNCONFIRMED
      row.hint = L.ITEM_WRONG_ID
    else
      row.hint = L.ITEM_NO_ID
      if pick.auction then sub[#sub + 1] = L.AH_CHECK end
    end
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
    local label = _G["ITEM_MOD_" .. k .. "_SHORT"] or _G[k] or (k:sub(1, 1) .. k:sub(2):lower():gsub("_", " "))
    parts[#parts + 1] = string.format("%s %s", tostring(label), Util.fmt(weights[k], 2))
  end
  return table.concat(parts, " · ")
end

local function sourceSet(list)
  local set = {}
  for _, source in ipairs(type(list) == "table" and list or {}) do set[source] = true end
  return set
end

-- "Dungeons, Questing": the sources a plan was made for, given what it left out.
local function sourcesText(without)
  local names = {}
  for _, source in ipairs(ns.Store.GEAR_SOURCES) do
    if not without[source] then names[#names + 1] = L["GEAR_FROM_" .. source:upper()] end
  end
  return table.concat(names, ", ")
end

function Panels.Gear()
  local blocks = {}
  local result = ns.Store:Result("gear")
  if not result or type(result.data) ~= "table" then return blocks end
  local data = result.data
  caveats(blocks, result, "gear")
  -- Dungeons, raids or questing left out since this plan was made: its picks
  -- from there are hidden at once; the rest of it is still the old plan.
  local without = sourceSet(ns.Store:GearWithout())
  local was = sourceSet(data.asked and data.asked.without)
  for _, source in ipairs(ns.Store.GEAR_SOURCES) do
    if (without[source] or false) ~= (was[source] or false) then
      add(blocks, { t = "p", text = string.format(L.OTHER_SOURCES, sourcesText(was)), color = "warn" })
      break
    end
  end
  local function wanted(pick)
    return not (type(pick.source) == "table" and without[pick.source.type])
  end
  if data.summary and data.summary ~= "" then add(blocks, { t = "p", text = data.summary }) end
  local weights = ns.Store:Weights()
  if weights then
    add(blocks, { t = "p", text = L.WEIGHTS .. ": " .. Panels.WeightsText(weights) .. (data.weightsNote and ("\n" .. data.weightsNote) or ""), color = "muted" })
  end
  notes(blocks, data.next, L.GO_FOR_FIRST)

  local buyable = 0
  for _, slot in ipairs(data.slots or {}) do
    for _, pick in ipairs(slot.picks or {}) do
      if pick.auction and wanted(pick) then buyable = buyable + 1 end
    end
  end
  if buyable > 0 then
    local open = ns.Auction and ns.Auction:IsOpen()
    local label = (open and "AH_SEARCH" or "AH_SEARCH_CLOSED") .. (buyable == 1 and "_ONE" or "")
    add(blocks, { t = "action", id = "auction", text = string.format(L[label], buyable), disabled = not open })
    local status = ns.Auction and ns.Auction:Status()
    if status then add(blocks, { t = "p", text = status, color = "muted" }) end
  end

  for _, slot in ipairs(data.slots or {}) do
    local picks = {}
    for _, pick in ipairs(slot.picks or {}) do
      if wanted(pick) then picks[#picks + 1] = pick end
    end
    -- A slot whose every pick came from what is left out now has nothing to show.
    if #picks > 0 then
      add(blocks, { t = "h", text = L["SLOT_" .. tostring(slot.slot):upper()] })
      local worn = ns.Items.Equipped(slot.slot)
      if worn then
        local score = weights and ns.Items.Score(worn, weights)
        add(blocks, { t = "row", link = worn, title = Util.clean(worn) or "?", sub = L.WEARING, right = score and Util.fmt(score, 1) or nil, rightColor = "muted", dim = true })
      else
        add(blocks, { t = "p", text = L.SLOT_EMPTY, color = "muted" })
      end
      for _, pick in ipairs(picks) do add(blocks, pickRow(pick, weights)) end
    end
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

-- Survival (tanks) -------------------------------------------------------------------

-- The defensive stats whose worth is measured, in the app's order, and the
-- inputs the game may not have given.
local DEFENSE_STATS = {
  armor = L.STAT_ARMOR, dodgePct = L.STAT_DODGE, parryPct = L.STAT_PARRY, blockPct = L.STAT_BLOCK,
  blockValue = L.STAT_BLOCK_VALUE, stamina = L.STAT_STAMINA,
}
local MISSING = {
  armor = L.MISSING_ARMOR, dodgePct = L.MISSING_DODGE, parryPct = L.MISSING_PARRY, blockPct = L.MISSING_BLOCK,
  blockValue = L.MISSING_BLOCK_VALUE, defense = L.MISSING_DEFENSE, maxHealth = L.MISSING_HEALTH,
}

-- "+1% Dodge" or "+100 Armor".
local function defenseAmount(w)
  local label = DEFENSE_STATS[w.stat] or tostring(w.stat)
  local pct = tostring(w.stat):sub(-3) == "Pct"
  return string.format(pct and "+%s%% %s" or "+%s %s", Util.fmt(w.amount, 0), label)
end

-- What a tank can expect to take from the enemy the AI assumed, worked out
-- by the app from the game's defensive numbers. Always marked an estimate.
local function survival(blocks, sv)
  add(blocks, { t = "h", text = L.SURVIVAL })
  local missing = {}
  for _, key in ipairs(type(sv.missing) == "table" and sv.missing or {}) do
    if key == "enemy" then
      add(blocks, { t = "p", text = L.SURVIVAL_NO_ENEMY, color = "warn" })
      return
    end
    missing[#missing + 1] = MISSING[key] or tostring(key)
  end
  if not sv.taken then return end
  local e = type(sv.enemy) == "table" and sv.enemy or {}
  local enemy = string.format(L.SURVIVAL_ENEMY, tostring(e.level or "?"), Util.fmt(e.meleeHit, 0), Util.fmt(e.attackSpeed, 1))
  if e.magicDps then enemy = enemy .. " " .. string.format(L.SURVIVAL_MAGIC, Util.fmt(e.magicDps, 1)) end
  add(blocks, { t = "p", text = enemy, color = "muted" })
  add(blocks, { t = "p", text = string.format(L.SURVIVAL_TAKEN, Util.fmt(sv.taken, 0), Util.fmt(sv.incoming, 0), Util.fmt(sv.mitigated, 0)) })
  add(blocks, { t = "note", text = string.format(L.SURVIVAL_ARMOR, Util.fmt(sv.armor, 1), Util.fmt(sv.armorReduction, 1)) })
  add(blocks, { t = "note", text = string.format(L.SURVIVAL_AVOIDED, Util.fmt(sv.avoided, 1)) })
  if (sv.blocked or 0) > 0 then add(blocks, { t = "note", text = string.format(L.SURVIVAL_BLOCKED, Util.fmt(sv.blocked, 1)) }) end
  local tb = sv.table
  if type(tb) == "table" then
    add(blocks, { t = "p", color = "muted", text = string.format(L.SURVIVAL_TABLE, Util.fmt(tb.miss, 1), Util.fmt(tb.dodge, 1),
      Util.fmt(tb.parry, 1), Util.fmt(tb.block, 1), Util.fmt(tb.crit, 1), Util.fmt(tb.crush, 1)) })
  end
  if sv.effectiveHealth then add(blocks, { t = "p", text = string.format(L.SURVIVAL_HEALTH, Util.fmt(sv.effectiveHealth, 0), Util.fmt(sv.health, 0)) }) end
  if sv.timeToDie then add(blocks, { t = "p", text = string.format(L.SURVIVAL_TIME, Util.fmt(sv.timeToDie, 1)) }) end
  if #missing > 0 then add(blocks, { t = "p", text = string.format(L.SURVIVAL_MISSING, table.concat(missing, ", ")), color = "warn" }) end
  if type(sv.worth) == "table" and #sv.worth > 0 then
    add(blocks, { t = "h", text = L.DEFENSE_WORTH })
    for _, w in ipairs(sv.worth) do
      local taken, time = tonumber(w.taken) or 0, tonumber(w.time)
      local line
      if taken > 0 and time then line = string.format(L.DEFENSE_WORTH_BOTH, defenseAmount(w), Util.fmt(taken, 2), Util.fmt(time, 2))
      elseif time then line = string.format(L.DEFENSE_WORTH_TIME, defenseAmount(w), Util.fmt(time, 2))
      else line = string.format(L.DEFENSE_WORTH_TAKEN, defenseAmount(w), Util.fmt(taken, 2)) end
      add(blocks, { t = "note", text = line })
    end
  end
  add(blocks, { t = "p", text = L.SURVIVAL_HINT, color = "muted" })
end

-- Calibration --------------------------------------------------------------------

local CAL_STATS = { attackPower = L.CAL_AP, rangedAttackPower = L.CAL_RAP, spellPower = L.CAL_SP, healingPower = L.CAL_HP }
-- Abilities named in one line before "and 4 more".
local CAL_NAMES = 6
-- Measured abilities listed one per line.
local CAL_LINES = 12

local function statText(stat, school)
  if stat == "spellPower" and school then
    return string.format(L.CAL_SCHOOL_SP, school:sub(1, 1):upper() .. school:sub(2))
  end
  return CAL_STATS[stat] or tostring(stat)
end

-- "Holy damage", "healing over time", or nothing for a number of another kind.
local function effectNoun(effect)
  local noun
  if effect.k == "damage" then noun = effect.w and string.format(L.CAL_SCHOOL_DAMAGE, effect.w) or L.CAL_DAMAGE
  elseif effect.k == "heal" then noun = L.CAL_HEALING
  elseif effect.k == "absorb" then noun = L.CAL_ABSORB end
  if noun and effect.dot then noun = string.format(L.CAL_OVER_TIME, noun) end
  return noun
end

local function perText(value, noun, stat)
  local v = Util.fmt(value, 2)
  return noun and string.format(L.CAL_PER, v, noun, stat) or string.format(L.CAL_PER_PLAIN, v, stat)
end

-- What one measured effect says, in a few words.
local function effectText(effect)
  local f = effect.fit
  if f.s == "scales" then
    local stats = {}
    for stat in pairs(f.per) do stats[#stats + 1] = stat end
    table.sort(stats)
    local parts = {}
    for i, stat in ipairs(stats) do
      parts[#parts + 1] = perText(f.per[stat], i == 1 and effectNoun(effect) or nil, statText(stat, stat == "spellPower" and f.school or nil))
    end
    return table.concat(parts, L.CAL_AND)
  elseif f.s == "flat" then
    local names = {}
    for _, t in ipairs(f.tested) do names[#names + 1] = statText(t.stat, t.school) end
    return string.format(L.CAL_FLAT, table.concat(names, L.CAL_OR))
  end
  local names, top = {}, 0
  for _, c in ipairs(f.candidates) do
    names[#names + 1] = statText(c.stat, c.school)
    if c.per > top then top = c.per end
  end
  return string.format(L.CAL_AMBIGUOUS, Util.fmt(top, 2), table.concat(names, L.CAL_OR))
end

-- "A, B, C and 4 more".
local function nameList(names)
  if #names <= CAL_NAMES then return table.concat(names, ", ") end
  local shown = {}
  for i = 1, CAL_NAMES do shown[i] = names[i] end
  return string.format(L.CAL_MORE, table.concat(shown, ", "), #names - CAL_NAMES)
end

-- One line per measured ability: "Judgement: +0.43 Holy damage per point of
-- spell power (5 readings)". The others are named together.
function Panels.Calibration()
  local blocks = {}
  local ok, report = pcall(ns.Calibrate.Report)
  report = ok and report or {}
  local lines, notYet, unclear = {}, {}, {}
  for _, item in ipairs(report) do
    local parts, seen, readings, old = {}, {}, 0, nil
    for _, effect in ipairs(item.effects) do
      if ns.Calibrate.IsMeasured(effect) then
        local text = effectText(effect)
        if not seen[text] then
          seen[text] = true
          parts[#parts + 1] = text
        end
        readings = math.max(readings, effect.fit.n or 0)
        old = old or effect.old
      end
    end
    if #parts > 0 then
      local line = item.name .. ": " .. table.concat(parts, "; ") .. " " .. string.format(L.CAL_READINGS, readings)
      if old then line = line .. " " .. string.format(L.CAL_OLD, old) end
      lines[#lines + 1] = line
    else
      local moved = false
      for _, effect in ipairs(item.effects) do
        if effect.fit.s == "unclear" then moved = true end
      end
      if moved then unclear[#unclear + 1] = item.name else notYet[#notYet + 1] = item.name end
    end
  end
  add(blocks, { t = "h", text = L.CAL_HEADING })
  if #lines == 0 then
    add(blocks, { t = "p", text = L.CAL_NOTHING, color = "muted" })
    return blocks
  end
  for i = 1, math.min(#lines, CAL_LINES) do add(blocks, { t = "note", text = lines[i] }) end
  -- Lines past the limit are named with the ones still waiting.
  for i = CAL_LINES + 1, #lines do notYet[#notYet + 1] = lines[i]:match("^(.-):") end
  if #unclear > 0 then add(blocks, { t = "p", text = string.format(L.CAL_UNCLEAR, nameList(unclear)), color = "muted" }) end
  if #notYet > 0 then add(blocks, { t = "p", text = string.format(L.CAL_NOT_YET, nameList(notYet)), color = "muted" }) end
  local cal = ns.Calibrate.Data()
  add(blocks, { t = "p", text = string.format(L.CAL_HINT, cal and #cal.readings or 0), color = "muted" })
  return blocks
end

-- Whether measurements came in that the rotation shown did not have: one
-- that was not sent then, or that has moved by more than its noise since.
function Panels.ScalingStale(data)
  if type(data) ~= "table" or data.test then return false end
  local ok, now = pcall(ns.Calibrate.Measured)
  if not ok then return false end
  local sent = type(data.scaling) == "table" and type(data.scaling.entries) == "table" and data.scaling.entries or {}
  for _, m in ipairs(now) do
    local found = false
    for _, e in ipairs(sent) do
      local measured = tonumber(e.measured)
      if e.name == m.name and e.kind == m.kind and e.stat == m.stat and measured
        and math.abs(measured - m.perPoint) <= math.max(0.02, 0.15 * math.abs(m.perPoint)) then
        found = true
        break
      end
    end
    if not found then return true end
  end
  return false
end

-- Which abilities of the rotation shown were checked against a measurement
-- by the app, and where the AI's model said something else.
local function scalingUsed(blocks, scaling)
  if type(scaling) ~= "table" or type(scaling.entries) ~= "table" or #scaling.entries == 0 then return end
  local used, seen, differs = {}, {}, {}
  for _, e in ipairs(scaling.entries) do
    if e.model ~= nil and type(e.name) == "string" then
      if e.agrees and not seen[e.name] then
        seen[e.name] = true
        used[#used + 1] = e.name
      elseif e.agrees == false then
        differs[#differs + 1] = string.format(L.CAL_DIFFERS, e.name, Util.fmt(tonumber(e.model) or 0, 2), statText(e.stat), Util.fmt(tonumber(e.measured) or 0, 2))
      end
    end
  end
  if #used > 0 then add(blocks, { t = "p", text = string.format(L.CAL_USED, nameList(used)), color = "good" }) end
  for _, line in ipairs(differs) do add(blocks, { t = "note", text = line }) end
  if #used == 0 and #differs == 0 then add(blocks, { t = "p", text = L.CAL_NONE_USED, color = "muted" }) end
end

local function calibration(blocks, data)
  for _, b in ipairs(Panels.Calibration()) do add(blocks, b) end
  if data then scalingUsed(blocks, data.scaling) end
end

function Panels.Rotation()
  local blocks = {}
  local result = ns.Store:Result("rotation")
  -- Without a rotation yet, what calibration measured so far.
  if not result or type(result.data) ~= "table" then
    calibration(blocks)
    return blocks
  end
  local data = result.data
  caveats(blocks, result, "rotation")
  if Panels.ScalingStale(data) then add(blocks, { t = "p", text = L.STALE_SCALING, color = "warn" }) end
  -- Ticked or unticked since: this rotation is for the other kind of fight.
  local aoe = type(data.asked) == "table" and data.asked.aoe == true
  if aoe ~= ns.Store:Aoe() then
    add(blocks, { t = "p", text = aoe and L.OTHER_AOE_MANY or L.OTHER_AOE_ONE, color = "warn" })
  end
  local unit = data.metric == "hps" and L.HPS or (data.metric == "tps" and L.TPS or L.DPS)
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
    -- A tank's rotation is ranked by threat; its damage is a fact about it.
    if best.damage then facts[#facts + 1] = string.format(L.TANK_DAMAGE, Util.fmt(best.damage, 1)) end
    if best.idle and best.idle >= 1 then facts[#facts + 1] = string.format(L.IDLE, Util.fmt(best.idle, 0)) end
    if best.starved and best.starved >= 1 then facts[#facts + 1] = string.format(L.STARVED, Util.fmt(best.starved, 0)) end
    if best.emptyAt then facts[#facts + 1] = string.format(L.EMPTY_AT, Util.fmt(best.emptyAt, 0)) end
    if #facts > 0 then add(blocks, { t = "p", text = table.concat(facts, " · "), color = "muted" }) end
  end

  -- What to have on before the fight, and whether it is on right now.
  if type(data.buffs) == "table" and #data.buffs > 0 then
    add(blocks, { t = "h", text = L.BUFFS })
    for _, buff in ipairs(data.buffs) do
      local sub = {}
      if buff.why and buff.why ~= "" then sub[#sub + 1] = buff.why end
      if not buff.counted then sub[#sub + 1] = L.BUFF_NOT_COUNTED end
      local on = Panels.BuffOn(buff.spellId, buff.name)
      add(blocks, {
        t = "row", icon = buff.spellId and Panels.SpellIcon(buff.spellId) or nil, spell = buff.spellId, title = buff.name,
        sub = table.concat(sub, " · "), right = on == true and L.BUFF_ON or (on == false and L.BUFF_OFF or nil),
        rightColor = on and "good" or "warn",
      })
    end
  end

  if data.rotations and #data.rotations > 1 then
    add(blocks, { t = "h", text = L.COMPARED })
    local top = best.value > 0 and best.value or 1
    for _, r in ipairs(data.rotations) do
      add(blocks, { t = "bar", label = r.name, value = r.value / top * 100, right = string.format("%s %s", Util.fmt(r.value, 1), unit) })
    end
  end

  if best and type(best.breakdown) == "table" and #best.breakdown > 0 then
    local heading = data.metric == "hps" and L.BREAKDOWN_HEALING or (data.metric == "tps" and L.BREAKDOWN_THREAT or L.BREAKDOWN_DAMAGE)
    add(blocks, { t = "h", text = heading })
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

  if type(data.survival) == "table" then survival(blocks, data.survival) end

  if type(data.table) == "table" and #data.table > 0 then
    add(blocks, { t = "h", text = data.metric == "tps" and L.ABILITY_TABLE_THREAT or L.ABILITY_TABLE })
    for _, row in ipairs(data.table) do
      local parts = { string.format(L.PER_USE, Util.fmt(row.perUse, 0)), string.format(L.PER_SECOND, Util.fmt(row.perSecond, 1)) }
      if row.perResource then parts[#parts + 1] = string.format(L.PER_RESOURCE, Util.fmt(row.perResource, 2)) end
      add(blocks, { t = "note", text = row.name .. ": " .. table.concat(parts, " · ") })
    end
  end

  local f = data.fight
  if type(f) == "table" then
    local targets = tonumber(f.targets) or 1
    local line = targets > 1
      and string.format(L.FIGHT_MANY, tostring(f.duration or "?"), tostring(targets), tostring(f.targetLevel or "?"), tostring(f.targetArmor or 0))
      or string.format(L.FIGHT, tostring(f.duration or "?"), tostring(f.targetLevel or "?"), tostring(f.targetArmor or 0))
    add(blocks, { t = "p", text = line, color = "muted" })
  end
  if data.modelIssues then add(blocks, { t = "p", text = string.format(L.MODEL_ISSUES, data.modelIssues), color = "warn" }) end
  notes(blocks, data.assumptions, L.ASSUMPTIONS)
  notes(blocks, data.notes, L.NOTES)
  calibration(blocks, data)
  return blocks
end

-- Whether the player has a buff on right now, by its name (a buff's id
-- changes with its rank): true, false, or nil on a client that cannot tell.
function Panels.BuffOn(spellId, name)
  local could = false
  local auras = type(C_UnitAuras) == "table" and C_UnitAuras or {}
  if auras.GetAuraDataBySpellName and name then
    local ok, aura = pcall(auras.GetAuraDataBySpellName, "player", name, "HELPFUL")
    if ok then
      could = true
      if aura then return true end
    end
  end
  if auras.GetPlayerAuraBySpellID and spellId then
    local ok, aura = pcall(auras.GetPlayerAuraBySpellID, spellId)
    if ok then
      could = true
      if aura then return true end
    end
  end
  if not could and AuraUtil and AuraUtil.FindAuraByName and name then
    local ok, found = pcall(AuraUtil.FindAuraByName, name, "player", "HELPFUL")
    if ok then
      could = true
      if found then return true end
    end
  end
  if could then return false end
  return nil
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
  caveats(blocks, result, "discover")
  if data.summary and data.summary ~= "" then add(blocks, { t = "p", text = data.summary }) end
  if not data.baseline and not data.test then add(blocks, { t = "p", text = L.NO_BASELINE, color = "muted" }) end
  -- The simulator takes an idea as the AI described it: say so once, where any idea has a figure.
  for _, idea in ipairs(data.ideas or {}) do
    if type(idea.measured) == "table" then
      add(blocks, { t = "p", text = L.MEASURED_HINT, color = "muted" })
      break
    end
  end
  for i, idea in ipairs(data.ideas or {}) do
    local title = string.format("%d. %s", i, idea.title)
    add(blocks, { t = "h", text = title })
    local tags = { L["IDEA_CONFIDENCE_" .. tostring(idea.confidence or "low"):upper()] }
    local color = "muted"
    if type(idea.measured) == "table" then
      local m = idea.measured
      local unit = m.metric == "hps" and L.HPS or (m.metric == "tps" and L.TPS or L.DPS)
      tags[#tags + 1] = string.format(L.MEASURED, signed(m.pct or 0), Util.fmt(m.base, 1), Util.fmt(m.value, 1), unit)
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

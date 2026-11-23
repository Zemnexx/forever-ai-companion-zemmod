-- Calibration: how each ability scales, measured from the character's own
-- tooltips. The game shows an ability's numbers already scaled by the
-- character's attack or spell power, but not by how much. Each time those
-- stats change (other gear, a level, a buff on or off), the addon takes a
-- reading: the stats and the effect numbers of every ability's tooltip at
-- that moment. With a few readings in which a stat moved, a straight line
-- through them (Fit.lua) says how many points of damage or healing one point
-- of the stat adds. The rotation analysis sends those measurements, and the
-- app tells the AI to use them in place of its own guesses.
--
-- Readings are compared only within one group: the same spell and rank, the
-- same character level, the same talents and the same wording of the tooltip
-- (so the n-th number always means the same thing). Everything is kept per
-- character in the saved data, bounded.
local _, ns = ...
local Util = ns.Util
local num, safe = Util.num, Util.safe

local Calibrate = {}
ns.Calibrate = Calibrate

-- Seconds without a new event before a reading: equipping a set of items or
-- a buff that changes several stats is one burst of events, and tooltips
-- catch up with the stats a moment after.
local QUIET = 2
-- At login the game hands over items and auras for a while.
local QUIET_LOGIN = 10
-- Seconds between two readings at least.
local MIN_GAP = 20
-- Readings kept per character, and abilities followed. The game writes saved
-- data verbosely (a line per value), so these keep the worst case to tens of
-- kilobytes; 8 readings chosen to keep their spread are plenty for a line.
local MAX_READINGS = 8
local MAX_SPELLS = 30
-- Effect numbers followed per ability.
local MAX_EFFECTS = 4
-- What the rotation analysis gets: measured effects, and the length of a label.
local MAX_SENT = 20
local MAX_LABEL = 40

local SCHOOLS = { "holy", "fire", "nature", "frost", "shadow", "arcane" }
local SCHOOL_WORDS = { holy = true, fire = true, nature = true, frost = true, shadow = true, arcane = true, physical = true }

-- Reading a tooltip's numbers ------------------------------------------------------

-- Parts of the lines above the description: cost, range, cast time,
-- cooldown. A line made only of these is not part of what the ability does.
local HEADER = {
  "enemy:", "friendly:", "[%d%.,]+ mana", "[%d%.,]+ rage", "[%d%.,]+ energy", "[%d%.,]+ focus", "[%d%.]+%% of base mana",
  "[%d%.]+ yd range", "[%d%.]+%-[%d%.]+ yd range", "melee range", "unlimited range", "instant cast", "instant",
  "[%d%.]+ sec cast", "[%d%.]+ min cast", "channeled", "[%d%.]+ sec cooldown", "[%d%.]+ min cooldown",
  "[%d%.]+ hr cooldown", "passive", "next melee",
}
-- Lines that start like this say what the ability needs, not what it does.
-- "Cooldown remaining" comes and goes, so it would change the wording.
local HEADER_START = { "requires ", "reagents:", "tools:", "cooldown remaining", "rank %d", "next rank" }

local function isHeader(line)
  local s = line:lower()
  for _, p in ipairs(HEADER_START) do
    if s:find("^" .. p) then return true end
  end
  for _, p in ipairs(HEADER) do s = s:gsub(p, " ") end
  return s:match("^[%s%p]*$") ~= nil
end

-- The word right after a number that makes it a time, a distance or a
-- count, not an amount of damage, healing or absorb.
local NOT_AMOUNT = {}
for word in ([[sec secs second seconds min mins minute minutes hour hours hr hrs ms yd yds yard yards
  charge charges stack stacks time times target targets enemy enemies ally allies member members
  attack attacks swing swings hit hits strike strikes spell spells block blocks combo totem totems
  application applications jump jumps bounce bounces mana rage energy focus level levels rank ranks
  talent talents x]]):gmatch("%a+") do
  NOT_AMOUNT[word] = true
end
-- Words that may stand between a number and what it counts ("3 additional targets").
local QUALIFIER = { additional = true, extra = true, more = true, nearby = true, melee = true, ranged = true, other = true, party = true, raid = true, friendly = true }
-- A number right after these is a rank or a level.
local NOT_AFTER = { rank = true, level = true, levels = true, lvl = true }

-- A number at `at` in `s`: its value, and where it ends. Thousands may be
-- grouped ("1,234"); a comma not followed by three digits ends the number.
local function readNumber(s, at)
  local digits = s:match("^%d+", at)
  if not digits then return nil end
  local stop = at + #digits
  local text = digits
  while true do
    local group = s:match("^,%d%d%d", stop)
    if not group or s:match("^,%d%d%d%d", stop) then break end
    text, stop = text .. group:sub(2), stop + 4
  end
  local decimals = s:match("^%.%d+", stop)
  if decimals then text, stop = text .. decimals, stop + #decimals end
  return tonumber(text), stop - 1
end

-- The first word of `rest`, past any qualifiers, lowercased.
local function countedWord(rest)
  for word in rest:lower():gmatch("%a+") do
    if not QUALIFIER[word] then return word end
  end
  return nil
end

-- What kind of amount a text names: the first such word in it, or with
-- `last` the last one (the closest to a number that follows the text).
local KIND_WORDS = { { "absorb", "absorb" }, { "damage", "damage" }, { "heal", "heal" }, { "health", "heal" } }
local function kindOf(text, last)
  local s = text:lower()
  local kind, where
  for _, w in ipairs(KIND_WORDS) do
    local at = 1
    while true do
      local i = s:find(w[1], at, true)
      if not i then break end
      if not where or (last and i > where) or (not last and i < where) then kind, where = w[2], i end
      if not last then break end
      at = i + 1
    end
  end
  return kind
end

-- A few words that say which number it is: from the number on ("82 to 87
-- Holy damage"), or the clause up to it when nothing follows it ("heals you
-- for 143").
local function labelOf(clause, start)
  local tail = Util.trim(clause:sub(start)):gsub("[%.%s]+$", "")
  if tail:find("%a%a") then return tail:sub(1, MAX_LABEL) end
  local whole = Util.trim(clause):gsub("[%.%s]+$", "")
  if #whole <= MAX_LABEL then return whole end
  return (whole:sub(-MAX_LABEL):gsub("^%S*%s+", ""))
end

-- A clause's effect numbers, one entry per number or range ("82 to 87").
-- sentence: the part of its sentence before the clause.
local function clauseNumbers(clause, sentence, out, previous)
  local at = 1
  while #out < MAX_EFFECTS do
    local start = clause:find("%d", at)
    if not start then return previous end
    local value, stop = readNumber(clause, start)
    local hi, hiStop
    -- A range: "82 to 87", "82 - 87".
    local gap = clause:match("^%s+to%s+", stop + 1) or clause:match("^%s*%-%s*", stop + 1)
    if gap and clause:find("^%d", stop + 1 + #gap) then hi, hiStop = readNumber(clause, stop + 1 + #gap) end
    local last = hiStop or stop
    local rest = clause:sub(last + 1)
    local before = clause:sub(1, start - 1)
    local skip = before:find("%a$") ~= nil -- part of a word ("T2")
      or rest:find("^%s*%%") ~= nil or rest:find("^/") ~= nil
      or NOT_AFTER[(before:match("(%a+)%s*$") or ""):lower()] or NOT_AMOUNT[countedWord(rest) or ""]
    if not skip and value then
      -- What the number is: said after it ("82 Holy damage"), else before it
      -- in its clause or its sentence ("heals the target and their party for
      -- 321 to 340", "causing 82 to 87 Holy damage, 164 to 173 if the target
      -- is stunned"), else what the number before it was.
      -- An absorb names the damage it absorbs ("absorbing 200 damage").
      local said = kindOf(before, true)
      local kind = (said == "absorb" and said) or kindOf(rest) or said or kindOf(sentence, true) or (previous and previous.k) or "other"
      local word = rest:match("^%s*(%a+)")
      local effect = {
        lo = value, hi = hi or value, k = kind,
        dot = (rest:lower():find("over [%d%.]+ [sm]") or rest:lower():find("every [%d%.]+ [sm]")) and true or nil,
        w = word and SCHOOL_WORDS[word:lower()] and word or nil,
        label = labelOf(clause, start),
      }
      out[#out + 1] = effect
      previous = effect
    end
    at = last + 1
  end
  return previous
end

-- The description of a spell's tooltip (its lines joined with " | ", as
-- Scan.Spells has them): the effect numbers in order, and the wording with
-- every number taken out, which says whether two readings can be compared.
function Calibrate.Effects(tip)
  if type(tip) ~= "string" then return {}, "" end
  local lines = {}
  for line in (tip .. " | "):gmatch("(.-) | ") do
    line = Util.trim(line)
    if line ~= "" and not isHeader(line) then lines[#lines + 1] = line end
  end
  local effects, previous = {}, nil
  for _, line in ipairs(lines) do
    for sentence in (line:gsub("%.%s", "\2") .. "\2"):gmatch("(.-)\2") do
      -- Clauses: what one comma, semicolon, "and" or "or" holds.
      local marked = sentence:gsub("[,;]%s", "\1"):gsub(" and ", "\1"):gsub(" or ", "\1")
      local soFar = {}
      for clause in (marked .. "\1"):gmatch("(.-)\1") do
        previous = clauseNumbers(clause, table.concat(soFar, " "), effects, previous)
        soFar[#soFar + 1] = clause
      end
    end
  end
  local shape = table.concat(lines, " | "):gsub("%d[%d,%.]*", "#")
  return effects, shape
end

-- The character -----------------------------------------------------------------------

-- A short, stable fingerprint of a string.
local function hash(s)
  -- Kept under 2^24 so the arithmetic stays exact with small integers too.
  local h = 5381
  for i = 1, #s do h = (h * 33 + s:byte(i)) % 16777213 end
  return string.format("%06x", h)
end

-- Talent choices, which change tooltip numbers too.
local function talentHash()
  local ranks = safe(ns.Scan.Ranks)
  if type(ranks) ~= "table" then return "?" end
  local ids = {}
  for id, rank in pairs(ranks) do
    if (tonumber(rank) or 0) > 0 then ids[#ids + 1] = id end
  end
  table.sort(ids, function(a, b) return tostring(a) < tostring(b) end)
  local parts = {}
  for _, id in ipairs(ids) do parts[#parts + 1] = tostring(id) .. ":" .. tostring(ranks[id]) end
  return hash(table.concat(parts, ","))
end

-- The stats a tooltip can scale with, now.
local function statsNow()
  local c = safe(ns.Scan.Combat)
  if type(c) ~= "table" then return nil end
  local s = { lv = num(c.level), ap = num(c.attackPower), rap = num(c.rangedAttackPower), hp = num(c.healingPower), sp = num(c.spellPower) }
  if not (s.ap or s.rap or s.hp or s.sp) then return nil end
  if type(c.spellPowerBySchool) == "table" then
    s.sch = {}
    for _, school in ipairs(SCHOOLS) do s.sch[school] = num(c.spellPowerBySchool[school]) end
  end
  s.tal = talentHash()
  return s
end

local function schoolPower(r, school)
  return (r.sch and r.sch[school]) or r.sp or 0
end

local function signature(s)
  local parts = { tostring(s.lv), s.tal, tostring(s.ap), tostring(s.rap), tostring(s.hp), tostring(s.sp) }
  for _, school in ipairs(SCHOOLS) do parts[#parts + 1] = tostring(s.sch and s.sch[school]) end
  return table.concat(parts, "/")
end

local function sameStats(a, b)
  if a.lv ~= b.lv or a.tal ~= b.tal or a.ap ~= b.ap or a.rap ~= b.rap or a.hp ~= b.hp or a.sp ~= b.sp then return false end
  for _, school in ipairs(SCHOOLS) do
    if schoolPower(a, school) ~= schoolPower(b, school) then return false end
  end
  return true
end

-- How far apart two readings' stats are.
local function distance(a, b)
  local d = 0
  for _, k in ipairs({ "ap", "rap", "hp" }) do d = d + ((a[k] or 0) - (b[k] or 0)) ^ 2 end
  for _, school in ipairs(SCHOOLS) do d = d + (schoolPower(a, school) - schoolPower(b, school)) ^ 2 end
  return d
end

-- The saved data ----------------------------------------------------------------------

-- This character's calibration: { seq, readings = { { id, t, lv, tal, ap,
-- rap, hp, sp, sch } }, spells = { [name] = { g, id, rank, lv, e = effects,
-- vals = { [reading id] = "84,169.5" }, kept } }, last, at }. kept: what
-- an earlier group of the ability measured. The current group's verdicts are
-- worked out again when needed, not saved: that keeps the saved data small.
function Calibrate.Data()
  local c = ns.Store and ns.Store:Char()
  if not c then return nil end
  local cal = c.calib
  if type(cal) ~= "table" or cal.v ~= 1 then
    cal = { v = 1, seq = 0, readings = {}, spells = {} }
    c.calib = cal
  end
  return cal
end

local CONCLUSIVE = { scales = true, flat = true, ambiguous = true }

local function kinds(effects)
  local out = {}
  for i, e in ipairs(effects or {}) do out[i] = e.k end
  return table.concat(out, ",")
end

-- Readings of one ability's group, as the fit wants them: a list per stat
-- and a list per effect number.
local function rows(cal, entry)
  local used = {}
  for _, r in ipairs(cal.readings) do
    if entry.vals[r.id] then used[#used + 1] = r end
  end
  return used
end

local function candidates(used)
  local out = {}
  for _, def in ipairs({ { "attackPower", "ap" }, { "rangedAttackPower", "rap" }, { "healingPower", "hp" } }) do
    local x = {}
    for i, r in ipairs(used) do x[i] = r[def[2]] or 0 end
    out[#out + 1] = { stat = def[1], x = x }
  end
  -- Spell power: one stat, unless some school moved differently from the
  -- others (an item with fire power only); then the schools that moved
  -- alike are one candidate, named by its school when it is not all of them.
  local groups = {}
  for _, school in ipairs(SCHOOLS) do
    local x = {}
    for i, r in ipairs(used) do x[i] = schoolPower(r, school) end
    local home
    for _, g in ipairs(groups) do
      local same = true
      for i = 2, #x do
        if (x[i] - x[1]) ~= (g.x[i] - g.x[1]) then same = false break end
      end
      if same then home = g break end
    end
    if home then home.schools[#home.schools + 1] = school else groups[#groups + 1] = { x = x, schools = { school } } end
  end
  for _, g in ipairs(groups) do
    out[#out + 1] = { stat = "spellPower", school = #groups > 1 and #g.schools == 1 and g.schools[1] or nil, x = g.x }
  end
  return out
end

-- A reading's numbers are saved as one string ("84,169.5"): the game writes
-- a table of numbers a line per number, which would make most of the saved data.
local function packValues(values)
  local parts = {}
  for i, v in ipairs(values) do parts[i] = Util.fmt(v, 1) end
  return table.concat(parts, ",")
end

local function unpackValues(packed)
  local out = {}
  for v in tostring(packed or ""):gmatch("[^,]+") do out[#out + 1] = tonumber(v) or 0 end
  return out
end

local function judge(cal, entry)
  local used = rows(cal, entry)
  local values = {}
  for j, r in ipairs(used) do values[j] = unpackValues(entry.vals[r.id]) end
  local fits = {}
  for i = 1, #(entry.e or {}) do
    local y, cands = {}, candidates(used)
    for j in ipairs(used) do y[j] = values[j][i] or 0 end
    local ok, verdict = pcall(ns.Fit.Judge, cands, y)
    fits[i] = ok and verdict or { s = "few", need = "readings", n = #y }
    fits[i].value = y[#y]
  end
  return fits
end

-- Verdicts by ability, until the next reading changes them.
local verdicts = {}
local function fitsOf(cal, name, entry)
  local stamp = tostring(cal.seq) .. "/" .. tostring(entry.g)
  local cached = verdicts[name]
  if cached and cached.stamp == stamp and cached.cal == cal then return cached.fits end
  local fits = judge(cal, entry)
  verdicts[name] = { stamp = stamp, cal = cal, fits = fits }
  return fits
end

local function r4(v) return v and Util.round(v, 4) end

-- A verdict as it is saved: rounded, without what only the fit needs.
local function compact(f)
  local out = { s = f.s, n = f.n, school = f.school, value = Util.round(f.value, 1), dropped = f.dropped }
  if f.s == "scales" then
    out.per = {}
    for stat, v in pairs(f.per) do out.per[stat] = r4(v) end
    out.pm, out.base, out.rms = r4(f.pm), Util.round(f.base, 1), Util.round(f.rms, 2)
  elseif f.s == "flat" then
    out.tested = f.tested
  elseif f.s == "ambiguous" then
    out.candidates = {}
    for i, c in ipairs(f.candidates) do out.candidates[i] = { stat = c.stat, school = c.school, per = r4(c.per) } end
  end
  return out
end

-- Removes a reading and its numbers from every ability.
local function forget(cal, id)
  for i = #cal.readings, 1, -1 do
    if cal.readings[i].id == id then table.remove(cal.readings, i) end
  end
  for _, entry in pairs(cal.spells) do entry.vals[id] = nil end
end

-- One reading too many: first the oldest of another level or other talents
-- (no group of today can use it), else the one closest to another reading
-- (it adds the least spread), the older of the two.
local function evict(cal, now)
  while #cal.readings > MAX_READINGS do
    local victim
    for _, r in ipairs(cal.readings) do
      if (r.lv ~= now.lv or r.tal ~= now.tal) and (not victim or r.t < victim.t) then victim = r end
    end
    if not victim then
      local best
      for i, a in ipairs(cal.readings) do
        for j, b in ipairs(cal.readings) do
          if i ~= j then
            local d = distance(a, b)
            if not best or d < best or (d == best and a.t < victim.t) then best, victim = d, a end
          end
        end
      end
    end
    forget(cal, victim.id)
  end
end

-- Takes a reading. `stats` are the stats read before the tooltips.
local function record(cal, stats, spells)
  cal.seq = (cal.seq or 0) + 1
  local r = { id = cal.seq, t = time(), lv = stats.lv, tal = stats.tal, ap = stats.ap, rap = stats.rap, hp = stats.hp, sp = stats.sp, sch = stats.sch }
  -- The same stats as an earlier reading (a buff back on): the newer one replaces it.
  for i = #cal.readings, 1, -1 do
    local old = cal.readings[i]
    if sameStats(old, r) then forget(cal, old.id) end
  end
  cal.readings[#cal.readings + 1] = r

  local seen = {}
  for _, spell in ipairs(spells) do
    if type(spell) == "table" and spell.name and spell.tip and not spell.passive then
      local effects, shape = Calibrate.Effects(spell.tip)
      local entry = cal.spells[spell.name]
      if #effects > 0 and (entry or Util.count(cal.spells) < MAX_SPELLS) then
        seen[spell.name] = true
        local key = table.concat({ tostring(spell.id), tostring(spell.rank or ""), tostring(r.lv), r.tal, hash(shape) }, ":")
        if not entry or entry.g ~= key then
          -- Another group: what was measured in the old one is kept until this one says more.
          local kept = entry and entry.kept
          if entry then
            local fits, any = fitsOf(cal, spell.name, entry), false
            for _, f in ipairs(fits) do any = any or CONCLUSIVE[f.s] or false end
            if any then
              -- Only what says something: the rest is waited for anyway.
              local saved = {}
              for i, f in ipairs(fits) do saved[i] = CONCLUSIVE[f.s] and compact(f) or false end
              kept = { fit = saved, lv = entry.lv, k = kinds(entry.e) }
            end
          end
          entry = { g = key, lv = r.lv, vals = {}, kept = kept }
          cal.spells[spell.name] = entry
        end
        entry.id, entry.rank = spell.id, spell.rank
        local meta, values = {}, {}
        for i, e in ipairs(effects) do
          meta[i] = { k = e.k, dot = e.dot, w = e.w, label = e.label }
          values[i] = (e.lo + e.hi) / 2
        end
        entry.e = meta
        entry.vals[r.id] = packValues(values)
      end
    end
  end
  -- Abilities no longer in the spellbook, or without numbers now, are dropped.
  for name in pairs(cal.spells) do
    if not seen[name] then cal.spells[name] = nil end
  end
  evict(cal, r)
  cal.at = r.t
end

-- When to take a reading -----------------------------------------------------------

local pokes, pending, forced, retrying = 0, false, false, false
Calibrate.skipped = nil -- { why, t }: the last attempt that took no reading

local function inCombat()
  return safe(InCombatLockdown) or safe(UnitAffectingCombat, "player") or false
end

local function skip(why)
  Calibrate.skipped = { why = why, t = time() }
  return false, why
end

local function later(seconds, fn)
  if C_Timer and C_Timer.After then
    C_Timer.After(seconds, fn)
    return true
  end
  return false
end

-- Takes a reading now when it can and something changed. Returns true, or
-- false and why not.
function Calibrate.Try()
  pending = false
  local cal = Calibrate.Data()
  if not cal then return skip("no saved data yet") end
  if inCombat() then
    pending = true
    return skip("in combat")
  end
  if safe(UnitIsDeadOrGhost, "player") then return skip("dead") end
  local before = statsNow()
  if not before then return skip("no stats from the game") end
  local sig = signature(before)
  if sig == cal.last and not forced then return skip("nothing changed") end
  local wait = MIN_GAP - (time() - (cal.at or 0))
  if wait > 0 then
    if not retrying and later(wait, function() retrying = false Calibrate.Poke() end) then retrying = true end
    return skip("too soon after the last reading")
  end
  -- The tooltips as the game shows them now, not as they were first read.
  ns.Scan.Changed("spells")
  local spells = safe(ns.Scan.Spells)
  if type(spells) ~= "table" or #spells == 0 then return skip("no spellbook") end
  local after = statsNow()
  -- Stats that moved while the tooltips were read: they may be half updated.
  if not after or signature(after) ~= sig then
    Calibrate.Poke()
    return skip("stats changed while reading")
  end
  local ok, err = pcall(record, cal, before, spells)
  if not ok then return skip("error: " .. tostring(err)) end
  cal.last, forced = sig, false
  Calibrate.skipped = nil
  return true
end

-- Something that may change the stats or the tooltips happened. A burst of
-- events makes one attempt, a few seconds after the last of them; in combat
-- it waits for the end of the fight. force: the spells or talents changed,
-- so a reading is worth taking even with the same stats.
function Calibrate.Poke(event, force)
  if force then forced = true end
  if inCombat() then
    pending = true
    return
  end
  pokes = pokes + 1
  local mine = pokes
  local quiet = (event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD") and QUIET_LOGIN or QUIET
  if not later(quiet, function()
    if mine == pokes then pcall(Calibrate.Try) end
  end) then
    pcall(Calibrate.Try)
  end
end

-- The fight is over: what waited for it is tried now.
function Calibrate.CombatEnded()
  if pending then Calibrate.Poke() end
end

-- What was measured --------------------------------------------------------------

-- Per followed ability: { name, id, rank, effects = { { k, dot, w, label,
-- fit = verdict, old = level when measured at another level or with other
-- talents } } }, sorted by name.
function Calibrate.Report()
  local cal = Calibrate.Data()
  local out = {}
  if not cal then return out end
  for name, entry in pairs(cal.spells) do
    local item = { name = name, id = entry.id, rank = entry.rank, effects = {}, readings = 0 }
    for _ in pairs(entry.vals) do item.readings = item.readings + 1 end
    local keptFits = entry.kept and entry.kept.k == kinds(entry.e) and entry.kept.fit or {}
    local fits = fitsOf(cal, name, entry)
    for i, e in ipairs(entry.e or {}) do
      local fit = fits[i] or { s = "few", need = "readings", n = item.readings }
      local effect = { k = e.k, dot = e.dot, w = e.w, label = e.label, fit = fit }
      if not CONCLUSIVE[fit.s] and keptFits[i] and CONCLUSIVE[keptFits[i].s] then
        effect.fit, effect.old = keptFits[i], entry.kept.lv
      end
      item.effects[#item.effects + 1] = effect
    end
    out[#out + 1] = item
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return out
end

-- The verdicts of an ability's current group, one per effect number, or nil.
function Calibrate.Fits(name)
  local cal = Calibrate.Data()
  local entry = cal and cal.spells[name]
  return entry and fitsOf(cal, name, entry) or nil
end

local function measured(effect)
  return CONCLUSIVE[effect.fit.s] or false
end
Calibrate.IsMeasured = measured

local function r3(v) return Util.round(v, 3) end

-- Measured effects as the app reads them (armory_scaling), or nil when
-- nothing is measured yet. Only what can be acted on: effects that scale,
-- do not scale, or scale with one of two stats.
function Calibrate.Section()
  local abilities, sent = {}, 0
  for _, item in ipairs(Calibrate.Report()) do
    local effects = {}
    for i, effect in ipairs(item.effects) do
      local f = effect.fit
      if measured(effect) and sent < MAX_SENT then
        local e = { index = i, kind = effect.k, text = effect.label, value = r3(f.value), status = f.s, readings = f.n }
        if effect.dot then e.overTime = true end
        if effect.old then e.level = effect.old end
        if f.s == "scales" then
          e.perPoint = {}
          for stat, v in pairs(f.per) do e.perPoint[stat] = r3(v) end
          e.base, e.margin, e.rms = Util.round(f.base, 1), r3(f.pm), Util.round(f.rms, 2)
          e.school = f.school
          if f.dropped then e.dropped = f.dropped end
        elseif f.s == "flat" then
          e.tested = {}
          for _, t in ipairs(f.tested) do e.tested[#e.tested + 1] = t.stat end
        else
          e.candidates = {}
          for _, c in ipairs(f.candidates) do e.candidates[#e.candidates + 1] = { stat = c.stat, school = c.school, perPoint = r3(c.per) } end
        end
        effects[#effects + 1] = e
        sent = sent + 1
      end
    end
    if #effects > 0 then abilities[#abilities + 1] = { name = item.name, id = item.id, rank = item.rank, effects = effects } end
  end
  if #abilities == 0 then return nil end
  local cal = Calibrate.Data()
  return { v = 1, readings = cal and #cal.readings or 0, abilities = abilities }
end

-- The measured effects in short, to tell when a result predates them:
-- { { name, kind, stat, perPoint } } (perPoint 0 for "does not scale").
function Calibrate.Measured()
  local out = {}
  for _, item in ipairs(Calibrate.Report()) do
    for _, effect in ipairs(item.effects) do
      local f = effect.fit
      if f.s == "scales" then
        for stat, v in pairs(f.per) do out[#out + 1] = { name = item.name, kind = effect.k, stat = stat, perPoint = v } end
      elseif f.s == "flat" then
        for _, t in ipairs(f.tested) do out[#out + 1] = { name = item.name, kind = effect.k, stat = t.stat, perPoint = 0 } end
      end
    end
  end
  return out
end

-- One line for /armory debug.
function Calibrate.Diagnose()
  local cal = Calibrate.Data()
  if not cal then return "calibration: no saved data yet" end
  local followed, done = 0, 0
  for _, item in ipairs(Calibrate.Report()) do
    followed = followed + 1
    for _, effect in ipairs(item.effects) do
      if measured(effect) then
        done = done + 1
        break
      end
    end
  end
  local line = string.format("calibration: %d readings, %d of %d abilities measured", #cal.readings, done, followed)
  if cal.at then line = line .. string.format(", last reading %ds ago", math.max(0, time() - cal.at)) end
  local s = Calibrate.skipped
  if s then line = line .. string.format("; last attempt skipped (%ds ago): %s", math.max(0, time() - s.t), s.why) end
  return line
end

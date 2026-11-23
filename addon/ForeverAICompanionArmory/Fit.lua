-- Least squares for calibration (Calibrate.lua): how one number of an
-- ability's tooltip moves with the character's stats across readings.
-- Plain arithmetic on lists of numbers, so it is tested without the game.
--
-- Fit.Judge(candidates, y) gives one verdict:
--   scales     one stat (or two together) explains the number: a clear,
--              positive slope and a fit within what rounding allows
--   flat       the stats moved and the number did not: it does not scale
--              with the stats that moved ("tested")
--   ambiguous  two stats moved together and either one explains it
--   few        not enough readings, or the stats moved too little to tell
--   unclear    the number moved, but no stat explains it (a buff that adds a
--              percentage, weapon damage, something not read)
local _, ns = ...

local Fit = {}
ns.Fit = Fit

-- Readings needed for a line through the points plus one to check it.
Fit.MIN_READINGS = 3
-- How far a stat must move across the readings before it can explain
-- anything. Tooltips show whole numbers, so the slope is only known to about
-- 1 / spread: 15 points pin it to a few hundredths.
Fit.MIN_SPREAD = 15
-- How far the number must move because of the stat before a slope counts:
-- a change of 1 is what rounding alone can make.
Fit.MIN_MOVE = 2
-- A number that moved no more than this did not move (rounding of a range's middle).
Fit.FLAT = 0.5
-- Two stats this correlated across the readings cannot be told apart.
Fit.CORRELATED = 0.95
-- What rounding to whole numbers leaves on a value: 1 / sqrt(12).
local ROUNDING = 0.29

local sqrt, abs = math.sqrt, math.abs

local function mean(xs)
  local s = 0
  for _, x in ipairs(xs) do s = s + x end
  return s / #xs
end

local function spread(xs)
  local lo, hi
  for _, x in ipairs(xs) do
    if not lo or x < lo then lo = x end
    if not hi or x > hi then hi = x end
  end
  return lo and (hi - lo) or 0
end
Fit.Spread = spread

-- How far a fit may miss each reading: rounding, plus a little for large
-- numbers, which a multiplier the addon does not see moves by more.
local function tolerance(y)
  return 0.8 + 0.002 * abs(mean(y))
end

-- y = a + b x. Returns { a, b, rms, r2, se } (se: the slope's standard
-- error, never smaller than rounding allows), or nil when x does not vary.
function Fit.Line(x, y)
  local n = #x
  if n < 2 then return nil end
  local mx, my = mean(x), mean(y)
  local sxx, sxy, syy = 0, 0, 0
  for i = 1, n do
    local dx, dy = x[i] - mx, y[i] - my
    sxx, sxy, syy = sxx + dx * dx, sxy + dx * dy, syy + dy * dy
  end
  if sxx <= 0 then return nil end
  local b = sxy / sxx
  local a = my - b * mx
  local ss = 0
  for i = 1, n do
    local e = y[i] - (a + b * x[i])
    ss = ss + e * e
  end
  local sigma = math.max(n > 2 and sqrt(ss / (n - 2)) or 0, ROUNDING)
  return { a = a, b = b, rms = sqrt(ss / n), r2 = syy > 0 and 1 - ss / syy or 1, se = sigma / sqrt(sxx) }
end

-- y = a + b1 x1 + b2 x2. Returns { a, b1, b2, rms, r2, se1, se2 }, or nil
-- when the two stats moved together (nothing can be told apart then).
function Fit.Plane(x1, x2, y)
  local n = #y
  if n < 3 then return nil end
  local m1, m2, my = mean(x1), mean(x2), mean(y)
  local c11, c22, c12, c1y, c2y, cyy = 0, 0, 0, 0, 0, 0
  for i = 1, n do
    local d1, d2, dy = x1[i] - m1, x2[i] - m2, y[i] - my
    c11, c22, c12 = c11 + d1 * d1, c22 + d2 * d2, c12 + d1 * d2
    c1y, c2y, cyy = c1y + d1 * dy, c2y + d2 * dy, cyy + dy * dy
  end
  local det = c11 * c22 - c12 * c12
  if c11 <= 0 or c22 <= 0 or det <= 1e-9 * c11 * c22 then return nil end
  local b1 = (c22 * c1y - c12 * c2y) / det
  local b2 = (c11 * c2y - c12 * c1y) / det
  local a = my - b1 * m1 - b2 * m2
  local ss = 0
  for i = 1, n do
    local e = y[i] - (a + b1 * x1[i] + b2 * x2[i])
    ss = ss + e * e
  end
  local sigma = math.max(n > 3 and sqrt(ss / (n - 3)) or 0, ROUNDING)
  return {
    a = a, b1 = b1, b2 = b2, rms = sqrt(ss / n), r2 = cyy > 0 and 1 - ss / cyy or 1,
    se1 = sigma * sqrt(c22 / det), se2 = sigma * sqrt(c11 / det),
  }
end

-- Pearson correlation of two lists (0 when either does not vary).
function Fit.Correlation(x1, x2)
  local m1, m2 = mean(x1), mean(x2)
  local c11, c22, c12 = 0, 0, 0
  for i = 1, #x1 do
    local d1, d2 = x1[i] - m1, x2[i] - m2
    c11, c22, c12 = c11 + d1 * d1, c22 + d2 * d2, c12 + d1 * d2
  end
  if c11 <= 0 or c22 <= 0 then return 0 end
  return c12 / sqrt(c11 * c22)
end

local function label(c)
  return { stat = c.stat, school = c.school }
end

-- A single stat explains the number: the slope is positive, clearly more
-- than its own uncertainty, moved the number by more than rounding does,
-- and the line passes every reading within tolerance.
local function explains(f, c, tol)
  return f.b > 0 and f.b * c.spread >= Fit.MIN_MOVE and f.b >= 3 * f.se and f.rms <= tol
end

local function scalesWith(c, f, n)
  return {
    s = "scales", per = { [c.stat] = f.b }, pm = f.se, base = f.a, rms = f.rms, r2 = f.r2, n = n, school = c.school,
  }
end

-- Two stats moved but not together: whether both are needed to explain it.
local function bestPair(varied, y, tol)
  local best
  for i = 1, #varied do
    for j = i + 1, #varied do
      local c1, c2 = varied[i], varied[j]
      -- Two schools of spell power are one stat to the simulator.
      if c1.stat ~= c2.stat and abs(Fit.Correlation(c1.x, c2.x)) < Fit.CORRELATED then
        local f = Fit.Plane(c1.x, c2.x, y)
        if f and f.rms <= tol and f.b1 > 0 and f.b2 > 0 and f.b1 >= 3 * f.se1 and f.b2 >= 3 * f.se2
          and f.b1 * c1.spread >= Fit.MIN_MOVE and f.b2 * c2.spread >= Fit.MIN_MOVE and (not best or f.rms < best.f.rms) then
          best = { c1 = c1, c2 = c2, f = f }
        end
      end
    end
  end
  return best
end

-- Several stats explain the number on their own. With readings enough to
-- fit two at once, one of them may still turn out to do nothing.
local function settle(goods, y, n)
  if n >= 4 and #goods == 2 and abs(Fit.Correlation(goods[1].c.x, goods[2].c.x)) < Fit.CORRELATED then
    local f = Fit.Plane(goods[1].c.x, goods[2].c.x, y)
    if f then
      local one, two = f.b1 >= 3 * f.se1, f.b2 >= 3 * f.se2
      if one and not two and abs(f.b2) < 2 * f.se2 then return scalesWith(goods[1].c, goods[1].f, n) end
      if two and not one and abs(f.b1) < 2 * f.se1 then return scalesWith(goods[2].c, goods[2].f, n) end
    end
  end
  local out = { s = "ambiguous", candidates = {}, n = n }
  for _, g in ipairs(goods) do
    local entry = label(g.c)
    entry.per = g.f.b
    out.candidates[#out.candidates + 1] = entry
  end
  return out
end

local function judge(cands, y)
  local n = #y
  if n < Fit.MIN_READINGS then return { s = "few", need = "readings", n = n } end
  local varied = {}
  for _, c in ipairs(cands) do
    c.spread = spread(c.x)
    if c.spread >= Fit.MIN_SPREAD then varied[#varied + 1] = c end
  end
  if #varied == 0 then return { s = "few", need = "spread", n = n } end
  if spread(y) <= Fit.FLAT then
    local tested = {}
    for _, c in ipairs(varied) do tested[#tested + 1] = label(c) end
    return { s = "flat", tested = tested, n = n }
  end
  local tol = tolerance(y)
  local goods, close = {}, false
  for _, c in ipairs(varied) do
    local f = Fit.Line(c.x, y)
    if f and explains(f, c, tol) then
      goods[#goods + 1] = { c = c, f = f }
    elseif f and f.b > 0 and f.rms <= tol then
      -- A line fits, but the stat moved the number too little to be sure.
      close = true
    end
  end
  if #goods == 1 then return scalesWith(goods[1].c, goods[1].f, n) end
  if #goods > 1 then
    table.sort(goods, function(a, b) return a.f.rms < b.f.rms end)
    return settle(goods, y, n)
  end
  if n >= 4 then
    local pair = bestPair(varied, y, tol)
    if pair then
      local f = pair.f
      return {
        s = "scales", per = { [pair.c1.stat] = f.b1, [pair.c2.stat] = f.b2 }, pm = math.max(f.se1, f.se2),
        base = f.a, rms = f.rms, r2 = f.r2, n = n, school = pair.c1.school or pair.c2.school,
      }
    end
  end
  if close then return { s = "few", need = "spread", n = n } end
  return { s = "unclear", n = n }
end

local function without(list, k)
  local out = {}
  for i, v in ipairs(list) do
    if i ~= k then out[#out + 1] = v end
  end
  return out
end

-- candidates: { { stat, school, x = { one value per reading } } }; y: the
-- number at each reading. One reading that fits nothing (taken with a buff
-- that adds a percentage the addon does not see, say) does not spoil the rest:
-- with 5 or more, a clear fit without one of them is taken, and says so.
function Fit.Judge(cands, y)
  local verdict = judge(cands, y)
  if verdict.s ~= "unclear" or #y < 5 then return verdict end
  local best
  for k = 1, #y do
    local trimmed = {}
    for i, c in ipairs(cands) do trimmed[i] = { stat = c.stat, school = c.school, x = without(c.x, k) } end
    local v = judge(trimmed, without(y, k))
    if v.s == "scales" and (not best or v.rms < best.rms) then best = v end
  end
  if best then
    best.dropped = 1
    return best
  end
  return verdict
end

-- Following a talent build. The app sends the build as the order in which
-- to spend every point (talent ids, already checked against the game's
-- rules); this file compares that order with the points the character has
-- right now, so the window always shows the next points to spend, also after
-- the player spends some or levels up, without asking the AI again.
local _, ns = ...

local Build = {}
ns.Build = Build

-- order: talent ids, one per point. ranks: { [id] = points the character has }.
-- Returns:
--   next       the points still to spend, in order: { id, rank (the rank that point gives), n (its place in the order) }
--   misplaced  points the character has that the build doesn't use: { id, extra }
--   matched    how many of the build's points are already spent
--   total      points in the build
function Build.Progress(order, ranks)
  local seen, upcoming, matched = {}, {}, 0
  for i, id in ipairs(order or {}) do
    seen[id] = (seen[id] or 0) + 1
    if seen[id] <= (ranks[id] or 0) then
      matched = matched + 1
    else
      upcoming[#upcoming + 1] = { id = id, rank = seen[id], n = i }
    end
  end
  local misplaced = {}
  for id, rank in pairs(ranks or {}) do
    local want = seen[id] or 0
    if rank > want then misplaced[#misplaced + 1] = { id = id, extra = rank - want } end
  end
  table.sort(misplaced, function(a, b) return a.id < b.id end)
  return { next = upcoming, misplaced = misplaced, matched = matched, total = #(order or {}) }
end

-- Consecutive points in the same talent as one step: { id, from, to, count, n }.
-- `limit`: at most this many steps.
function Build.Steps(points, limit)
  local steps = {}
  for _, p in ipairs(points or {}) do
    local last = steps[#steps]
    if last and last.id == p.id and last.to + 1 == p.rank then
      last.to, last.count = p.rank, last.count + 1
    else
      if limit and #steps >= limit then break end
      steps[#steps + 1] = { id = p.id, from = p.rank - 1, to = p.rank, count = 1, n = p.n }
    end
  end
  return steps
end

-- Talents by id from a scan (Scan.Talents): { [id] = talent }, each with its tree.
function Build.Index(section)
  local byId = {}
  for _, tree in ipairs(section and section.trees or {}) do
    for _, talent in ipairs(tree.talents or {}) do
      byId[talent.id] = { name = talent.name, max = talent.max, row = talent.row, tree = tree.name, rank = talent.rank }
    end
  end
  return byId
end

-- The whole order as runs: { id, from, to, first (place of its first point), last }.
function Build.Runs(order)
  local runs, seen = {}, {}
  for i, id in ipairs(order or {}) do
    seen[id] = (seen[id] or 0) + 1
    local last = runs[#runs]
    if last and last.id == id then
      last.to, last.last = seen[id], i
    else
      runs[#runs + 1] = { id = id, from = seen[id] - 1, to = seen[id], first = i, last = i }
    end
  end
  return runs
end

-- The character level at which point number n of a build is earned: one
-- point per level from 10 on classic-style trees.
function Build.LevelOf(n)
  return n + 9
end

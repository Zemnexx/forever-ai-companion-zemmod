-- Small helpers shared by the Armory's files.
-- Written for the game's Lua 5.1 and for the Lua 5.3 the tests run on.
local _, ns = ...

local Util = {}
ns.Util = Util

local floor = math.floor

-- pcall that returns the first result or nil: a game function that is missing
-- or behaves differently on this client never breaks the caller.
function Util.safe(fn, ...)
  if type(fn) ~= "function" then return nil end
  local ok, a, b, c, d = pcall(fn, ...)
  if ok then return a, b, c, d end
  return nil
end

-- Newer clients return "secret" values addons may show but not compute with.
function Util.secret(v)
  if not issecretvalue then return false end
  local ok, is = pcall(issecretvalue, v)
  return not ok or is
end

-- A number the addon can compute with, or nil.
function Util.num(v)
  if v == nil or type(v) ~= "number" or Util.secret(v) then return nil end
  return v
end

function Util.round(n, digits)
  n = Util.num(n)
  if not n then return nil end
  local m = 10 ^ (digits or 0)
  return floor(n * m + 0.5) / m
end

-- Strips the game's markup (colors, textures, links) so the AI gets plain text.
function Util.clean(s)
  if type(s) ~= "string" or Util.secret(s) then return nil end
  s = s:gsub("|c%x%x%x%x%x%x%x%x", "")
  s = s:gsub("|cn[%w_]*:", "")
  s = s:gsub("|r", "")
  s = s:gsub("|T.-|t", "")
  s = s:gsub("|A.-|a", "")
  s = s:gsub("|H.-|h(.-)|h", "%1")
  s = s:gsub("|n", "\n")
  return s
end

function Util.trim(s)
  return (tostring(s or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

-- 1234567 copper -> "123g 45s 67c" (short: "123g" once gold is involved).
function Util.money(copper, short)
  copper = Util.num(copper)
  if not copper then return nil end
  copper = floor(copper)
  local g, s, c = floor(copper / 10000), floor(copper / 100) % 100, copper % 100
  if short and g >= 10 then return string.format("%dg", g) end
  if g > 0 then return string.format("%dg %ds", g, s) end
  if s > 0 then return string.format("%ds %dc", s, c) end
  return string.format("%dc", c)
end

-- 0.1234 -> "12.3"; whole numbers lose the ".0".
function Util.fmt(n, digits)
  n = Util.num(n)
  if not n then return "?" end
  local s = string.format("%." .. (digits or 1) .. "f", n)
  if s:find("%.") then s = s:gsub("0+$", ""):gsub("%.$", "") end
  return s
end

-- "3 min ago" from a time() value.
function Util.ago(t, L)
  local d = (time and time() or os.time()) - (tonumber(t) or 0)
  if d < 90 then return L.AGO_NOW end
  if d < 3600 then return string.format(L.AGO_MIN, floor(d / 60)) end
  if d < 86400 then return string.format(L.AGO_HOUR, floor(d / 3600)) end
  return string.format(L.AGO_DAY, floor(d / 86400))
end

-- Names compared loosely: case, punctuation and spaces don't count.
function Util.sameName(a, b)
  if type(a) ~= "string" or type(b) ~= "string" then return false end
  local function norm(s) return (s:lower():gsub("[%s%p]+", "")) end
  return norm(a) == norm(b)
end

function Util.count(t)
  local n = 0
  for _ in pairs(type(t) == "table" and t or {}) do n = n + 1 end
  return n
end

-- The character's key in saved data: its GUID (the realm's name can be blank
-- on WoW Forever), else "Name-Realm". Same rule as the main addon.
function Util.charKey()
  local guid = UnitGUID and UnitGUID("player")
  if type(guid) == "string" and guid:match("^Player%-") then return guid end
  return (UnitName and UnitName("player") or "?") .. "-" .. (GetRealmName and GetRealmName() or "?")
end

function Util.chat(msg)
  print("|cff66ccffArmory:|r " .. tostring(msg))
end

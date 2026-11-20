// Runs Collect.lua against a fake WoW API (modern C_Container / C_Item style
// plus a classic ammo slot) and checks the snapshot the AI would receive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLua } from './helpers.js';

const FAKE_WOW = `
  local items = {
    [2519] = { "Virote pesado", 1, 15, 15, "Proyectil", "Virote", 200, "INVTYPE_AMMO" },
    [4306] = { "Paño de seda", 1, 15, 0, "Comercio", "Tela", 20, "" },
    [858]  = { "Poción de sanación inferior", 1, 5, 1, "Consumible", "Poción", 5, "" },
    [9999] = { "Leotardos de cuero", 2, 25, 20, "Armadura", "Cuero", 1, "INVTYPE_LEGS" },
    [3000] = { "Repetidora de púas sepulcral", 2, 30, 25, "Arma", "Ballesta", 1, "INVTYPE_RANGEDRIGHT" },
  }
  local function link(id) return "|cffffffff|Hitem:" .. id .. "::::::::33:::::|h[" .. items[id][1] .. "]|h|r" end
  -- bag -> slot -> { id, count }
  local bagContents = {
    [0] = { { 4306, 20 }, { 858, 5 }, { 4306, 7 } },
    [1] = { { 9999, 1 }, { 2519, 200 }, { 2519, 200 } },
  }
  NUM_TOTAL_EQUIPPED_BAG_SLOTS = 4
  C_Container = {
    GetContainerNumSlots = function(bag) return bagContents[bag] and #bagContents[bag] + 2 or 0 end,
    GetContainerNumFreeSlots = function(bag) return bagContents[bag] and 2 or 0 end,
    GetContainerItemInfo = function(bag, slot)
      local s = bagContents[bag] and bagContents[bag][slot]
      if not s then return nil end
      return { hyperlink = link(s[1]), stackCount = s[2] }
    end,
  }
  C_Item = {
    GetItemInfo = function(l)
      local id = tonumber(l:match("item:(%d+)"))
      local it = items[id]
      if not it then return nil end
      return it[1], l, it[2], it[3], it[4], it[5], it[6], it[7], it[8]
    end,
  }
  GetInventoryItemLink = function(unit, slot)
    if slot == 0 then return link(2519) end
    if slot == 18 then return link(3000) end
    return nil
  end
  GetInventoryItemCount = function(unit, slot) return slot == 0 and 183 or 0 end
  GetInventoryItemDurability = function() return 40, 50 end
  C_Item.GetItemStats = function(l)
    if l:find("item:3000") then return { ITEM_MOD_AGILITY_SHORT = 4, ITEM_MOD_DAMAGE_PER_SECOND_SHORT = 14.27 } end
    return {}
  end
  GetTime = function() return 1000 end
  local units = { player = { "Sharp", 33, 820, 1000 }, pet = { "Garra", 32, 500, 500 } }
  UnitName = function(u) return units[u] and units[u][1] end
  UnitLevel = function(u) return units[u] and units[u][2] end
  UnitExists = function(u) return units[u] ~= nil end
  UnitHealth = function(u) return units[u] and units[u][3] end
  UnitHealthMax = function(u) return units[u] and units[u][4] end
  UnitCreatureFamily = function() return "Felino" end
  GetPetHappiness = function() return 3, 125, 2 end
  UnitClass = function() return "Cazadora", "HUNTER" end
  GetBindLocation = function() return "Forjaz" end
  C_UnitAuras = { GetAuraDataByIndex = function(u, i, f)
    if f == "HELPFUL" and i == 1 then return { name = "Bien alimentado", applications = 0, expirationTime = 1600 } end
  end }
  C_QuestLog = {
    GetNumQuestLogEntries = function() return 2 end,
    GetInfo = function(i)
      if i == 1 then return { isHeader = true, title = "Gnomeregan" } end
      return { title = "Excavadoras gyroagujereamáticas", level = 30, questID = 2928 }
    end,
    GetQuestObjectives = function() return { { text = "Entrañas robomecánicas: 0/24", finished = false } } end,
    GetQuestTagInfo = function() return { tagName = "Mazmorra" } end,
    GetNextWaypointText = function() return "Ve a Gnomeregan" end,
  }
  GetQuestLogQuestText = function(i) return "desc", "Consigue 24 Entrañas robomecánicas." end
  GetQuestLogRewardXP = function() return 3100 end
  GetQuestLogRewardMoney = function() return 12500 end
  GetNumQuestLogChoices = function() return 1 end
  GetQuestLogItemLink = function(kind, i, id) return kind == "choice" and link(9999) or nil end
  date = os.date
`;

test('snapshot includes bag contents grouped with counts, and ammo', () => {
  const json = runLua(
    'RESULT = ns.Json.Encode(ns.Collect:Snapshot())',
    {},
    ['Json.lua', 'Collect.lua'],
    FAKE_WOW,
  );
  const snap = JSON.parse(json);
  assert.deepEqual(snap.ammo, { name: 'Virote pesado', equipped: 183 });

  const inv = Object.fromEntries(snap.inventory.map((i) => [i.name, i]));
  assert.equal(inv['Paño de seda'].count, 27);          // two stacks merged
  assert.equal(inv['Virote pesado'].count, 400);
  assert.equal(inv['Poción de sanación inferior'].count, 5);
  assert.equal(inv['Leotardos de cuero'].equipSlot, 'INVTYPE_LEGS');
  assert.equal(inv['Leotardos de cuero'].itemLevel, 25);
  assert.equal(inv['Paño de seda'].equipSlot, undefined);
  assert.deepEqual(snap.bags, { freeSlots: 4, totalSlots: 10 });

  assert.equal(snap.gear.length, 1);
  assert.equal(snap.gear[0].name, 'Repetidora de púas sepulcral');
  assert.equal(snap.gear[0].durabilityPct, 80);
  assert.deepEqual(snap.gear[0].stats, { AGILITY: 4, DAMAGE_PER_SECOND: 14.3 });
  assert.equal(snap.lowestDurabilityPct, 80);

  assert.deepEqual(snap.pet, { name: 'Garra', level: 32, family: 'Felino', healthPct: 100, happiness: 'happy', damagePct: 125, loyaltyRate: 2 });
  assert.deepEqual(snap.buffs, [{ name: 'Bien alimentado', minutesLeft: 10 }]);

  const q = snap.quests[0];
  assert.equal(q.zone, 'Gnomeregan');
  assert.equal(q.tag, 'Mazmorra');
  assert.equal(q.goal, 'Consigue 24 Entrañas robomecánicas.');
  assert.equal(q.nextStep, 'Ve a Gnomeregan');
  assert.equal(q.rewardXp, 3100);
  assert.equal(q.rewardMoney, '1g 25s 0c');
  assert.equal(q.rewardChoices[0].name, 'Leotardos de cuero');
  assert.deepEqual(q.objectives, ['[ ] Entrañas robomecánicas: 0/24']);

  // Fields this fake client lacks (UnitRace...) are just left out.
  assert.equal(snap.character.name, 'Sharp');
  assert.equal(snap.character.race, undefined);
});

test('secret values (Midnight) never drop the character or the pet', () => {
  const secretWow = `${FAKE_WOW}
    SECRET = setmetatable({}, { __tostring = function() return "secret" end })
    issecretvalue = function(v) return v == SECRET end
    UnitHealth = function() return SECRET end
    UnitHealthMax = function() return SECRET end
    UnitRace = function() return "Enana" end
    UnitXP = function() return 5120 end
    UnitXPMax = function() return 13600 end
    GetMoney = function() return 43712 end
    UnitAttackPower = function() return SECRET, 0, 0 end
    UnitRangedAttackPower = function() return 152, 10, 0 end
    GetCritChance = function() error("this API is broken here") end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], secretWow));
  assert.equal(snap.character.name, 'Sharp');
  assert.equal(snap.character.race, 'Enana');
  assert.equal(snap.character.xpPct, 38);
  assert.equal(snap.character.money, '4g 37s 12c');
  assert.equal(snap.character.healthPct, undefined);
  assert.equal(snap.pet.name, 'Garra');
  assert.equal(snap.pet.happiness, 'happy');
  assert.equal(snap.pet.healthPct, undefined);
  assert.equal(snap.stats.rangedAttackPower, 162);
  assert.equal(snap.stats.attackPower, undefined);
  assert.equal(snap.stats.critPct, undefined);
  // Only APIs this fake client really lacks show up as section errors.
  assert.deepEqual(Object.keys(snap.diagnostics).sort(), ['client', 'position']);
});

test('JSON encoder turns values it cannot read into null instead of failing', () => {
  const json = runLua(`
    local broken = setmetatable({}, { __len = function() error("secret value") end })
    local weird = setmetatable({}, { __pairs = function() error("secret table") end })
    issecretvalue = function(v) return v == "SECRET" end
    RESULT = ns.Json.Encode({ a = 1, b = broken, c = "ok", d = weird, e = "SECRET", f = { 1, 2 } })
  `, {}, ['Json.lua']);
  // `weird` looks empty to next(), so it is encoded as an empty list: also fine.
  assert.deepEqual(JSON.parse(json), { a: 1, b: null, c: 'ok', d: [], e: null, f: [1, 2] });
});

test('a section that fails is reported in diagnostics', () => {
  const broken = `${FAKE_WOW}
    C_Container.GetContainerItemInfo = function() error("boom") end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], broken));
  assert.equal(snap.inventory, undefined);
  assert.match(snap.diagnostics.inventory, /boom/);
});

test('quests carry the game map coordinates; items, race and lockouts are included', () => {
  const extra = `
    C_QuestLog.GetNextWaypoint = function(id) return 1426, 0.244, 0.391 end
    C_QuestLog.GetQuestsOnMap = function(map) if map == 1426 then return { { questID = 2928, x = 0.512, y = 0.633 } } end return {} end
    GetQuestUiMapID = function() return 1426 end
    C_Map = { GetMapInfo = function(id) return id == 1426 and { name = "Dun Morogh" } or nil end }
    UnitRace = function() return "Cielonata de la Suma Orden", "Skyborne" end
    GetNumSavedInstances = function() return 2 end
    GetSavedInstanceInfo = function(i)
      if i == 1 then return "La Ciudad Anegada", 1, 7200, 1, true, false, 0, false, 5, "Normal" end
      return "Gnomeregan", 2, 0, 1, false, false, 0, false, 5, "Normal"
    end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  const q = snap.quests[0];
  assert.deepEqual(q.where, { zone: 'Dun Morogh', x: 51.2, y: 63.3 });
  assert.deepEqual(q.waypoint, { zone: 'Dun Morogh', x: 24.4, y: 39.1 });
  assert.equal(q.rewardChoices[0].itemId, 9999, 'item id, to look it up in English');
  assert.equal(snap.gear[0].itemId, 3000);
  assert.equal(snap.character.raceToken, 'Skyborne');
  assert.deepEqual(snap.lockouts, [{ name: 'La Ciudad Anegada', players: 5, difficulty: 'Normal', resetHours: 2 }]);
});
// --- Linked items, open windows and recipes ------------------------------------

test('items linked in the question come with stats and the slots they replace', () => {
  const out = runLua(`
    local q = "Is " .. "|cff1eff00|Hitem:3000::::::::33:::::|h[Repetidora]|h|r" .. " better than "
      .. "|cff1eff00|Hitem:9999::::::::33:::::|h[Leotardos]|h|r" .. "? Or |cff71d5ff|Hspell:3044|h[Disparo arcano]|h|r"
    RESULT = ns.Json.Encode(ns.Collect:Links(q)) .. "#" .. ns.Collect.Clean(q)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW);
  const [json, clean] = out.split('#');
  const links = JSON.parse(json);
  assert.equal(links.length, 3);
  assert.equal(links[0].name, 'Repetidora de púas sepulcral');
  assert.deepEqual(links[0].slots, ['ranged']);
  assert.equal(links[0].stats.AGILITY, 4);
  assert.deepEqual(links[1].slots, ['legs']);
  assert.deepEqual(links[2], { kind: 'spell', name: 'Disparo arcano', id: 3044 });
  assert.equal(clean, 'Is [Repetidora] better than [Leotardos]? Or [Disparo arcano]');
});

test('links colored the newer way ("|cnIQ1:") are cleaned too', () => {
  // Exactly what WoW Forever put in the question box.
  const out = runLua(`
    local q = "que es esto? |cnIQ1:|Hitem:4306::::::::33:::::|h[Simple Wood]|h|r"
    local links = ns.Collect:Links(q)
    RESULT = ns.Collect.Clean(q) .. "#" .. links[1].name .. "#" .. tostring(links[1].itemId)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW);
  assert.equal(out, 'que es esto? [Simple Wood]#Paño de seda#4306');
});

test('open windows: vendor with prices and repair, quest reward choices; nothing when closed', () => {
  const extra = `
    GetMerchantNumItems = function() return 2 end
    GetMerchantItemInfo = function(i)
      if i == 1 then return "Repetidora de púas sepulcral", 0, 12345, 1, -1, true, true, false end
      return "Agua refrescante", 0, 25, 5, 3, true, true, false
    end
    GetMerchantItemLink = function(i) return i == 1 and "|Hitem:3000::::::::33:::::|h[x]|h" or nil end
    CanMerchantRepair = function() return true end
    GetRepairAllCost = function() return 5000 end
    GetTitleText = function() return "Excavadoras" end
    GetQuestID = function() return 2928 end
    GetRewardText = function() return "¡Gracias, |cffffff00amigo|r!" end
    GetRewardXP = function() return 3100 end
    GetRewardMoney = function() return 0 end
    GetNumQuestRewards = function() return 0 end
    GetNumQuestChoices = function() return 2 end
    GetQuestItemLink = function(kind, i) return i == 1 and "|Hitem:9999|h[a]|h" or "|Hitem:3000|h[b]|h" end
    GetQuestItemInfo = function(kind, i) return "x", 0, 1 end
  `;
  const out = runLua(`
    local closed = ns.Json.Encode(ns.Collect:Snapshot().screen or "none")
    ns.Collect.cache = {}
    ns.Collect.open.merchant = true
    ns.Collect.open.quest = "complete"
    RESULT = closed .. "#" .. ns.Json.Encode(ns.Collect:Snapshot().screen)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  const [closed, json] = out.split('#');
  assert.equal(closed, '"none"', 'nothing is sent while no window is open');
  const screen = JSON.parse(json);
  assert.equal(screen.merchant.items.length, 2);
  assert.equal(screen.merchant.items[0].price, '1g 23s 45c');
  assert.deepEqual(screen.merchant.items[0].slots, ['ranged']);
  assert.deepEqual(screen.merchant.items[1], { name: 'Agua refrescante', price: '0g 0s 25c', stack: 5, limited: 3 });
  assert.equal(screen.merchant.canRepair, true);
  assert.equal(screen.merchant.repairAllCost, '0g 50s 0c');
  assert.equal(screen.questReward.title, 'Excavadoras');
  assert.equal(screen.questReward.text, '¡Gracias, amigo!');
  assert.equal(screen.questReward.rewards.xp, 3100);
  assert.deepEqual(screen.questReward.rewards.choices.map((c) => c.slots[0]), ['legs', 'ranged']);
});

// --- More context: pet, Beast Training, skills, target, items, bars, errors -------

// WoW Forever style: pet functions in C_PetInfo, the pet's spellbook in C_SpellBook.
const PET_WOW = `
  GetPetHappiness = nil
  C_PetInfo = {
    GetPetHappiness = function() return 2, 100, 0 end,
    GetPetLoyalty = function() return "Loyalty Level 4 (Faithful)" end,
    GetPetTrainingPoints = function() return 120, 85 end,
    GetPetFoodTypes = function() return "Meat", "Fish" end,
  }
  Enum = { SpellBookSpellBank = { Player = 0, Pet = 1 }, SpellBookItemType = { Spell = 1, FutureSpell = 2, PetAction = 3 } }
  local petBook = {
    { name = "Attack", itemType = 3 },
    { name = "Claw", subName = "Rank 4", itemType = 1 },
    { name = "Growl", subName = "Rank 3", itemType = 1 },
    { name = "Great Stamina", subName = "Rank 2", itemType = 1, isPassive = true },
  }
  C_SpellBook = {
    HasPetSpells = function() return #petBook, "PET" end,
    GetSpellBookItemInfo = function(i, bank) return bank == 1 and petBook[i] or nil end,
    GetSpellBookItemAutoCast = function(i, bank) if i == 2 then return true, true end if i == 3 then return true, false end return false, false end,
  }
  GetPetActionInfo = function(i)
    if i == 1 then return "PET_ACTION_ATTACK", nil, true, false end
    if i == 8 then return "PET_MODE_DEFENSIVE", nil, true, true end
    if i == 9 then return "PET_MODE_PASSIVE", nil, true, false end
  end
  PET_MODE_DEFENSIVE = "Defensive"
  UnitStat = function(u, i) return 0, ({ 40, 60, 80, 20, 30 })[i] end
  UnitArmor = function(u) return 900, 1100 end
  UnitAttackPower = function(u) return 300, 20, 0 end
  UnitDamage = function(u) return 40.2, 55.9 end
  UnitAttackSpeed = function(u) return 2 end
  UnitResistance = function(u, i) return 0, i == 3 and 15 or 0 end
`;

test('the pet: abilities with rank and autocast, stance, loyalty, training points, diet and stats', () => {
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + PET_WOW));
  assert.deepEqual(snap.pet.abilities, ['Claw (Rank 4) [autocast on]', 'Growl (Rank 3) [autocast off]', 'Great Stamina (Rank 2) [passive]']);
  assert.equal(snap.pet.mode, 'Defensive');
  assert.equal(snap.pet.happiness, 'content');
  assert.equal(snap.pet.loyalty, 'Loyalty Level 4 (Faithful)');
  assert.deepEqual(snap.pet.trainingPoints, { available: 35, spent: 85 });
  assert.deepEqual(snap.pet.diet, ['Meat', 'Fish']);
  assert.deepEqual(snap.pet.stats, {
    strength: 40, agility: 60, stamina: 80, intellect: 20, spirit: 30,
    armor: 1100, attackPower: 320, damage: '40-55', attackSpeed: 2, resistances: { nature: 15 },
  });
});

test('Beast Training (a trainer window with no NPC in Forever) lists what the pet knows and what it can learn', () => {
  const extra = `
    UnitClass = function() return "Hunter", "HUNTER" end
    local lines = {
      { "Claw", "header", true, false },
      { "Bite", "header", true, false },
    }
    local expandedLines = {
      { "Claw", "header", true, true },
      { "Claw", "Rank 4", "used" },
      { "Claw", "Rank 5", "available", nil, 10, 40 },
      { "Bite", "header", true, true },
      { "Bite", "Rank 6", "unavailable", nil, 12, 40 },
    }
    local shown = lines
    GetNumTrainerServices = function() return #shown end
    GetTrainerServiceInfo = function(i) local l = shown[i]; return l[1], l[2] ~= "header" and l[2] or "", l[2] == "header" and "header" or l[3], l[4] end
    ExpandTrainerSkillLine = function(i) EXPANDED = i; shown = expandedLines end
    GetTrainerServiceCost = function(i) return 0, shown[i][5] or 0 end
    GetTrainerServiceLevelReq = function(i) return shown[i][6] or 1 end
    GetTrainerServiceSkillReq = function() return nil end
  `;
  const out = runLua(`
    ns.Collect.open.trainer = true
    local screen = ns.Collect:Snapshot().screen
    RESULT = ns.Json.Encode(screen) .. "#" .. tostring(EXPANDED) .. "#" .. ns.Json.Encode(ns.Collect:BeastTraining())
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + PET_WOW + extra);
  const [screenJson, expanded, rememberedJson] = out.split('#');
  const screen = JSON.parse(screenJson);
  assert.equal(expanded, '0', 'the collapsed categories were expanded');
  assert.equal(screen.trainer.beastTraining, true);
  assert.deepEqual(screen.trainer.services, [
    { name: 'Claw', rank: 'Rank 4', status: 'known' },
    { name: 'Claw', rank: 'Rank 5', status: 'available', trainingPoints: 10, level: 40 },
    { name: 'Bite', rank: 'Rank 6', status: 'unavailable', trainingPoints: 12, level: 40 },
  ]);
  const remembered = JSON.parse(rememberedJson);
  assert.equal(remembered.pet, 'Garra');
  assert.equal(remembered.petTrainingPoints, 35);
  assert.equal(remembered.abilities.length, 3);
});

test('a class trainer still lists only what can be learned', () => {
  const extra = `
    GetNumTrainerServices = function() return 2 end
    GetTrainerServiceInfo = function(i) if i == 1 then return "Serpent Sting", "Rank 2", "used" end return "Serpent Sting", "Rank 3", "available" end
    GetTrainerServiceCost = function(i) return 1200, false end
    GetTrainerServiceLevelReq = function() return 18 end
  `;
  const out = runLua(`
    ns.Collect.open.trainer = true
    RESULT = ns.Json.Encode(ns.Collect:Snapshot().screen.trainer)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + `UnitName = function(u) if u == "npc" then return "Hogger" end return "Sharp" end
    UnitExists = function(u) return u == "npc" or u == "player" end` + extra);
  assert.deepEqual(JSON.parse(out), {
    npc: 'Hogger', services: [{ name: 'Serpent Sting', rank: 'Rank 3', status: 'available', cost: '0g 12s 0c', level: 18 }],
  });
});

test('weapon skills from C_SkillInfo (WoW Forever), and rested XP as points plus % of the level', () => {
  const extra = `
    GetProfessions = function() return nil end
    local lines = {
      { skillName = "Professions", isHeader = true },
      -- WoW Forever lists professions and secondary skills twice.
      { skillName = "Mining", skillRank = 199, skillMaxRank = 225 },
      { skillName = "Mining", skillRank = 199, skillMaxRank = 225 },
      { skillName = "Weapon Skills", isHeader = true },
      { skillName = "Bows", skillRank = 150, skillMaxRank = 180 },
      { skillName = "Daggers", skillRank = 1, skillMaxRank = 180 },
    }
    C_SkillInfo = { GetNumSkillLines = function() return #lines end, GetSkillLineInfo = function(i) return lines[i] end }
    UnitXP = function() return 1150 end
    UnitXPMax = function() return 71600 end
    GetXPExhaustion = function() return 76 end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.deepEqual(snap.skills, [
    { name: 'Mining', rank: 199, max: 225, group: 'Professions' },
    { name: 'Bows', rank: 150, max: 180, group: 'Weapon Skills' },
    { name: 'Daggers', rank: 1, max: 180, group: 'Weapon Skills' },
  ]);
  assert.equal(snap.character.restedXp, 76);
  assert.equal(snap.character.restedPctOfLevel, 0.1);
});

test('the target: npc id, family, reaction, quest relation and tooltip lines', () => {
  const extra = `
    UnitExists = function(u) return u == "player" or u == "target" end
    UnitName = function(u) return u == "target" and "Snapjaw Crocolisk" or "Sharp" end
    UnitIsPlayer = function() return false end
    UnitGUID = function() return "Creature-0-AB12-0-CD34-1150-0000ABCDEF" end
    UnitCreatureFamily = function(u) return u == "target" and "Crocolisk" or nil end
    UnitReaction = function() return 2 end
    C_QuestLog.UnitIsRelatedToActiveQuest = function() return true end
    C_TooltipInfo = { GetUnit = function() return { lines = {
      { leftText = "Snapjaw Crocolisk" }, { leftText = "Level 35 Beast" },
      { leftText = "|cffffffffSnapjaw Hides: 3/8|r" }, { leftText = "Skinnable" },
    } } end }
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.equal(snap.target.npcId, 1150);
  assert.equal(snap.target.family, 'Crocolisk');
  assert.equal(snap.target.reaction, 'hostile');
  assert.equal(snap.target.questRelated, true);
  assert.deepEqual(snap.target.tooltip, ['Level 35 Beast', 'Snapjaw Hides: 3/8', 'Skinnable']);
});

test('items carry their Equip/Use effects and weapon speed from the tooltip', () => {
  const extra = `
    ITEM_SPELL_TRIGGER_ONEQUIP = "Equip:"
    ITEM_SPELL_TRIGGER_ONUSE = "Use:"
    ITEM_SET_BONUS = "Set: %s"
    C_TooltipInfo = { GetHyperlink = function(l)
      if l:find("item:3000") then return { lines = {
        { leftText = "Repetidora" }, { leftText = "45 - 68 Damage", rightText = "Speed 2.90" },
        { leftText = "Equip: Improves your chance to hit by 1%." }, { leftText = "Set: +10 Agility." },
      } } end
      return { lines = { { leftText = "Poción" }, { leftText = "Use: Restores 140 to 180 health." } } }
    end }
  `;
  const out = runLua(`
    local q = "|Hitem:3000|h[a]|h y |Hitem:858|h[b]|h"
    RESULT = ns.Json.Encode(ns.Collect:Links(q))
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  const [weapon, potion] = JSON.parse(out);
  assert.equal(weapon.weaponDamage, '45 - 68');
  assert.equal(weapon.weaponSpeed, 2.9);
  assert.deepEqual(weapon.effects, ['Equip: Improves your chance to hit by 1%.', 'Set: +10 Agility.']);
  assert.deepEqual(potion.effects, ['Use: Restores 140 to 180 health.']);
});

test('action bars with keys, and known spells that are on no bar', () => {
  const extra = `
    Enum = { SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1, FutureSpell = 2, Flyout = 4 } }
    local book = {
      { name = "Arcane Shot", subName = "Rank 1", itemType = 1 }, { name = "Serpent Sting", subName = "Rank 1", itemType = 1 },
      { name = "Aspect of the Hawk", itemType = 1 }, { name = "Volley", itemType = 2 },
      -- Not spells to list: a group of the spellbook (flyout) and the auto attack.
      { name = "Aspects", itemType = 4 }, { name = "Attack", itemType = 1, spellID = 6603 },
    }
    C_SpellBook = {
      GetNumSpellBookSkillLines = function() return 1 end,
      GetSpellBookSkillLineInfo = function() return { name = "Marksmanship", itemIndexOffset = 0, numSpellBookItems = #book } end,
      GetSpellBookItemInfo = function(i) return book[i] end,
      GetSpellBookItemLevelLearned = function(i) return i == 4 and 40 or 1 end,
    }
    local bar = { [1] = { "spell", 1 }, [2] = { "flyout", 7 }, [61] = { "macro", 3 } }
    HasAction = function(s) return bar[s] ~= nil end
    GetActionInfo = function(s) return bar[s][1], bar[s][2] end
    C_Spell = { GetSpellName = function(id) return id == 1 and "Arcane Shot" or nil end }
    GetFlyoutInfo = function() return "Aspect", "", 1 end
    GetFlyoutSlotInfo = function() return 9, 9, true, "Aspect of the Hawk" end
    GetMacroInfo = function() return "PetAttack" end
    GetBindingKey = function(b) if b == "ACTIONBUTTON1" then return "1" end if b == "MULTIACTIONBAR1BUTTON1" then return "SHIFT-1" end end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.deepEqual(snap.actionBars, ['Arcane Shot [1]', 'Aspect', 'macro PetAttack [SHIFT-1]']);
  assert.deepEqual(snap.spellsNotOnBars, ['Serpent Sting']);
  assert.deepEqual(snap.spells, [{ tab: 'Marksmanship', spells: ['Arcane Shot (Rank 1)', 'Serpent Sting (Rank 1)', 'Aspect of the Hawk'], notLearned: ['Volley (level 40)'] }]);
});

test('a spell used only through a macro counts as on the bars', () => {
  const extra = `
    Enum = { SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1, FutureSpell = 2 } }
    local book = {
      { name = "Judgement", itemType = 1 }, { name = "Seal of Command", subName = "Rank 2", itemType = 1 },
      { name = "Crusader Strike", itemType = 1 }, { name = "Hammer of Wrath", subName = "Rank 1", itemType = 1 },
      { name = "Holy Light", subName = "Rank 4", itemType = 1 }, { name = "Divine Shield", itemType = 1 },
    }
    C_SpellBook = {
      GetNumSpellBookSkillLines = function() return 1 end,
      GetSpellBookSkillLineInfo = function() return { name = "Retribution", itemIndexOffset = 0, numSpellBookItems = #book } end,
      GetSpellBookItemInfo = function(i) return book[i] end,
      GetSpellBookItemLevelLearned = function() return 1 end,
    }
    local macros = {
      [1] = { "Ret", "#showtooltip\\n/cast [@target,harm][] Judgement\\n/castsequence reset=target Seal of Command(Rank 2), crusader strike" },
      [2] = { "Heal", "/cast [@mouseover,help][] !Holy Light" },
      [3] = { "Bubble", "/stopcasting" },
    }
    local bar = { [1] = { "macro", 1 }, [2] = { "macro", 2 }, [3] = { "macro", 3 } }
    HasAction = function(s) return bar[s] ~= nil end
    GetActionInfo = function(s) return bar[s][1], bar[s][2] end
    GetMacroInfo = function(i) return macros[i][1], 134400, macros[i][2] end
    -- The spell the game shows for a macro (its #showtooltip or first /cast).
    GetMacroSpell = function(i) if i == 3 then return 642 end end
    C_Spell = { GetSpellName = function(id) return id == 642 and "Divine Shield" or nil end }
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.deepEqual(snap.actionBars, ['macro Ret (Judgement)', 'macro Heal (Holy Light)', 'macro Bubble (Divine Shield)']);
  assert.deepEqual(snap.spellsNotOnBars, ['Hammer of Wrath'], 'only the spell that is really on no bar or macro');
});

test('newer clients: a macro slot gives the spell it shows, and the macro is found by its name', () => {
  const extra = `
    Enum = { SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1, FutureSpell = 2 } }
    local book = {
      { name = "Judgement", itemType = 1 }, { name = "Seal of Command", subName = "Rank 2", itemType = 1 },
      { name = "Blessing of Might", subName = "Rank 3", itemType = 1 }, { name = "Hammer of Wrath", subName = "Rank 1", itemType = 1 },
    }
    C_SpellBook = {
      GetNumSpellBookSkillLines = function() return 1 end,
      GetSpellBookSkillLineInfo = function() return { name = "Retribution", itemIndexOffset = 0, numSpellBookItems = #book } end,
      GetSpellBookItemInfo = function(i) return book[i] end,
      GetSpellBookItemLevelLearned = function() return 1 end,
    }
    -- Slot 2: a macro showing Judgement (spell 20271); slot 150: a macro on a newer bar.
    local bar = { [2] = { "macro", 20271, "spell" }, [150] = { "macro", 19835, "spell" } }
    HasAction = function(s) return bar[s] ~= nil end
    GetActionInfo = function(s) return bar[s][1], bar[s][2], bar[s][3] end
    GetActionText = function(s) return s == 2 and "Ret" or s == 150 and "Buff" or nil end
    local macros = { Ret = 7, Buff = 8 }
    GetMacroIndexByName = function(name) return macros[name] or 0 end
    local bodies = { [7] = { "Ret", "/cast Judgement\\n/cast Seal of Command" }, [8] = { "Buff", "/cast [@target,help][] Blessing of Might" } }
    -- Asked with the spell id, as a macro index it is nothing.
    GetMacroInfo = function(i) local m = bodies[i]; if m then return m[1], 1, m[2] end end
    C_Spell = { GetSpellName = function(id) return id == 20271 and "Judgement" or id == 19835 and "Blessing of Might" or nil end }
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.deepEqual(snap.actionBars, ['macro Ret (Judgement)', 'macro Buff (Blessing of Might)']);
  assert.deepEqual(snap.spellsNotOnBars, ['Hammer of Wrath']);
});

test('auras, stances and forms on the stance bar count as on the bars', () => {
  const extra = `
    Enum = { SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1, FutureSpell = 2 } }
    local book = {
      { name = "Judgement", itemType = 1 }, { name = "Devotion Aura", subName = "Rank 3", itemType = 1 },
      { name = "Retribution Aura", subName = "Rank 2", itemType = 1 }, { name = "Concentration Aura", itemType = 1 },
      { name = "Hammer of Wrath", subName = "Rank 1", itemType = 1 },
    }
    C_SpellBook = {
      GetNumSpellBookSkillLines = function() return 1 end,
      GetSpellBookSkillLineInfo = function() return { name = "Retribution", itemIndexOffset = 0, numSpellBookItems = #book } end,
      GetSpellBookItemInfo = function(i) return book[i] end,
      GetSpellBookItemLevelLearned = function() return 1 end,
    }
    local bar = { [1] = { "spell", 20271 } }
    HasAction = function(s) return bar[s] ~= nil end
    GetActionInfo = function(s) return bar[s][1], bar[s][2] end
    local names = { [20271] = "Judgement", [10292] = "Devotion Aura", [10299] = "Retribution Aura" }
    C_Spell = { GetSpellName = function(id) return names[id] end }
    -- Newer clients: icon, active, castable, spellID. Older ones: icon, name, active, castable.
    local stances = { { 1, true, true, 10292 }, { 2, false, true, 10299 }, { 3, "Concentration Aura", false, true } }
    GetNumShapeshiftForms = function() return #stances end
    GetShapeshiftFormInfo = function(i) return table.unpack(stances[i]) end
  `;
  const snap = JSON.parse(runLua('RESULT = ns.Json.Encode(ns.Collect:Snapshot())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.deepEqual(snap.actionBars, ['Judgement']);
  assert.deepEqual(snap.spellsNotOnBars, ['Hammer of Wrath'], 'the auras are on the stance bar');
});

test('recipes of the modern profession window on WoW Forever: the profession from the base info when the child one is blank', () => {
  const extra = `
    -- The game also takes item ids (the reagents come as ids).
    local byLink = C_Item.GetItemInfo
    C_Item.GetItemInfo = function(x)
      if type(x) == "number" then return ({ [2772] = "Iron Ore" })[x] end
      return byLink(x)
    end
    local recipes = {
      [1] = { name = "Smelt Iron", learned = true, relativeDifficulty = 1 },
      [2] = { name = "Smelt Mithril", learned = false, relativeDifficulty = 0 },
      [3] = { name = "Lodestone", learned = true, relativeDifficulty = 3 },
    }
    C_TradeSkillUI = {
      -- Forever: a blank child profession, the real one in the base info.
      GetChildProfessionInfo = function() return { professionName = "", skillLevel = 0 } end,
      GetBaseProfessionInfo = function() return { professionName = "Mining", skillLevel = 206, maxSkillLevel = 300 } end,
      GetAllRecipeIDs = function() return { 1, 2, 3 } end,
      GetRecipeInfo = function(id) return recipes[id] end,
      GetRecipeSchematic = function(id)
        return { reagentSlotSchematics = { { quantityRequired = 1, reagents = { { itemID = 2772 } } } } }
      end,
    }
  `;
  const out = runLua('RESULT = ns.Json.Encode(ns.Collect:Recipes("trade"))', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  assert.deepEqual(JSON.parse(out), {
    profession: 'Mining', rank: 206, max: 300,
    recipes: [{ name: 'Smelt Iron', difficulty: 'yellow', reagents: '1x Iron Ore' }, { name: 'Lodestone', difficulty: 'grey' }],
  });
});

test('recent red error messages and deaths go along for a while', () => {
  const extra = `
    FRAMES = {}
    CreateFrame = function()
      local f = { events = {} }
      function f:RegisterEvent(e) self.events[e] = true end
      function f:SetScript(_, fn) self.onEvent = fn end
      FRAMES[#FRAMES + 1] = f
      return f
    end
    function FIRE(event, ...)
      for _, f in ipairs(FRAMES) do if f.events[event] and f.onEvent then f.onEvent(f, event, ...) end end
    end
    NOW = 1000
    GetTime = function() return NOW end
    GetRealZoneText = function() return "Stranglethorn Vale" end
    GetSubZoneText = function() return "" end
  `;
  const snap = JSON.parse(runLua(`
    FIRE("UI_ERROR_MESSAGE", 50, "Out of range.")
    FIRE("UI_ERROR_MESSAGE", 51, "Your pet is dead.")
    FIRE("UI_ERROR_MESSAGE", 50, "Out of range.")
    FIRE("PLAYER_DEAD")
    NOW = 1000 + 5 * 60
    RESULT = ns.Json.Encode(ns.Collect:Snapshot())
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra));
  assert.deepEqual(snap.recentErrors, [
    { text: 'Out of range.', minutesAgo: 5 },
    { text: 'Your pet is dead.', minutesAgo: 5 },
  ]);
  assert.deepEqual(snap.recentDeaths, [{ minutesAgo: 5, zone: 'Stranglethorn Vale', level: 33 }]);
});

test('the open flight map lists where the player can fly and the cost', () => {
  const extra = (withEnum) => `
    ${withEnum ? 'Enum = { FlightPathState = { Current = 0, Reachable = 1, Unreachable = 2 } }' : ''}
    C_TaxiMap = { GetAllTaxiNodes = function() return {
      { name = "Stormwind, Elwynn", state = 0, slotIndex = 1 },
      { name = "Booty Bay, Stranglethorn", state = 1, slotIndex = 2 },
      { name = "Thelsamar, Loch Modan", state = 2, slotIndex = 3 },
    } end }
    GetTaxiMapID = function() return 13 end
    TaxiNodeCost = function(i) return i == 2 and 4500 or 0 end
    GetNumRoutes = function(i) return i == 2 and 3 or 1 end
  `;
  for (const withEnum of [true, false]) {
    const out = runLua(`
      ns.Collect.open.taxi = true
      RESULT = ns.Json.Encode(ns.Collect:Snapshot().screen.flightMap)
    `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra(withEnum));
    assert.deepEqual(JSON.parse(out), {
      from: 'Stormwind, Elwynn', destinations: [{ name: 'Booty Bay, Stranglethorn', cost: '0g 45s 0c', stops: 3 }],
    }, withEnum ? 'with Enum.FlightPathState' : 'without it: the same numbers');
  }
});

test('flight points: per continent, the ones the player can fly to and the ones not discovered yet', () => {
  const extra = `
    Enum = { FlightPathState = { Current = 0, Reachable = 1, Unreachable = 2 }, UIMapType = { Continent = 2, Zone = 3 } }
    local maps = {
      [1437] = { name = "Wetlands", mapType = 3, parentMapID = 1415 },
      [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 },
      [1414] = { name = "Kalimdor", mapType = 2, parentMapID = 947 },
      [947] = { name = "Azeroth", mapType = 1 },
    }
    C_Map = { GetBestMapForUnit = function() return 1437 end, GetMapInfo = function(id) return maps[id] end }
    UnitFactionGroup = function() return "Alliance", "Alianza" end
    C_TaxiMap = {
      -- The flight master's map in Menethil Harbor: 0 = here, 1 = can fly there, 2 = not discovered.
      GetAllTaxiNodes = function() return {
        { nodeID = 7, name = "Menethil Harbor, Wetlands", state = 0, slotIndex = 1 },
        { nodeID = 6, name = "Ironforge, Dun Morogh", state = 1, slotIndex = 2 },
        { nodeID = 8, name = "Thelsamar, Loch Modan", state = 2, slotIndex = 3 },
        { nodeID = 19, name = "Booty Bay, Stranglethorn", state = 2, slotIndex = 4 },
        { nodeID = 10, name = "Undercity, Tirisfal", state = 2, slotIndex = 5 },
        { nodeID = 99, name = "zzOLDPowderfuse Port, Riverglades", state = 2, slotIndex = 6 }, -- no longer used
      } end,
      -- Every flight point of a continent, both factions (2 Alliance, 1 Horde, 0 neutral),
      -- named in the client's language now.
      GetTaxiNodesForMap = function(id)
        if id == 1415 then return {
          { nodeID = 7, name = "Puerto de Menethil, Los Humedales", faction = 2 },
          { nodeID = 6, name = "Forjaz, Dun Morogh", faction = 2 },
          { nodeID = 8, name = "Thelsamar, Loch Modan", faction = 2 },
          { nodeID = 19, name = "Bahía del Botín, Tuercespina", faction = 0 },
          { nodeID = 10, name = "Entrañas, Tirisfal", faction = 1 },
        } end
        if id == 1414 then return {
          { nodeID = 26, name = "Auberdine, Darkshore", faction = 2 },
          { nodeID = 22, name = "Thunder Bluff, Mulgore", faction = 1 },
        } end
      end,
    }
  `;
  const out = runLua(`
    -- The older list (names only) from before.
    local data = { flightPaths = { ["Auberdine, Darkshore"] = true, ["Ironforge, Dun Morogh"] = true } }
    ns.Core = { CharData = function() return data end }
    local status = ns.Collect.FlightMapStatus()
    -- What Core:RememberFlightPaths keeps for the continent.
    data.flights = { [status.continent] = { name = status.name, seenAt = "2026-11-18 10:00", known = status.known, notKnown = status.notKnown } }
    RESULT = ns.Json.Encode(status) .. "#" .. ns.Json.Encode(ns.Collect:Snapshot().flightPaths)
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  const [status, sent] = out.split('#').map((j) => JSON.parse(j));
  assert.deepEqual(status, {
    continent: 1415, name: 'Eastern Kingdoms',
    known: [{ id: 7, name: 'Menethil Harbor, Wetlands' }, { id: 6, name: 'Ironforge, Dun Morogh' }],
    notKnown: [{ id: 8, name: 'Thelsamar, Loch Modan' }, { id: 19, name: 'Booty Bay, Stranglethorn' }, { id: 10, name: 'Undercity, Tirisfal' }],
  });
  assert.deepEqual(sent, [
    // No flight master's map seen there yet: what the older list had on that continent.
    { continent: 'Kalimdor', notChecked: true, known: ['Auberdine, Darkshore'] },
    // Today's names; the other faction's flight point is left out.
    {
      continent: 'Eastern Kingdoms', seenAt: '2026-11-18 10:00',
      known: ['Forjaz, Dun Morogh', 'Puerto de Menethil, Los Humedales'],
      notKnown: ['Bahía del Botín, Tuercespina', 'Thelsamar, Loch Modan'],
    },
  ]);
});

test('flight points on older clients: DISTANT ones are not discovered yet', () => {
  const extra = `
    local nodes = { { "Stormwind, Elwynn", "CURRENT" }, { "Lakeshire, Redridge", "REACHABLE" }, { "Darkshire, Duskwood", "DISTANT" }, { "?", "NONE" } }
    NumTaxiNodes = function() return #nodes end
    TaxiNodeName = function(i) return nodes[i][1] end
    TaxiNodeGetType = function(i) return nodes[i][2] end
  `;
  const out = runLua('RESULT = ns.Json.Encode(ns.Collect.FlightMapStatus())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  assert.deepEqual(JSON.parse(out), {
    continent: 0, known: [{ name: 'Stormwind, Elwynn' }, { name: 'Lakeshire, Redridge' }], notKnown: [{ name: 'Darkshire, Duskwood' }],
  });
});

test('the open auction house: results, the item searched, my auctions; prices seen are sent for my items', () => {
  const extra = `
    C_AuctionHouse = {
      GetBrowseResults = function() return {
        { itemKey = { itemID = 4306 }, minPrice = 1500, totalQuantity = 340 },
        { itemKey = { itemID = 9999 }, minPrice = 98000, totalQuantity = 2 },
      } end,
      GetItemKeyInfo = function(key)
        local names = { [4306] = "Paño de seda", [9999] = "Leotardos de cuero", [858] = "Poción de sanación inferior" }
        return { itemName = names[key.itemID] }
      end,
      GetNumCommoditySearchResults = function() return 2 end,
      GetCommoditySearchResultInfo = function(id, i) return { unitPrice = i == 1 and 1400 or 1550, quantity = i == 1 and 20 or 200 } end,
      GetNumOwnedAuctions = function() return 1 end,
      GetOwnedAuctionInfo = function() return { itemKey = { itemID = 858 }, quantity = 5, buyoutAmount = 2500, status = 0 } end,
    }
  `;
  const out = runLua(`
    ns.Collect.open.auction = true
    ns.Core = {
      CharData = function() return {} end,
      Prices = function() return { [4306] = { name = "Paño de seda", unit = 1400, seenAt = "2026-11-16 10:00" },
                                   [12345] = { name = "Not mine", unit = 5, seenAt = "2026-11-16 10:00" } } end,
    }
    local snap = ns.Collect:Snapshot()
    RESULT = ns.Json.Encode(snap.screen.auction) .. "#" .. ns.Json.Encode(snap.auctionPrices) .. "#" .. ns.Json.Encode(ns.Collect:AuctionPrices())
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  const [auctionJson, pricesJson, seenJson] = out.split('#');
  const auction = JSON.parse(auctionJson);
  assert.deepEqual(auction.results, [
    { name: 'Paño de seda', itemId: 4306, quantity: 340, price: '0g 15s 0c' },
    { name: 'Leotardos de cuero', itemId: 9999, quantity: 2, price: '9g 80s 0c' },
  ]);
  assert.deepEqual(auction.myAuctions, [{ name: 'Poción de sanación inferior', itemId: 858, quantity: 5, price: '0g 5s 0c' }]);
  // Only items in the bags or bank get their remembered price.
  assert.deepEqual(JSON.parse(pricesJson), [{ name: 'Paño de seda', itemId: 4306, price: '0g 14s 0c', seenAt: '2026-11-16 10:00' }]);
  assert.deepEqual(JSON.parse(seenJson).map((p) => [p.itemId, p.unit]), [[4306, 1500], [9999, 98000]]);
});

test('the classic auction house window is read too', () => {
  const extra = `
    GetNumAuctionItems = function(kind) return kind == "list" and 2 or 0 end
    GetAuctionItemInfo = function(kind, i)
      if i == 1 then return "Paño de seda", 0, 20, 1, true, 0, nil, 1000, 0, 30000, 0, false, nil, "x", nil, 0, 4306 end
      return "Paño de seda", 0, 10, 1, true, 0, nil, 500, 0, 12000, 0, false, nil, "y", nil, 0, 4306
    end
  `;
  const out = runLua(`
    ns.Collect.open.auction = true
    RESULT = ns.Json.Encode(ns.Collect:Snapshot().screen.auction) .. "#" .. ns.Json.Encode(ns.Collect:AuctionPrices())
  `, {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  const [auctionJson, seenJson] = out.split('#');
  assert.deepEqual(JSON.parse(auctionJson).results[1], { name: 'Paño de seda', itemId: 4306, quantity: 10, price: '0g 12s 0c', bid: '0g 5s 0c' });
  assert.deepEqual(JSON.parse(seenJson), [{ itemId: 4306, name: 'Paño de seda', quantity: 10, unit: 1200, bid: 500 }], 'cheapest per item');
});

test('recipes of the open profession window, with skill-up color and reagents', () => {
  const extra = `
    GetTradeSkillLine = function() return "Herrería", 75, 150 end
    local lines = {
      { "Hojas", "header" },
      { "Espada de cobre", "optimal", 2, { { "Barra de cobre", 6 }, { "Piedra de afilar", 1 } } },
      { "Barra de cobre pulida", "trivial", 10 },
    }
    GetNumTradeSkills = function() return #lines end
    GetTradeSkillInfo = function(i) return lines[i][1], lines[i][2], lines[i][3] or 0 end
    GetTradeSkillNumReagents = function(i) return lines[i][4] and #lines[i][4] or 0 end
    GetTradeSkillReagentInfo = function(i, j) local r = lines[i][4][j]; return r[1], 0, r[2] end
  `;
  const json = runLua('RESULT = ns.Json.Encode(ns.Collect:Recipes())', {}, ['Json.lua', 'Collect.lua'], FAKE_WOW + extra);
  assert.deepEqual(JSON.parse(json), {
    profession: 'Herrería', rank: 75, max: 150,
    recipes: [
      { name: 'Espada de cobre', difficulty: 'orange', canMake: 2, reagents: '6x Barra de cobre, 1x Piedra de afilar' },
      { name: 'Barra de cobre pulida', difficulty: 'grey', canMake: 10 },
    ],
  });
});

// The combat model: the contract between the AI (which writes one from the
// character's real tooltips, talents and stats) and the simulator
// (sim/engine.js, which crunches the numbers). MODEL_SPEC goes into the AI's
// instructions word for word, so it is written for the model as much as for
// the people maintaining the engine: change the two together.
//
// Everything is plain JSON: no formulas or expressions to parse. Unknown
// fields are ignored and missing ones take the defaults below, so a model can
// start small.

export const MODEL_VERSION = 1;

export const MODEL_SPEC = `### Combat model format (JSON)
{
  "version": 1,
  "kind": "damage" | "healing",
  "fight": {
    "duration": 180,          // seconds per fight
    "targets": 1,             // enemies in reach
    "targetLevel": 63,        // 63 = raid boss for a level 60; a dungeon boss is the player's level + 2
    "targetArmor": 3700,      // 0 for a caster model
    "executePct": 20          // the target's health falls evenly from 100% to 0% over the fight
  },
  "player": {
    "level": 60,
    "stats": {                // totals as the character sheet shows them, buffs the player always has included
      "attackPower": 0, "rangedAttackPower": 0, "spellPower": 0, "healingPower": 0,
      "critPct": 0, "rangedCritPct": 0, "spellCritPct": 0,
      "hitPct": 0, "spellHitPct": 0,
      "hastePct": 0           // weapon swing speed only; faster casting is a "castHastePct" modifier
    },
    "weapons": {              // null when not used. The weapon's OWN damage range, as on the item's tooltip:
                              // the simulator adds attackPower / 14 * speed to every weapon hit itself,
                              // and halves off-hand hits itself
      "mainHand": { "min": 0, "max": 0, "speed": 0 },
      "offHand": null,
      "ranged": null
    },
    "autoAttack": "melee" | "ranged" | "none",
    "resource": {
      "type": "mana" | "rage" | "energy" | "none",
      "max": 100,
      "start": 100,                                  // rage starts at 0
      "regenPerSec": 0,                              // steady regeneration (mana while casting)
      "tick": { "amount": 20, "interval": 2 },       // or null: regeneration in ticks (energy)
      "perSwing": {                                  // or null: resource from auto attacks that hit (rage)
        "perDamage": 0,                              // per point of damage dealt
        "perWeaponSpeed": 0,                         // per second of the weapon's speed
        "flat": 0,
        "critMult": 1                                // multiplier on a critical auto attack
      }
    },
    "critMultiplier": { "melee": 2, "ranged": 2, "spell": 1.5, "heal": 1.5 },
    "modifiers": [ MODIFIER ],                       // always on: talents, set bonuses, passives
    "threatMultiplier": 1                            // threat per point of damage from a stance, Righteous Fury,
                                                     // threat talents and the like, all together (1.3 = 30% more)
  },
  "enemy": {                  // tanks only ("role": "tank"): the enemy whose hits the player has to survive
    "level": 63,
    "meleeHit": 0,            // one ordinary melee hit before armor, as an estimate
    "attackSpeed": 2.0,       // seconds between its melee swings
    "magicDps": 0             // steady magic damage per second it deals, when you know of any; else 0
  },
  "abilities": [ ABILITY ],
  "buffs": [ BUFF ],
  "procs": [ PROC ],
  "statConversions": {        // what one point of a primary stat gives THIS character
    "strength": { "attackPower": 2 },
    "agility": { "attackPower": 1, "critPct": 0.05 },
    "intellect": { "spellCritPct": 0.0168 }
  },
  "rotations": [ { "name": "short label", "actions": [ ACTION ] } ]
}

ABILITY = {
  "id": "bloodthirst",        // your own short id, lowercase, unique
  "name": "Bloodthirst",      // exactly as in the spell data you were given
  "spellId": 23881,           // from the spell data when present, else omit
  "type": "melee" | "ranged" | "spell" | "heal",
  "school": "physical" | "holy" | "fire" | "nature" | "frost" | "shadow" | "arcane",
  "cost": 30,                 // resource spent
  "gain": 0,                  // resource gained on use
  "castTime": 0,              // seconds; 0 = instant
  "gcd": 1.5,                 // 0 = off the global cooldown
  "cooldown": 6,
  "nextSwing": false,         // true = replaces the next main-hand auto attack (Heroic Strike style)
  "damage": {                 // per use (per tick when "channelTicks" > 0); null for none
    "min": 0, "max": 0,       // base damage BEFORE attack power / spell power scaling
    "apCoef": 0,              // + attackPower * apCoef (rangedAttackPower for "ranged")
    "spCoef": 0,              // + spellPower * spCoef (healingPower for "heal")
    "weaponPct": 0,           // + weaponPct% of a weapon hit (100 = one weapon swing)
    "weapon": "mainHand",     // which weapon "weaponPct" uses
    "normalizedSpeed": 0      // > 0: weapon damage uses this speed for its attack power part (instant attacks)
  },
  "channelTicks": 0,          // > 0: "castTime" is the channel's length and "damage" lands this many times
  "dot": {                    // or null: periodic effect applied on hit
    "tickDamage": 0, "apCoefPerTick": 0, "spCoefPerTick": 0,
    "interval": 3, "duration": 15, "canCrit": false, "maxStacks": 1
  },
  "canCrit": true, "canMiss": true, "ignoresArmor": false,
  "maxTargets": 1,            // enemies hit, up to fight.targets
  "threatMultiplier": 1,      // the ability's own threat per point of its damage ("causes 20% additional threat" = 1.2)
  "threat": 0,                // flat threat each time it lands, where the tooltip or a Forever source gives one.
                              // Threat = (damage * threatMultiplier + threat) * player.threatMultiplier
  "applies": [ "buffId" ],    // buffs or debuffs started (or refreshed, +1 stack) when it lands
  "consumes": [ "buffId" ],   // buffs removed when used
  "requires": CONDITION       // can only be used while this holds (e.g. target below 20% health)
}

BUFF = {
  "id": "flurry", "name": "Flurry",
  "onTarget": false,          // true = a debuff on the enemy
  "duration": 15,             // 0 = lasts the whole fight
  "maxStacks": 1,
  "charges": 0,               // > 0: ends after this many of "chargeOn"
  "chargeOn": "swing" | "ability" | "spell",
  "initial": false,           // true = already active when the fight starts
  "modifiers": [ MODIFIER ]   // per stack
}

MODIFIER = {
  "stat": "attackPower" | "attackPowerPct" | "spellPower" | "spellPowerPct" | "critPct" | "spellCritPct"
        | "hitPct" | "spellHitPct" | "hastePct" | "castHastePct" | "damagePct" | "critDamagePct"
        | "costPct" | "armorIgnorePct" | "targetArmor" | "resourceRegenPct",
  "value": 10,                // percentages as whole numbers: 10 = +10%, -15 = 15% less
  "school": "fire",           // optional filters: only this school,
  "types": [ "melee" ],       // only these ability types ("melee", "ranged", "spell", "heal", "auto"),
  "abilities": [ "id" ]       // only these abilities
}

PROC = {
  "id": "windfury", "name": "Windfury Weapon",
  "trigger": "meleeHit" | "meleeCrit" | "swing" | "rangedHit" | "spellHit" | "spellCrit" | "spellCast"
           | "anyHit" | "anyCrit" | "dotTick" | "abilityUse",
  "abilities": [ "id" ],      // optional: only these abilities trigger it
  "chance": 0.2,              // 0..1 per trigger; or use "ppm" (procs per minute, melee and ranged only)
  "ppm": 0,
  "icd": 0,                   // seconds before it can trigger again
  "effect": {
    "damage": { "min": 0, "max": 0, "apCoef": 0, "spCoef": 0, "school": "nature", "canCrit": true },
    "buff": "buffId",
    "resource": 0,
    "extraAttacks": 0,        // extra main-hand swings
    "resetCooldown": "abilityId"
  }
}

ACTION = { "use": "abilityId", "if": CONDITION }   // "if" optional. The first action that can be used is used.

CONDITION = an object; every key in it must hold:
  "resourceAtLeast": 50, "resourceBelow": 80,
  "buffUp": "id", "buffDown": "id",                 // a buff, a debuff or an ability's "dot" by the ability's id
  "buffStacksAtLeast": { "id": "x", "n": 3 }, "buffRemainsBelow": { "id": "x", "sec": 3 },
  "cooldownUp": "abilityId", "cooldownRemainsAbove": { "id": "abilityId", "sec": 4 },
  "targetHealthBelow": 20, "targetHealthAbove": 20,
  "timeAtLeast": 5, "timeRemainingBelow": 20, "targetsAtLeast": 3,
  "swingTimerAbove": 1.0,                           // seconds until the next main-hand auto attack
  "any": [ CONDITION ], "not": CONDITION`;

// Stats the engine can move one at a time to get stat weights (see
// sim/engine.js statWeights). Primary stats go through "statConversions".
export const WEIGHT_STATS = [
  'attackPower', 'rangedAttackPower', 'spellPower', 'healingPower',
  'critPct', 'rangedCritPct', 'spellCritPct', 'hitPct', 'spellHitPct', 'hastePct',
  'strength', 'agility', 'intellect', 'spirit', 'stamina',
];

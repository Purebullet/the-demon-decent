
// Base stats for the regular enemies. Floor tuning (LevelData.js) multiplies
// hp, damage, speed, windup and cooldown on top of these.
//
// Attack volumes are boxes in the enemy's local space (+Z is forward) that
// are live only during the strike frames. `lunge` moves the enemy forward
// during the strike; negative knockback yanks the player in. A `projectile`
// attack throws fireballs from the model's staff tip instead.

export const ENEMY_TYPES = {
  ghoul: {
    name: 'Husk Ghoul',
    asset: 'ghoul',
    hp: 38,
    dmg: 8,
    speed: 4.1,
    radius: 0.4,
    poise: 22,
    mass: 1,
    role: 'swarmer',
    swarmer: true,
    cooldown: 1.0,
    turnRate: 9,
    stride: 2.6,
    loot: { potion: 0.14, weapon: 0.05, spell: 0.012 },
    attacks: [
      { name: 'claw', windup: 0.45, strike: 0.16, recover: 0.5, dmg: 1, minRange: 0, maxRange: 1.9, volume: { c: [0, 0.9, 0.85], h: [0.55, 0.55, 0.65] }, lunge: 3, knockback: 2 },
      { name: 'pounce', windup: 0.55, strike: 0.36, recover: 0.65, dmg: 1.35, minRange: 3, maxRange: 6, volume: { c: [0, 0.8, 0.55], h: [0.45, 0.55, 0.55] }, lunge: 11, knockback: 4 },
    ],
  },
  fiend: {
    name: 'Chain Fiend',
    asset: 'fiend',
    hp: 72,
    dmg: 13,
    speed: 3.4,
    radius: 0.5,
    poise: 45,
    mass: 1.6,
    role: 'flanker',
    cooldown: 1.5,
    turnRate: 6,
    stride: 2.0,
    loot: { potion: 0.22, weapon: 0.1, spell: 0.035 },
    attacks: [
      { name: 'sweep', windup: 0.65, strike: 0.22, recover: 0.7, dmg: 1, minRange: 0, maxRange: 3.0, volume: { c: [0, 1.0, 1.5], h: [1.7, 0.6, 1.4] }, lunge: 0, knockback: 3.5 },
      { name: 'lash', windup: 0.75, strike: 0.2, recover: 0.75, dmg: 0.85, minRange: 2.4, maxRange: 4.6, volume: { c: [0, 1.1, 2.8], h: [0.4, 0.45, 2.0] }, lunge: 0, knockback: -7 },
    ],
  },
  brute: {
    name: 'Flame-Horned Brute',
    asset: 'brute',
    hp: 170,
    dmg: 22,
    speed: 2.6,
    radius: 0.65,
    poise: 100,
    mass: 3,
    role: 'bruiser',
    cooldown: 2.0,
    turnRate: 3.5,
    stride: 1.6,
    loot: { potion: 0.45, weapon: 0.3, spell: 0.08 },
    attacks: [
      { name: 'slam', windup: 0.95, strike: 0.18, recover: 1.0, dmg: 1, minRange: 0, maxRange: 2.7, volume: { c: [0, 0.8, 1.7], h: [0.6, 1.0, 1.1] }, lunge: 1.5, knockback: 5, aoe: { at: [0, 2.0], radius: 2.8, dmg: 0.45 } },
      { name: 'sweep', windup: 0.7, strike: 0.2, recover: 0.85, dmg: 0.8, minRange: 0, maxRange: 2.5, volume: { c: [0, 1.2, 1.3], h: [1.6, 0.6, 1.0] }, lunge: 0, knockback: 9 },
    ],
  },
  hound: {
    // Fast pack hunter of the hotter floors: darts in, bites, and pounces from
    // range. Too quick to outrun; dodge the pounce and punish the landing.
    name: 'Cinder Hound',
    asset: 'hound',
    hp: 34,
    dmg: 9,
    speed: 6.2,
    radius: 0.45,
    poise: 18,
    mass: 0.9,
    role: 'swarmer',
    swarmer: true,
    cooldown: 0.8,
    turnRate: 10,
    stride: 2.2,
    loot: { potion: 0.12, weapon: 0.04, spell: 0.012 },
    attacks: [
      { name: 'bite', windup: 0.35, strike: 0.14, recover: 0.45, dmg: 1, minRange: 0, maxRange: 2.0, volume: { c: [0, 0.6, 1.1], h: [0.4, 0.4, 0.6] }, lunge: 4, knockback: 2 },
      { name: 'pounce', windup: 0.5, strike: 0.38, recover: 0.7, dmg: 1.4, minRange: 3.5, maxRange: 7.5, volume: { c: [0, 0.7, 0.9], h: [0.45, 0.5, 0.7] }, lunge: 13, knockback: 5 },
    ],
  },
  witch: {
    // Ranged caster: keeps her distance and hurls hellfire from her staff
    // (three bolts at once on the deep floors); a fire burst throws you off
    // her if you close in. Fragile once you reach her.
    name: 'Pyre Witch',
    asset: 'witch',
    hp: 58,
    dmg: 12,
    speed: 3.1,
    radius: 0.45,
    poise: 28,
    mass: 1.1,
    role: 'caster',
    keepAway: [5, 11],
    cooldown: 1.7,
    turnRate: 5,
    stride: 1.4,
    loot: { potion: 0.25, weapon: 0.08, spell: 0.06 },
    attacks: [
      { name: 'hex', windup: 0.85, strike: 0.25, recover: 0.6, dmg: 1, minRange: 3, maxRange: 16, volume: null, projectile: { speed: 11, count: 1, spread: 0.16, homing: 0.5 } },
      { name: 'repel', windup: 0.55, strike: 0.2, recover: 0.9, dmg: 0.6, minRange: 0, maxRange: 2.8, volume: null, aoe: { at: [0, 0], radius: 3.2, dmg: 0.6 } },
    ],
  },
};

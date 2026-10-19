// Base stats for the regular enemies. Floor tuning (LevelData.js)
// multiplies hp, damage, speed, windup and cooldown on top of these, and
// Enemy.js on top of that makes every demon tougher, harder-hitting and
// slower to wind up (so a fight is about reading and answering blows).
//
// Every kind fights its own way, so each is a puzzle of its own to learn:
//
//   Gaunt Stalker  hit and run: a quick snap that may run on into a full
//                  rake; two blows landed on it and it springs clear.
//   Cinder Hound   flurries of burning bites; pounces that may be feints;
//                  a maul down a red cone that latches on and thrashes.
//   Shadow Fiend   a sweep and the backhand after it; blinks behind you
//                  when you watch it from afar.
//   Brute          armoured blows (gold, not red: they can't be countered
//                  with a light hit); a bull rush that ends stunned in a
//                  wall if you sidestep it; a stamp for those who hug its
//                  back; berserk when badly hurt.
//   Pyre Witch     fireballs (parry them back at her), the ground erupting
//                  under and ahead of you, and a blink away when cornered.
//
// Attack fields: `windup`/`strike`/`recover` seconds; `dmg` x the kind's
// damage; `minRange`/`maxRange` when it is used; `volume` the box in the
// enemy's local space (+Z forward) live during the strike; `lunge` moves it
// forward through the strike (negative knockback yanks the player in);
// `projectile`, `aoe` and `eruption` for blows at a distance. And:
//
//   clip       animation to play (default: the attack's name)
//   weight     how often it is chosen among those in range
//   combo      { next, chance, windup, max }: the string's next blow
//   comboOnly  only ever the follow-up of a string
//   feint      chance the lunge never comes: it skips aside, then goes again
//   armor      cannot be interrupted except by a heavy blow (gold tell)
//   charge     runs on through the strike; a wall stops it, stunned
//   behind     used only when the player is behind it or pressed against it
//   ignite     { dps, dur } sets the player alight
//   cone       { range, half } a wedge on the ground shows where it lands
//   lockAt     fraction of the wind-up after which it stops turning
//   latch      { dur, dps } jaws that hang on (Enemy._latch)
//   rest       seconds before it will choose this attack again
//   shadow     the shadow fiend's lash (Enemy._shadowGather, _shadowLash)
//
// Kind fields: `guard` (raises a guard against swings it sees coming:
// chance, how long, seconds between), `skittish` (springs clear after
// `hits` blows within `window` s), `dodge` (sees your swing coming and
// leaps back out of reach: chance per swing, how near, seconds between,
// chance it pounces straight back in), `blink` (vanishes and reappears:
// 'behind' the player, or 'away' from them), `enrage` (below `at` of its
// health: windups, cooldowns and speed scaled).

export const ENEMY_TYPES = {
  ghoul: {
    // Gaunt wolf-beasts that hunt in packs: snap and rake, spring clear when
    // stung, pounce from range, and on deep floors surround you and lunge
    // together.
    name: 'Gaunt Stalker',
    asset: 'ghoul',
    hp: 105,
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
    skittish: { hits: 2, window: 1.5, chance: 0.55 },
    dodge: { chance: 0.3, range: 3.2, cooldown: [1.6, 3], pounce: 0.3 },
    loot: { potion: 0.14, weapon: 0.05, spell: 0.012 },
    attacks: [
      // A quick snap: little warning and little harm, but it may run straight
      // on into the full rake.
      // It is also what it punishes a sluggish swing with: at once, quicker.
      { name: 'snap', clip: 'claw', windup: 0.2, strike: 0.1, recover: 0.34, dmg: 0.45, minRange: 0, maxRange: 1.75, volume: { c: [0, 0.85, 0.8], h: [0.45, 0.5, 0.6] }, lunge: 2.5, knockback: 1, weight: 2, punish: true, combo: { next: 'claw', chance: 0.4, windup: 0.8 } },
      { name: 'claw', windup: 0.45, strike: 0.16, recover: 0.5, dmg: 1, minRange: 0, maxRange: 1.9, volume: { c: [0, 0.9, 0.85], h: [0.55, 0.55, 0.65] }, lunge: 3, knockback: 2, weight: 1.4 },
      { name: 'pounce', windup: 0.55, strike: 0.36, recover: 0.65, dmg: 1.35, minRange: 3, maxRange: 6, volume: { c: [0, 0.8, 0.55], h: [0.45, 0.55, 0.55] }, lunge: 11, knockback: 4, feint: 0.2 },
    ],
  },
  fiend: {
    // Long-armed shadow demon that flanks: wide sweeps and the backhand
    // after them, a reaching grab that drags you in, and a blink through
    // the shadows to strike from behind when you keep it at a distance.
    name: 'Shadow Fiend',
    asset: 'fiend',
    hp: 120,
    dmg: 13,
    speed: 3.4,
    radius: 0.5,
    poise: 45,
    mass: 1.6,
    role: 'flanker',
    guard: { chance: 0.4, dur: [0.7, 1.3], cooldown: 3.2 },
    blink: { mode: 'behind', cooldown: [7, 11], range: [4.5, 13], then: 'sweep', thenWindup: 1.1, time: 0.5 },
    cooldown: 1.5,
    turnRate: 6,
    stride: 2.0,
    loot: { potion: 0.22, weapon: 0.1, spell: 0.035 },
    attacks: [
      { name: 'sweep', windup: 0.65, strike: 0.22, recover: 0.7, dmg: 1, minRange: 0, maxRange: 3.0, volume: { c: [0, 1.0, 1.5], h: [1.7, 0.6, 1.4] }, lunge: 0, knockback: 3.5, combo: { next: 'backhand', chance: 0.5, windup: 0.55 } },
      // The arm comes back the other way: block twice, or be clear of both.
      { name: 'backhand', clip: 'sweep', windup: 0.45, strike: 0.2, recover: 0.9, dmg: 0.8, minRange: 0, maxRange: 3.2, volume: { c: [0, 1.0, 1.5], h: [1.7, 0.6, 1.4] }, lunge: 1.5, knockback: 6, comboOnly: true },
      // A whip of shadow from afar: a cone on the ground shows its reach
      // as shadow gathers into its arm, then it lashes out and drags you in.
      { name: 'lash', windup: 0.75, strike: 0.2, recover: 0.75, dmg: 0.85, minRange: 2.4, maxRange: 4.6, volume: { c: [0, 1.1, 2.8], h: [0.4, 0.45, 2.0] }, lunge: 0, knockback: -7, cone: { range: 4.9, half: 0.2 }, lockAt: 0.7, shadow: true, combo: { next: 'sweep', chance: 0.45, windup: 0.6 } },
    ],
  },
  brute: {
    // Armoured, slow to turn and murderous: its slam can't be stopped by a
    // light blow, it rushes you from afar (step aside and let it hit the
    // wall), stamps the ground if you stand at its back, and goes berserk
    // when badly wounded.
    name: 'Flame-Horned Brute',
    asset: 'brute',
    hp: 260,
    dmg: 22,
    speed: 2.6,
    radius: 0.65,
    poise: 100,
    mass: 3,
    role: 'bruiser',
    guard: { chance: 0.5, dur: [0.9, 1.6], cooldown: 3.5 },
    enrage: { at: 0.4, windup: 0.72, cooldown: 0.6, speed: 1.3 },
    cooldown: 2.0,
    turnRate: 3.5,
    stride: 1.6,
    loot: { potion: 0.45, weapon: 0.3, spell: 0.08 },
    attacks: [
      { name: 'slam', windup: 0.95, strike: 0.18, recover: 1.0, dmg: 1, minRange: 0, maxRange: 2.7, volume: { c: [0, 0.8, 1.7], h: [0.6, 1.0, 1.1] }, lunge: 1.5, knockback: 5, aoe: { at: [0, 2.0], radius: 2.8, dmg: 0.45 }, armor: true },
      { name: 'sweep', windup: 0.7, strike: 0.2, recover: 0.85, dmg: 0.8, minRange: 0, maxRange: 2.5, volume: { c: [0, 1.2, 1.3], h: [1.6, 0.6, 1.0] }, lunge: 0, knockback: 9, combo: { next: 'slam', chance: 0.35, windup: 0.7 } },
      { name: 'charge', windup: 0.85, strike: 1.0, recover: 0.9, dmg: 1.1, minRange: 4.5, maxRange: 11, volume: { c: [0, 0.9, 0.9], h: [0.7, 0.9, 0.6] }, lunge: 11, knockback: 11, charge: true, armor: true, weight: 0.8 },
      { name: 'stomp', windup: 0.5, strike: 0.2, recover: 0.75, dmg: 0.55, minRange: 0, maxRange: 2.2, volume: null, aoe: { at: [0, 0], radius: 2.6, dmg: 0.55 }, behind: true },
    ],
  },
  hound: {
    // Fast pack hunter of the hotter floors: darts in with a flurry of
    // burning bites, pounces from range (sometimes a feint to draw your
    // dodge), and mauls: a leap down a red cone that latches on. It never
    // springs away: too quick to outrun, it stays on you.
    name: 'Cinder Hound',
    asset: 'hound',
    hp: 65,
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
      { name: 'bite', windup: 0.3, strike: 0.12, recover: 0.42, dmg: 0.75, minRange: 0, maxRange: 2.0, volume: { c: [0, 0.6, 1.1], h: [0.4, 0.4, 0.6] }, lunge: 4, knockback: 1.5, ignite: { dps: 0.12, dur: 2 }, combo: { next: 'bite', chance: 0.5, windup: 0.65, max: 2 } },
      { name: 'pounce', windup: 0.5, strike: 0.38, recover: 0.7, dmg: 1.4, minRange: 3.5, maxRange: 7.5, volume: { c: [0, 0.7, 0.9], h: [0.45, 0.5, 0.7] }, lunge: 13, knockback: 5, feint: 0.35, weight: 0.6 },
      // The maul: it crouches, a red cone on the ground shows where it will
      // go, it leaps along it and, if its jaws find you (not your guard),
      // hangs on and thrashes until its hold gives or a blow throws it off.
      // From up close as well as at range (it never springs back to make
      // room), but not again within `rest` seconds.
      { name: 'maul', clip: 'pounce', windup: 0.8, strike: 0.42, recover: 0.75, dmg: 0.45, minRange: 1.0, maxRange: 6, rest: 7, volume: { c: [0, 0.7, 0.9], h: [0.5, 0.55, 0.75] }, lunge: 13, knockback: 0, cone: { range: 6.6, half: 0.36 }, lockAt: 0.6, latch: { dur: 1.8, dps: 1.2 }, weight: 1.4 },
    ],
  },
  witch: {
    // Ranged caster: keeps her distance and hurls hellfire from her staff
    // (three bolts at once on the deep floors) that a well-timed block
    // throws back at her; makes the ground erupt under you and where you
    // are heading; a fire burst throws you off if you close in, and a blink
    // takes her away when cornered. Fragile once you reach her.
    name: 'Pyre Witch',
    asset: 'witch',
    hp: 100,
    dmg: 12,
    speed: 3.1,
    radius: 0.45,
    poise: 28,
    mass: 1.1,
    role: 'caster',
    // A ward of hellfire rather than a raised arm.
    guard: { chance: 0.35, dur: [0.8, 1.2], cooldown: 4, ward: true },
    blink: { mode: 'away', cooldown: [6, 9], range: [3, 8], time: 0.55 },
    keepAway: [5, 11],
    cooldown: 1.7,
    turnRate: 5,
    stride: 1.4,
    loot: { potion: 0.25, weapon: 0.08, spell: 0.06 },
    attacks: [
      { name: 'hex', windup: 0.85, strike: 0.25, recover: 0.6, dmg: 1, minRange: 3, maxRange: 16, volume: null, projectile: { speed: 11, count: 1, spread: 0.16, homing: 0.5 }, weight: 1.4 },
      { name: 'pyre', clip: 'hex', windup: 0.8, strike: 0.25, recover: 0.7, dmg: 0.9, minRange: 3, maxRange: 13, volume: null, eruption: { count: 3, radius: 1.4, delay: 0.85, spread: 2.4 } },
      { name: 'repel', windup: 0.55, strike: 0.2, recover: 0.9, dmg: 0.6, minRange: 0, maxRange: 2.8, volume: null, aoe: { at: [0, 0], radius: 3.2, dmg: 0.6 } },
    ],
  },
};

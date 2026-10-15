# Combat design

One-on-one, first-person melee with no stamina. What limits a fighter is rhythm, commitment,
the weapon in hand, and reading the demon in front of them. Five pillars, each with the code
that carries it.

## 1. Rhythm: the Perfect Chain (`src/combat/Rhythm.js`, `Player._onPress`)

Every swing has a windup `W`, an arc `A` and a recovery `R`. The arc completes at `tc = W + A`.
A left-button press is judged where it falls:

| Press at time `t` in the current swing | Result |
| --- | --- |
| no swing running | an ordinary swing, at once (tap = light; hold 0.2 s = heavy) |
| `t < tc − 0.07 s` | **fumble**: the press is thrown away, the chain breaks, and the next swing is *sluggish* |
| `tc − 0.07 ≤ t ≤ tc + 0.11 s`, swing not fumbled | **Perfect Chain**: the next light swing starts immediately |
| `t > tc + 0.11 s` (recovery) | an ordinary swing, at once |

The window widens by the Grim Metronome relic (×1.45). A swing that has been fumbled can never
chain perfectly, so mashing never stumbles into the window by luck. **Nothing is queued.**

Timings (`lightTiming`), from the weapon's base windup/active/recover:

- light swings: × 0.75 (a quarter faster than the old swing)
- perfect, chain `c` (1…5): windup × 0.5·(1 − 0.04c), arc × 0.9·(1 − 0.04c)
- sluggish: windup × 1.6, arc × 1.15, recovery × 1.45, and you are **exposed**: you take ×1.3
  damage, and every demon in reach drops its attack cooldown and takes the opening
- all ÷ (attack-speed boons × sword momentum)

What a chain of `c` links adds (`chainBonus`): damage × (1 + 0.06c), every proc chance
× (1 + 0.6c), a brighter, whiter weapon trail (`combat/SwingTrail.js`), a deeper swing and hit
sound (rate × (1 − 0.045c)) and a chime that rises with each link. A ring round the crosshair
fills as the arc nears completion and burns gold inside the window; pips count the chain.

## 2. Weight, commitment, vulnerability

- **Light swings** let you keep walking (72% speed, 50% when sluggish). A block or a Phantom Step
  dodge can cut a light swing short only in its recovery, never in its windup or arc.
- **Heavy swings** (hold to draw back, release to strike; power = held time / 0.75 s, up to 1)
  root you and cannot be cancelled: no block, no dodge, no potion. Damage × (1.6 + 0.8·power).
  A heavy already in its arc carries through a blow you take.
- **Counter-hit**: a blow that lands while the demon is in its windup (`Enemy.isWindingUp`).
  Damage × 2 (× 2.5 heavy), the demon is knocked out of its attack for 0.9 s (bosses only by a
  heavy), hit-stop at least 0.14 s, a heavy camera shake, a flash and a booming hit. Every demon
  telegraphs: its body glows ever redder through the windup (brighter with Gravedigger's Lantern),
  and windups last 35% longer than before, time to read and answer.
- **Guards** (`Enemy.raiseGuard`): fiends, brutes, witches and bosses may raise a burning ward
  of runes against a swing they see coming (a 0.12 s reaction, so a quick enough blow beats it),
  or after being stung. A blow on the ward's front (about 140°) **bounces**: no damage, your blade
  is thrown back along its own arc, you are staggered 0.5–0.7 s, the chain and momentum break,
  and the demon answers with a riposte at 55% of its normal windup. Strike from the side, wait
  for it to drop, or bring the right weapon (below).
- **Demon blows stagger you** (0.28–0.75 s by damage, shortened by the Ironbark Gorget): a light
  swing or a drawn-back heavy is knocked away, and you cannot strike, block or dodge until you
  recover. A blocked blow costs 20% and a short 0.12 s jolt; a crushing one (brute slam, boss)
  breaks the block for 0.4 s. Demons hit ×1.62 harder (×1.8, less 10%) and have ×1.3 the health they used to.

## 3. Weapon personalities (`src/combat/Styles.js`)

| Weapon | Personality | Rule |
| --- | --- | --- |
| Sword | Momentum & flow | Each swing that lands +1 momentum (max 10); speed × (1 + 0.045·m). A swing that hits nothing or a blow you take resets it; it bleeds off 1/s after 3 s without a hit. The blade heats as it builds. |
| Axe | Savagery & sunder | Each hit +1 sunder (+2 heavy, max 5, 7 s): damage taken × (1 + 0.08·stacks), stagger threshold × (1 − 0.1·stacks). An axe **shatters** a guard: the demon reels 1.5 s and takes ×1.5 damage for 2.7 s. |
| Mace | Impact & domination | Any hit knocks the demon out of whatever it is doing into a heavy stumble (0.75 s, 1.35 s heavy; bosses only from heavy blows). A charged blow (power ≥ 0.5) **crashes through** a guard (stumble, 60% damage). |

## 4. Explosive escalation: procs (`src/combat/Procs.js`, `src/combat/Relics.js`)

Triggers a hit can raise (several at once): `hit`, `perfect`, `counter`, `crit` (head),
`heavy` (full charge), `kill`, `heavyKill`. Sources are the relics carried (a second copy ×1.5)
and the weapon's enchantment. For each source whose trigger fired:

```
chance = base × (1 + 0.6 × chain) × (1.25 on a counter-hit), at most 0.95
```

Each proc has an internal cooldown so it lands as an event. Effects: **Rime Burst** (frozen
solid 2.4 s, the next blow shatters the ice for ×1.6), **Blood Reaver** (blood torn from the
corpse streams into you: +12% max health), **Hellfire Eruption** (3.4 m blast, 70% weapon damage,
burning), **Storm Chain** (lightning to three more demons within 7 m, or down on the same one),
**Hemorrhage** (bleeding, 24% weapon damage per second for 4 s), **Soul Rend** (the soul
detonates, 4.5 m), **Phantom Echo** (a ghost blade repeats the blow at 60%).

Eleven relics (chests: the first always holds one; elite demons from floor 3; bosses) and five
weapon enchantments (Uncommon weapons and rarer, more often the rarer) carry them. Passive relics change rules: a wider window,
less damage and shorter staggers, a farther torch and brighter tells, or every blow after you are
struck counting as a counter.

## 5. Game feel and hit detection (`Player._sweep`, `src/physics/Hitbox.js`, `GltfCharacter.react`)

- **What the blade covers on screen is what it hits.** The weapon is drawn over the world, so on
  screen it covers everything along the lines of sight behind it. The blade's centre line (the
  grip span in `WEAPON_TYPES.blade`) is first put where it is seen: the viewmodel is drawn with a
  narrower lens (62°) than the world (75°), so its camera-space x and y are pushed out by
  `tan(37.5°) / tan(31°) ≈ 1.28`. Then it is carried out along those lines of sight in depth
  slices (the line scaled by 1 → 1.3 → 1.65 → 2.05 → 2.5 → 3.1 → 3.8 from the eye, which keeps it on
  the same pixels), each cut off at the weapon's `reach` from the eye (sword 2.55 m, axe 2.65 m,
  mace 2.45 m). Each slice is a thin box (half-thickness 5.5 cm sword, 10 cm axe, 12 cm mace, plus
  2 cm grace, all scaled with the depth) as deep as the slice. Tested against demons placed at
  1–3 m: every swing seen to cross a demon within reach lands, and none lands that is not seen to.
- The arc is swept in steps of at most 0.04 rad, interpolating the camera too, so neither a fast
  swing nor a mouse flick tunnels.
- Hurtboxes ride the creatures' bones (head, chest, hips, forearms); head hits crit. The contact
  point is the point on the blade's centre line nearest the struck part, pulled into it: blood is
  thrown along the blade's travel from there, and the number appears there.
- Every hit kicks an underdamped spring (k = 320, c = 15) per axis in the creature's own frame:
  pitch and roll away from the blow, twist with the blade's sweep, scaled by the height of the
  contact (leverage), the blow's force (heavy, counter and mace hit harder) and 1/√mass. It turns
  the whole body a little and the chest and head more; the head snaps hardest when struck.
- **Hit-stop** freezes the blade in the flesh and the demons around it (game time × 0.12), never
  your feet, your view or your torch: those run on real time.

## 6. Being hit (`Player.takeDamage`, `Hud.playerHurt`)

- The view jolts (an irregular judder of position and angle on top of the head snapping away from
  the blow), the screen reddens hardest on the side the blow came from, and blood is thrown across
  the lens near that edge (one to three splats by the size of the blow), running and fading over
  about two seconds.
- The health vial (frame, blood and numbers together) shakes, its blood flares, the lost chip
  burns and drains, and the amount lost rises off it.
- Potions heal 20% of your health over the drink.

## 7. Parry (`Player.canParry`, `Enemy.parried`, `Effects._reflect`)

A block raised within 0.2 s before a blow lands (from the front) **parries** it: no damage, a
hit-stop, sparks and a ring of steel; the demon reels for 1.1 s (a boss for 0.7 s), its string
broken, and your next blow counts as a counter. A fireball parried flies back at its caster,
hotter (×2.5 damage, burning). The window re-arms once the block has been down 0.35 s, so holding
or fanning the block does not parry. A late block still takes the usual 20%.

## 8. Reading the demons (`src/entities/EnemyTypes.js`, `Enemy.js`)

Every kind fights its own way, so each is a puzzle to learn. The tells are colour coded: **red** is
a blow you can counter in its windup; **gold** is an **armoured** blow that a light hit cannot stop
(only a heavy one, or a parry), to be blocked or dodged.

| Demon | How it fights | How to beat it |
| --- | --- | --- |
| Gaunt Stalker | A quick, weak **snap** (0.27 s tell) that may run straight on into the full **rake**; a **pounce** from range that is sometimes a feint. Hit twice within 1.5 s and it often **springs clear**. | Parry the snap, counter the slower rake; don't chase its retreat, let the pounce come. |
| Cinder Hound | **Bite flurries** (up to three) that **set you alight** (a dodge puts it out); feinted pounces. | Parry or block the flurry; save the dodge for the real pounce, punish the landing. |
| Shadow Fiend | A wide **sweep** with a **backhand** after it; a **lash** that drags you in and may sweep after. Keep it at a distance and it **blinks behind you** (a hiss and a puff of shadow) and swings. | Block twice, or be clear of both; turn when you hear it vanish. |
| Flame-Horned Brute | An **armoured slam**; a sweep that may run into the slam; from afar an **armoured bull charge** that ends **stunned for 2.1 s** in any wall it hits; a **stomp** if you stand at its back or hug it. Below 40% it goes **berserk** (faster windups, shorter rests, quicker feet). | Sidestep the charge into a wall and punish; heavy blows into the slam; never stand behind it. |
| Pyre Witch | Fireballs (three on deep floors) that **parry back** at her; **pyre**: the ground erupts under you and where you are heading; a fire burst up close; **blinks away** when cornered. | Parry the fireballs; keep moving through the pyre; corner her after the blink. |
| Gorvath | Armoured slam and charge (the charge stuns him in a wall); the sweep may run into the slam. | As the brute, bigger. |
| Azrakel | The sweep may run into the gust; an armoured leap. | Watch the ring, then the follow-up. |

Common to all: demons waiting for an opening **circle** you instead of queueing; strings keep
their attack token; a string's next blow has a shorter windup (`combo.windup`); blinks and hops
can't be hit while hidden; parrying breaks a string.

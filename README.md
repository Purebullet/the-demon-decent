# The Demon Descent

A brutal dark-fantasy, first-person roguelike for **Project 0 lot #1738**, built with Three.js.

You start on the surface lot: a jagged hole to hell torn through dark-stone ruins, choked with fog, embers streaming up and a red glow pulsing from below. Step over the edge and descend through 20 hand-built floors. You get one life: no armour, no regeneration, only potions and dodging. Die and you lose everything and climb back out at the surface. The deepest floor you reach is your high score.

## Play

```sh
npm install
npm run dev        # http://localhost:5173  (add ?floor=10 to jump to a floor; scores are not recorded)
npm run build      # dist/index.html + dist/assets/models/ — upload the whole dist/ folder
npm test
```

| Control | Action |
| --- | --- |
| W A S D, mouse | Move, aim |
| Left click (hold to chain) | Melee attack |
| Space / Shift | Dodge (invulnerability frames) |
| F | Drink a health potion |
| 1 2 3 | Demon spells: Hellfire Nova, Shade Step, Blood Siphon |
| E | Take a weapon, wake a sanctum altar |
| Esc, M | Pause, mute |

## How it is built

- **Run flow** (`src/game/Game.js`, `src/game/transitions.js`): a state machine with a transition table: `title → surface → floor(1) → sanctum → floor(2) … floor(20) → victory`. Death from any floor goes `dead → surface` and throws the run away.
- **Floors** (`src/world/LevelData.js`): 20 ASCII maps with per-floor tuning (hp, damage, speed, windup, cooldown, attack slots, swarm, aggro, fog, loot). Floor 10 is Gorvath, floor 20 is Azrakel. Floors 11–19 add lava, spike traps, fire vents, burrowed ambushers and swarm tactics, with faster movement and tighter attack windups. `npm test` checks every map is enclosed and that every enemy, potion and exit can be reached.
- **Sanctums** (`src/world/Sanctum.js`): between floors you can wake one of three altars: the Blood Well (+max health or +potion capacity), the Magic Circle (learn or upgrade a spell), or the Burning Sigil (+damage or +attack speed).
- **Combat hitboxes** (`src/physics`): the weapon blade is an oriented box swept along its swing arc. The sweep is sub-stepped and includes the camera's own motion, so a fast swing or a mouse flick can't skip through a target. It is tested with a separating-axis test against per-body-part hurtboxes (head hits crit). Enemy attacks are strike volumes that are only active on their strike frames, tested against the player's capsule.
- **Weapons**: swords are balanced alternating slashes, axes are slow heavy chops, and maces are overheads that break poise and knock enemies back. Weapons drop in four tiers.
- **Enemy AI** (`src/ai`): A* on the tile grid with terrain costs, a per-frame search budget, and string-pulled paths. A director hands out attack tokens and sends flankers to points behind the player, routed by A* with a penalty on tiles inside the player's view cone. On deep floors, ghoul packs take slots on a ring around you and lunge in sequence.

## AI-generated 3D models (Zoodle)

Every model slot (enemies, bosses, weapons, potion, braziers, cave rock, pillars, ruins, trees, gravestones, skulls, Blood Well) is listed in `src/assets/manifest.js` with its size, reference image and prompt. The game loads whatever GLBs exist in `assets/models/` and uses a built-in stand-in for anything missing.

`scripts/zoodle.mjs` fills the slots from your Zoodle account. It runs in Node only and reads the key from `ZOODLE_API_KEY`, so the key never ends up in the game.

```sh
npm run zoodle -- status                  # which slots have models
npm run zoodle -- list                    # your finished Zoodle creations
npm run zoodle -- pull ghoul=<id>         # download an existing creation into a slot (free)
npm run zoodle -- batch                   # characters from assets/reference/*  (dry run)
npm run zoodle -- batch --spend           # ... actually generate (30 Z-Coins per character)
npm run zoodle -- objects --spend         # props from their text prompts
```

Slot-to-Zoodle-id mappings are saved in `assets/zoodle.json`, so models can be downloaded again without paying again.

Zoodle game models are static meshes. To animate them, a vertex shader bends the body at the hips: the torso rears back on the telegraph, lunges on the strike, twists on sweeps and recoils when staggered, and the legs scissor while walking. The head and torso hitboxes follow the same bend. Rigged GLBs with clips are supported as well: their hitboxes ride the bones, and the idle, walk, run, attack, hit and death clips are driven by the AI state.

Textures embedded in GLBs are decoded with `createImageBitmap` straight from the file's bytes, not through `blob:` URLs. That keeps models textured even if the hosting page's Content-Security-Policy blocks `blob:`.

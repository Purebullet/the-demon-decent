# The Demon Descent

A brutal dark-fantasy, first-person roguelike for **Project 0 lot #265**, built with Three.js.

From the street, the lot is a hell-mouth: a volcanic mound torn open by a glowing pit, with a vortex of hellfire rising out of it. Enter the lot and the game opens as its own world: the surface lot with a jagged crater in dark-stone ruins, fog, embers and a red glow pulsing from below. Step over the edge and descend through 20 hand-built floors. You get one life: no armour, no regeneration, only potions and dodging. Die and you lose everything and climb back out at the surface. Your deepest floor goes on the lot's weekly score table.

## Play

```sh
npm install
npm run dev        # http://localhost:5173  (add ?floor=10 to jump to a floor; scores are not recorded)
npm test
npm run build      # dist/experience/ + dist/experience.zip (Project 0) and dist/web/ (any static host)
```

| Control | Action |
| --- | --- |
| W A S D, mouse | Move, aim (click to capture the mouse; drag to look also works) |
| Left click (hold to chain) | Melee attack |
| Space / Shift | Dodge (invulnerability frames) |
| F | Drink a health potion |
| 1 2 3 | Demon spells: Hellfire Nova, Shade Step, Blood Siphon |
| E | Take a weapon, wake a sanctum altar |
| M | Mute |

On phones: the city's stick moves; tap to strike, drag to look; on-screen buttons dodge, drink, use and cast.

## Publishing to Project 0

The game is a Project 0 **experience** (`src/experience.js` is its `start(p0)`); the street view is three LOD models made by `npm run lot`. Keys come from environment secrets, never from files: `P0_KEY` (Project 0 key) and `ZOODLE_API_KEY`.

```sh
npm run p0 -- me                                   # lot sizes and budgets
npm run p0 -- status building                      # cubes assemble on the lot while you work
npm run lot -- --width W --depth D --height H      # street view into dist/lot (use the lot's real size)
npm run p0 -- validate-lot dist/lot                # free check
npm run p0 -- publish-lot dist/lot
npm run build
npm run p0 -- validate-experience                  # free check of dist/experience.zip
npm run p0 -- publish-experience
npm run p0 -- box subtle --color "#ff3a10"         # faint glass box, ember outline
npm run p0 -- status done
```

Before publishing a new version, run it in Project 0's own sandbox: `npm run devkit` (serves the package with CORS on :5500), then `npm run devkit:check -- --width W --depth D --height H`. That runs it in software rendering like the review, prints frame times, errors and the review simulation, and saves screenshots to `dist/devkit/`.

## How it is built

- **Host interface** (`src/platform`): the game never touches the page. `p0host.js` wraps Project 0's sandbox (a worker with no DOM, storage or Web Audio): its renderer, input events, sound files, weekly score table and package assets. `browserhost.js` does the same for a plain web page.
- **A world bigger than the lot.** Project 0 clips a game to the lot's box on screen when its camera is outside the box. The render camera stays at the lot's centre and the world is shifted around it every frame, so the 90 m caverns fill the screen.
- **No hitches.** Every kind of material is drawn once into a 4 x 4 pixel corner behind the black fade before a scene is shown, one per frame. That includes the things that appear mid-fight. So no frame stalls on a shader, even in the software renderer Project 0's review uses. Resolution steps down on slow machines.
- **Interface** (`src/ui/Hud.js`): painted on a canvas (`OffscreenCanvas` in the worker) and drawn over the 3D view.
- **Sound** (`scripts/make-sounds.mjs`): every effect and the ambient drone is synthesized in code into WAV files at build time; no third-party audio.
- **Run flow** (`src/game/Game.js`, `src/game/transitions.js`): a state machine with a transition table: `title → surface → floor(1) → sanctum → floor(2) … floor(20) → victory`. Death from any floor goes `dead → surface` and throws the run away.
- **Floors** (`src/world/LevelData.js`): 20 ASCII maps with per-floor tuning (hp, damage, speed, windup, cooldown, attack slots, swarm, aggro, fog, loot). Pyre Witches join on floor 4 and Cinder Hounds on floor 6. Floor 10 is Gorvath, floor 20 is Azrakel. Floors 11–19 add lava, spike traps, fire vents, burrowed ambushers and swarm tactics, with faster enemies and tighter attack windups. `npm test` checks that every map is enclosed and that every enemy, potion and exit can be reached.
- **Sanctums** (`src/world/Sanctum.js`): between floors you can wake one of three altars: the Blood Well (+max health or +potion capacity), the Magic Circle (learn or upgrade a spell), or the Burning Sigil (+damage or +attack speed).
- **Combat hitboxes** (`src/physics`): the weapon blade is an oriented box swept along its swing arc. The sweep is sub-stepped and includes the camera's own motion, so a fast swing or a mouse flick can't skip through a target. It is tested with a separating-axis test against per-body-part hurtboxes; head hits crit. Enemy attacks are strike volumes that are only active on their strike frames.
- **Weapons**: swords are balanced alternating slashes, axes are slow heavy chops, and maces are overheads that break poise and knock enemies back. Weapons drop in four tiers.
- **Enemy AI** (`src/ai`): A* on the tile grid with terrain costs, a per-frame search budget, and string-pulled paths. A director hands out attack tokens and sends flankers to points behind the player, routed by A* with a penalty on tiles inside the player's view cone. On deep floors, ghoul packs take slots on a ring around you and lunge in sequence.
- **Street view** (`src/lot/buildLot.js`, `scripts/make-lot.mjs`): three LODs made for the lot's box, plus `lot.json` with shaders for the hellfire and the molten cracks, and a script that turns the vortex.

## AI-generated 3D models

The game is medium-poly and every creature is an AI-generated model; none is modelled in code. A creature without its model yet shows as a plain grey block while you develop, and `npm run build` refuses to package the game until all seven have one.

| Creature | Role | Floors | Export budget |
| --- | --- | --- | --- |
| Husk Ghoul | swarmer; packs encircle and lunge together | 1+ (burrowed ambushers 11+) | 10k tris |
| Chain Fiend | flanker; sweeps, and its chain lash pulls you in | 2+ | 15k tris |
| Flame-Horned Brute | bruiser; ground slams and sweeps | 5+ | 15k tris |
| Pyre Witch | caster; keeps her distance and throws hellfire, bursts you away up close | 4+ | 15k tris |
| Cinder Hound | fast pack hunter; bites and long pounces | 6+ | 10k tris |
| Gorvath, the Flame-Horned | boss | 10 | 20k tris |
| Azrakel, the Winged Archfiend | final boss | 20 | 20k tris |

Each creature's look, size, budget and flame points are in `src/assets/manifest.js`. They are made in three steps, each run from Node so no key reaches the game:

1. **Concept images** (`scripts/concepts.mjs`, Google's Gemini image models, key in `GEMINI_API_KEY`). Each creature is drawn whole, in a neutral pose on a plain background, without fire effects (flames are particles in the game), redrawn from its reference art in `assets/reference/` when it has one. Takes go to `assets/concepts/`, with a contact sheet at `assets/concepts/index.html`.
2. **Approval.** One take per creature is approved; nothing goes on to 3D without it.
3. **Image-to-3D** (`scripts/zoodle.mjs`, a Zoodle batch job, key in `ZOODLE_API_KEY`, 30 Z-Coins per creature, failures refunded). Only approved images are sent, and each model is exported at its triangle budget.

```sh
npm run concepts                          # dry run: prompts and cost
npm run concepts -- --spend               # one take per creature that has none
npm run concepts -- witch --spend --note "hood up, staff held higher"   # another take
npm run concepts -- approve ghoul=1 witch=2
npm run zoodle -- batch                   # dry run: approved creatures and cost
npm run zoodle -- batch --spend           # build them
npm run zoodle -- status                  # models, approvals and Zoodle ids
npm run zoodle -- pull                    # download recorded models again (free)
```

Slot-to-Zoodle mappings are saved in `assets/zoodle.json`, so models can be downloaded again without paying again.

- **Static meshes:** Zoodle's game models are static. A vertex shader bends them at the hips (rearing back, lunging, twisting, recoiling and striding; hounds trot on diagonal pairs), and the head and torso hitboxes follow the bend.
- **Rigged animations:** a creature's Zoodle animations come as rigged GLBs. `pull` saves them as `<id>-<clip>.glb`. Their hitboxes then ride the bones, and the AI state drives the idle, walk, run, attack, hit and death clips.
- **Textures:** embedded textures are decoded with `createImageBitmap` straight from the file's bytes, not through `blob:` URLs, so a strict Content-Security-Policy can't turn models grey.

Weapons, the potion and the props listed under `PROPS` in the manifest go through Zoodle the same way (`npm run zoodle -- objects`). The cave walls, ruins and other scenery are still built in code and are next to be replaced by generated models.

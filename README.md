# The Demon Descent

A brutal dark-fantasy, first-person roguelike for **Project 0 lot #265**, built with Three.js.

From the street, the lot is a hell-mouth: a volcanic mound torn open by a glowing pit, with a vortex of hellfire rising out of it. Enter the lot and the game opens as its own world: the surface lot with a jagged crater in dark-stone ruins, fog, embers and a red glow pulsing from below. Step over the edge and descend through 20 hand-built floors. You get one life: no armour, no regeneration, only potions, timing and steel. Die and you lose everything and climb back out at the surface. Your deepest floor goes on the lot's weekly score table.

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
| Left click | Light attack; click again as the arc lands for a Perfect Chain |
| Hold left button | Draw back a heavy blow, released when you let go |
| Right button | Block; raise it just as a blow lands to parry (fireballs fly back) |
| Double-tap A / D / S (or Space) | Phantom Step dodge, once learned |
| E | Drink a health potion (a fifth of your health) |
| 1 2 3 | Demon spells: Hellfire Nova, Shade Step, Blood Siphon |
| F | Take a weapon, wake a sanctum altar |

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
- **Floors** (`src/world/LevelData.js`): 20 ASCII maps with per-floor tuning (hp, damage, speed, windup, cooldown, attack slots, swarm, aggro, fog, loot) and a `look`. Pyre Witches join on floor 4 and Cinder Hounds on floor 6. Floor 10 is Gorvath, floor 20 is Azrakel. Floors 11–19 add lava, spike traps, fire vents, burrowed ambushers and swarm tactics, with faster enemies and tighter attack windups. `npm test` checks that every map is enclosed and that every enemy, potion and exit can be reached.
- **Cavern looks** (`src/world/themes.js`, `src/world/Dressing.js`): each floor names one of 15 looks, which sets its palette, fog, light, glow colour, ceiling height, glowing floor veins and which generated props dress it: the fungus-lit Gullet, blue-crystal Weeping Tunnels, the bone-strewn Ossuary, the Chain Halls of gibbets and hanging chains, sulphur-yellow Brimstone, the stalagmite jaws of the Hollow of Teeth, ember-split Cinder, the stakes of the Flayed Maze, the statues of the Threshold of Ash, Gorvath's Crucible, the Molten Vein, the egg-clutched Writhing Pit, the violet Screaming Deep, the Last Gate and Azrakel's throne room. The floor's own seed varies tint, height and placement, so floors sharing a look still differ. Walls are stacked generated boulders and slabs, with stalactites, rubble, set pieces on pillar tiles, and props along the walls, from the ceiling and across the floor; a hell-gate stands behind every exit. Everything repeated is instanced per 12 m chunk, and chunks beyond the fog are hidden.
- **Sanctums** (`src/world/Sanctum.js`): between floors you can wake one of three altars: the Blood Well (+max health or +potion capacity), the Magic Circle (learn or upgrade a spell), or the Burning Sigil (+damage or +attack speed).
- **Combat** (`src/combat`, design and formulas in [docs/COMBAT.md](docs/COMBAT.md)): no stamina; timing is the limit. Presses on the beat flow into Perfect Chains, mashing fumbles and exposes you, nothing is queued. Counter-hits land in a demon's glowing windup; guarded blows bounce. Swords build momentum, axes sunder and shatter guards, maces knock demons into stumbles. Relics and weapon enchantments turn perfect timing into procs (freeze, life steal, hellfire, chain lightning, bleeding, soul rends, echo strikes).
- **Combat hitboxes** (`src/physics`, `Player._sweep`): what the blade covers on screen is what it hits. Its centre line is placed where the viewmodel shows it, then carried out along the lines of sight behind it in depth slices to the weapon's reach (about 2.5 m), each a thin oriented box, swept along the swing arc. The sweep is sub-stepped and includes the camera's own motion, so a fast swing or a mouse flick can't skip through a target. It is tested with a separating-axis test against per-body-part hurtboxes; head hits crit; each hit kicks a spring through the creature's body along the angle and weight of the blow. Enemy attacks are strike volumes that are only active on their strike frames.
- **Weapons**: four tiers, and from the second tier on a weapon may carry an enchantment (its own proc).
- **Icons** (`npm run icons`): the skill, relic and weapon icons are generated 3D models rendered into one atlas (`assets/icons/atlas.webp`).
- **Demons** (`src/entities/EnemyTypes.js`, `Enemy.js`): every kind fights its own way. Stalkers snap and rake and spring clear when stung; hounds bite in burning flurries and feint their pounces; fiends string a backhand after a sweep and blink behind you; brutes swing armoured blows (a gold glow: block or dodge, don't counter), bull-rush you into the walls and go berserk when wounded; witches parry-able fireballs, erupt the ground under you and blink away when cornered. Waiting demons circle you rather than queue.
- **Enemy AI** (`src/ai`): A* on the tile grid with terrain costs, a per-frame search budget in time, and string-pulled paths. A director hands out attack tokens and sends flankers to points behind the player, routed by A* with a penalty on tiles inside the player's view cone. On deep floors, stalker packs take slots on a ring around you and lunge in sequence.
- **Street view** (`src/lot/buildLot.js`, `scripts/make-lot.mjs`): three LODs made for the lot's box, plus `lot.json` with shaders for the hellfire and the molten cracks, and a script that turns the vortex.

## AI-generated 3D models

Every creature and prop is an AI-generated model from [Zoodle](https://zoodle3d.com); none is modelled in code. A creature without its model shows as a plain grey block while you develop, and `npm run build` refuses to package the game until all seven have one.

| Creature | Zoodle model | Role | Floors |
| --- | --- | --- | --- |
| Gaunt Stalker | #204 Gaunt Wolf-Beast | swarmer; packs encircle and lunge together | 1+ (burrowed ambushers 11+) |
| Shadow Fiend | #209 Shadow Beast | flanker; wide sweeps, and a reaching grab that drags you in | 2+ |
| Pyre Witch | #206 Demon Witch | caster; keeps her distance and throws hellfire, slams her staff to throw you off | 4+ |
| Flame-Horned Brute | #203 Horned Monster | bruiser; ground slams, sweeps, charges and stomps | 5+ |
| Cinder Hound | #210 Demon Hound | fast pack hunter; bites and long pounces | 6+ |
| Gorvath, the Flame-Horned | the brute, grown huge, horns ablaze | boss | 10 |
| Azrakel, the Archfiend | the fiend, grown huge and blood-red | final boss | 20 |

Each creature's Zoodle id, size and flame points are in `src/assets/manifest.js`.

### Rigging and animation

Zoodle's game models are static meshes, so `npm run rig` (`scripts/rig.mjs`) rigs and animates them:

- **Skeleton**: joints placed per creature in `scripts/rigs.mjs` (a biped plan, or a four-legged plan with a three-bone tail), then centred in the limb's cross-section. Marker bones carry the horn tips, the witch's staff crystal and Azrakel's heart for the flames.
- **Skin weights**: each vertex goes to the bones nearest to it relative to each bone's thickness, inside the bone's region; triangles the generator fused between parts that must move apart (a hand resting on a thigh) are cut; the witch's staff is bound rigidly to her hand by flood-filling the surface from its crystal; weights are smoothed over the surface so joints bend softly.
- **Clips** (`scripts/motions.mjs`): idle, walk, run, hit, death and one clip per attack (slam, sweep, charge, stomp, lash, cast, staff slam, burst, leap, claw, bite, pounce), written as poses over time and baked at 30 fps. Each frame is grounded so feet stay on the floor and the walk bobs by itself. Beasts trot on diagonal pairs and gallop with a flexing spine.
- **Hurtboxes** are measured from the mesh around the head, torso, legs and forearms and stored in the GLB.

In the game (`src/entities/GltfCharacter.js`), clip time comes from the AI rather than the clock: walking and running follow the stride phase, so the feet keep pace with the ground; attack clips map their windup, strike and recovery (`src/entities/clipPhases.js`) onto the attack's own timings, so a claw lands exactly while its strike volume is live, however a floor tunes them. Clips cross-fade by weight.

```sh
npm run zoodle -- pull                    # download every prop and every creature's static source (free)
npm run rig                               # rig and animate the creatures into assets/models/
npm run rig -- witch                      # one creature
npm run zoodle -- objects --spend         # generate any missing prop from its prompt
npm run zoodle -- objects crystal --spend # generate one again
npm run zoodle -- status
```

`tools/model.html?src=../assets/models/witch.glb&poses=idle:0,hex:0.42,hex:0.6` shows a model in any pose (`&weights=1` colours the skin weights, `&skel=1` draws the bones), and `tools/sheet.html` shows every model on one sheet; serve the repository root to open them.

### Props

The cavern props are generated from text prompts in the creatures' look (stylized, hand-painted, chunky shapes in charcoal, purple and crimson) and downloaded at a triangle budget per prop (`maxTris`): the wall rocks that are instanced hundreds of times are a few hundred triangles each. Glowing props (crystals, fungus, eggs, rune stones) are made pale and take each floor's glow colour. Slot-to-Zoodle mappings are saved in `assets/zoodle.json`, so models can be downloaded again without paying again. Generated materials come fully metallic, which a torchlit cave renders black, so creatures and scenery are made matte when they load.

The concept-image route (`npm run concepts`, `npm run zoodle -- batch`) still works for making a creature from a drawing.

- **Textures:** embedded textures are decoded with `createImageBitmap` straight from the file's bytes, not through `blob:` URLs, so a strict Content-Security-Policy can't turn models grey.

// Every 3D asset slot in the game, filled by AI-generated, medium-poly GLBs
// from Zoodle. No creature is modelled in code: one without its GLB shows a
// plain "missing model" block in development, and `npm run build` refuses to
// package the game until every creature has its model.
//
// Creatures are Zoodle characters (`zoodle` is the character id). Zoodle's
// game models are static, so `npm run zoodle -- pull` saves them to
// assets/source/ and `npm run rig` gives each one a skeleton, skin weights
// and its animation clips (scripts/rig.mjs, joints in scripts/rigs.mjs),
// written to `model`. The two bosses are two of the creatures grown huge, so
// they share their model with them, `tint`ed.
//
// Sizes are in metres. Characters are scaled so their height matches, then
// stood on y = 0 facing +Z. Rigged models carry their own hurtboxes and
// marker bones (horn tips, a staff's head).
//
// `fire` puts flame emitters on bones (`bone` is a name pattern, any case)
// at an offset given as a fraction of the character's height. `at` is the
// same point in root space, used when the model has no skeleton. Flames are
// particles in the game, so the models are made without them.

// What image-to-3D needs from a concept: one whole figure in a neutral pose,
// nothing in front of it and nothing glowing in the air around it.
const SHEET =
  'Single creature concept for a 3D game model. Whole body from the top of the head to the feet, nothing cropped, centred, ' +
  'plain flat light grey background, soft even studio light, no cast shadow, no ground, no scenery, no text, no frame, no watermark. ' +
  'No fire, flames, smoke, sparks or magic effects anywhere: glowing parts are drawn as solid glowing material. ' +
  'Stylized dark fantasy creature with hand-painted textures, sharp focus';
const BIPED = 'Front three-quarter view, standing upright in a relaxed A-pose, arms held a little away from the body, legs slightly apart, feet flat';
const BEAST = 'Side three-quarter view, standing square on all four legs, legs slightly apart, head level, tail held straight out';

export const CHARACTERS = {
  ghoul: {
    // Zoodle "Gaunt Wolf-Beast": the swarming pack of the upper floors.
    name: 'Gaunt Stalker',
    zoodle: 204,
    model: 'assets/models/ghoul.glb',
    height: 1.3,
    body: 'beast',
    look: 'Gaunt starving wolf-beast with very long thin legs and long clawed toes, a shaggy mane of dark blue and moss-green fur over the shoulders and neck, bare dark grey hide on the ribs and legs, pointed ears, glowing yellow eyes, a long bushy blue and green tail',
    pose: BEAST,
    fire: [],
  },
  fiend: {
    // Zoodle "Shadow Beast": the flanker.
    name: 'Shadow Fiend',
    zoodle: 209,
    model: 'assets/models/fiend.glb',
    height: 2.2,
    look: 'Hunched, heavily muscled demon of dark purple-grey stone-like plated hide, huge curled ram horns, glowing red eyes, a jutting jaw of white tusks, very long arms with hooked claws, digitigrade clawed feet',
    pose: BIPED,
    fire: [],
  },
  brute: {
    // Zoodle "Horned Monster": the bruiser.
    name: 'Flame-Horned Brute',
    zoodle: 203,
    model: 'assets/models/brute.glb',
    height: 2.3,
    look: 'Fat hulking ogre-demon with crimson skin and olive-green belly and blotches, a huge shaggy mane of dark purple fur over the back and shoulders, short branching antler horns, glowing yellow eyes, a heavy brow and tusked underbite, long arms with big clawed hands, short thick legs',
    pose: BIPED,
    fire: [
      { bone: 'LeftHorn', at: [0.1, 0.91, 0.08], kind: 'horn', rate: 26 },
      { bone: 'RightHorn', at: [-0.1, 0.91, 0.08], kind: 'horn', rate: 26 },
    ],
  },
  hound: {
    // Zoodle "Demon Hound": the fast pack hunter of the hotter floors.
    name: 'Cinder Hound',
    zoodle: 210,
    model: 'assets/models/hound.glb',
    height: 1.25,
    body: 'beast',
    look: 'Snarling hellhound with crimson skin under a bristling mane of dark brown spiked fur, a gaping jaw of yellowed fangs, pointed ears, a studded iron collar with heavy chains wrapped around its body and dragging on the ground, a thick curled tail',
    pose: BEAST,
    fire: [{ bone: 'Waist', offset: [0, 0.1, 0], at: [0, 0.62, 0], kind: 'ember', rate: 10 }],
  },
  witch: {
    // Zoodle "Demon Witch": the caster.
    name: 'Pyre Witch',
    zoodle: 206,
    model: 'assets/models/witch.glb',
    height: 2.1,
    look: 'Old, scary, skinny hunched witch with dark red wrinkled skin, glowing orange eyes, a tall crooked pointed hat whose tip curls and burns, a necklace of fangs, long tattered dark robes, holding a gnarled staff topped with a glowing orange crystal in her right hand',
    pose: BIPED,
    fire: [
      { bone: 'StaffTip', at: [-0.13, 0.9, 0.12], kind: 'torch', rate: 30, name: 'staffTip' },
      { bone: 'HatEnd', at: [0.02, 0.95, -0.06], kind: 'horn', rate: 10 },
    ],
  },
  sleeper: {
    // Boss of floor 5, the Sleeper: the lot owner's own model (an ogre-demon,
    // rigged by scripts/rig.mjs), asleep in the arena at the end of the candle
    // hall. His axe is the prop `sleeperAxe`.
    name: 'Vorgrath, the Sleeper',
    model: 'assets/models/sleeper.glb',
    height: 5.2,
    look: "The lot owner's ogre-demon",
    pose: BIPED,
    // Skinned with dual quaternions: his thick arms keep their girth as they
    // twist and bend (no candy-wrapper pinch at the shoulders and wrists).
    dualQuat: true,
    fire: [],
  },
  azrakel: {
    // Boss of floor 10, the last: the user's own Zoodle creature, a hunched
    // beast-lord in bone-white plates over red hide, with a black mane and a
    // tail (rigged by scripts/rig.mjs).
    name: 'Azrakel, the Archfiend',
    zoodle: 211,
    model: 'assets/models/azrakel.glb',
    height: 3.5,
    look: 'A hunched beast-lord, bone plates on red hide, a black mane',
    pose: BIPED,
    dualQuat: true,
    fire: [],
  },
};

// The text prompt for a creature's concept image.
export function conceptPrompt(id) {
  const c = CHARACTERS[id];
  return `${c.look}. ${c.pose}. ${SHEET}.`;
}

// Props: `size` is the target height (or length for weapons, measured along
// their longest axis, which is turned to point up). `maxTris` is the budget
// Zoodle decimates the download to: scenery that is instanced hundreds of
// times (wall rocks, stalactites) stays very light.
//
// Every prop is drawn in the creatures' look (stylized, hand-painted, chunky
// shapes, muted charcoal, purple and crimson), so the caverns and the demons
// read as one world. Props that glow per floor (crystals, fungus, eggs) are
// generated pale, and each floor's theme tints them (see world/themes.js).
const LOOK =
  'stylized dark fantasy game asset, hand-painted painterly textures like a sculpted fantasy creature, chunky exaggerated shapes, soft sculpted forms, muted charcoal, deep purple and dark crimson tones, single object, no ground, no base plate';

export const PROPS = {
  sword: { model: 'assets/models/sword.glb', size: 1.15, weapon: true, guard: true, prompt: `One-handed longsword, notched dark iron blade, cross guard, leather-wrapped grip, round pommel, ${LOOK}` },
  axe: { model: 'assets/models/axe.glb', size: 1.25, weapon: true, edge: true, prompt: `Bearded battle axe, wide crescent iron head with notches, long dark wooden haft bound with leather, ${LOOK}` },
  mace: { model: 'assets/models/mace.glb', size: 1.0, weapon: true, prompt: `Flanged spiked mace, iron head with spikes, dark wooden haft with leather grip, ${LOOK}` },
  // The weapons demons drop: three more of each kind, each its own shape.
  swordBone: { model: 'assets/models/sword-bone.glb', size: 1.2, weapon: true, guard: true, prompt: `Demonic straight longsword, serrated blackened steel blade with a glowing red crack down its fuller, crossguard of two curved horns, bone-wrapped grip, small skull pommel, ${LOOK}` },
  swordFlame: { model: 'assets/models/sword-flame.glb', size: 1.2, weapon: true, guard: true, prompt: `Flamberge sword with a long wavy flame-shaped dark steel blade, ornate curled crossguard, crimson leather grip, ring pommel, ${LOOK}` },
  swordGreat: { model: 'assets/models/sword-great.glb', size: 1.35, weapon: true, guard: true, prompt: `Huge broad two-handed greatsword, thick wide double-edged blade engraved with glowing runes, heavy square spiked crossguard, long grip, spiked pommel, ${LOOK}` },
  axeTwin: { model: 'assets/models/axe-twin.glb', size: 1.3, weapon: true, edge: true, prompt: `Double-headed battle axe, two symmetric crescent blades of dark iron on one long haft wrapped with chains and leather, ${LOOK}` },
  axeHeadsman: { model: 'assets/models/axe-headsman.glb', size: 1.1, weapon: true, edge: true, prompt: `Executioner's axe, one huge broad squared iron blade with a hooked spike on the back, thick short dark wooden haft bound in iron, ${LOOK}` },
  axeHorn: { model: 'assets/models/axe-horn.glb', size: 1.2, weapon: true, edge: true, prompt: `Bearded war axe with a narrow hooked blade and a long spike on top, haft of pale bone with leather bands, demon horn on the back of the head, ${LOOK}` },
  maceStar: { model: 'assets/models/mace-star.glb', size: 1.05, weapon: true, prompt: `Morning star mace, round iron ball head covered in long sharp spikes on a straight dark wooden haft, leather grip, ${LOOK}` },
  maceHammer: { model: 'assets/models/mace-hammer.glb', size: 0.9, weapon: true, prompt: `Heavy warhammer, block-shaped iron hammer head with a demon skull carved into its face and a spike at the back, long dark haft, ${LOOK}` },
  maceClub: { model: 'assets/models/mace-club.glb', size: 0.92, weapon: true, prompt: `Brutal war club, thick knobbed bone club studded with iron nails and curved fang spikes, leather-wrapped handle, ${LOOK}` },
  // The torch in your left hand (the flame is drawn by the game on its rags).
  torch: { model: 'assets/models/torch.glb', size: 0.72, upright: true, maxTris: 3000, prompt: `Hand-held dungeon torch: one straight shaft of gnarled blackened wood bound with worn leather straps and riveted iron bands, a bone-and-iron pommel at the bottom, and at the top a small cage of curved black iron claws holding a tight bundle of oil-soaked cloth rags, no flame, standing upright, ${LOOK}` },
  potion: { model: 'assets/models/potion.glb', size: 0.36, maxTris: 1500, prompt: `Small round glass potion flask filled with glowing blood-red liquid, cork stopper, leather cord, ${LOOK}` },
  brazier: { model: 'assets/models/brazier.glb', size: 1.3, maxTris: 3000, prompt: `Wrought iron brazier on three clawed demon legs, wide bowl heaped with glowing orange coals, ${LOOK}` },
  // ---- Cavern scenery (floors 1-20).
  pillar: { model: 'assets/models/cave-pillar.glb', size: 6.4, maxTris: 2500, prompt: `Massive gnarled natural cave column of dark stone from floor to ceiling, dripping mineral flows, thick at the base and top, narrower in the middle, ${LOOK}` },
  rock: { model: 'assets/models/cave-rock.glb', size: 2.6, maxTris: 800, instanced: true, prompt: `Large jagged cave boulder of dark stone, broken sharp facets and deep cracks, ${LOOK}` },
  slab: { model: 'assets/models/cave-slab.glb', size: 3, maxTris: 800, instanced: true, prompt: `Tall broken slab of layered cave rock, stacked stone strata with jagged edges, ${LOOK}` },
  stalagmite: { model: 'assets/models/stalagmite.glb', size: 2.4, maxTris: 1000, instanced: true, prompt: `Cluster of three tall pointed stalagmites of wet dark cave stone with dripping mineral ridges, ${LOOK}` },
  skulls: { model: 'assets/models/skull-pile.glb', size: 0.6, maxTris: 1200, instanced: true, prompt: `Small pile of human skulls and scattered bones, ${LOOK}` },
  crystal: { model: 'assets/models/crystal.glb', size: 1.7, maxTris: 1200, glow: true, prompt: `Cluster of jagged pale white glowing crystal shards growing out of a dark rock, sharp translucent points, ${LOOK}` },
  fungus: { model: 'assets/models/fungus.glb', size: 1.3, maxTris: 1500, glow: true, prompt: `Cluster of eerie cave mushrooms with thin crooked stalks and drooping pale caps covered in glowing spots, ${LOOK}` },
  eggs: { model: 'assets/models/egg-sacs.glb', size: 1.1, maxTris: 1500, glow: true, prompt: `Cluster of five large oval demon eggs standing upright in a nest of dark roots, smooth pale glossy shells with dark veins, ${LOOK}` },
  ribcage: { model: 'assets/models/ribcage.glb', size: 3.4, maxTris: 3000, prompt: `Skeleton of a giant beast: a long spine lying on the ground with six huge curved bleached-white rib bones rising from it like an open cage, gaps between the ribs, ${LOOK}` },
  cage: { model: 'assets/models/gibbet-cage.glb', size: 2.4, maxTris: 2000, prompt: `Rusted iron gibbet cage shaped like a tall birdcage with a slumped human skeleton inside, ${LOOK}` },
  stakes: { model: 'assets/models/stakes.glb', size: 2, maxTris: 2000, prompt: `Row of sharpened crooked wooden impaling stakes with skulls stuck on top, bound with rope, ${LOOK}` },
  chains: { model: 'assets/models/hanging-chains.glb', size: 3.2, maxTris: 1600, prompt: `Bundle of heavy rusted iron chains hanging straight down with a large bloody meat hook at the bottom, ${LOOK}` },
  altar: { model: 'assets/models/altar.glb', size: 1.4, maxTris: 2500, prompt: `Demonic sacrificial stone altar with carved horns at the corners, melted candles and dried blood, ${LOOK}` },
  obelisk: { model: 'assets/models/obelisk.glb', size: 3.6, maxTris: 1500, glow: true, prompt: `Tall cracked black stone obelisk with a jagged broken top, carved with pale glowing runes, ${LOOK}` },
  statue: { model: 'assets/models/demon-statue.glb', size: 3.4, maxTris: 3000, prompt: `Tall weathered stone statue of a standing horned demon warrior holding a sword point-down in front of it, on a square pedestal, cracked grey stone, ${LOOK}` },
  remains: { model: 'assets/models/chained-skeleton.glb', size: 1.1, maxTris: 2500, prompt: `Human skeleton sitting slumped with its arms chained up to an iron ring, tattered rags, ${LOOK}` },
  gate: { model: 'assets/models/hell-gate.glb', size: 5.2, maxTris: 4000, prompt: `Huge demonic stone archway made of two great curved horns meeting at the top, carved skulls along the arch, open gateway, ${LOOK}` },
  throne: { model: 'assets/models/throne.glb', size: 4.2, maxTris: 4000, prompt: `Massive demonic throne of black obsidian and bones with huge curved horns rising from the back, ${LOOK}` },
  // ---- The deep (floors 6-20): a hotter, harder rock of their own.
  obsidian: { model: 'assets/models/deep-obsidian.glb', size: 2.4, maxTris: 1000, instanced: true, glow: true, prompt: `Jagged cluster of glossy black volcanic obsidian shards with thin glowing orange lava cracks running through them, sharp glass-like facets, ${LOOK}` },
  basalt: { model: 'assets/models/deep-basalt.glb', size: 3, maxTris: 1000, instanced: true, prompt: `Cluster of tall hexagonal black basalt columns of different heights standing together, cracked flat tops, ${LOOK}` },
  ironSpire: { model: 'assets/models/deep-spire.glb', size: 6.4, maxTris: 2500, prompt: `Tall twisted spire of black iron and fused bones rising from floor to ceiling, hooked spikes along it, thick at the base, ${LOOK}` },
  idol: { model: 'assets/models/deep-idol.glb', size: 1.8, maxTris: 2500, glow: true, prompt: `Squat horned demon idol of black stone sitting cross-legged, its gaping mouth full of glowing embers, ${LOOK}` },
  anvil: { model: 'assets/models/deep-anvil.glb', size: 1.2, maxTris: 2000, prompt: `Infernal blacksmith anvil on a scorched stone block, iron tongs and a half-forged jagged blade lying on it, ${LOOK}` },
  spikewall: { model: 'assets/models/deep-spikewall.glb', size: 2, maxTris: 2000, prompt: `Barricade of crossed rusted iron spikes and broken blades lashed to a charred wooden frame, ${LOOK}` },
  pyre: { model: 'assets/models/deep-pyre.glb', size: 1.4, maxTris: 1500, glow: true, prompt: `Low pile of charred logs and burned bones with glowing orange embers among them, ${LOOK}` },
  // ---- The boss hall (floor 5): the candle corridor and the arena.
  candlePedestal: { model: 'assets/models/hall-candle-pedestal.glb', size: 1.35, maxTris: 2000, prompt: `Waist-high carved black stone pedestal with a cluster of thick melted wax candles on top, unlit candles with blackened wicks, wax dripping down the stone, ${LOOK}` },
  candelabra: { model: 'assets/models/hall-candelabra.glb', size: 2.4, maxTris: 2000, prompt: `Tall black iron gothic floor candelabrum, a twisted stem on three clawed feet holding five thick unlit wax candles in spiked cups, ${LOOK}` },
  hallColumn: { model: 'assets/models/hall-column.glb', size: 9, maxTris: 2500, prompt: `Tall gothic cathedral column of dark carved stone, a ribbed shaft with carved demonic faces at its base and a flaring capital at the top, ${LOOK}` },
  banner: { model: 'assets/models/hall-banner.glb', size: 4, maxTris: 1500, prompt: `Long tattered dark crimson banner hanging from a black iron crossbar, a torn demonic horned sigil stitched in faded gold, frayed ragged bottom edge, ${LOOK}` },
  boneNest: { model: 'assets/models/hall-bone-nest.glb', size: 1.6, maxTris: 3000, prompt: `Huge low wide nest of bones, skulls and rusted chains heaped in a ring, where a giant demon sleeps, ${LOOK}` },
  // The Sleeper's double-bitted axe (the lot owner's own model).
  sleeperAxe: { model: 'assets/models/sleeper-axe.glb', size: 3.3, weapon: true },
  // Treasure at the dead ends, and things to smash.
  chest: { model: 'assets/models/chest.glb', size: 0.95, maxTris: 2500, prompt: `Ornate demonic treasure chest of dark charred wood bound with black iron bands, a horned skull on the lock plate, closed lid, ${LOOK}` },
  urn: { model: 'assets/models/urn.glb', size: 1.0, maxTris: 1200, prompt: `Tall cracked clay burial urn with a narrow neck, carved skull and rune motifs, dark terracotta glaze, ${LOOK}` },
  coffin: { model: 'assets/models/coffin.glb', size: 1.9, maxTris: 1500, prompt: `Old upright wooden coffin of dark rotten planks held with rusted iron nails, a cracked lid, ${LOOK}` },
  crate: { model: 'assets/models/crate.glb', size: 1.0, maxTris: 1000, prompt: `Old wooden supply crate bound with rusted iron straps, a crude skull burned into the side, ${LOOK}` },
  barrel: { model: 'assets/models/barrel.glb', size: 1.1, maxTris: 1200, prompt: `Old rotten wooden barrel bound with rusted iron hoops, splintered planks, bones poking out of the open top, ${LOOK}` },
  // ---- Relics: cursed trinkets found in chests and on elites. Each floats
  // where it lies, and is drawn (tools/icons.html) into its HUD icon.
  relicRime: { model: 'assets/models/relic-rime.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Heavy sword pommel encased in jagged pale blue ice crystals, frost runes carved in dark iron, small floating cursed relic, ${LOOK}` },
  relicFang: { model: 'assets/models/relic-fang.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Huge curved demon fang on a knotted leather cord, glowing blood-red veins inside the ivory, small cursed relic, ${LOOK}` },
  relicCinder: { model: 'assets/models/relic-cinder.glb', size: 0.45, maxTris: 1500, relic: true, prompt: `Cracked black obsidian heart with glowing orange molten lava in the cracks, small cursed relic, ${LOOK}` },
  relicStorm: { model: 'assets/models/relic-storm.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Round iron amulet holding a crackling storm-blue eye gem, lightning runes around the rim, small cursed relic, ${LOOK}` },
  relicWhetstone: { model: 'assets/models/relic-whetstone.glb', size: 0.45, maxTris: 1500, relic: true, prompt: `Cursed whetstone carved with dripping blood-red runes, bound in barbed wire, small cursed relic, ${LOOK}` },
  relicMetronome: { model: 'assets/models/relic-metronome.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Small gothic metronome of brass and bone with a tiny skull as the swinging weight, small cursed relic, ${LOOK}` },
  relicChain: { model: 'assets/models/relic-chain.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Coil of black iron chain with ghostly green soul flames trapped inside the links, small cursed relic, ${LOOK}` },
  relicEcho: { model: 'assets/models/relic-echo.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Ornate dagger hilt with a translucent spectral pale-blue ghost blade, floating, small cursed relic, ${LOOK}` },
  relicGorget: { model: 'assets/models/relic-gorget.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Heavy spiked iron gorget neck guard bound with petrified bark, demonic, small cursed relic, ${LOOK}` },
  relicLantern: { model: 'assets/models/relic-lantern.glb', size: 0.5, maxTris: 1500, relic: true, prompt: `Old iron lantern with a small skull inside burning with an orange flame, small cursed relic, ${LOOK}` },
  relicBrand: { model: 'assets/models/relic-brand.glb', size: 0.55, maxTris: 1500, relic: true, prompt: `Branding iron whose end is a glowing red-hot demonic sigil, wrapped leather handle, small cursed relic, ${LOOK}` },
  // ---- Skill icons only (tools/icons.html draws them; never shipped).
  iconNova: { model: 'assets/models/icon-nova.glb', size: 1, maxTris: 2000, icon: true, prompt: `Erupting ball of hellfire: a molten glowing core wrapped in rings of curling flame and burning horns, ${LOOK}` },
  iconStep: { model: 'assets/models/icon-step.glb', size: 1, maxTris: 2000, icon: true, prompt: `Ghostly shadow wraith mask with hollow glowing violet eyes and trailing smoke wisps, ${LOOK}` },
  iconSiphon: { model: 'assets/models/icon-siphon.glb', size: 1, maxTris: 2000, icon: true, prompt: `Ornate gothic chalice with bone handles overflowing with glowing blood-red liquid, ${LOOK}` },
  iconDodge: { model: 'assets/models/icon-dodge.glb', size: 1, maxTris: 2000, icon: true, prompt: `Pair of spectral shadow greaves (armoured boots) with small ghostly feathered wings at the heels, ${LOOK}` },
  // ---- The street view (scripts/make-lot.mjs): sharp rocks and broken
  // pillars, sharing one texture atlas there.
  spire: { model: 'assets/models/lot-spire.glb', size: 4, maxTris: 900, lot: true, prompt: `Tall razor-sharp spire of black volcanic obsidian rock, jagged splintered facets, several knife-like points, leaning, ${LOOK}` },
  crag: { model: 'assets/models/lot-crag.glb', size: 2.5, maxTris: 900, lot: true, prompt: `Cluster of sharp jagged broken dark rock shards bursting up from the ground, splintered angular crystalline stone blades, ${LOOK}` },
  pillarA: { model: 'assets/models/lot-pillar-a.glb', size: 5, maxTris: 1600, lot: true, prompt: `Tall ancient gothic stone pillar snapped off at a jagged angle near the top, carved demon faces, chunks missing, cracked plinth, ${LOOK}` },
  pillarB: { model: 'assets/models/lot-pillar-b.glb', size: 3, maxTris: 1600, lot: true, prompt: `Short stump of a thick fluted stone column broken off low with a ragged top, fallen drum segment leaning against it, rubble at the base, ${LOOK}` },
  // The tall set pieces of the street view, made tall (never stretched).
  horn: { model: 'assets/models/lot-horn.glb', size: 18, maxTris: 3000, lot: true, prompt: `One colossal curved demon horn rising straight up out of the ground, thick ridged ribbed black horn sweeping up and curling slightly inward to a sharp point, cracked base, tall and narrow, ${LOOK}` },
  tower: { model: 'assets/models/lot-tower.glb', size: 16, maxTris: 3000, lot: true, prompt: `Tall narrow ruined gothic hell tower of black stone, pointed spire roof, thin arched glowing windows, iron spikes and carved skulls on its buttresses, crumbling battlements, tall and slender, ${LOOK}` },
  pillarC: { model: 'assets/models/lot-pillar-c.glb', size: 4.5, maxTris: 1600, lot: true, prompt: `Ruined twisted spiral stone column wrapped in rusted chains, split down the middle with a crack, top shattered, skull carved on the base, ${LOOK}` },
  // ---- The surface and the sanctums.
  well: { model: 'assets/models/blood-well.glb', size: 2.7, prompt: `Ancient round stone well filled with dark blood, iron frame with hanging chains, ${LOOK}` },
  column: { model: 'assets/models/ruin-column.glb', size: 5.5, maxTris: 2500, prompt: `Broken ancient dark stone column snapped at the top, cracked fluted shaft, square plinth base, weathered gothic ruin, ${LOOK}` },
  shard: { model: 'assets/models/rock-shard.glb', size: 4, maxTris: 1200, prompt: `Tall jagged obsidian rock spike, sharp broken shard, dark volcanic stone, ${LOOK}` },
  tree: { model: 'assets/models/dead-tree.glb', size: 6, maxTris: 3000, prompt: `Dead twisted leafless tree, black charred bark, gnarled clawing branches, ${LOOK}` },
  gravestone: { model: 'assets/models/gravestone.glb', size: 1.2, maxTris: 1200, prompt: `Weathered cracked gothic gravestone, dark stone, ${LOOK}` },
};

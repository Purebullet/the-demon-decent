// Every 3D asset slot in the game, filled by AI-generated, medium-poly GLBs
// from Zoodle. Creatures come from an approved concept image (image-to-3D
// batch, see scripts/concepts.mjs and scripts/zoodle.mjs); props from their
// text prompt. No creature is modelled in code: one without its GLB shows a
// plain "missing model" block in development, and `npm run build` refuses to
// package the game until every creature has its model.
//
// Sizes are in metres. Characters are scaled so their height matches, then
// stood on y = 0 facing +Z (`yaw` corrects a model that faces elsewhere).
// `tris` is the triangle budget the model is exported at. Rigged characters
// get hitboxes on their bones and play their animation clips (saved as
// <id>-<clip>.glb by `npm run zoodle -- pull`).
//
// `fire` puts flame emitters on bones (`bone` is a name pattern) at an offset
// given as a fraction of the character's height. `at` is the same point in
// root space, used when the model has no skeleton. Flames are particles in the
// game, so the concept art is drawn without them.

const STYLE = 'dark fantasy, realistic, highly detailed PBR textures, game-ready, clean topology';

// What image-to-3D needs from a concept: one whole figure in a neutral pose,
// nothing in front of it and nothing glowing in the air around it.
const SHEET =
  'Single creature concept for a 3D game model. Whole body from the top of the head to the feet, nothing cropped, centred, ' +
  'plain flat light grey background, soft even studio light, no cast shadow, no ground, no scenery, no text, no frame, no watermark. ' +
  'No fire, flames, smoke, sparks or magic effects anywhere: glowing parts are drawn as solid glowing material. ' +
  'Realistic, highly detailed dark fantasy creature with painted PBR materials, sharp focus';
const BIPED = 'Front three-quarter view, standing upright in a relaxed A-pose, arms held a little away from the body, legs slightly apart, feet flat';
const BEAST = 'Side three-quarter view, standing square on all four legs, legs slightly apart, head level, tail held straight out';

export const CHARACTERS = {
  ghoul: {
    name: 'Husk Ghoul',
    model: 'assets/models/ghoul.glb',
    height: 1.45,
    tris: 10000,
    reference: 'assets/reference/ghoul.png',
    look: 'Emaciated grey ghoul, hairless bulbous head with long pointed bat ears, pale glowing eyes, wide mouth of needle teeth, visible ribs and a sagging belly, long thin arms ending in hooked claws, mottled grey-purple skin, hunched shoulders',
    pose: BIPED,
    fire: [],
  },
  fiend: {
    name: 'Chain Fiend',
    model: 'assets/models/fiend.glb',
    height: 2.1,
    tris: 15000,
    reference: 'assets/reference/fiend.png',
    look: 'Muscular purple-skinned demon, a mane of long ragged glowing green hair, four swept-back bone horns, glowing cyan eyes, fanged reptilian snout, bone spikes on the shoulders, iron chains across the chest and wrists, brown loincloth with a skull belt, clawed digitigrade feet, a hooked iron sickle on a chain hanging from its right hand',
    pose: BIPED,
    fire: [{ bone: 'head', offset: [0, 0.06, -0.04], at: [0, 0.97, -0.03], kind: 'green', rate: 40 }],
  },
  brute: {
    name: 'Flame-Horned Brute',
    model: 'assets/models/brute.glb',
    height: 2.5,
    tris: 15000,
    reference: 'assets/reference/brute.jpg',
    look: 'Hulking brown-skinned demon with a skull-like face and red glowing eyes, thick curved horns with glowing ember-orange tips, spiked shoulders and back, a glowing molten X-shaped scar on the chest, iron chain belt with a large ring buckle, tattered dark leather loincloth, chains wrapped on the forearms, clawed hands, holding a spiked bone club',
    pose: BIPED,
    fire: [
      { bone: 'head', offset: [-0.07, 0.07, 0.01], at: [-0.07, 0.99, 0.02], kind: 'horn', rate: 30 },
      { bone: 'head', offset: [0.07, 0.07, 0.01], at: [0.07, 0.99, 0.02], kind: 'horn', rate: 30 },
      { bone: 'head', offset: [-0.05, 0.03, 0], at: [-0.05, 0.95, 0.02], kind: 'hornBlue', rate: 16 },
      { bone: 'head', offset: [0.05, 0.03, 0], at: [0.05, 0.95, 0.02], kind: 'hornBlue', rate: 16 },
    ],
  },
  hound: {
    name: 'Cinder Hound',
    model: 'assets/models/hound.glb',
    height: 1.15,
    tris: 10000,
    body: 'beast',
    look: 'Skinless hellhound, lean wolf-like body of exposed dark red muscle and patches of black scorched hide, cracks of glowing molten orange along the spine and ribs, long narrow skull with bared teeth and no lips, glowing yellow eyes, a ridge of short bone spikes down the back, long clawed paws, thin whip-like tail',
    pose: BEAST,
    fire: [{ at: [0, 0.95, 0.05], kind: 'ember', rate: 10 }],
  },
  witch: {
    name: 'Pyre Witch',
    model: 'assets/models/witch.glb',
    height: 2.0,
    tris: 15000,
    look: 'Gaunt, hunched hag-demon with charred ash-grey skin, long matted black hair, small curled goat horns, eyes sewn shut with glowing orange stitches, a ragged black hooded robe hanging in tatters, a necklace of small skulls, very long clawed fingers, holding upright in her right hand a tall gnarled bone staff topped with a blackened horned skull whose eye sockets glow orange',
    pose: BIPED,
    fire: [{ bone: 'righthand|hand_r|r_hand|hand.r', offset: [0, 0.5, 0], at: [0.28, 1.04, 0.08], kind: 'torch', rate: 34, name: 'staffTip' }],
  },
  gorvath: {
    // Boss of floor 10.
    name: 'Gorvath, the Flame-Horned',
    model: 'assets/models/gorvath.glb',
    height: 4.75,
    tris: 20000,
    look: 'Colossal demon warlord, skull-like face with a heavy jaw of tusks, enormous curved horns with glowing ember tips, dense spikes on the shoulders and back, a molten heart glowing orange through a cracked chest, blackened iron plates riveted into the shoulders, iron chain belt with a ring buckle, tattered leather loincloth, clawed hands, holding a huge spiked bone club',
    pose: BIPED,
    fire: [
      { bone: 'head', offset: [-0.07, 0.07, 0.01], at: [-0.07, 0.99, 0.02], kind: 'horn', rate: 40 },
      { bone: 'head', offset: [0.07, 0.07, 0.01], at: [0.07, 0.99, 0.02], kind: 'horn', rate: 40 },
      { bone: 'spine2|chest|spine', offset: [0.02, 0.0, 0.08], at: [0.02, 0.72, 0.1], kind: 'heart', rate: 20 },
    ],
  },
  azrakel: {
    // Final boss of floor 20.
    name: 'Azrakel, the Winged Archfiend',
    model: 'assets/models/azrakel.glb',
    height: 4.9,
    tris: 20000,
    reference: 'assets/reference/archfiend.jpg',
    look: 'Towering winged archdemon with a skeletal grinning face, enormous curved ram horns, huge tattered bat wings half spread, gaunt muscular brown body with small spikes and iron rings, a heart glowing orange through the chest, chain belt over a long ragged dark robe, holding a tall wooden staff topped with an iron fire basket full of glowing coals',
    pose: BIPED,
    fire: [
      { bone: 'spine2|chest|spine', offset: [0.02, 0.0, 0.06], at: [0.02, 0.7, 0.08], kind: 'heart', rate: 30 },
      { bone: 'righthand|hand_r|r_hand|hand.r', offset: [0, 0.42, 0], at: [0.3, 1.0, 0.1], kind: 'torch', rate: 40, name: 'staffTip' },
    ],
  },
};

// The text prompt for a creature's concept image.
export function conceptPrompt(id) {
  const c = CHARACTERS[id];
  return `${c.look}. ${c.pose}. ${SHEET}.`;
}

// Props: `size` is the target height (or length for weapons, measured along
// their longest axis, which is turned to point up).
export const PROPS = {
  sword: { model: 'assets/models/sword.glb', size: 1.15, weapon: true, prompt: `One-handed longsword, notched dark iron blade, cross guard, leather-wrapped grip, round pommel, single object, ${STYLE}` },
  axe: { model: 'assets/models/axe.glb', size: 1.25, weapon: true, prompt: `Bearded battle axe, wide crescent iron head with notches, long dark wooden haft bound with leather, single object, ${STYLE}` },
  mace: { model: 'assets/models/mace.glb', size: 1.0, weapon: true, prompt: `Flanged spiked mace, iron head with spikes, dark wooden haft with leather grip, single object, ${STYLE}` },
  potion: { model: 'assets/models/potion.glb', size: 0.36, prompt: `Small round glass potion flask filled with glowing blood-red liquid, cork stopper, leather cord, single object, ${STYLE}` },
  brazier: { model: 'assets/models/brazier.glb', size: 1.3, prompt: `Wrought iron brazier on three clawed legs, bowl filled with glowing coals, single object, ${STYLE}` },
  pillar: { model: 'assets/models/cave-pillar.glb', size: 6.4, prompt: `Massive natural cave rock column from floor to ceiling, dark volcanic stone with cracks, single object, ${STYLE}` },
  rock: { model: 'assets/models/cave-rock.glb', size: 2.6, instanced: true, prompt: `Jagged dark volcanic boulder with sharp facets and deep cracks, single object, ${STYLE}` },
  column: { model: 'assets/models/ruin-column.glb', size: 5.5, prompt: `Broken ancient dark stone column snapped at the top, cracked fluted shaft, square plinth base, weathered gothic ruin, single object, ${STYLE}` },
  shard: { model: 'assets/models/rock-shard.glb', size: 4, prompt: `Tall jagged obsidian rock spike, sharp broken shard, dark volcanic stone, single object, ${STYLE}` },
  tree: { model: 'assets/models/dead-tree.glb', size: 6, prompt: `Dead twisted leafless tree, black charred bark, gnarled branches, single object, ${STYLE}` },
  gravestone: { model: 'assets/models/gravestone.glb', size: 1.2, prompt: `Weathered cracked gothic gravestone, dark stone, single object, ${STYLE}` },
  skulls: { model: 'assets/models/skull-pile.glb', size: 0.6, prompt: `Small pile of human skulls and bones, single object, ${STYLE}` },
  well: { model: 'assets/models/blood-well.glb', size: 2.7, prompt: `Ancient round stone well filled with dark blood, iron frame with hanging chains, single object, ${STYLE}` },
};

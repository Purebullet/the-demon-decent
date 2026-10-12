// Every 3D asset slot in the game. Each one is meant to be filled by an
// AI-generated GLB (image-to-3D from the reference art, or text-to-3D from the
// prompt). Until a file exists at `model`, the game falls back to its built-in
// procedural stand-in, so the game always runs.
//
// Sizes are in metres. Characters are scaled so their height matches, then
// stood on y = 0 facing +Z (`yaw` corrects a model that faces elsewhere).
// Rigged characters get hitboxes on their bones and play their animation
// clips; `animations` lists extra single-clip GLBs (same rig) to merge in.
//
// `fire` puts flame emitters on bones (`bone` is a name pattern) at an offset
// given as a fraction of the character's height. `at` is the same point in
// root space, used when the model has no skeleton.

const STYLE = 'dark fantasy, realistic, highly detailed PBR textures, game-ready, clean topology';
const POSE = 'standing upright, full body visible, feet on the ground, arms slightly away from the body';

export const CHARACTERS = {
  ghoul: {
    model: 'assets/models/ghoul.glb',
    animations: { walk: 'assets/models/ghoul-walk.glb', run: 'assets/models/ghoul-run.glb' },
    height: 1.45,
    reference: 'assets/reference/ghoul.png',
    prompt: `Emaciated grey ghoul, hairless bulbous head with long pointed bat ears, pale glowing eyes, wide mouth of needle teeth, visible ribs and sagging belly, long thin arms with clawed fingers, mottled grey-purple skin, hunched, ${POSE}, ${STYLE}`,
    fire: [],
  },
  fiend: {
    model: 'assets/models/fiend.glb',
    animations: { walk: 'assets/models/fiend-walk.glb', run: 'assets/models/fiend-run.glb' },
    height: 2.1,
    reference: 'assets/reference/fiend.png',
    prompt: `Muscular purple-skinned demon with ghostly green flames for hair, four swept-back bone horns, glowing cyan eyes, fanged reptilian snout, bone spikes on shoulders, iron chains across chest and wrists, brown loincloth with skull belt, clawed digitigrade feet, holding a chain sickle, ${POSE}, ${STYLE}`,
    fire: [{ bone: 'head', offset: [0, 0.06, -0.04], at: [0, 0.97, -0.03], kind: 'green', rate: 40 }],
  },
  brute: {
    model: 'assets/models/brute.glb',
    animations: { walk: 'assets/models/brute-walk.glb', run: 'assets/models/brute-run.glb' },
    height: 2.5,
    reference: 'assets/reference/brute.jpg',
    prompt: `Hulking brown-skinned demon with a skull-like face and red glowing eyes, curved horns, spiked shoulders and back, glowing molten X-shaped scar on the chest, iron chain belt with a large ring buckle, tattered dark leather loincloth, chains wrapped on forearms, clawed hands, holding a spiked bone club, ${POSE}, ${STYLE}`,
    fire: [
      { bone: 'head', offset: [-0.07, 0.07, 0.01], at: [-0.07, 0.99, 0.02], kind: 'horn', rate: 30 },
      { bone: 'head', offset: [0.07, 0.07, 0.01], at: [0.07, 0.99, 0.02], kind: 'horn', rate: 30 },
      { bone: 'head', offset: [-0.05, 0.03, 0], at: [-0.05, 0.95, 0.02], kind: 'hornBlue', rate: 16 },
      { bone: 'head', offset: [0.05, 0.03, 0], at: [0.05, 0.95, 0.02], kind: 'hornBlue', rate: 16 },
    ],
  },
  gorvath: {
    // Boss of floor 10. Falls back to the brute model (scaled) if absent.
    model: 'assets/models/gorvath.glb',
    fallback: 'brute',
    height: 4.75,
    reference: 'assets/reference/brute.jpg',
    prompt: `Colossal demon warlord, skull-like face, enormous curved horns, dense spikes on shoulders and back, burning molten heart glowing through a cracked chest, iron chain belt with ring buckle, tattered leather loincloth, clawed hands, holding a huge spiked bone club, ${POSE}, ${STYLE}`,
    fire: [
      { bone: 'head', offset: [-0.07, 0.07, 0.01], at: [-0.07, 0.99, 0.02], kind: 'horn', rate: 40 },
      { bone: 'head', offset: [0.07, 0.07, 0.01], at: [0.07, 0.99, 0.02], kind: 'horn', rate: 40 },
      { bone: 'spine2|chest|spine', offset: [0.02, 0.0, 0.08], at: [0.02, 0.72, 0.1], kind: 'heart', rate: 20 },
    ],
  },
  azrakel: {
    // Final boss of floor 20.
    model: 'assets/models/azrakel.glb',
    animations: { walk: 'assets/models/azrakel-walk.glb' },
    height: 4.9,
    reference: 'assets/reference/archfiend.jpg',
    prompt: `Towering winged archdemon with a skeletal grinning face, enormous curved ram horns, huge tattered bat wings, gaunt muscular brown body with small spikes and iron rings, a burning heart of fire in the chest, chain belt over a long ragged dark robe, holding a tall wooden staff topped with a blazing torch, ${POSE}, ${STYLE}`,
    fire: [
      { bone: 'spine2|chest|spine', offset: [0.02, 0.0, 0.06], at: [0.02, 0.7, 0.08], kind: 'heart', rate: 30 },
      { bone: 'righthand|hand_r|r_hand|hand.r', offset: [0, 0.42, 0], at: [0.3, 1.0, 0.1], kind: 'torch', rate: 40, name: 'staffTip' },
    ],
  },
};

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

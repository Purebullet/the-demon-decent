// The HUD's painted icons: generated 3D objects (assets/models/icon-*.glb,
// relic-*.glb and the weapons) rendered by `npm run icons` (tools/icons.html)
// into one atlas, assets/icons/atlas.webp, CELL px per icon, COLS across.
// Each icon is lit with its own colour from below and behind.

export const CELL = 160;
export const COLS = 5;

export const ICONS = [
  { id: 'nova', model: 'icon-nova', color: '#ff7a24' },
  { id: 'step', model: 'icon-step', color: '#b080ff' },
  { id: 'siphon', model: 'icon-siphon', color: '#ff3a2a' },
  { id: 'dodge', model: 'icon-dodge', color: '#c8b8ff' },
  { id: 'rime', model: 'relic-rime', color: '#9fe4ff', tilt: -0.7 },
  { id: 'fang', model: 'relic-fang', color: '#ff4a3a', tilt: 0.5 },
  { id: 'cinder', model: 'relic-cinder', color: '#ff8a2a' },
  { id: 'storm', model: 'relic-storm', color: '#a8c8ff' },
  { id: 'whetstone', model: 'relic-whetstone', color: '#e0202a' },
  { id: 'metronome', model: 'relic-metronome', color: '#e8c070' },
  { id: 'chain', model: 'relic-chain', color: '#7dffb0', pitch: 0.5 },
  { id: 'echo', model: 'relic-echo', color: '#c4d8ff' },
  { id: 'gorget', model: 'relic-gorget', color: '#c0a070' },
  { id: 'lantern', model: 'relic-lantern', color: '#ffb050' },
  { id: 'brand', model: 'relic-brand', color: '#ff5030', tilt: -0.75 },
  { id: 'sword', model: 'sword', color: '#ffb070', tilt: -0.8 },
  { id: 'axe', model: 'axe', color: '#ffb070', tilt: -0.8 },
  { id: 'mace', model: 'mace', color: '#ffb070', tilt: -0.8 },
  { id: 'potion', model: 'potion', color: '#ff3a2a' },
];

export const ICON_INDEX = Object.fromEntries(ICONS.map((ic, i) => [ic.id, i]));

// Where an icon sits in the atlas.
export function iconRect(id) {
  const i = ICON_INDEX[id];
  if (i == null) return null;
  return { x: (i % COLS) * CELL, y: Math.floor(i / COLS) * CELL, w: CELL, h: CELL };
}

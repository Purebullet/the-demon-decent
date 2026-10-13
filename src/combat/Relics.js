// Relics: cursed trinkets found in chests, on elite demons and on bosses.
// Each one either grants procs (a chance, on some trigger, of a sudden
// magical effect: see Procs.js) or changes a rule. Finding a relic you
// already carry deepens it: its proc chances rise by half again.
//
// Triggers a proc can listen for (one hit can raise several at once):
//   hit        any melee hit
//   perfect    a hit from a Perfect Chain swing
//   counter    a hit landed while the demon was winding up
//   crit       a hit on the head
//   heavy      a hit from a fully charged heavy blow
//   kill       a killing blow
//   heavyKill  a killing blow from a heavy attack

export const RELICS = {
  rime: {
    name: 'Rime-Bound Pommel',
    model: 'relicRime',
    color: '#9fe4ff',
    text: 'Perfect Chain hits may freeze a demon solid.',
    procs: [{ proc: 'freeze', on: 'perfect', chance: 0.2 }],
  },
  fang: {
    name: 'Fang of the Blood Moon',
    model: 'relicFang',
    color: '#ff4a3a',
    text: 'Killing blows may tear out the blood and heal you.',
    procs: [{ proc: 'lifesteal', on: 'kill', chance: 0.45 }],
  },
  cinder: {
    name: 'Cinder Heart',
    model: 'relicCinder',
    color: '#ff8a2a',
    text: 'Counter-hits may erupt in hellfire.',
    procs: [{ proc: 'hellfire', on: 'counter', chance: 0.6 }],
  },
  storm: {
    name: 'Storm-Eye Sigil',
    model: 'relicStorm',
    color: '#a8c8ff',
    text: 'Critical hits may loose chain lightning.',
    procs: [{ proc: 'lightning', on: 'crit', chance: 0.4 }],
  },
  whetstone: {
    name: 'Hexed Whetstone',
    model: 'relicWhetstone',
    color: '#e0202a',
    text: 'Any hit may open a bleeding wound.',
    procs: [{ proc: 'bleed', on: 'hit', chance: 0.12 }],
  },
  metronome: {
    name: 'Grim Metronome',
    model: 'relicMetronome',
    color: '#e8c070',
    text: 'The Perfect Chain window is wider, and perfect hits strike harder.',
    passive: { window: 1.45, perfectDamage: 0.12 },
  },
  chain: {
    name: 'Soulreaver Chain',
    model: 'relicChain',
    color: '#7dffb0',
    text: 'Heavy killing blows may rend the soul and blast the demons near it.',
    procs: [{ proc: 'soulrend', on: 'heavyKill', chance: 0.75 }],
  },
  echo: {
    name: 'Echo of the Duelist',
    model: 'relicEcho',
    color: '#c4d8ff',
    text: 'Perfect Chains of three or more may strike twice.',
    procs: [{ proc: 'echo', on: 'perfect', chance: 0.3, minChain: 3 }],
  },
  gorget: {
    name: 'Ironbark Gorget',
    model: 'relicGorget',
    color: '#c0a070',
    text: 'You take 18% less damage, and your staggers end sooner.',
    passive: { armor: 0.18, poise: 0.4 },
  },
  lantern: {
    name: "Gravedigger's Lantern",
    model: 'relicLantern',
    color: '#ffb050',
    text: "Your torch burns farther, and demons' wind-ups blaze brighter.",
    passive: { light: 1.35, tells: 1.8 },
  },
  brand: {
    name: 'Wrathful Brand',
    model: 'relicBrand',
    color: '#ff5030',
    text: 'After a demon strikes you, your next blow within 2 s lands as a counter.',
    passive: { wrath: 2 },
  },
};

export const RELIC_IDS = Object.keys(RELICS);

// A relic for a chest or a kill, favouring ones not yet carried.
export function rollRelic(run, rand = Math.random) {
  const fresh = RELIC_IDS.filter((id) => !run.relics[id]);
  const pool = fresh.length && rand() < 0.8 ? fresh : RELIC_IDS;
  return pool[Math.floor(rand() * pool.length)];
}

// Take a relic into the run; returns its new stack count.
export function addRelic(run, id) {
  run.relics[id] = (run.relics[id] || 0) + 1;
  return run.relics[id];
}

// A passive value summed over carried relics (stacks multiply the effect
// of multiplicative ones: two Gorgets are 1 - (1 - 0.18)^2).
export function relicPassive(run, key) {
  let out = null;
  for (const [id, n] of Object.entries(run.relics)) {
    const v = RELICS[id]?.passive?.[key];
    if (v == null) continue;
    if (key === 'armor') out = 1 - (1 - (out ?? 0)) * (1 - v) ** n;
    else if (key === 'window' || key === 'light' || key === 'tells') out = (out ?? 1) * v ** n;
    else out = (out ?? 0) + v * n;
  }
  return out;
}

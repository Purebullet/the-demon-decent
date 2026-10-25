// Sound effects and music, played through the host from the WAV files that
// scripts/make-sounds.mjs renders. Sounds with a world position fade with
// distance from the listener. Rapid repeats of the same sound are thinned so
// a swarm does not turn into noise.
//
// Music: on the title and the surface "Infernal Crescendo"; on the first
// floors the ambient drone; in the Deep (floors 6 on) "Inferno Allegro";
// and "Blood in the Arena" on the boss floors. Each loops. Floor 5, the
// Sleeper's hall: "Shadows in the Hall" down the candle corridor, then
// "From Shadows to Thunder" for the fight, kept low under his voice (and
// lower still while he speaks).

import { SOUND_EXT } from './soundFormat.js';
import { SOUND_NAMES } from './soundList.js';

const DIR = 'assets/sounds/';
const SONGS = {
  intro: 'assets/music/infernal-crescendo.mp3',
  boss: 'assets/music/blood-in-the-arena.mp3',
  deep: 'assets/music/inferno-allegro.mp3',
  hall: 'assets/music/shadows-in-the-hall.mp3',
  thunder: 'assets/music/from-shadows-to-thunder.mp3',
  drone: `${DIR}drone.wav`,
};
// (The songs are mastered a few dB quieter than the drone is played.)
const MUSIC = { intro: 0.8, boss: 0.85, deep: 0.75, hall: 0.75, thunder: 0.5, drone: 0.35 };
// The music under a spoken line.
const DUCK = 0.45;

export class Audio {
  constructor(host) {
    this.host = host;
    this.listener = null;
    this.muted = false;
    this.started = false;
    this.last = new Map();
    this.heartT = 0;
    this.mode = 'intro';
    this.playing = null;
    this.fade = null;
    this.duckT = 0;
    this.duck = 1;
  }

  // Starts the music. Called when the game starts; browsers that hold sound
  // back until the first click or key press get it then (the host waits).
  init() {
    if (this.started) return;
    this.started = true;
    this._startMusic();
  }

  setMuted(m) {
    this.muted = m;
    if (m) {
      this.host.music.stop();
      this.playing = null;
    } else this._startMusic();
  }

  // 'intro', 'boss', 'deep', 'hall', 'thunder' or 'drone'. Asking for what
  // is already playing leaves it be.
  music(mode) {
    if (mode === this.mode && (this.playing || !this.started)) return;
    this.mode = mode;
    this._startMusic();
  }

  // Let the music die away over `secs` (the jump into the pit).
  fadeMusic(secs) {
    if (this.playing) this.fade = { t: 0, secs };
  }

  _startMusic() {
    this.fade = null;
    if (!this.started || this.muted) return;
    this.host.music.play(this.host.asset(SONGS[this.mode]), { volume: MUSIC[this.mode] * this.duck, loop: true });
    this.playing = this.mode;
  }

  // A spoken line (the boss's voice), `secs` long: played as it is, the
  // music drawn down under it.
  voice(path, secs) {
    if (this.muted || !this.started) return;
    this.host.sound.play(this.host.asset(path), { volume: 1, rate: 1 });
    this.duckT = Math.max(this.duckT, secs);
  }

  // Once a frame: a fade, while one runs; the music ducked under a voice.
  update(dt) {
    this.duckT = Math.max(0, this.duckT - dt);
    const want = this.duckT > 0 ? DUCK : 1;
    if (want !== this.duck) {
      this.duck += Math.sign(want - this.duck) * Math.min(Math.abs(want - this.duck), dt * 1.5);
      if (this.playing && !this.fade) this.host.music.volume?.(MUSIC[this.mode] * this.duck);
    }
    const f = this.fade;
    if (!f) return;
    f.t += dt;
    const k = Math.max(0, 1 - f.t / f.secs);
    this.host.music.volume?.(MUSIC[this.mode] * k * k * this.duck);
    if (k <= 0) {
      this.fade = null;
      this.host.music.stop();
      this.playing = null;
    }
  }

  // Every effect (and any `extra` files, a boss's voice) played once,
  // inaudibly, while a floor loads: the host decodes a sound the first time
  // it is played, a stall and a late sound mid-fight otherwise. A few at a
  // time, so nothing playing is crowded out. Each file once a session.
  prime(extra = []) {
    if (this.muted || !this.started) return;
    this.primed ||= new Set();
    const list = [...SOUND_NAMES.map((n) => `${DIR}${n}.${SOUND_EXT}`), ...extra].filter((p) => !this.primed.has(p));
    for (const p of list) this.primed.add(p);
    let i = 0;
    const next = () => {
      if (this.muted) return;
      for (const end = i + 6; i < end && i < list.length; i++) this.host.sound.play(this.host.asset(list[i]), { volume: 0.001, rate: 1 });
      if (i < list.length) setTimeout(next, 60);
    };
    next();
  }

  _vol(pos) {
    if (!pos || !this.listener) return 1;
    const d = Math.hypot(pos.x - this.listener.x, pos.z - this.listener.z);
    return Math.max(0, 1 - d / 28) ** 1.5;
  }

  play(name, { pos = null, volume = 1, rate = 1, gap = 0.05 } = {}) {
    if (this.muted || !this.started) return;
    const v = volume * this._vol(pos);
    if (v < 0.02) return;
    const now = performance.now() / 1000;
    if (now - (this.last.get(name) || 0) < gap) return;
    this.last.set(name, now);
    this.host.sound.play(this.host.asset(`${DIR}${name}.${SOUND_EXT}`), { volume: Math.min(1, v), rate: rate * (0.94 + Math.random() * 0.12) });
  }

  setLowHealth(k, dt) {
    this.heartT -= dt;
    if (k > 0 && this.heartT <= 0) {
      this.heartT = 1.1 - k * 0.45;
      this.play('heartbeat', { volume: 0.4 + k * 0.5, gap: 0.3 });
    }
  }

  // Each creature borrows the voice nearest its size.
  kind = (k) => (k === 'ghoul' || k === 'hound' ? 'ghoul' : k === 'fiend' || k === 'witch' || k === 'wraith' ? 'fiend' : 'brute');

  // A swing's sound says how it was made: a Perfect Chain cuts deeper with
  // every link, a sluggish one drags, a heavy blow (or an axe or mace) heaves
  // through the air, a burning blade roars.
  swing(type, { perfect = false, chain = 0, sluggish = false, flame = false } = {}) {
    const take = (n) => 1 + Math.floor(Math.random() * n);
    if (perfect) {
      this.play('swing_perfect', { volume: 0.9, rate: 1 - 0.05 * chain });
      this.play('chain', { volume: 0.35 + 0.08 * chain, rate: 1 + 0.06 * chain, gap: 0.02 });
    } else if (type === 'heavy') this.play(`swing_heavy_${take(2)}`, { volume: sluggish ? 0.55 : 0.95, rate: sluggish ? 0.8 : 0.92 });
    else if (type === 'sword') this.play(`swing_light_${take(3)}`, { volume: sluggish ? 0.5 : 0.85, rate: sluggish ? 0.78 : 1 });
    else this.play(`swing_heavy_${take(2)}`, { volume: sluggish ? 0.5 : 0.8, rate: sluggish ? 0.9 : 1.15 });
    if (flame) this.play('flame_swing', { volume: 0.7, gap: 0.05 });
  }
  footstep(ground = 'gravel', pace = 1) {
    this.play(`step_${ground}_${1 + Math.floor(Math.random() * 3)}`, { volume: 0.22 + 0.12 * Math.min(1.6, pace), gap: 0.12, rate: 0.95 + 0.05 * Math.min(1.6, pace) });
  }
  slime() {
    this.play('slime', { volume: 0.9, gap: 0.2 });
  }
  extinguish() {
    this.play('extinguish', { volume: 0.8, gap: 0.5 });
  }
  guardDrop() {
    this.play('guard_drop', { volume: 0.8, gap: 0.3 });
  }
  fumble() {
    this.play('fumble', { volume: 0.6, gap: 0.08 });
  }
  clash() {
    this.play('clash', { volume: 1, gap: 0.05 });
  }
  guardBreak() {
    this.play('guard_break', { volume: 1, gap: 0.1 });
  }
  guardUp(pos) {
    this.play('guard_up', { pos, volume: 0.7, gap: 0.2 });
  }
  shatter(pos) {
    this.play('shatter', { pos, volume: 0.9, gap: 0.1 });
  }
  levelUp() {
    this.play('levelup', { volume: 0.9, gap: 0.3 });
  }
  relic() {
    this.play('relic', { volume: 0.9, gap: 0.5 });
  }
  proc(id) {
    const name = { freeze: 'freeze', lifesteal: 'lifesteal', hellfire: 'eruption', lightning: 'zap', bleed: 'bleed', soulrend: 'soulrend', echo: 'echo', echoHit: 'echo' }[id];
    if (name) this.play(name, { volume: 0.95, gap: 0.05, rate: id === 'echoHit' ? 1.25 : 1 });
  }
  // Steel into flesh: a wet slash (one of three, so repeats don't drone),
  // with the weapon's own impact under it.
  hit(type, { counter = false, perfect = false, chain = 0 } = {}) {
    const deep = perfect ? 1 - 0.04 * chain : 1;
    this.play(`flesh_${1 + Math.floor(Math.random() * 3)}`, { volume: 1, gap: 0.04, rate: (0.92 + Math.random() * 0.16) * deep });
    this.play(type === 'sword' ? 'hit_sword' : 'hit_heavy', { volume: 0.45, gap: 0.04, rate: deep });
    if (counter) this.play('counter', { volume: 1, gap: 0.05 });
  }
  smash(kind) {
    const wood = kind === 'barrel' || kind === 'crate' || kind === 'coffin' || kind === 'stakes' || kind === 'pyre';
    const low = kind === 'coffin' || kind === 'statue' ? 0.75 : kind === 'skulls' || kind === 'crystal' ? 1.15 : 0.9;
    this.play(wood ? 'smash_wood' : 'smash_clay', { volume: 0.9, gap: 0.05, rate: low + Math.random() * 0.2 });
  }
  chest() {
    this.play('chest', { volume: 0.9, gap: 0.3 });
  }
  strike() {
    this.play('strike', { volume: 0.8, gap: 0.1, rate: 0.9 + Math.random() * 0.2 });
  }
  ignite() {
    this.play('ignite', { volume: 0.9, gap: 0.5 });
  }
  parry() {
    this.play('parry', { volume: 1, gap: 0.05 });
  }
  whoosh(pos) {
    this.play('whoosh', { pos, volume: 0.7, gap: 0.08, rate: 0.9 + Math.random() * 0.2 });
  }
  blink(pos) {
    this.play('blink', { pos, volume: 0.9, gap: 0.1 });
  }
  block() {
    this.play('block', { volume: 0.9, gap: 0.05, rate: 0.95 + Math.random() * 0.1 });
  }
  charge() {
    this.play('charge', { volume: 0.6, gap: 0.2 });
  }
  chargeFull() {
    this.play('charge_full', { volume: 0.6, gap: 0.2 });
  }
  kill() {
    this.play('kill', { volume: 1, gap: 0.05 });
  }
  hurt() {
    this.play('hurt', { gap: 0.15 });
  }
  dodge() {
    this.play('dodge', { volume: 0.6 });
  }
  growl(kind, pos) {
    this.play(`growl_${this.kind(kind)}`, { pos, volume: 0.7, gap: 0.3 });
  }
  telegraph(kind, pos) {
    this.play(`telegraph_${this.kind(kind)}`, { pos, volume: 0.6, gap: 0.12 });
  }
  enemySwing(kind, pos) {
    if (kind === 'sleeper') return this.bossSwing(pos);
    this.play('enemy_swing', { pos, volume: 0.6, gap: 0.08 });
  }
  death(kind, pos) {
    this.play(`death_${this.kind(kind)}`, { pos, volume: 0.7, gap: 0.1 });
  }
  slam(pos) {
    this.play('slam', { pos, gap: 0.15 });
  }
  burst(pos) {
    this.play('burst', { pos, volume: 0.6, gap: 0.08 });
  }
  fireball(pos) {
    this.play('fireball', { pos, volume: 0.6, gap: 0.06 });
  }
  roar() {
    this.play('roar', { volume: 0.9, gap: 1 });
  }
  nova() {
    this.play('nova');
  }
  step() {
    this.play('step', { volume: 0.7 });
  }
  siphon() {
    this.play('siphon', { volume: 0.8 });
  }
  drink() {
    this.play('drink', { volume: 0.8 });
  }
  pickup() {
    this.play('pickup', { volume: 0.6 });
  }
  // A spell sigil or a relic taken up; one falling to the floor.
  acquire() {
    this.play('acquire', { volume: 0.95, gap: 0.2 });
  }
  drop(pos) {
    this.play('drop', { pos, volume: 0.85, gap: 0.08 });
  }
  // The Sleeper's own: footfalls, the axe in the floor, its swing, his roar.
  bossStep(pos) {
    this.play('boss_step', { pos, volume: 1, rate: 0.94 + Math.random() * 0.1, gap: 0.12 });
  }
  bossImpact(pos) {
    this.play('boss_impact', { pos, volume: 1, gap: 0.2 });
  }
  bossSwing(pos) {
    this.play('boss_swing', { pos, volume: 1, gap: 0.3 });
  }
  bossRoar(pos) {
    this.play('boss_roar', { pos, volume: 1, gap: 0.5 });
  }
  choose() {
    this.play('choose', { volume: 0.8 });
  }
  portal() {
    this.play('portal', { volume: 0.8, gap: 1 });
  }
  sealBreak() {
    this.play('seal', { volume: 0.7, gap: 1 });
  }
  playerDeath() {
    this.play('player_death', { gap: 1 });
  }
}

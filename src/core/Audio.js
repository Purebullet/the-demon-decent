// Sound effects and the ambient drone, played through the host from the WAV
// files that scripts/make-sounds.mjs renders. Sounds with a world position
// fade with distance from the listener. Rapid repeats of the same sound are
// thinned so a swarm does not turn into noise.

const DIR = 'assets/sounds/';

export class Audio {
  constructor(host) {
    this.host = host;
    this.listener = null;
    this.muted = false;
    this.started = false;
    this.last = new Map();
    this.heartT = 0;
  }

  // Browsers only allow sound after the first click or key press.
  init() {
    if (this.started) return;
    this.started = true;
    if (!this.muted) this.host.music.play(this.host.asset(`${DIR}drone.wav`), { volume: 0.35, loop: true });
  }

  setMuted(m) {
    this.muted = m;
    if (m) this.host.music.stop();
    else if (this.started) this.host.music.play(this.host.asset(`${DIR}drone.wav`), { volume: 0.35, loop: true });
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
    this.host.sound.play(this.host.asset(`${DIR}${name}.wav`), { volume: Math.min(1, v), rate: rate * (0.94 + Math.random() * 0.12) });
  }

  setLowHealth(k, dt) {
    this.heartT -= dt;
    if (k > 0 && this.heartT <= 0) {
      this.heartT = 1.1 - k * 0.45;
      this.play('heartbeat', { volume: 0.4 + k * 0.5, gap: 0.3 });
    }
  }

  // Each creature borrows the voice nearest its size.
  kind = (k) => (k === 'ghoul' || k === 'hound' ? 'ghoul' : k === 'fiend' || k === 'witch' ? 'fiend' : 'brute');

  // A swing's sound says how it was made: a Perfect Chain cuts deeper with
  // every link, a sluggish one drags.
  swing(type, { perfect = false, chain = 0, sluggish = false } = {}) {
    if (perfect) {
      this.play('swing_perfect', { volume: 0.8, rate: 1 - 0.05 * chain });
      this.play('chain', { volume: 0.35 + 0.08 * chain, rate: 1 + 0.06 * chain, gap: 0.02 });
    } else if (sluggish) this.play(type === 'sword' ? 'swing_light' : 'swing_heavy', { volume: 0.45, rate: 0.75 });
    else this.play(type === 'sword' ? 'swing_light' : 'swing_heavy', { volume: 0.7 });
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
    this.play(kind === 'barrel' ? 'smash_wood' : 'smash_clay', { volume: 0.9, gap: 0.05, rate: 0.9 + Math.random() * 0.2 });
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

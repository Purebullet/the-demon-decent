// Procedural Web Audio: every sound is synthesized, so the game ships with no
// audio files. Sounds with a world position are attenuated by distance to
// the listener.

export class Audio {
  constructor() {
    this.ctx = null;
    this.listener = null;
    this.muted = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._ambient();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.7;
  }

  _vol(pos) {
    if (!pos || !this.listener) return 1;
    const d = Math.hypot(pos.x - this.listener.x, pos.z - this.listener.z);
    return Math.max(0, 1 - d / 28) ** 1.5;
  }

  _env(gainNode, t, attack, decay, peak) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  noise({ freq = 800, freqEnd = freq, q = 1, type = 'bandpass', attack = 0.005, decay = 0.2, gain = 0.4, pos = null, delay = 0 } = {}) {
    if (!this.ctx) return;
    const v = gain * this._vol(pos);
    if (v < 0.005) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + attack + decay);
    const g = this.ctx.createGain();
    this._env(g, t, attack, decay, v);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.4);
    src.stop(t + attack + decay + 0.05);
  }

  tone({ type = 'sine', freq = 220, freqEnd = freq, attack = 0.005, decay = 0.3, gain = 0.3, pos = null, delay = 0, lp = 0 } = {}) {
    if (!this.ctx) return;
    const v = gain * this._vol(pos);
    if (v < 0.005) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(10, freqEnd), t + attack + decay);
    const g = this.ctx.createGain();
    this._env(g, t, attack, decay, v);
    let node = o;
    if (lp) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      node = o.connect(f);
    }
    node.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  _ambient() {
    // Low detuned drone + wind, slowly breathing.
    const c = this.ctx;
    const out = c.createGain();
    out.gain.value = 0.05;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    for (const f of [41, 41.6, 61.5]) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start();
    }
    lp.connect(out);
    const wind = c.createBufferSource();
    wind.buffer = this.noiseBuf;
    wind.loop = true;
    const wf = c.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 380;
    wf.Q.value = 0.6;
    const wg = c.createGain();
    wg.gain.value = 0.35;
    wind.connect(wf).connect(wg).connect(out);
    wind.start();
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = c.createGain();
    lfoG.gain.value = 140;
    lfo.connect(lfoG).connect(wf.frequency);
    lfo.start();
    out.connect(this.master);
    this.ambientGain = out;
    // Heartbeat bus, raised when health is low.
    this.heartT = 0;
  }

  setLowHealth(k, dt) {
    if (!this.ctx) return;
    this.heartT -= dt;
    if (k > 0 && this.heartT <= 0) {
      this.heartT = 1.1 - k * 0.45;
      this.tone({ freq: 55, freqEnd: 40, decay: 0.16, gain: 0.25 + k * 0.35 });
      this.tone({ freq: 50, freqEnd: 36, decay: 0.2, gain: 0.2 + k * 0.3, delay: 0.22 });
    }
  }

  // ---- Combat --------------------------------------------------------------

  swing(type) {
    const heavy = type !== 'sword';
    this.noise({ freq: heavy ? 300 : 600, freqEnd: heavy ? 1100 : 2400, q: 1.4, attack: 0.04, decay: heavy ? 0.22 : 0.15, gain: 0.32 });
  }

  hit(type) {
    this.tone({ freq: type === 'mace' ? 110 : 160, freqEnd: 40, decay: 0.18, gain: 0.55 });
    this.noise({ type: 'lowpass', freq: type === 'sword' ? 3500 : 1600, freqEnd: 300, decay: 0.12, gain: 0.5 });
    if (type === 'sword') this.tone({ type: 'triangle', freq: 1800, freqEnd: 1500, decay: 0.1, gain: 0.05 });
  }

  hurt() {
    this.tone({ type: 'square', freq: 90, freqEnd: 50, decay: 0.2, gain: 0.25, lp: 600 });
    this.noise({ type: 'lowpass', freq: 900, freqEnd: 200, decay: 0.2, gain: 0.45 });
  }

  dodge() {
    this.noise({ freq: 900, freqEnd: 300, q: 0.8, attack: 0.02, decay: 0.18, gain: 0.22 });
  }

  growl(kind, pos) {
    const f = kind === 'ghoul' ? 140 : kind === 'fiend' ? 95 : 60;
    this.tone({ type: 'sawtooth', freq: f, freqEnd: f * 0.7, attack: 0.08, decay: 0.55, gain: 0.22, pos, lp: 700 });
    this.noise({ freq: f * 4, freqEnd: f * 2, q: 3, attack: 0.08, decay: 0.5, gain: 0.15, pos });
  }

  telegraph(kind, pos) {
    const f = kind === 'ghoul' ? 220 : kind === 'fiend' ? 150 : 80;
    this.tone({ type: 'sawtooth', freq: f * 0.8, freqEnd: f * 1.3, attack: 0.05, decay: 0.3, gain: 0.12, pos, lp: 900 });
  }

  enemySwing(kind, pos) {
    this.noise({ freq: 400, freqEnd: 1400, q: 1.2, attack: 0.03, decay: 0.2, gain: 0.22, pos });
  }

  death(kind, pos) {
    const f = kind === 'ghoul' ? 160 : kind === 'fiend' ? 110 : 70;
    this.tone({ type: 'sawtooth', freq: f, freqEnd: f * 0.3, attack: 0.02, decay: 0.8, gain: 0.25, pos, lp: 800 });
    this.noise({ type: 'lowpass', freq: 600, freqEnd: 80, decay: 0.5, gain: 0.3, pos });
  }

  slam(pos) {
    this.tone({ freq: 70, freqEnd: 28, attack: 0.005, decay: 0.7, gain: 0.7, pos });
    this.noise({ type: 'lowpass', freq: 700, freqEnd: 60, decay: 0.6, gain: 0.6, pos });
  }

  burst(pos) {
    this.noise({ freq: 1200, freqEnd: 200, q: 0.7, decay: 0.35, gain: 0.35, pos });
  }

  fireball(pos) {
    this.noise({ freq: 300, freqEnd: 1600, q: 0.8, attack: 0.05, decay: 0.3, gain: 0.25, pos });
  }

  roar(pos) {
    this.tone({ type: 'sawtooth', freq: 70, freqEnd: 45, attack: 0.15, decay: 1.4, gain: 0.4, lp: 500 });
    this.tone({ type: 'sawtooth', freq: 105, freqEnd: 60, attack: 0.15, decay: 1.3, gain: 0.25, lp: 700 });
    this.noise({ freq: 300, freqEnd: 150, q: 2, attack: 0.2, decay: 1.2, gain: 0.3 });
  }

  // ---- Player actions ------------------------------------------------------

  nova() {
    this.tone({ freq: 90, freqEnd: 30, decay: 0.8, gain: 0.6 });
    this.noise({ freq: 2000, freqEnd: 200, q: 0.5, decay: 0.7, gain: 0.5 });
  }

  step() {
    this.tone({ type: 'sine', freq: 200, freqEnd: 900, attack: 0.02, decay: 0.25, gain: 0.2 });
    this.noise({ freq: 3000, freqEnd: 600, q: 2, decay: 0.3, gain: 0.15 });
  }

  siphon() {
    for (let i = 0; i < 3; i++) this.tone({ freq: 60, freqEnd: 40, decay: 0.15, gain: 0.35, delay: i * 0.18 });
    this.tone({ type: 'triangle', freq: 300, freqEnd: 150, attack: 0.1, decay: 0.6, gain: 0.12 });
  }

  drink() {
    for (let i = 0; i < 3; i++) this.noise({ type: 'lowpass', freq: 500, freqEnd: 200, decay: 0.08, gain: 0.3, delay: i * 0.17 });
  }

  pickup() {
    [523, 659, 784].forEach((f, i) => this.tone({ type: 'triangle', freq: f, decay: 0.25, gain: 0.1, delay: i * 0.06 }));
  }

  choose() {
    [196, 247, 294, 392].forEach((f, i) => this.tone({ type: 'triangle', freq: f, decay: 0.8, gain: 0.12, delay: i * 0.1 }));
    this.tone({ freq: 60, freqEnd: 40, decay: 1.2, gain: 0.3 });
  }

  portal() {
    this.tone({ type: 'sawtooth', freq: 55, freqEnd: 30, attack: 0.3, decay: 1.6, gain: 0.3, lp: 300 });
    this.noise({ freq: 200, freqEnd: 2000, q: 1, attack: 0.6, decay: 1.0, gain: 0.25 });
  }

  sealBreak() {
    this.tone({ type: 'triangle', freq: 220, freqEnd: 110, decay: 1.4, gain: 0.2 });
    this.noise({ freq: 4000, freqEnd: 800, q: 4, decay: 0.6, gain: 0.15 });
  }

  playerDeath() {
    this.tone({ type: 'sawtooth', freq: 110, freqEnd: 25, attack: 0.05, decay: 2.5, gain: 0.35, lp: 400 });
    this.noise({ type: 'lowpass', freq: 400, freqEnd: 40, decay: 2.0, gain: 0.4 });
  }
}

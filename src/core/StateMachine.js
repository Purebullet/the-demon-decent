// Small finite state machine. Each state is an object with optional
// enter(owner, params, prevName), exit(owner, nextName) and update(owner, dt).
// An optional transition table restricts which states may follow which, so an
// illegal jump (e.g. sanctum -> surface without dying) throws instead of
// silently corrupting the run.

export class StateMachine {
  constructor(owner, transitions = null) {
    this.owner = owner;
    this.transitions = transitions;
    this.states = new Map();
    this.current = null;
    this.currentName = null;
    this.onChange = null;
  }

  add(name, state) {
    this.states.set(name, state);
    return this;
  }

  canChange(name) {
    if (!this.states.has(name)) return false;
    if (!this.transitions || this.currentName === null) return true;
    const allowed = this.transitions[this.currentName];
    return !!allowed && allowed.includes(name);
  }

  change(name, params) {
    if (!this.states.has(name)) throw new Error(`Unknown state "${name}"`);
    if (!this.canChange(name)) {
      throw new Error(`Illegal transition ${this.currentName} -> ${name}`);
    }
    const prev = this.currentName;
    this.current?.exit?.(this.owner, name);
    this.current = this.states.get(name);
    this.currentName = name;
    this.current.enter?.(this.owner, params, prev);
    this.onChange?.(name, prev);
  }

  update(dt) {
    this.current?.update?.(this.owner, dt);
  }

  is(name) {
    return this.currentName === name;
  }
}

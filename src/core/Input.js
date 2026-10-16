// Keyboard + mouse/touch input from the host (Project 0's sandbox or a web
// page). Held state is queried with isDown(); one-shot presses with
// wasPressed(), cleared every frame by endFrame().
//
// Looking around: mouse movement while the pointer is locked, or a drag when
// it is not (pointer lock can be refused, and phones have none). On a touch
// screen a short tap is a click.
//
// A menu over the game (a level gained, an altar's choice) keeps the pointer
// locked: the mouse moves a cursor the game draws (`menuCursor`) instead of
// the view, so it never has to let the mouse go and win it back, which a
// browser may refuse, leaving the page's cursor out while you play.

export class Input {
  constructor(host) {
    this.host = host;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.mouseDown = [false, false, false];
    this.mouseClicked = [false, false, false];
    this.taps = [];
    this.pointer = { x: 0, y: 0 };
    this.touch = false;
    this.sensitivity = 0.0022;
    this.dragSensitivity = 0.005;
    this.onLockChange = null;
    this._down = null;
    this.menu = null;

    host.on('keydown', (e) => {
      if (!e.code || e.repeat) return;
      this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    host.on('keyup', (e) => this.keys.delete(e.code));
    host.on('pointerdown', (e) => {
      this.pointer.x = e.x;
      this.pointer.y = e.y;
      this.touch = !!e.touch;
      this._down = { x: e.x, y: e.y, t: performance.now(), moved: 0, button: e.button ?? 0 };
      if (this.locked || !e.touch) {
        const b = Math.max(0, e.button ?? 0);
        this.mouseDown[b] = true;
        this.mouseClicked[b] = true;
      }
      const at = this.cursor;
      this.taps.push({ x: at === this.menu ? at.x : e.x, y: at === this.menu ? at.y : e.y, touch: !!e.touch });
    });
    host.on('pointerup', (e) => {
      const b = Math.max(0, e.button ?? 0);
      this.mouseDown[b] = false;
      // A short touch with little movement is a tap = attack.
      const d = this._down;
      if (d && e.touch && d.moved < 12 && performance.now() - d.t < 300) this.mouseClicked[0] = true;
      this._down = null;
    });
    host.on('pointermove', (e) => {
      this.pointer.x = e.x;
      this.pointer.y = e.y;
      const dx = e.dx || 0;
      const dy = e.dy || 0;
      if (this.locked && this.menu) {
        const m = this.menu;
        m.x = Math.max(0, Math.min(m.w, m.x + dx));
        m.y = Math.max(0, Math.min(m.h, m.y + dy));
      } else if (this.locked) {
        if (Math.abs(dx) < 300 && Math.abs(dy) < 300) {
          this.mouseDX += dx * this.sensitivity;
          this.mouseDY += dy * this.sensitivity;
        }
      } else if (this._down) {
        this._down.moved += Math.abs(dx) + Math.abs(dy);
        this.mouseDX += dx * this.dragSensitivity;
        this.mouseDY += dy * this.dragSensitivity;
      }
    });
    host.on('pointerlock', () => {
      if (!this.locked) {
        this.keys.clear();
        this.mouseDown.fill(false);
      }
      this.onLockChange?.(this.locked);
    });
  }

  get locked() {
    return this.host.pointerLocked;
  }

  // A menu is up: the mouse moves a cursor from (x, y) over a w x h screen.
  menuCursor(x, y, w, h) {
    this.menu = { x, y, w, h };
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  closeMenu() {
    this.menu = null;
  }

  // Where the cursor is: the menu's while the pointer is locked, else the
  // page's.
  get cursor() {
    return this.menu && this.locked ? this.menu : this.pointer;
  }

  requestLock() {
    if (!this.locked && !this.touch) this.host.lockPointer();
  }

  isDown(code) {
    return this.keys.has(code) || this.host.isDown?.(code);
  }

  wasPressed(code) {
    return this.pressed.has(code);
  }

  // Forward/strafe axes in [-1, 1].
  moveAxes() {
    const f = (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0) - (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0);
    const s = (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) - (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);
    return { forward: f, strafe: s };
  }

  consumeMouse() {
    const dx = this.mouseDX;
    const dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  // A tap that hit an on-screen button: it should not also attack or look.
  claimTap() {
    this._down = null;
    this.mouseClicked[0] = false;
    this.mouseDown[0] = false;
  }

  endFrame() {
    this.pressed.clear();
    this.mouseClicked.fill(false);
    this.taps.length = 0;
  }
}

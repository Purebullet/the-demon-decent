// Keyboard + pointer-lock mouse input.
// Held state is queried with isDown(); one-shot presses with wasPressed(),
// which are cleared at the end of every frame by endFrame().

export class Input {
  constructor(dom) {
    this.dom = dom;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.mouseDown = [false, false, false];
    this.mouseClicked = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0022;
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown.fill(false);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Some browsers report huge spikes on lock; drop them.
      if (Math.abs(e.movementX) > 300 || Math.abs(e.movementY) > 300) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    dom.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.mouseDown[e.button] = true;
      this.mouseClicked[e.button] = true;
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseDown[e.button] = false;
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this.mouseDown.fill(false);
      }
      this.onLockChange?.(this.locked);
    });
  }

  requestLock() {
    if (this.locked) return;
    const req = this.dom.requestPointerLock?.();
    // Chrome returns a promise that rejects if the user exits lock too quickly.
    req?.catch?.(() => {});
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code) {
    return this.keys.has(code);
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
    const dx = this.mouseDX * this.sensitivity;
    const dy = this.mouseDY * this.sensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  endFrame() {
    this.pressed.clear();
    this.mouseClicked.fill(false);
  }
}

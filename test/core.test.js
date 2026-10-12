import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Quaternion, Vector3, Euler } from 'three';
import { OBB } from '../src/physics/OBB.js';
import { CollisionWorld } from '../src/physics/CollisionWorld.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { StateMachine } from '../src/core/StateMachine.js';
import { TRANSITIONS, nextAfterFloor } from '../src/game/transitions.js';
import { recordDepth } from '../src/game/Progression.js';

const box = (pos, rotY = 0, half = [0.5, 0.5, 0.5]) =>
  new OBB().setFromMatrix(new Vector3(), new Vector3(...half), new Matrix4().compose(new Vector3(...pos), new Quaternion().setFromEuler(new Euler(0, rotY, 0)), new Vector3(1, 1, 1)));

test('OBB separating-axis test handles rotation', () => {
  assert.ok(box([0, 0, 0]).intersectsOBB(box([0.9, 0, 0])));
  assert.ok(!box([0, 0, 0]).intersectsOBB(box([1.1, 0, 0])));
  // A 45-degree box reaches further along x: corner at ~0.707.
  assert.ok(box([0, 0, 0]).intersectsOBB(box([1.15, 0, 0], Math.PI / 4)));
  assert.ok(!box([0, 0, 0]).intersectsOBB(box([1.3, 0, 0], Math.PI / 4)));
  // Long thin blade crossing a body diagonally.
  assert.ok(box([0, 1, 0], 0, [0.3, 0.6, 0.3]).intersectsOBB(box([0.5, 1, 0.5], Math.PI / 4, [0.05, 0.05, 1])));
});

test('OBB vs sphere', () => {
  const b = box([0, 0, 0]);
  assert.ok(b.intersectsSphere(new Vector3(0.8, 0, 0), 0.31));
  assert.ok(!b.intersectsSphere(new Vector3(0.8, 0, 0), 0.29));
});

function grid(rows) {
  const nav = new NavGrid(rows[0].length, rows.length, 2);
  rows.forEach((row, r) => [...row].forEach((ch, c) => (nav.walkable[r * nav.cols + c] = ch === '#' ? 0 : 1)));
  return nav;
}

test('A* routes around walls and never cuts corners', () => {
  const nav = grid(['.....', '.###.', '.#...', '.#.#.', '...#.']);
  const path = nav.findPath(2, 2, 0, 0);
  assert.ok(path, 'path exists');
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const ac = a % nav.cols;
    const ar = (a - ac) / nav.cols;
    const bc = b % nav.cols;
    const br = (b - bc) / nav.cols;
    assert.ok(nav.isWalkable(bc, br));
    if (ac !== bc && ar !== br) assert.ok(nav.isWalkable(bc, ar) && nav.isWalkable(ac, br), 'diagonal cut a corner');
  }
  assert.equal(nav.findPath(0, 0, 2, 2).length, path.length);
});

test('A* penalty field diverts the route', () => {
  const nav = grid(['.....', '.....', '.....']);
  const straight = nav.findPath(0, 1, 4, 1);
  assert.ok(straight.every((i) => Math.floor(i / nav.cols) === 1));
  // Make the middle row expensive: the path should leave it.
  const detour = nav.findPath(0, 1, 4, 1, { penalty: (i) => (Math.floor(i / nav.cols) === 1 && i % nav.cols > 0 && i % nav.cols < 4 ? 10 : 0) });
  assert.ok(detour.some((i) => Math.floor(i / nav.cols) !== 1));
});

test('grid line of sight', () => {
  const nav = grid(['.....', '..#..', '.....']);
  assert.ok(!nav.hasLineOfSight(1, 3, 9, 3));
  assert.ok(nav.hasLineOfSight(1, 1, 9, 1));
});

test('circle collision slides along walls', () => {
  const world = new CollisionWorld({ grid: { cols: 3, rows: 3, solid: Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]) }, tileSize: 2 });
  const p = new Vector3(3, 0, 3);
  world.move(p, 0.4, 5, 0.5);
  assert.ok(p.x <= 4 - 0.4 + 1e-6, 'stopped by wall');
  assert.ok(p.z > 3, 'kept sliding');
});

test('state machine enforces the run flow', () => {
  const fsm = new StateMachine({}, TRANSITIONS);
  for (const s of Object.keys(TRANSITIONS)) fsm.add(s, {});
  fsm.change('title');
  fsm.change('surface');
  fsm.change('floor');
  assert.throws(() => fsm.change('surface'), /Illegal/);
  fsm.change('sanctum');
  fsm.change('floor');
  fsm.change('dead');
  fsm.change('surface');
  assert.deepEqual(nextAfterFloor(9, 20), { state: 'sanctum', next: 10 });
  assert.deepEqual(nextAfterFloor(20, 20), { state: 'victory' });
});

test('high score keeps the deepest floor', () => {
  const s = { best: 5 };
  assert.equal(recordDepth(s, 3), false);
  assert.equal(s.best, 5);
  assert.equal(recordDepth(s, 7), true);
  assert.equal(s.best, 7);
});

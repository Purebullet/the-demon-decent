// Legal state transitions for the run. Anything else is a bug.
//
//   title --click--> surface --fall into pit--> floor(1)
//   floor(n) --exit, n < 20--> sanctum(n+1) --portal--> floor(n+1)
//   floor(20) --exit--> victory --> surface
//   floor(any) --death--> dead --> surface   (permadeath: the run is wiped)

export const TRANSITIONS = {
  title: ['surface'],
  surface: ['floor'],
  floor: ['sanctum', 'dead', 'victory'],
  sanctum: ['floor'],
  dead: ['surface'],
  victory: ['surface'],
};

// Where an exit portal leads from floor n.
export function nextAfterFloor(n, floorCount) {
  return n >= floorCount ? { state: 'victory' } : { state: 'sanctum', next: n + 1 };
}

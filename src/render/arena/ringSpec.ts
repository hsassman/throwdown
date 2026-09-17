import { FT, IN } from "./octagonSpec";

// Regulation boxing ring, in real measurements.
//
// Same approach as octagonSpec.ts and for the same reason: the numbers are
// testable on their own, and proportions that are wrong at this level cannot
// be fixed by nudging the render code afterwards.
//
// WHERE "20 FEET" IS MEASURED
//
// A championship ring is 20 feet INSIDE THE ROPES — not 20 feet of platform.
// The apron is extra, and it has to be: fighters stand on it, corners work
// from it, and a fighter driven onto the ropes needs somewhere for their feet
// to be. Reading the 20 feet as the platform edge would put the ropes at 16
// feet apart and make the ring a quarter smaller than it should be.
//
// The four ropes are the detail that makes a ring read as a ring rather than a
// square with a fence. Their heights are the standard set, measured from the
// canvas.

export const RING = {
  /** Inside the ropes, wall to wall, metres. */
  insideRopes: 20 * FT,
  /** Canvas continuing past the ropes on every side, metres. */
  apron: 2 * FT,
  /** Platform height above the floor, metres. */
  platformHeight: 3 * FT,

  /** Corner posts: height above the canvas, and thickness. */
  postHeight: 58 * IN,
  postRadius: 2.5 * IN,
  /** Foam turnbuckle pad wrapped round each post. */
  padRadius: 5 * IN,
  padHeight: 48 * IN,

  /** Rope heights above the canvas, bottom to top. The standard four. */
  ropeHeights: [18 * IN, 30 * IN, 42 * IN, 54 * IN],
  ropeRadius: 0.6 * IN,

  /** Skirt hanging from the platform edge to the floor. */
  skirtDrop: 3 * FT,
} as const;

export interface RingCorner {
  x: number;
  z: number;
}

/** Half the distance between opposite ropes. */
export function ropeHalfSpan(inside = RING.insideRopes): number {
  return inside / 2;
}

/** Half the platform, including the apron. */
export function platformHalfSpan(inside = RING.insideRopes): number {
  return inside / 2 + RING.apron;
}

/** Canvas area inside the ropes, square metres. */
export function ringArea(inside = RING.insideRopes): number {
  return inside * inside;
}

/**
 * The four post centres, on the XZ plane, centred on the origin.
 *
 * Posts sit ON the rope line, at its corners — that is what the ropes are
 * tensioned between, so anywhere else and the ropes would not meet them.
 */
export function ringCorners(inside = RING.insideRopes): RingCorner[] {
  const h = ropeHalfSpan(inside);
  return [
    { x: -h, z: -h },
    { x: h, z: -h },
    { x: h, z: h },
    { x: -h, z: h },
  ];
}

export interface RopeRun {
  from: RingCorner;
  to: RingCorner;
  height: number;
}

/** Every rope segment: four sides times four heights. */
export function ropes(inside = RING.insideRopes): RopeRun[] {
  const c = ringCorners(inside);
  const out: RopeRun[] = [];
  for (const height of RING.ropeHeights) {
    for (let i = 0; i < c.length; i++) {
      out.push({ from: c[i], to: c[(i + 1) % c.length], height });
    }
  }
  return out;
}

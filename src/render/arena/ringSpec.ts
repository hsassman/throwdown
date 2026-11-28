import { FT, IN } from "./octagonSpec";

// Regulation boxing ring, in real measurements.

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

/** The four post centres, on the XZ plane, centred on the origin. */
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

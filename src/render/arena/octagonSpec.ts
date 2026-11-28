// Real-world dimensions of a regulation octagon, and the pure geometry derived
// from them. No three.js here on purpose - the numbers are testable on their
// own, and getting them wrong is the one mistake that cannot be fixed by
// nudging the render code afterwards.
// Where "30 feet across" is measured, and why it matters

/** Feet to metres. The spec sheet is imperial; everything downstream is SI. */
export const FT = 0.3048;
/** Inches to metres, for the small stuff (post width, mesh aperture). */
export const IN = 0.0254;

export const OCTAGON = {
  /** Wall to opposite wall, metres. The headline "30 feet across". */
  acrossFlats: 30 * FT,
  /** Fence height above the canvas, metres. Sheet: "maximum cage height 6 ft". */
  fenceHeight: 6 * FT,
  /** Canvas height above the surrounding ground, metres. Sheet: "maximum
   *  height above ground: 4 ft". */
  platformHeight: 4 * FT,
  /** How far the floor continues past the fence line, metres. Sheet: "floor
   *  extends at least 1.5 feet from cage". This is the apron fighters get
   *  pushed onto, and it is why the platform outline is a larger octagon than
   *  the fence. */
  apron: 1.5 * FT,

  /** Padded corner posts. Not on the sheet as a number - taken from the
   *  photograph, where a post reads as roughly a hand-span across and the pad
   *  as a fat sausage around it. */
  postWidth: 6 * IN,
  postDepth: 6 * IN,
  /** Radius of the foam padding wrapped around each post. */
  postPadRadius: 5 * IN,

  /** Chain-link aperture, corner to corner of one diamond. */
  meshAperture: 2 * IN,
  /** Wire gauge. "Heavy-duty steel wire" on the sheet. */
  meshWire: 0.18 * IN,

  /** Height of the vinyl-wrapped padding that skirts the platform edge below
   *  the fence - the red band in both reference images. */
  skirtHeight: 4 * FT,
} as const;

/** Circumradius: centre to a corner, metres. */
export function circumradius(acrossFlats = OCTAGON.acrossFlats): number {
  // apothem = acrossFlats / 2, and apothem = R * cos(pi/8).
  return acrossFlats / 2 / Math.cos(Math.PI / 8);
}

/** Centre to the middle of a wall, metres. Half the across-flats figure. */
export function apothem(acrossFlats = OCTAGON.acrossFlats): number {
  return acrossFlats / 2;
}

/** Length of one of the eight walls, metres. */
export function sideLength(acrossFlats = OCTAGON.acrossFlats): number {
  return 2 * circumradius(acrossFlats) * Math.sin(Math.PI / 8);
}

/** Enclosed floor area, square metres. */
export function floorArea(acrossFlats = OCTAGON.acrossFlats): number {
  const r = circumradius(acrossFlats);
  return 2 * Math.SQRT2 * r * r;
}

export interface Corner {
  x: number;
  z: number;
}

/** The eight corners, on the XZ plane, centred on the origin. */
export function corners(radius = circumradius()): Corner[] {
  const out: Corner[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    out.push({ x: Math.sin(a) * radius, z: Math.cos(a) * radius });
  }
  return out;
}

/** Midpoint of each wall, paired with its outward normal. One per panel. */
export function walls(radius = circumradius()): {
  mid: Corner;
  angle: number;
  length: number;
}[] {
  const c = corners(radius);
  return c.map((a, i) => {
    const b = c[(i + 1) % 8];
    return {
      mid: { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 },
      // Rotation about Y that lays a +X-aligned plane along this wall.
      angle: Math.atan2(-(b.z - a.z), b.x - a.x),
      length: Math.hypot(b.x - a.x, b.z - a.z),
    };
  });
}

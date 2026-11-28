import type { ImpactPoint } from "../perception/strikeGeometry";

// The punching dummy: an upper body on a stand.
// Everything here is expressed in the same torso-unit body frame that
// `strikeGeometry.ts` resolves strikes into - 0 is the belt line, 1.0 is the
// shoulder line, and lateral is offset from the midline. Nothing in this file
// is in metres, and nothing in it knows what the dummy looks like.

export interface DummySpec {
  /** Top of the head, torso units above the belt line. */
  crown: number;
  /** Shoulder line. 1.0 by definition - the torso scale is shoulder-to-hip. */
  shoulder: number;
  /** Where the body stops and the stand begins. */
  base: number;
  /** Half-width of the chest at the shoulder line. */
  chestHalfWidth: number;
  /** Half-width of the head at eye level. */
  headHalfWidth: number;
  /** Height of the neck's narrowest point. */
  neck: number;
  /**
   * Height at which the body is widest - the deltoid line, a little below the
   * shoulder line rather than exactly on it.
   */
  deltoid: number;
  /** Depth of the torso front-to-back, for the renderer's cross-section. */
  torsoDepth: number;
  /** Stand column and base radii. */
  stand: { radius: number; footRadius: number };
}

/**
 * Proportions of a commercial free-standing dummy, expressed against the
 * figure's own torso so it scales with whoever is being tracked.
 */
export const DUMMY: DummySpec = {
  crown: 1.68,
  shoulder: 1.0,
  base: 0.34,
  chestHalfWidth: 0.46,
  headHalfWidth: 0.19,
  neck: 1.12,
  deltoid: 0.88,
  // 0.5 torso units = 0.24m front to back on this rig, which is a real chest.
  // It was 0.4 (0.19m) and that made the chest shallower than the head was
  // deep - a test asserting the chest is the deepest part of the body caught
  // it. A head protruding further forward than the sternum would have put
  // every body target behind the face in depth.
  torsoDepth: 0.5,
  // The column is slim and ribbed, flaring into a wide weighted base.
  stand: { radius: 0.095, footRadius: 0.62 },
};

/** Smoothstep. Used everywhere a profile has to meet another without a crease. */
function smooth(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** The head's profile, 0..1, as a fraction of its widest point. */
function headProfile(h: number, spec: DummySpec): number {
  const bottom = spec.neck - 0.18;
  const centre = (bottom + spec.crown) / 2;
  const halfH = (spec.crown - bottom) / 2;
  const t = (h - centre) / halfH;
  return Math.sqrt(Math.max(0, 1 - t * t));
}

/** Half-width of the head at a given height. */
function headHalfWidth(h: number, spec: DummySpec): number {
  return spec.headHalfWidth * headProfile(h, spec);
}

/** Half-width of the dummy's silhouette at a given height. */
export function halfWidthAt(h: number, spec: DummySpec = DUMMY): number {
  if (h < spec.base || h > spec.crown) return 0;
  if (h >= spec.neck) return headHalfWidth(h, spec);

  if (h <= spec.deltoid) {
    // Torso: narrowest at the cut line, widening into the chest. A straight
    // column makes every body shot land at the same lateral offset and the
    // liver stops being a distinct target from the ribs.
    const t = (h - spec.base) / (spec.deltoid - spec.base);
    return spec.chestHalfWidth * (0.74 + 0.26 * smooth(t));
  }

  // Shoulder plateau, deltoid line to shoulder line. This is the broad flat
  // shoulder the reference dummy has, and it is what stops the silhouette
  // reading as a bowling pin: without it the body starts narrowing the instant
  // it reaches full width, so there is no shoulder at all, just a cone.
  if (h <= spec.shoulder) return spec.chestHalfWidth;

  // Trapezius, sloping from the shoulder line into the neck.
  const t = (h - spec.shoulder) / (spec.neck - spec.shoulder);
  const neckW = headHalfWidth(spec.neck, spec);
  return spec.chestHalfWidth + (neckW - spec.chestHalfWidth) * smooth(t);
}

/** Front-to-back half-depth of the silhouette at a given height. */
export function halfDepthAt(h: number, spec: DummySpec = DUMMY): number {
  if (h < spec.base || h > spec.crown) return 0;
  // A head is deeper than it is wide - front to back is its long axis.
  const headDepth = spec.headHalfWidth * HEAD_DEPTH_RATIO;
  if (h >= spec.neck) return headDepth * headProfile(h, spec);

  const half = spec.torsoDepth / 2;
  if (h <= spec.deltoid) {
    const t = (h - spec.base) / (spec.deltoid - spec.base);
    return half * (0.84 + 0.16 * smooth(t));
  }
  if (h <= spec.shoulder) return half;
  const t = (h - spec.shoulder) / (spec.neck - spec.shoulder);
  const neckD = headDepth * headProfile(spec.neck, spec);
  return half + (neckD - half) * smooth(t);
}

/** How much deeper than wide the head is. */
const HEAD_DEPTH_RATIO = 1.15;

/** Exponent of the superelliptical cross-section. */
export function sectionExponent(h: number, spec: DummySpec = DUMMY): number {
  return h > spec.neck ? 2.0 : 2.4;
}

/** Depth of the surface directly in front of a lateral/height position. */
export function surfaceDepth(
  lateral: number,
  h: number,
  spec: DummySpec = DUMMY
): number {
  const halfW = halfWidthAt(h, spec);
  const halfD = halfDepthAt(h, spec);
  if (halfW <= 0 || halfD <= 0) return 0;
  const n = sectionExponent(h, spec);
  const t = Math.min(1, Math.abs(lateral) / halfW);
  return halfD * Math.pow(Math.max(0, 1 - Math.pow(t, n)), 1 / n);
}

/** Whether a resolved impact actually landed on the dummy at all. */
export function onDummy(p: ImpactPoint, spec: DummySpec = DUMMY): boolean {
  const half = halfWidthAt(p.height, spec);
  return half > 0 && Math.abs(p.lateral) <= half;
}

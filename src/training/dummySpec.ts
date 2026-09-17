import type { ImpactPoint } from "../perception/strikeGeometry";

// The punching dummy: an upper body on a stand.
// WHY THIS IS A SPEC AND NOT A MESH
//
// Everything here is expressed in the SAME torso-unit body frame that
// `strikeGeometry.ts` resolves strikes into — 0 is the belt line, 1.0 is the
// shoulder line, and lateral is offset from the midline. Nothing in this file
// is in metres, and nothing in it knows what the dummy looks like.
//
// That is the standing rule from `docs/ARCHITECTURE.md` applied to the training
// mode: what you hit must not depend on how it is drawn. The renderer consumes
// this spec to BUILD the dummy; perception consumes it to decide what was hit.
// Both read the same numbers, and the arrow only ever points outward from here.
// WHAT A DUMMY IS NOT
//
// It has no legs, no arms and no kit. Two consequences worth stating, because
// they are features rather than omissions:
//
//   * There is nothing below `BASE`. The `low` region in strikeGeometry.ts is
//     a foul against a fighter; against a dummy there is simply no body there,
//     so a low punch hits the STAND and reads as a miss. The dummy teaches the
//     belt line by having one.
//   * It cannot block, slip or punch back. That is the point — a dummy is for
//     measuring the player's output in isolation, with the opponent's
//     behaviour removed as a variable. The live opponent lives in `sim/`.

export interface DummySpec {
  /** Top of the head, torso units above the belt line. */
  crown: number;
  /** Shoulder line. 1.0 by definition — the torso scale IS shoulder-to-hip. */
  shoulder: number;
  /**
   * Where the body stops and the stand begins.
   *
   * Measured off the reference photo the project owner supplied: a Century-BOB
   * type dummy is cut off at the LOWER CHEST, well above the navel, and the
   * moulded torso meets the column just under the ribcage. That is much higher
   * than a first guess puts it, and it matters — it is why there is no `gut`
   * target zone. A dummy has no gut to hit.
   */
  base: number;
  /** Half-width of the chest at the shoulder line. */
  chestHalfWidth: number;
  /** Half-width of the head at eye level. */
  headHalfWidth: number;
  /** Height of the neck's narrowest point. */
  neck: number;
  /**
   * Height at which the body is WIDEST — the deltoid line, a little below the
   * shoulder line rather than exactly on it.
   *
   * Without this the torso reaches full width at `shoulder` and then has only
   * the 0.08 torso units up to `neck` to get back down to neck width. That is
   * under 4cm, so the loft renders it as a near-horizontal shelf and the dummy
   * reads as a box with a lid on it. Real shoulders are widest just below the
   * joint and slope for a good 10cm into the neck.
   */
  deltoid: number;
  /** Depth of the torso front-to-back, for the renderer's cross-section. */
  torsoDepth: number;
  /**
   * Stand column and base radii.
   *
   * There is deliberately NO length here. How far the column has to reach is
   * not a property of the dummy — it is however far it is from the belt line
   * down to the floor, which depends on where the dummy is standing. Storing a
   * length would be storing a second, independent answer to a question the
   * placement already answers, and the two would disagree.
   */
  stand: { radius: number; footRadius: number };
}

/**
 * Proportions of a commercial free-standing dummy, expressed against the
 * figure's own torso so it scales with whoever is being tracked.
 *
 * `crown` is 1.68 rather than a round number because that is where the
 * strikeGeometry region table already puts the top of the skull — `crown`
 * spans 1.58..2.2 and the head narrows out of reach above ~1.68. Picking a
 * different number here would build a head that the hit map disagrees with.
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
  // It was 0.4 (0.19m) and that made the chest SHALLOWER than the head was
  // deep — a test asserting the chest is the deepest part of the body caught
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

/**
 * The head's profile, 0..1, as a fraction of its widest point.
 *
 * A true ellipsoid that reaches EXACTLY ZERO at the crown. The first version
 * used a damped form that bottomed out at 0.42, which left the top of the head
 * as an open-ended cylinder — the loft caps the bottom of the body but not the
 * top, so the dummy rendered with a flat hole where its skull should be.
 *
 * The ellipsoid is anchored BELOW the neck so it still has real width where it
 * meets the shoulders. Anchoring it at the neck would pinch the head to a
 * point at the jaw, which is where the jaw and chin targets live.
 */
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

/**
 * Half-width of the dummy's silhouette at a given height.
 *
 * Used for two jobs that must not be allowed to disagree: the renderer lofts
 * its cross-sections from this, and the drill uses it to reject target zones
 * that would fall off the edge of the body.
 *
 * The three sections meet CONTINUOUSLY by construction — the shoulder cap ends
 * at whatever width the head profile has at the neck, rather than at a stored
 * neck width that could drift out of agreement with it and leave a ledge.
 */
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

  // SHOULDER PLATEAU, deltoid line to shoulder line. This is the broad flat
  // shoulder the reference dummy has, and it is what stops the silhouette
  // reading as a bowling pin: without it the body starts narrowing the instant
  // it reaches full width, so there is no shoulder at all, just a cone.
  if (h <= spec.shoulder) return spec.chestHalfWidth;

  // Trapezius, sloping from the shoulder line into the neck.
  const t = (h - spec.shoulder) / (spec.neck - spec.shoulder);
  const neckW = headHalfWidth(spec.neck, spec);
  return spec.chestHalfWidth + (neckW - spec.chestHalfWidth) * smooth(t);
}

/**
 * Front-to-back half-depth of the silhouette at a given height.
 *
 * Lives here next to `halfWidthAt` because the two together ARE the dummy's
 * shape, and splitting them across modules is how a hit map and a mesh end up
 * describing different objects. Nothing in the perception path reads this —
 * impacts are resolved in the lateral/height plane only — but the renderer
 * needs it to loft a cross-section, and zone markers need it to sit ON the
 * surface rather than floating in front of it.
 */
export function halfDepthAt(h: number, spec: DummySpec = DUMMY): number {
  if (h < spec.base || h > spec.crown) return 0;
  // A head is deeper than it is wide — front to back is its long axis.
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

/**
 * Exponent of the superelliptical cross-section.
 *
 * 2 is a plain ellipse. Higher values square the section off, which is closer
 * to what a chest looks like from above; the head stays a true ellipse,
 * because a squared-off skull looks wrong from every angle.
 */
export function sectionExponent(h: number, spec: DummySpec = DUMMY): number {
  return h > spec.neck ? 2.0 : 2.4;
}

/**
 * Depth of the surface directly in front of a lateral/height position.
 *
 * Solves the superellipse for its depth. This is what puts a target marker on
 * the skin: a marker placed at a FIXED depth would sink into the chest at the
 * midline and hover in mid-air out by the ribs, because the body is curved and
 * the zones are spread right across it.
 */
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

/**
 * Whether a resolved impact actually landed on the dummy at all.
 *
 * The `> 0` guard is load-bearing and was put here by a failing test. Without
 * it, `halfWidthAt` returns 0 off the ends of the body and `Math.abs(0) <= 0`
 * is TRUE — so a punch straight down the midline registered as landing on the
 * dummy at ANY height, including through the floor. Every midline punch is a
 * jab or a straight, which is to say the most common punch in the game hit the
 * one case that was wrong.
 */
export function onDummy(p: ImpactPoint, spec: DummySpec = DUMMY): boolean {
  const half = halfWidthAt(p.height, spec);
  return half > 0 && Math.abs(p.lateral) <= half;
}

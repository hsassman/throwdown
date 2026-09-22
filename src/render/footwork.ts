import { FOOTWORK_CONFIG } from "../config/tuning";

// Feet that stay where they were put, and step when they have to.
// THE PROBLEM THIS SOLVES
//
// Both fighters used to travel by translating the whole body. The simulation
// said "circle left" and the figure slid left, legs straight, feet welded to
// the hips — the single most artificial thing left in the game. A boxer's feet
// are the one part that is NOT continuously moving: they hold the canvas, take
// the weight, and then one of them relocates, quickly, while the other holds.
//
// So a foot here is a position in the ground plane that does NOT track the
// body. It is left behind as the body travels, and only catches up when the
// stretch gets too big — at which point it steps: lifts, swings, lands. The
// legs are then solved to reach it (legIk.ts), which is what turns the whole
// thing into bent knees rather than a slide.
// ONE FOOT AT A TIME, ALWAYS
//
// The rule that makes this read as boxing rather than walking is that a step
// is never taken by both feet at once. A fighter with both feet off the canvas
// cannot punch, cannot take a punch, and is not doing anything a boxer does.
// So `stepping` is a single slot: whichever foot is furthest from where it
// ought to be gets it, and the other one waits its turn no matter how stretched
// it is. Under fast travel that produces the shuffle a boxer actually uses —
// alternating quick steps, weight always on something.
// FRAME-AGNOSTIC ON PURPOSE
//
// Nothing here knows about three.js, about which way the figure faces, or about
// world axes. It is handed a body position and a pair of stance offsets in some
// ground plane and it keeps two points in that same plane. The caller owns the
// frame. That is what lets the same class serve the opponent (whose frame is
// its pivot) and the player (whose frame is the rig root) without either
// growing a special case, and it is what makes it testable without a rig.

export interface Ground {
  x: number;
  z: number;
}

export interface FootPose {
  x: number;
  z: number;
  /** Height above the canvas. Zero whenever the foot is planted. */
  lift: number;
}

export interface StanceOffsets {
  left: Ground;
  right: Ground;
}

/** Smootherstep. Zero velocity at both ends, so a step neither jerks off the
 *  canvas nor slams onto it. */
function ease(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * c * (c * (c * 6 - 15) + 10);
}

export class Footwork {
  private readonly foot: Record<"left" | "right", FootPose> = {
    left: { x: 0, z: 0, lift: 0 },
    right: { x: 0, z: 0, lift: 0 },
  };
  /** Where the stepping foot left from. The destination is re-read every frame
   *  instead of being frozen, so a foot launched while the body is still moving
   *  lands where the body ENDED UP rather than trailing one step behind it. */
  private from: Ground = { x: 0, z: 0 };
  private stepping: "left" | "right" | null = null;
  private progress = 0;
  private offsets: StanceOffsets;
  /**
   * Multiplier turning FOOTWORK_CONFIG's torso-unit distances into whatever
   * unit the caller's ground plane uses.
   *
   * The config is written in torso units because that is the unit a stance is
   * naturally described in and the unit that survives a re-export at another
   * scale. The callers, though, track feet in WORLD units, because that is the
   * frame a planted foot has to stay still in. Feeding world positions against
   * torso-unit thresholds silently doubled the step trigger — the feet dragged
   * about twice as far as intended before picking themselves up, which is
   * exactly the gliding this class exists to remove.
   */
  private readonly scale: number;
  /**
   * True from the moment a step lands until the stance is square again.
   *
   * This is the step-and-follow that makes the whole thing read as boxing. One
   * foot moves because the body dragged it past `stepTrigger`; the other is
   * then left somewhere short of that and, on its own, would never move again —
   * so the fighter would settle into a stance permanently narrower or wider
   * than it started, and drift further with every exchange. While unsettled the
   * bar drops to `settleTrigger`, which brings the trailing foot up behind the
   * one that just moved, exactly as a boxer recovers their base.
   */
  private unsettled = false;

  constructor(offsets: StanceOffsets, body: Ground = { x: 0, z: 0 }, scale = 1) {
    this.offsets = offsets;
    this.scale = scale;
    this.plantBoth(body);
  }

  /**
   * Plants both feet at explicit positions.
   *
   * Used at the start of a fight, where the feet are put exactly where the rig
   * already has them and the stance is then adopted by stepping into it. The
   * alternative — snapping them straight to the stance offsets — teleports both
   * ankles a quarter of a metre on the first frame the figure is visible, which
   * is the frame the player is most likely to be looking at it.
   */
  plantAt(left: Ground, right: Ground): void {
    Object.assign(this.foot.left, { x: left.x, z: left.z, lift: 0 });
    Object.assign(this.foot.right, { x: right.x, z: right.z, lift: 0 });
    this.stepping = null;
    this.progress = 0;
    this.unsettled = false;
  }

  /** Re-seats both feet under the body immediately. Used on a reset, where a
   *  step animation would be a figure scrambling to a mark it should simply be
   *  standing on. */
  plantBoth(body: Ground): void {
    for (const side of ["left", "right"] as const) {
      this.foot[side].x = body.x + this.offsets[side].x;
      this.foot[side].z = body.z + this.offsets[side].z;
      this.foot[side].lift = 0;
    }
    this.stepping = null;
    this.progress = 0;
    this.unsettled = false;
  }

  /** Changes the stance the feet aim for — a switch of lead, or a wider base. */
  setOffsets(offsets: StanceOffsets): void {
    this.offsets = offsets;
  }

  get left(): Readonly<FootPose> {
    return this.foot.left;
  }

  get right(): Readonly<FootPose> {
    return this.foot.right;
  }

  /** Which foot is mid-step, or null when both are planted. */
  get steppingFoot(): "left" | "right" | null {
    return this.stepping;
  }

  /** Where a foot would ideally be for the body's current position. */
  private home(side: "left" | "right", body: Ground): Ground {
    return { x: body.x + this.offsets[side].x, z: body.z + this.offsets[side].z };
  }

  private stretch(side: "left" | "right", body: Ground): number {
    const h = this.home(side, body);
    return Math.hypot(this.foot[side].x - h.x, this.foot[side].z - h.z);
  }

  update(dt: number, body: Ground): void {
    if (this.stepping) {
      this.advanceStep(dt, body);
      // The foot that is NOT stepping still has to stay inside the leg's reach
      // while it waits its turn — see `maxStretch`.
      this.dragIfOverstretched(this.stepping === "left" ? "right" : "left", body);
      return;
    }

    // Nothing in flight: see whether either foot has been left behind far
    // enough to be worth moving. The MORE stretched foot goes first, which is
    // what keeps the two alternating under sustained travel rather than one
    // foot doing all the work while the other drags.
    const left = this.stretch("left", body);
    const right = this.stretch("right", body);
    const worst = left >= right ? "left" : "right";
    const bar =
      (this.unsettled
        ? FOOTWORK_CONFIG.settleTrigger
        : FOOTWORK_CONFIG.stepTrigger) * this.scale;

    if (Math.max(left, right) < bar) {
      // Square again. Raise the bar back so a fighter standing still does not
      // patter their feet over sub-millimetre drift.
      this.unsettled = false;
      return;
    }

    this.stepping = worst;
    this.progress = 0;
    this.from = { x: this.foot[worst].x, z: this.foot[worst].z };
  }

  /**
   * Slides a planted foot back toward its stance if the body has pulled it
   * further than a leg can span.
   *
   * Deliberately a hard clamp rather than a spring: the point is a guarantee
   * that the IK is never handed an unreachable target, and a spring only
   * promises to get there eventually. The foot stays on the canvas and scuffs
   * along it, which is exactly what happens when a fighter is moved faster than
   * they can pick their feet up.
   */
  private dragIfOverstretched(side: "left" | "right", body: Ground): void {
    const limit = FOOTWORK_CONFIG.maxStretch * this.scale;
    const h = this.home(side, body);
    const f = this.foot[side];
    const dx = f.x - h.x;
    const dz = f.z - h.z;
    const d = Math.hypot(dx, dz);
    if (d <= limit || d < 1e-9) return;
    const k = limit / d;
    f.x = h.x + dx * k;
    f.z = h.z + dz * k;
  }

  private advanceStep(dt: number, body: Ground): void {
    const side = this.stepping!;
    this.progress = Math.min(1, this.progress + dt / FOOTWORK_CONFIG.stepSeconds);
    const t = ease(this.progress);
    const to = this.home(side, body);

    const f = this.foot[side];
    f.x = this.from.x + (to.x - this.from.x) * t;
    f.z = this.from.z + (to.z - this.from.z) * t;
    // A half-sine: on the canvas at both ends, highest in the middle. Boxing
    // steps skim rather than march, so the peak is deliberately low — see
    // FOOTWORK_CONFIG.stepHeight.
    f.lift = Math.sin(Math.PI * this.progress) * FOOTWORK_CONFIG.stepHeight * this.scale;

    if (this.progress >= 1) {
      f.x = to.x;
      f.z = to.z;
      f.lift = 0;
      this.stepping = null;
      this.unsettled = true;
    }
  }
}

/**
 * The stance the feet hold, as offsets from the body's ground position.
 *
 * `width` and `stagger` are in the same units as the body position the caller
 * feeds `update`. The lead foot goes FORWARD and a little narrower; the rear
 * foot sits back and wider, which is where a boxer's weight actually lives.
 * Square feet side by side is a stance no fighter uses and reads instantly as a
 * character standing rather than fighting.
 *
 * The two basis arguments are what keep this frame-agnostic: `left` points the
 * way the figure's own LEFT lies in the caller's ground plane and `forward` the
 * way it FACES, both as unit vectors. Passing basis VECTORS rather than a pair
 * of signs means a stage that stands the fighters at some angle other than
 * squarely down one axis still gets a correctly oriented stance — the same
 * reason the knee's pole direction is read off the rig instead of assumed.
 *
 * Getting one of these backwards puts both feet on the same side of the body,
 * so the tests assert the feet straddle the centre line rather than checking
 * any particular sign.
 */
export function boxingStance(
  leadSide: "left" | "right",
  width: number,
  stagger: number,
  left: Ground = { x: 1, z: 0 },
  forward: Ground = { x: 0, z: 1 }
): StanceOffsets {
  const narrow = FOOTWORK_CONFIG.leadWidthShare;
  const place = (side: "left" | "right"): Ground => {
    const lateral = (side === "left" ? 1 : -1) * width * (leadSide === side ? narrow : 1);
    const along = stagger * (leadSide === side ? 1 : -1);
    return {
      x: left.x * lateral + forward.x * along,
      z: left.z * lateral + forward.z * along,
    };
  };
  return { left: place("left"), right: place("right") };
}

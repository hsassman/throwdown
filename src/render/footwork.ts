import { FOOTWORK_CONFIG } from "../config/tuning";

// Feet that stay where they were put, and step when they have to.
// THE PROBLEM THIS SOLVES

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
   */
  private readonly scale: number;
  /** True from the moment a step lands until the stance is square again. */
  private unsettled = false;

  constructor(offsets: StanceOffsets, body: Ground = { x: 0, z: 0 }, scale = 1) {
    this.offsets = offsets;
    this.scale = scale;
    this.plantBoth(body);
  }

  /** Plants both feet at explicit positions. */
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

  /** Changes the stance the feet aim for - a switch of lead, or a wider base. */
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
      // while it waits its turn - see `maxStretch`.
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
    // steps skim rather than march, so the peak is deliberately low - see
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

/** The stance the feet hold, as offsets from the body's ground position. */
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

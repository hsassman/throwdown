import type { HandSide } from "./punchTypes";
import { midpoint, torsoScaleOf, type Keypoint, type PoseFrame } from "../pose/poseTypes";
import { PERCEPTION_CONFIG, STRIKE_CONFIG } from "../config/tuning";
import {
  approachOf,
  coarseZone,
  damageOf,
  regionAt,
  type Approach,
  type BodyRegion,
  type ImpactPoint,
} from "./strikeGeometry";

// Resolves punches into landed strikes against a training target.

/** Vertical band a strike arrives at. */
export type StrikeHeight = "head" | "body";
/** Lateral band, from the player's point of view facing the target. */
export type StrikeLane = "left" | "centre" | "right";

export interface TargetZone {
  height: StrikeHeight;
  lane: StrikeLane;
}

export interface StrikeEvent {
  hand: HandSide;
  /**
   * Coarse 2x3 zone. Still here because the texture map and the target's
   * reaction animations are authored against it - but it is now derived from
   * `impact` rather than being the measurement. See strikeGeometry.ts.
   */
  zone: TargetZone;
  /** Continuous landing point in the target's body frame, torso units. */
  impact: ImpactPoint;
  /** Anatomical region struck, and what it is worth. */
  region: BodyRegion;
  /** How the strike arrived. Descriptive; nothing gates on it. */
  approach: Approach;
  /** Final damage: region value x power x any rotational bonus. 0 for fouls. */
  damage: number;
  /**
   * How far past the reach threshold the punch got, 0-1, after which it is
   * clamped. Drives impact strength - a fully committed cross should move the
   * target more than a flicked jab.
   */
  power: number;
  /** Peak fist speed during the strike, torso-widths per second. */
  speed: number;
  /**
   * How far the glove's striking surface was from the shoulder when the strike
   * landed, in torso units - i.e. wrist extension plus the glove.
   */
  contactReach: number;
  /** performance.now() at the moment the strike resolved. */
  timestamp: number;
}

interface HandState {
  /** True while the fist is past the reach threshold - used for edge
   * detection, so one long extension registers one strike, not sixty. */
  extended: boolean;
  /** Last extension reading, torso units. */
  lastReach: number;
  lastPos: { x: number; y: number } | null;
  /** Previous out-of-plane extension, torso units - differentiated to get the
   *  forward component of travel without ever reading MediaPipe's z. */
  lastDepth: number;
  lastT: number;
  /** Recent wrist samples, oldest first, spanning STRIKE_CONFIG.speedWindowMs.
   *  Velocity is measured across the window rather than between the last two
   *  samples - see speedWindowMs. */
  trail: { t: number; x: number; y: number; depth: number }[];
  speed: number;
  /** Body-frame velocity at the last sample: across, up, forward. */
  vel: { x: number; y: number; z: number };
  peakSpeed: number;
  /** Time the current extension began; strikes shorter than the minimum
   * interval are suppressed. */
  lastStrikeAt: number;
  /** Recent segment-length readings, newest last, for confirming growth of
   *  the learned full length. See STRIKE_CONFIG.spanConfirmFrames. */
  spans: ArmSpan[];
  /** A strike that has crossed the threshold and is waiting for the fist to
   *  reach its peak before it resolves. See STRIKE_CONFIG.peakLatchMs. */
  pending: PendingStrike | null;
}

/** A strike between crossing the threshold and resolving. */
interface PendingStrike {
  /** Interpolated time the reach crossed the threshold. */
  crossedAt: number;
  /** Samples seen since the crossing, which bounds the latch. */
  samples: number;
  peakReach: number;
  impact: ImpactPoint;
  vel: { x: number; y: number; z: number };
  peakSpeed: number;
}

function freshHand(): HandState {
  return {
    extended: false,
    lastReach: 0,
    lastPos: null,
    lastDepth: 0,
    lastT: 0,
    trail: [],
    speed: 0,
    vel: { x: 0, y: 0, z: 0 },
    peakSpeed: 0,
    lastStrikeAt: -Infinity,
    spans: [],
    pending: null,
  };
}

export interface StrikeDebugState {
  /** Current normalized reach per hand, 0 = at guard, 1 = at the threshold. */
  reach: Record<HandSide, number>;
  speed: Record<HandSide, number>;
  zone: Record<HandSide, TargetZone | null>;
  impact: Record<HandSide, ImpactPoint | null>;
  region: Record<HandSide, BodyRegion | null>;
}

/** Per-segment observed lengths, torso units. */
interface ArmSpan {
  upper: number;
  lower: number;
}

/**
 * Measures reach as on-screen extension plus how far the arm points out of the
 * image plane.
 */
function reachOf(
  shoulder: Keypoint,
  wrist: Keypoint,
  torso: number,
  span: ArmSpan,
  full: ArmSpan
): { reach: number; depth: number } {
  const planar = Math.hypot(wrist.x - shoulder.x, wrist.y - shoulder.y) / torso;

  // sqrt(1 - (projected/full)^2) - the same derivation the retargeting layer
  // uses, from x/y only. MediaPipe's z is never read.
  const depthOf = (projected: number, fullLen: number) => {
    if (!(fullLen > 1e-6)) return 0;
    const r = Math.min(1, Math.max(0, projected / fullLen));
    return Math.sqrt(Math.max(0, 1 - r * r));
  };
  const depth =
    (depthOf(span.upper, full.upper) + depthOf(span.lower, full.lower)) / 2;

  // Out-of-plane distance the fist has travelled, in the same torso units as
  // `planar`. Returned alongside the reach so the caller can differentiate it
  // over time and recover a forward velocity - which is what separates a
  // straight punch down the lens from a hook, now that the arc descriptor is
  // measured rather than classified.
  const forward = depth * (full.upper + full.lower);
  return {
    reach: planar + forward * STRIKE_CONFIG.depthReachWeight,
    depth: forward,
  };
}

/** Where a fist sits in the body frame, as continuous coordinates. */
export function impactPointOf(
  wrist: Keypoint,
  shoulders: Keypoint,
  hips: Keypoint,
  torso: number
): ImpactPoint {
  const midX = (shoulders.x + hips.x) / 2;
  return {
    // The raw camera frame is not mirrored, so the player's own right is at
    // smaller x. Negated to express the offset from the puncher's viewpoint.
    lateral: -(wrist.x - midX) / torso,
    // Image y grows downward; flipped so that up is positive.
    height: (hips.y - wrist.y) / torso,
  };
}

export class StrikeResolver {
  private hands: Record<HandSide, HandState> = {
    left: freshHand(),
    right: freshHand(),
  };
  /**
   * Longest length seen for each arm segment, torso units - the reference
   * foreshortening is measured against.
   */
  private fullArm: Record<HandSide, ArmSpan> = {
    left: { ...STRIKE_CONFIG.seedArmSpan },
    right: { ...STRIKE_CONFIG.seedArmSpan },
  };
  private zone: Record<HandSide, TargetZone | null> = { left: null, right: null };
  private impact: Record<HandSide, ImpactPoint | null> = { left: null, right: null };
  private listeners = new Set<(e: StrikeEvent) => void>();

  onStrike(cb: (e: StrikeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  reset(): void {
    this.hands = { left: freshHand(), right: freshHand() };
    this.fullArm = {
      left: { ...STRIKE_CONFIG.seedArmSpan },
      right: { ...STRIKE_CONFIG.seedArmSpan },
    };
    this.zone = { left: null, right: null };
    this.impact = { left: null, right: null };
  }

  get debug(): StrikeDebugState {
    return {
      reach: {
        left: this.hands.left.lastReach / STRIKE_CONFIG.reachThreshold,
        right: this.hands.right.lastReach / STRIKE_CONFIG.reachThreshold,
      },
      speed: { left: this.hands.left.speed, right: this.hands.right.speed },
      zone: { ...this.zone },
      impact: { ...this.impact },
      // Live region readout - this is what makes the new model legible while
      // training: you can see the name of the spot your fist is currently
      // pointing at, before you commit to the punch.
      region: {
        left: this.impact.left ? regionAt(this.impact.left) : null,
        right: this.impact.right ? regionAt(this.impact.right) : null,
      },
    };
  }

  /** Feeds one pose sample. Emits at most one strike per hand per call. */
  update(pose: PoseFrame): StrikeEvent[] {
    const minConf = PERCEPTION_CONFIG.minLandmarkConfidence;
    const torso = torsoScaleOf(pose, minConf)?.value ?? null;
    if (torso === null) return [];

    const shoulders = midpoint(pose.leftShoulder, pose.rightShoulder);
    const hips = midpoint(pose.leftHip, pose.rightHip);
    const out: StrikeEvent[] = [];

    for (const hand of ["left", "right"] as const) {
      const shoulder = hand === "left" ? pose.leftShoulder : pose.rightShoulder;
      const elbow = hand === "left" ? pose.leftElbow : pose.rightElbow;
      const wrist = hand === "left" ? pose.leftWrist : pose.rightWrist;
      const state = this.hands[hand];

      if (
        shoulder.confidence < minConf ||
        elbow.confidence < minConf ||
        wrist.confidence < minConf
      ) {
        // A strike that already crossed the threshold was really thrown -
        // the arm being lost on the way to its peak does not un-throw it, so
        // it resolves with the peak it had reached.
        if (state.pending) out.push(this.resolve(hand, state));
        // Losing the arm must not fire a new strike, and must not leave the
        // hand latched "extended" - otherwise the next good frame registers a
        // hit the player never threw.
        state.extended = false;
        state.lastPos = null;
        state.spans.length = 0;
        state.trail.length = 0;
        continue;
      }

      // Learn this player's segment lengths. Never shrinks - a shorter
      // reading is foreshortening, which is the signal, not noise - and only
      // grows on a reading that has held for several samples, because one
      // mis-tracked frame would otherwise lengthen the reference for good.
      const span: ArmSpan = {
        upper: Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y) / torso,
        lower: Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y) / torso,
      };
      const full = this.fullArm[hand];
      state.spans.push(span);
      if (state.spans.length > STRIKE_CONFIG.spanConfirmFrames) state.spans.shift();
      if (state.spans.length === STRIKE_CONFIG.spanConfirmFrames) {
        const seed = STRIKE_CONFIG.seedArmSpan;
        const held = (k: keyof ArmSpan) =>
          Math.min(
            Math.min(...state.spans.map((s) => s[k])),
            seed[k] * STRIKE_CONFIG.spanMaxGrowth
          );
        full.upper = Math.max(full.upper, held("upper"));
        full.lower = Math.max(full.lower, held("lower"));
      }

      const prevReach = state.lastReach;
      const prevT = state.lastT;
      const { reach, depth } = reachOf(shoulder, wrist, torso, span, full);
      state.lastReach = reach;

      // Fist speed and body-frame velocity, torso-widths per second.
      // Measured against the oldest sample still inside the window, so the
      // displacement spans one to three pose intervals depending on the rate.
      const trail = state.trail;
      while (trail.length > 0 && pose.timestamp - trail[0].t > STRIKE_CONFIG.speedWindowMs) {
        trail.shift();
      }
      const ref = trail[0];
      if (ref && pose.timestamp > ref.t) {
        const dt = (pose.timestamp - ref.t) / 1000;
        const dx = wrist.x - ref.x;
        const dy = wrist.y - ref.y;
        state.vel = {
          // Same two sign conventions as impactPointOf: unmirrored camera, and
          // image y growing downward.
          x: -dx / torso / dt,
          y: -dy / torso / dt,
          z: (depth - ref.depth) / dt,
        };
        // On-screen speed alone is blind to a punch thrown down the lens.
        state.speed = Math.hypot(
          Math.hypot(dx, dy) / torso / dt,
          state.vel.z * STRIKE_CONFIG.depthSpeedWeight
        );
      }
      const hadPos = state.lastPos !== null;
      state.lastPos = { x: wrist.x, y: wrist.y };
      state.lastDepth = depth;
      state.lastT = pose.timestamp;
      trail.push({ t: pose.timestamp, x: wrist.x, y: wrist.y, depth });

      // Continuous landing point, in the player's own body frame. Using the
      // body frame rather than image coordinates is what makes it hold when
      // the player moves around the room.
      const impact = impactPointOf(wrist, shoulders, hips, torso);
      this.impact[hand] = impact;
      this.zone[hand] = coarseZone(impact);

      const threshold = STRIKE_CONFIG.reachThreshold;

      // A crossed strike waits for its peak: it resolves on the first sample
      // where the reach stops growing, or when the latch runs out.
      const pending = state.pending;
      if (pending) {
        pending.samples++;
        const growing = reach > pending.peakReach;
        if (growing) {
          pending.peakReach = reach;
          pending.impact = impact;
          pending.peakSpeed = Math.max(pending.peakSpeed, state.speed);
        }
        if (!growing || pending.samples >= STRIKE_CONFIG.peakLatchSamples) {
          out.push(this.resolve(hand, state));
        }
      }

      if (!state.extended) {
        state.peakSpeed = Math.max(state.peakSpeed, state.speed);
        const fastEnough = state.speed >= STRIKE_CONFIG.minStrikeSpeed;
        const late = pose.timestamp - state.lastStrikeAt >= STRIKE_CONFIG.refractoryMs;
        if (reach >= threshold && fastEnough && late) {
          state.extended = true;
          // The threshold was crossed somewhere between the last sample and
          // this one. At 19 FPS that interval is ~50ms, which is the same
          // order as the windows the fight judges evasion by, so the crossing
          // is interpolated rather than rounded to the later sample.
          const crossedAt =
            hadPos && reach > prevReach && prevReach < threshold && pose.timestamp > prevT
              ? prevT + ((threshold - prevReach) / (reach - prevReach)) * (pose.timestamp - prevT)
              : pose.timestamp;
          state.lastStrikeAt = crossedAt;
          state.pending = {
            crossedAt,
            samples: 0,
            peakReach: reach,
            impact,
            vel: { ...state.vel },
            peakSpeed: Math.max(state.peakSpeed, state.speed),
          };
          state.peakSpeed = 0;
          if (STRIKE_CONFIG.peakLatchSamples <= 0) out.push(this.resolve(hand, state));
        }
      } else if (!state.pending && reach < threshold * STRIKE_CONFIG.releaseFraction) {
        // Hysteresis: the fist has to come meaningfully back before another
        // strike can register. Without it, noise around the threshold machine-
        // guns events out of one held extension.
        state.extended = false;
        state.peakSpeed = 0;
      }
    }

    return out;
  }

  /** Turns a hand's pending strike into an event, at its peak. */
  private resolve(hand: HandSide, state: HandState): StrikeEvent {
    const p = state.pending!;
    state.pending = null;
    const threshold = STRIKE_CONFIG.reachThreshold;
    const power = Math.min(
      1,
      (p.peakReach - threshold) / STRIKE_CONFIG.powerRange + STRIKE_CONFIG.basePower
    );
    const region = regionAt(p.impact);
    // Approach is read from the velocity at the crossing, while the fist is
    // still travelling - at the peak it has all but stopped.
    const approach = approachOf(p.vel.x, p.vel.y, p.vel.z);
    const event: StrikeEvent = {
      hand,
      zone: coarseZone(p.impact),
      impact: p.impact,
      region,
      approach,
      damage: damageOf(region, power, approach),
      power,
      speed: p.peakSpeed,
      contactReach: p.peakReach + STRIKE_CONFIG.gloveNoseReach,
      timestamp: p.crossedAt,
    };
    for (const cb of this.listeners) cb(event);
    return event;
  }
}

/** Which zone a fist is arriving at, in the player's own body frame. */
export function zoneOf(
  wrist: Keypoint,
  shoulders: Keypoint,
  hips: Keypoint,
  torso: number
): TargetZone {
  // Now a thin view over the continuous measurement rather than a parallel
  // calculation. Two independent implementations of "which side is left" is
  // exactly the sort of duplication that produced the mirrored-handedness bug
  // earlier in this project, so there is deliberately only one.
  return coarseZone(impactPointOf(wrist, shoulders, hips, torso));
}

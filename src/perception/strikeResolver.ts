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
//
// In a 1v1 there is no shared physical space: two players stand in two rooms
// and there is no real distance between them, so "did the punch reach?" is a
// design decision, not a measurement. Against a training target the same is
// true - the dummy is at a virtual range we choose. So this does not measure a
// collision. It measures how far the player extended and in which direction,
// and resolves that against a chosen reach.
//
// Two rules it keeps:
//
// 1. Landmarks only, never the character mesh. Retargeting lives under render/
//    precisely so the drawn skeleton cannot influence hit resolution; the
//    drawn arm's forward extension is a cosmetic estimate recovered from
//    foreshortening, and feeding it back would make what you hit depend on how
//    you are drawn.
// 2. MediaPipe's z is never read. Depth comes from x/y foreshortening.
//
// Deliberately independent of punchClassifier.ts, which is still ~19%. A
// target that only registered hits when the type classifier agreed would
// inherit that failure rate. Reach and zone are a much easier measurement than
// punch type, so training works now and can show a type alongside once the
// classifier earns it.

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
   *
   * The threshold still gates on wrist extension, because that is what
   * measures commitment and it is what the detection was calibrated against.
   * This is what actually made contact, and it is what TARGET_CONFIG.distance
   * is derived from so the glove meets the face instead of passing through it.
   * Reported rather than gated on, so the render and the HUD can show where
   * the blow landed without hit detection depending on the character mesh.
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
  speed: number;
  /** Body-frame velocity at the last sample: across, up, forward. */
  vel: { x: number; y: number; z: number };
  peakSpeed: number;
  /** Time the current extension began; strikes shorter than the minimum
   * interval are suppressed. */
  lastStrikeAt: number;
}

function freshHand(): HandState {
  return {
    extended: false,
    lastReach: 0,
    lastPos: null,
    lastDepth: 0,
    lastT: 0,
    speed: 0,
    vel: { x: 0, y: 0, z: 0 },
    peakSpeed: 0,
    lastStrikeAt: -Infinity,
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
 *
 * The depth half must be measured per segment, against each segment's own full
 * length. An earlier version compared the sum of both segments against a
 * straight arm, which is wrong in a way that matters: bending your elbow also
 * shortens that sum, so a normal guard - elbow folded, fist at the chin -
 * registered as a heavily foreshortened arm and sat most of the way to a
 * landed hit. Comparing each segment to itself separates the two: bending
 * changes the angle between segments, foreshortening shortens each one.
 *
 * Both halves are needed. A hook travels a long way on screen and barely
 * foreshortens; a straight punch down the lens barely moves on screen and
 * foreshortens almost completely. Either signal alone misses one of them.
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

/**
 * Where a fist sits in the body frame, as continuous coordinates.
 *
 * Height is measured from the hip line and divided by the torso scale, which
 * is itself the shoulder-to-hip distance - so the shoulder line lands at
 * exactly 1.0 for every player, of any height, at any distance from the
 * camera. The anatomical table in strikeGeometry.ts is written against that
 * normalisation, which is why its numbers are proportions and not centimetres.
 */
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
   *
   * Seeded from anthropometry rather than starting at zero, and this matters:
   * starting from the first observation would make the threshold depend on
   * whatever the player happened to be doing when training mode opened. It
   * only ever grows, because a shorter reading is foreshortening - the signal
   * - not a better measurement.
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
        // Losing the arm must not fire a strike, and must not leave the hand
        // latched "extended" - otherwise the next good frame registers a hit
        // the player never threw.
        state.extended = false;
        state.lastPos = null;
        continue;
      }

      // Learn this player's segment lengths. Grows immediately (a longer
      // observation is real evidence), never shrinks - a shorter reading is
      // foreshortening, which is the signal, not noise.
      const span: ArmSpan = {
        upper: Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y) / torso,
        lower: Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y) / torso,
      };
      const full = this.fullArm[hand];
      if (span.upper > full.upper) full.upper = span.upper;
      if (span.lower > full.lower) full.lower = span.lower;

      const { reach, depth } = reachOf(shoulder, wrist, torso, span, full);
      state.lastReach = reach;

      // Fist speed and body-frame velocity, torso-widths per second.
      if (state.lastPos && pose.timestamp > state.lastT) {
        const dt = (pose.timestamp - state.lastT) / 1000;
        const dx = wrist.x - state.lastPos.x;
        const dy = wrist.y - state.lastPos.y;
        state.speed = Math.hypot(dx, dy) / torso / dt;
        state.vel = {
          // Same two sign conventions as impactPointOf: unmirrored camera, and
          // image y growing downward.
          x: -dx / torso / dt,
          y: -dy / torso / dt,
          z: (depth - state.lastDepth) / dt,
        };
      }
      state.lastPos = { x: wrist.x, y: wrist.y };
      state.lastDepth = depth;
      state.lastT = pose.timestamp;

      // Continuous landing point, in the player's own body frame. Using the
      // body frame rather than image coordinates is what makes it hold when
      // the player moves around the room.
      const impact = impactPointOf(wrist, shoulders, hips, torso);
      this.impact[hand] = impact;
      this.zone[hand] = coarseZone(impact);

      const threshold = STRIKE_CONFIG.reachThreshold;
      if (!state.extended) {
        state.peakSpeed = Math.max(state.peakSpeed, state.speed);
        const fastEnough = state.speed >= STRIKE_CONFIG.minStrikeSpeed;
        const late = pose.timestamp - state.lastStrikeAt >= STRIKE_CONFIG.refractoryMs;
        if (reach >= threshold && fastEnough && late) {
          state.extended = true;
          state.lastStrikeAt = pose.timestamp;
          const power = Math.min(
            1,
            (reach - threshold) / STRIKE_CONFIG.powerRange + STRIKE_CONFIG.basePower
          );
          const region = regionAt(impact);
          const approach = approachOf(state.vel.x, state.vel.y, state.vel.z);
          const event: StrikeEvent = {
            hand,
            zone: this.zone[hand]!,
            impact,
            region,
            approach,
            damage: damageOf(region, power, approach),
            power,
            speed: Math.max(state.peakSpeed, state.speed),
            contactReach: reach + STRIKE_CONFIG.gloveNoseReach,
            timestamp: pose.timestamp,
          };
          state.peakSpeed = 0;
          out.push(event);
          for (const cb of this.listeners) cb(event);
        }
      } else if (reach < threshold * STRIKE_CONFIG.releaseFraction) {
        // Hysteresis: the fist has to come meaningfully back before another
        // strike can register. Without it, noise around the threshold machine-
        // guns events out of one held extension.
        state.extended = false;
        state.peakSpeed = 0;
      }
    }

    return out;
  }
}

/**
 * Which zone a fist is arriving at, in the player's own body frame.
 *
 * Height splits at the shoulder line rather than at the nose: a punch level
 * with the shoulders is already a head shot in boxing terms, and using the
 * nose put the boundary so high that body shots swallowed everything.
 */
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

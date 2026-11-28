// The two fight cameras. First person sits at the player's eyes; third person
// sits just behind and above their head with their fighter drawn see-through.
// Both look at the opponent. Plain vectors in and out, testable without WebGL.

/** Placement, field of view and dodge lean of a fight camera. */
export interface ViewCamera {
  forward: number;
  up: number;
  lookDown: number;
  fov: number;
  minHFov: number;
  maxFov: number;
  tau: number;
  leanSide: number;
  leanSideMax: number;
  leanRoll: number;
  leanRollMax: number;
  leanTargetShare: number;
}

export const FPS_CAMERA = {
  /** Offset from the midpoint of the eye bones toward the opponent, metres. */
  forward: -0.06,
  /** Offset above the eye bones, metres. */
  up: 0.01,
  /** Aim this far below the opponent's head centre, so their head sits in the
   *  upper half with their gloves and body below. */
  lookDown: 0.02,
  /** Vertical field of view on a landscape screen, degrees. */
  fov: 68,
  /** The horizontal field of view never drops below this, so a portrait
   *  phone still shows the opponent's shoulders. */
  minHFov: 70,
  /** Cap on the widened vertical field of view, degrees. */
  maxFov: 100,
  /** Camera smoothing, seconds. Short: in first person, lag reads as motion sickness. */
  tau: 0.035,
  /** Extra sideways travel per torso unit of slip, on top of the head's own movement. */
  leanSide: 0.15,
  leanSideMax: 0.1,
  /** Roll into the slip per torso unit, radians, and its cap (about 4 degrees). */
  leanRoll: 0.12,
  leanRollMax: 0.07,
  /** Share of the sideways travel applied to the look target. */
  leanTargetShare: 0.5,
  /** Render resolution cap in first person on a touch screen, which shares its GPU with pose tracking. */
  phoneMaxPixelRatio: 1,
  /** Opponent glove glow at full wind-up, as an emissive colour. */
  windupGlow: 0xff7a1a,
} as const;

/** Third person: behind the player's head (the head bone, not the eyes). */
export const SHOULDER_CAMERA = {
  /** Far enough back that the see-through fighter shows from about the hips
   *  up at the bottom of the frame, with the opponent beyond. */
  forward: -1.35,
  /** A touch above eye line, so the gloves read in front of the face. */
  up: 0.2,
  /** Aim just below the opponent's chin: head and gloves in the upper half. */
  lookDown: 0.18,
  fov: 50,
  minHFov: 62,
  maxFov: 90,
  tau: 0.06,
  leanSide: 0.45,
  leanSideMax: 0.32,
  leanRoll: 0.16,
  leanRollMax: 0.12,
  leanTargetShare: 0.5,
  /** The player's body, so the opponent shows through it. Gloves stay solid. */
  playerOpacity: 0.28,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

/**
 * Camera at `eye`, looking at `opponentHead`. The forward direction is
 * horizontal, so a duck lowers the view instead of tilting it. `side` slides
 * the camera to screen right (positive) for the dodge lean.
 */
export function fpsCameraPose(eye: Vec3, opponentHead: Vec3, cfg: ViewCamera = FPS_CAMERA, side = 0): CameraPose {
  let dx = opponentHead.x - eye.x;
  let dz = opponentHead.z - eye.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    dx = 0;
    dz = 1;
  } else {
    dx /= len;
    dz /= len;
  }
  const rx = -dz;
  const rz = dx;
  const ts = side * cfg.leanTargetShare;
  return {
    position: {
      x: eye.x + dx * cfg.forward + rx * side,
      y: eye.y + cfg.up,
      z: eye.z + dz * cfg.forward + rz * side,
    },
    target: {
      x: opponentHead.x + rx * ts,
      y: opponentHead.y - cfg.lookDown,
      z: opponentHead.z + rz * ts,
    },
  };
}

/** Vertical field of view for `aspect` (width / height), degrees. */
export function fpsFov(aspect: number, cfg: ViewCamera = FPS_CAMERA): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const fromH = (2 * Math.atan(Math.tan((cfg.minHFov * Math.PI) / 360) / a) * 180) / Math.PI;
  return Math.min(cfg.maxFov, Math.max(cfg.fov, fromH));
}

/**
 * Dodge lean for a slip of `lateral` torso units (positive toward the
 * player's right): sideways slide in world units and roll in radians.
 */
export function fpsLean(lateral: number, cfg: ViewCamera = FPS_CAMERA): { side: number; roll: number } {
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  const l = Number.isFinite(lateral) ? lateral : 0;
  return {
    side: clamp(l * cfg.leanSide, cfg.leanSideMax),
    roll: clamp(l * cfg.leanRoll, cfg.leanRollMax),
  };
}

/** Exponential approach of `current` toward `goal`, frame-rate independent. */
export function approach(current: Vec3, goal: Vec3, dt: number, tau: number): Vec3 {
  const a = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
  return {
    x: current.x + (goal.x - current.x) * a,
    y: current.y + (goal.y - current.y) * a,
    z: current.z + (goal.z - current.z) * a,
  };
}

/** Glove meshes, by the mesh's own name or its parent's. */
export function isGlove(names: readonly string[]): boolean {
  return names.some((n) => n.toLowerCase().startsWith("glove"));
}

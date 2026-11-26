// FPS mode: the camera sits just behind the player's own head and looks at the
// opponent, and the player's own fighter is drawn see-through so it never
// blocks the view of the person they are fighting.
//
// Kept free of three.js scene state (plain vectors in, plain vectors out) so
// the placement can be unit-tested without a WebGL context.

export const FPS_CAMERA = {
  /** How far behind the player's head the camera sits, world units. Far
   *  enough that the player's see-through fighter shows from about the hips
   *  up, centred at the bottom of the frame, with the opponent and the ring
   *  beyond them - the head sits over the opponent's, not filling the screen. */
  back: 1.35,
  /** How far above the head centre, world units. A touch above eye line so
   *  the gloves read in front of the face rather than underneath it. */
  up: 0.2,
  /** Where on the opponent the camera looks, relative to their head centre:
   *  slightly below the chin, so their head and gloves sit in the upper half
   *  and their body shows below. */
  lookDown: 0.18,
  /** Vertical field of view in FPS mode, degrees. Wider than the third-person
   *  view so both of the player's own gloves stay in frame when they punch. */
  fov: 50,
  /** Opacity of the player's own body. Low enough that the opponent is
   *  clearly visible through it. The gloves are NOT faded (see isGhostPart):
   *  where your fists are is the one thing you must always see. */
  playerOpacity: 0.28,
  /** Camera smoothing time constant, seconds. The head moves with every
   *  landmark wobble; a camera locked rigidly to it shakes. */
  tau: 0.06,
  /** Dodge lean: extra sideways camera travel per torso unit of slip, world
   *  units. On top of the head's own movement, so a slip visibly takes you
   *  out of the line of the punch. */
  leanSide: 0.45,
  /** Cap on that sideways travel, world units. */
  leanSideMax: 0.32,
  /** Camera roll into the slip per torso unit, radians. */
  leanRoll: 0.16,
  /** Cap on the roll, radians (about 7 degrees). */
  leanRollMax: 0.12,
  /** Share of the sideways travel applied to the look target too. Under 1,
   *  so the view swings a little toward the opponent rather than sliding
   *  flat past them. */
  leanTargetShare: 0.5,
  /** Render resolution cap in FPS Mode on a phone (touch screen). The scene
   *  shares the phone's GPU with pose tracking, and in FPS Mode any lag shows
   *  as your own gloves trailing your punches, right in front of you. Same
   *  value as the ?demo preset. Shadows and the crowd are also switched off
   *  there (see BoxerModel). */
  phoneMaxPixelRatio: 1,
  /** Opponent glove glow at full wind-up, as an emissive colour. */
  windupGlow: 0xff7a1a,
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
 * Where the camera should be this frame: behind `head` on the line away from
 * `opponentHead`, raised by `up`, looking at the opponent.
 *
 * The direction is horizontal only (y ignored), so a ducking player does not
 * tilt the whole view toward the floor. Falls back to looking down +z when
 * the two heads are on top of each other.
 */
export function fpsCameraPose(head: Vec3, opponentHead: Vec3, cfg = FPS_CAMERA, side = 0): CameraPose {
  let dx = opponentHead.x - head.x;
  let dz = opponentHead.z - head.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) {
    dx = 0;
    dz = 1;
  } else {
    dx /= len;
    dz /= len;
  }
  // The camera's right, looking along (dx, 0, dz): forward x up.
  const rx = -dz;
  const rz = dx;
  const ts = side * cfg.leanTargetShare;
  return {
    position: {
      x: head.x - dx * cfg.back + rx * side,
      y: head.y + cfg.up,
      z: head.z - dz * cfg.back + rz * side,
    },
    target: {
      x: opponentHead.x + rx * ts,
      y: opponentHead.y - cfg.lookDown,
      z: opponentHead.z + rz * ts,
    },
  };
}

/**
 * The dodge lean for a slip of `lateral` torso units (positive toward the
 * player's own right, as BodyMotion reports it): how far to slide the camera
 * sideways (world units, positive is screen right) and how much to roll it
 * (radians, positive rolls the camera clockwise - the top of the view
 * toward screen right - which is into a right slip).
 */
export function fpsLean(lateral: number, cfg = FPS_CAMERA): { side: number; roll: number } {
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

/**
 * Whether a part of the player's fighter is drawn see-through in FPS mode.
 * Everything except the gloves: the body fades so it never hides the
 * opponent, while the gloves stay solid so the player always sees exactly
 * where their fists are. `name` is the mesh's own name or its parent's
 * (glove_L / glove_R in the shipped model).
 */
export function isGhostPart(names: readonly string[]): boolean {
  return !names.some((n) => n.toLowerCase().startsWith("glove"));
}

// A camera director.
//
// Produces a DESIRED camera pose each frame; the renderer eases toward it.
// Deliberately free of three.js so the shot logic can be tested headlessly —
// "did it cut to the right shot at the right moment" is a scheduling question,
// not a rendering one.
// THE RULE THIS IS BUILT AROUND: NEVER CUT AWAY FROM A LIVE EXCHANGE
//
// Broadcast fight coverage is famously conservative — one wide camera holds
// almost the entire fight, and the dramatic angles only appear in replay. That
// is not a lack of ambition, it is because a cut mid-exchange costs the viewer
// a beat of reorientation, and a beat is a whole combination.
//
// It matters more here than in a normal fighting game, because the player is
// also the controller. A camera that swings around during an exchange makes
// someone throwing real punches lose track of where the opponent is, which is
// disorienting in a physical way a gamepad player never experiences.
//
// So: cuts happen on knockdowns, between rounds, and at the decision. Never
// during live action. The only motion during a round is a slow drift that
// keeps both fighters framed.

import { DIRECTOR_CONFIG } from "../../config/tuning";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
  /** Vertical field of view, degrees. Tighter shots narrow it. */
  fov: number;
}

export type ShotName =
  | "broadcast"
  | "tight"
  | "lowAngle"
  | "corner"
  | "overhead"
  | "decision";

export interface DirectorInput {
  /** Where the two fighters are, world space. */
  player: Vec3;
  opponent: Vec3;
  /** Radius of the cage, for keeping shots inside it. */
  radius: number;
}

interface Shot {
  /** Builds the pose for this shot from the current fighter positions. */
  frame(input: DirectorInput): CameraPose;
  /** Seconds to hold before returning to the default. 0 = hold forever. */
  hold: number;
  /** How quickly the camera eases toward it. Higher = snappier. */
  ease: number;
}

const mid = (a: Vec3, b: Vec3): Vec3 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
  z: (a.z + b.z) / 2,
});

/** Unit vector from a to b on the ground plane, with a stable fallback. */
function axis(a: Vec3, b: Vec3): Vec3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  // Two fighters standing in exactly the same spot has no meaningful axis.
  // Without a fallback every shot derived from it becomes NaN and the camera
  // vanishes — and a clinch is precisely when they are closest.
  if (d < 1e-4) return { x: 0, y: 0, z: 1 };
  return { x: dx / d, y: 0, z: dz / d };
}

const SHOTS: Record<ShotName, Shot> = {
  // The workhorse. Side-on to the line between the fighters, so both are
  // visible and neither occludes the other — the single most important
  // property of a fight camera and the reason broadcast sits side-on rather
  // than behind.
  broadcast: {
    hold: 0,
    ease: DIRECTOR_CONFIG.slowEase,
    frame({ player, opponent, radius }) {
      const c = mid(player, opponent);
      const a = axis(player, opponent);
      // Perpendicular on the ground plane.
      const px = -a.z;
      const pz = a.x;
      const dist = radius * DIRECTOR_CONFIG.broadcastDistance;
      return {
        position: {
          x: c.x + px * dist,
          y: DIRECTOR_CONFIG.broadcastHeight,
          z: c.z + pz * dist,
        },
        target: { x: c.x, y: c.y + DIRECTOR_CONFIG.aimHeight, z: c.z },
        fov: 42,
      };
    },
  },

  tight: {
    hold: DIRECTOR_CONFIG.tightHold,
    ease: DIRECTOR_CONFIG.slowEase,
    frame({ player, opponent, radius }) {
      const c = mid(player, opponent);
      const a = axis(player, opponent);
      const dist = radius * DIRECTOR_CONFIG.tightDistance;
      return {
        position: { x: c.x - a.z * dist, y: 1.6, z: c.z + a.x * dist },
        target: { x: c.x, y: c.y + DIRECTOR_CONFIG.aimHeight, z: c.z },
        fov: 30,
      };
    },
  },

  // The knockdown shot. Low, close, looking up — which is the angle that makes
  // a downed fighter read as downed rather than just short.
  lowAngle: {
    hold: DIRECTOR_CONFIG.knockdownHold,
    ease: DIRECTOR_CONFIG.fastEase,
    frame({ player, opponent }) {
      const c = mid(player, opponent);
      const a = axis(player, opponent);
      return {
        position: {
          x: c.x - a.z * 1.6 + a.x * 0.6,
          y: DIRECTOR_CONFIG.lowAngleHeight,
          z: c.z + a.x * 1.6 + a.z * 0.6,
        },
        target: { x: c.x, y: c.y + 1.1, z: c.z },
        fov: 52,
      };
    },
  },

  corner: {
    hold: DIRECTOR_CONFIG.cornerHold,
    ease: DIRECTOR_CONFIG.slowEase,
    frame({ player, radius }) {
      return {
        position: { x: player.x * 1.4, y: 2.2, z: player.z * 1.4 + radius * 0.5 },
        target: { x: player.x, y: player.y + 1.3, z: player.z },
        fov: 38,
      };
    },
  },

  overhead: {
    hold: DIRECTOR_CONFIG.overheadHold,
    ease: DIRECTOR_CONFIG.slowEase,
    frame({ player, opponent }) {
      const c = mid(player, opponent);
      return {
        position: { x: c.x, y: 6.5, z: c.z + 0.4 },
        target: { x: c.x, y: c.y, z: c.z },
        fov: 46,
      };
    },
  },

  decision: {
    hold: 0,
    ease: DIRECTOR_CONFIG.slowEase,
    frame({ player, opponent, radius }) {
      const c = mid(player, opponent);
      const a = axis(player, opponent);
      return {
        position: {
          x: c.x - a.z * radius * 0.9,
          y: 2.6,
          z: c.z + a.x * radius * 0.9,
        },
        target: { x: c.x, y: c.y + 1.2, z: c.z },
        fov: 36,
      };
    },
  },
};

export class FightCamera {
  shot: ShotName = "broadcast";
  /** Current, eased pose. This is what the renderer applies. */
  pose: CameraPose;
  private holdLeft = 0;
  private locked = false;

  constructor(input: DirectorInput) {
    this.pose = SHOTS.broadcast.frame(input);
  }

  /**
   * Requests a shot.
   *
   * Refused during live action unless `force` is set — see the header. The
   * only callers that should force are knockdowns and round boundaries.
   */
  cut(shot: ShotName, force = false): boolean {
    if (this.locked && !force) return false;
    this.shot = shot;
    this.holdLeft = SHOTS[shot].hold;
    return true;
  }

  /** True while a round is live, which blocks discretionary cuts. */
  setLive(live: boolean): void {
    this.locked = live;
  }

  update(dt: number, input: DirectorInput): CameraPose {
    const shot = SHOTS[this.shot];
    const want = shot.frame(input);

    if (this.holdLeft > 0) {
      this.holdLeft -= dt;
      if (this.holdLeft <= 0 && this.shot !== "broadcast") {
        this.shot = "broadcast";
        this.holdLeft = 0;
      }
    }

    // Exponential ease, framed so it is FRAME-RATE INDEPENDENT. The naive
    // `current += (want - current) * k` moves further per second at 120 FPS
    // than at 30, which means the camera feels different on different
    // machines — the same bug the bone smoothing in rigDriver.ts had to fix.
    const k = 1 - Math.exp(-shot.ease * dt);
    this.pose = {
      position: lerp3(this.pose.position, want.position, k),
      target: lerp3(this.pose.target, want.target, k),
      fov: this.pose.fov + (want.fov - this.pose.fov) * k,
    };
    return this.pose;
  }

  /** Jumps straight to the current shot with no easing. For round starts. */
  snap(input: DirectorInput): CameraPose {
    this.pose = SHOTS[this.shot].frame(input);
    return this.pose;
  }
}

function lerp3(a: Vec3, b: Vec3, k: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
  };
}

// A camera director.

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
  /**
   * The fighter this moment is about, when there is one. Defaults to the
   * midpoint between the two.
   */
  subject?: Vec3;
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

/** What a shot should be pointed at: whoever the moment is about, or the
 *  middle of the two when it is about both of them. */
const focus = (i: DirectorInput): Vec3 => i.subject ?? mid(i.player, i.opponent);

/** Unit vector from a to b on the ground plane, with a stable fallback. */
function axis(a: Vec3, b: Vec3): Vec3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  // Two fighters standing in exactly the same spot has no meaningful axis.
  // Without a fallback every shot derived from it becomes NaN and the camera
  // vanishes - and a clinch is precisely when they are closest.
  if (d < 1e-4) return { x: 0, y: 0, z: 1 };
  return { x: dx / d, y: 0, z: dz / d };
}

const SHOTS: Record<ShotName, Shot> = {
  // The workhorse. Side-on to the line between the fighters, so both are
  // visible and neither occludes the other - the single most important
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

  // The knockdown shot. Low, close, looking up - which is the angle that makes
  // a downed fighter read as downed rather than just short.
  lowAngle: {
    hold: DIRECTOR_CONFIG.knockdownHold,
    ease: DIRECTOR_CONFIG.fastEase,
    frame(input) {
      const { player, opponent } = input;
      // The downed fighter, when the caller says who that is - not the middle
      // of the two. See DirectorInput.subject.
      const c = focus(input);
      const a = axis(player, opponent);
      const d = DIRECTOR_CONFIG.lowAngleDistance;
      return {
        position: {
          x: c.x - a.z * d + a.x * d * 0.38,
          y: DIRECTOR_CONFIG.lowAngleHeight,
          z: c.z + a.x * d + a.z * d * 0.38,
        },
        // Low: a fighter on the canvas is a metre below where they were
        // standing, and an aim at chest height looks over the top of them.
        target: { x: c.x, y: c.y + DIRECTOR_CONFIG.lowAngleAim, z: c.z },
        fov: 52,
      };
    },
  },

  corner: {
    hold: DIRECTOR_CONFIG.cornerHold,
    ease: DIRECTOR_CONFIG.slowEase,
    frame(input) {
      const c = focus(input);
      return {
        position: { x: c.x * 1.4, y: 2.2, z: c.z * 1.4 + input.radius * 0.5 },
        target: { x: c.x, y: c.y + 1.3, z: c.z },
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
  private house: CameraPose | null = null;

  constructor(input: DirectorInput) {
    this.pose = SHOTS.broadcast.frame(input);
  }

  /** The pose to rest at when no cinematic shot is running. */
  setHouseShot(pose: CameraPose | null): void {
    this.house = pose;
  }

  /** True while the director is showing something other than the house shot,
   *  i.e. while it - rather than the caller - should own the camera. */
  get cinematic(): boolean {
    return this.shot !== "broadcast";
  }

  /** Distance from the current eased pose to where it is heading. The caller
   *  uses this to know when a return to the house shot has finished and it can
   *  take its camera back. */
  settleError(input: DirectorInput): number {
    const want = this.frameOf(this.shot, input);
    return Math.max(
      dist3(this.pose.position, want.position),
      dist3(this.pose.target, want.target)
    );
  }

  private frameOf(shot: ShotName, input: DirectorInput): CameraPose {
    if (shot === "broadcast" && this.house) return this.house;
    return SHOTS[shot].frame(input);
  }

  /** Requests a shot. */
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
    const want = this.frameOf(this.shot, input);

    if (this.holdLeft > 0) {
      this.holdLeft -= dt;
      if (this.holdLeft <= 0 && this.shot !== "broadcast") {
        this.shot = "broadcast";
        this.holdLeft = 0;
      }
    }

    // Exponential ease, framed so it is frame-rate independent. The naive
    // `current += (want - current) * k` moves further per second at 120 FPS
    // than at 30, which means the camera feels different on different
    // machines - the same bug the bone smoothing in rigDriver.ts had to fix.
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
    this.pose = this.frameOf(this.shot, input);
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

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

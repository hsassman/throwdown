// An opponent that fights back.
// Two design commitments
//
// 1. It telegraphs. Every attack has a visible wind-up before it can hurt you.
//    That is not a concession to make it easy - it is the entire basis of the
//    genre. A fight against an opponent that strikes instantly is a reaction
//    test; a fight against one that shows you what is coming is a game. The
//    wind-up window is the only thing that makes defence meaningful, and it is
//    doubly necessary here because the player's own input arrives at ~15 FPS
//    through a webcam, so anything faster than about 250ms is not defendable
//    even in principle.
//
// 2. It is deterministic. All randomness comes from a seeded generator held in
//    this object, never from Math.random. That makes every test reproducible,
//    and - more importantly - it is a hard prerequisite for the rollback
//    netcode in the netcode notes. Rollback replays past frames and
//    requires identical results; a CPU calling Math.random would desync two
//    peers the first time it threw a punch. Building it non-deterministically
//    now would mean rewriting it later, so it is deterministic from the start.

import type { Evasion, GuardPosture } from "./fightState";
import type { ImpactPoint } from "../perception/strikeGeometry";
import { CPU_CONFIG, FIGHT_GEOMETRY } from "../config/tuning";

export type CpuState = "circling" | "telegraph" | "striking" | "recovering" | "hurt";

/**
 * What the feet are doing. Independent of what the hands are doing, on purpose.
 *
 * A boxer steps while throwing, circles while resting, and backs out of range
 * after a combination. Folding footwork into the attack state machine would
 * have meant the opponent stood perfectly still between punches, which is the
 * single most obvious tell that something is a state machine and not a person.
 * So this is a second machine on its own clock, and the two only interact
 * where a fight says they should - you do not back away mid-combination, and
 * you do not circle while hurt.
 */
export type CpuFootwork = "hold" | "advance" | "retreat" | "circleLeft" | "circleRight";

/**
 * Where the opponent's body is, in the same channels the camera produces for
 * the player (`perception/bodyMotion.ts`).
 *
 * This is the piece that makes the render layer simple. There is one movement
 * vocabulary in the game - lateral, depth, crouch, lean - and two sources for
 * it: a webcam for the player, this state machine for the opponent. The
 * animator does not need to know which is which, and a channel that reads
 * correctly for one reads correctly for the other.
 */
export interface CpuStance {
  /** Torso units, positive toward the CPU's own right. */
  lateral: number;
  /** Torso units, positive = closer to the player. */
  depth: number;
  /** 0-1. */
  crouch: number;
  /** Radians of torso lean, signed with `lateral`. */
  lean: number;
}

export type Difficulty = "rookie" | "contender" | "champion";

export interface CpuIntent {
  /** A strike is being thrown now. */
  strike?: {
    impact: ImpactPoint;
    power: number;
    hand: "left" | "right";
    /**
     * Deterministic spread in [-0.5, 0.5] for the caller's approach vector.
     *
     * Emitted from here rather than rolled by the caller because the approach
     * decides the punch's arc, and the arc feeds `damageOf` through the
     * rising-chin bonus. A caller reaching for Math.random would have made the
     * fight non-reproducible from outside the one class that guarantees it.
     */
    jitter: number;
  };
  /** Guard changed this tick. */
  guard?: GuardPosture;
  /** Head movement started or ended this tick. Emitted only on change, like
   *  the guard, so the caller can hand it straight to `FightSim.setEvasion`
   *  without re-charging the stamina cost every frame. */
  evasion?: Evasion;
}

/** What the CPU can see. Deliberately narrow - it gets what a human would. */
export interface CpuPerception {
  /** Our own remaining stamina, 0-1. */
  stamina: number;
  /** Opponent's remaining health, 0-1. */
  opponentHealth: number;
  /** True while the opponent is stunned - the opening to press. */
  opponentStunned: boolean;
  /** True while the opponent's fist is extended toward us. */
  opponentThrowing: boolean;
  /** Opponent's guard, if readable. */
  opponentGuard: GuardPosture;
  /**
   * Gap to the opponent, torso units. 0 is chest to chest.
   *
   * Supplied by the caller rather than simulated here, because the player's
   * half of it is a camera measurement (`BodyMotion.depth`) and the CPU's half
   * is `stance.depth`. Keeping the subtraction outside means this class never
   * has to know that one of the two fighters is a person.
   */
  range: number;
  /**
   * Which side the incoming punch is arriving on, in the CPU's own frame, or
   * null when it cannot tell. Only meaningful while `opponentThrowing`.
   *
   * Gated by the difficulty's discipline roll before it is acted on - a rookie
   * that always slipped the correct way would be reading the player's mind.
   */
  incomingSide?: "left" | "right" | null;
}

interface Profile {
  /** Seconds of wind-up before a strike lands. Longer is more readable. */
  telegraph: number;
  /** Seconds of vulnerability after throwing. */
  recovery: number;
  /** Mean seconds between attack attempts while circling. */
  tempo: number;
  /** Probability of raising the correct guard against a read punch. */
  discipline: number;
  /** 0-1 - how willing it is to trade rather than reset. */
  aggression: number;
  /** Punches in a combination, maximum. */
  maxCombo: number;
  /** Multiplier on footwork travel speed. */
  footSpeed: number;
  /** Probability of answering a read punch with a slip rather than a guard.
   *  A slip is the better answer when it works and the worse one when it does
   *  not, so this is a measure of nerve as much as skill. */
  evasiveness: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  rookie: {
    telegraph: 0.55,
    recovery: 0.75,
    tempo: 2.4,
    discipline: 0.35,
    aggression: 0.3,
    maxCombo: 1,
    footSpeed: 0.7,
    evasiveness: 0.15,
  },
  contender: {
    telegraph: 0.38,
    recovery: 0.5,
    tempo: 1.5,
    discipline: 0.62,
    aggression: 0.55,
    maxCombo: 3,
    footSpeed: 1,
    evasiveness: 0.4,
  },
  champion: {
    // Still 260ms of wind-up. Below the webcam's own latency floor there is
    // nothing to react to, and an unreadable opponent is not a harder fight,
    // it is a coin toss.
    telegraph: 0.26,
    recovery: 0.34,
    tempo: 0.95,
    discipline: 0.85,
    aggression: 0.8,
    maxCombo: 5,
    footSpeed: 1.25,
    evasiveness: 0.65,
  },
};

/**
 * mulberry32. Small, fast, and good enough for behaviour selection - this is
 * choosing between four target zones, not generating keys.
 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Target neighbourhoods, in the same body-frame units as ImpactPoint. */
const TARGETS: { name: string; impact: ImpactPoint; high: boolean }[] = [
  { name: "chin", impact: { lateral: 0, height: 1.21 }, high: true },
  { name: "jaw", impact: { lateral: 0.2, height: 1.24 }, high: true },
  { name: "temple", impact: { lateral: 0.28, height: 1.44 }, high: true },
  { name: "solar", impact: { lateral: 0, height: 0.6 }, high: false },
  { name: "liver", impact: { lateral: -0.26, height: 0.56 }, high: false },
  { name: "ribs", impact: { lateral: 0.28, height: 0.62 }, high: false },
];

export class CpuOpponent {
  state: CpuState = "circling";
  private profile: Profile;
  private rand: () => number;
  private timer: number;
  private comboLeft = 0;
  private pending: NonNullable<CpuIntent["strike"]> | null = null;
  private guard: GuardPosture = "high";

  /** The feet, on their own clock. See `CpuFootwork`. */
  footwork: CpuFootwork = "hold";
  private footTimer = 0;
  /** Which way it is currently circling. Held across `hold` states so the CPU
   *  drifts consistently rather than jittering left-right around one spot. */
  private circleSign = 1;

  /** Committed head movement and its clock. */
  evasion: Evasion = "none";
  private evadeTimer = 0;
  private evadeCooldown = 0;

  /** Commanded stance - where the body is being asked to go. */
  private commanded: CpuStance = { lateral: 0, depth: 0, crouch: 0, lean: 0 };
  /** Shown stance - where it actually is. Chases `commanded`, because a body
   *  is a thing with mass and a state machine's output is a step function. */
  private shown: CpuStance = { lateral: 0, depth: 0, crouch: 0, lean: 0 };

  readonly difficulty: Difficulty;

  constructor(difficulty: Difficulty = "contender", seed = 0x5eed) {
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
    this.rand = rng(seed);
    this.timer = this.profile.tempo;
  }

  /** Where the body actually is, for the render layer. */
  get stance(): CpuStance {
    return this.shown;
  }

  /** Visible wind-up progress, 0-1. The render layer uses this to animate the
   *  telegraph, which is what makes the commitment above actually legible. */
  get windup(): number {
    if (this.state !== "telegraph") return 0;
    return 1 - Math.max(0, this.timer) / this.profile.telegraph;
  }

  /** Called when this fighter gets hit, so it can be interrupted. */
  onHurt(seconds: number): void {
    this.state = "hurt";
    this.timer = seconds;
    this.comboLeft = 0;
    // Being hit ends a slip. A fighter who was still slipping would be
    // evading punches while stunned, which is exactly the window a knockdown
    // is supposed to open.
    this.evasion = "none";
    this.evadeTimer = 0;
    this.evadeCooldown = CPU_CONFIG.evadeCooldown;
    // Hurt fighters give ground. Standing in front of someone who has just
    // hurt you is the one thing no boxer does.
    this.setFootwork("retreat", seconds);
    // An interrupted punch does not land. Dropping it here is what makes
    // beating the opponent to the punch actually work.
    this.pending = null;
    this.guard = "none";
  }

  /** Advances by `dt` seconds and returns whatever it wants to do. */
  update(dt: number, see: CpuPerception): CpuIntent {
    const intent: CpuIntent = {};
    this.timer -= dt;

    switch (this.state) {
      case "hurt":
        if (this.timer <= 0) {
          this.state = "circling";
          this.timer = this.profile.tempo * CPU_CONFIG.resetAfterHurt;
          intent.guard = this.setGuard("high");
        }
        break;

      case "circling": {
        // Defensive read. A disciplined opponent raises the correct guard
        // against an incoming punch; a rookie mostly does not.
        if (see.opponentThrowing && this.rand() < this.profile.discipline) {
          intent.guard = this.setGuard(this.rand() < 0.65 ? "high" : "low");
        }
        // Gassed fighters stop throwing and cover up. This is what makes
        // draining the opponent a real strategy rather than a stat that ticks
        // down cosmetically.
        if (see.stamina < CPU_CONFIG.exhaustedFraction) {
          intent.guard = this.setGuard("high");
          this.timer = Math.max(this.timer, this.profile.tempo);
          break;
        }
        if (this.timer <= 0) {
          // Press a stunned opponent hard. The window after a knockdown is
          // where fights are actually finished.
          const urgency = see.opponentStunned
            ? CPU_CONFIG.stunnedUrgency
            : 1 - this.profile.aggression * 0.5;
          // Out of range is not a reason to punch the air. An opponent that
          // lands blows from across the ring is the most obvious way this
          // reads as fake, so it closes the distance first and reconsiders
          // when it arrives.
          if (see.range > FIGHT_GEOMETRY.strikingRange) {
            this.setFootwork("advance", CPU_CONFIG.footworkMin);
            this.timer = CPU_CONFIG.footworkMin;
          } else if (see.opponentStunned || this.rand() < this.profile.aggression) {
            this.beginCombo(see);
          } else {
            this.timer = this.profile.tempo * urgency * (0.6 + this.rand() * 0.8);
          }
        }
        break;
      }

      case "telegraph":
        if (this.timer <= 0 && this.pending) {
          intent.strike = this.pending;
          this.pending = null;
          this.state = "recovering";
          this.timer = this.profile.recovery;
          // Committing to a punch drops the guard. The trade that makes
          // counter-punching work.
          intent.guard = this.setGuard("none");
        }
        break;

      case "striking":
        // Transitional; the strike is emitted out of `telegraph`.
        this.state = "recovering";
        this.timer = this.profile.recovery;
        break;

      case "recovering":
        if (this.timer <= 0) {
          if (this.comboLeft > 0) {
            this.nextInCombo(see);
          } else {
            this.state = "circling";
            this.timer = this.profile.tempo * (0.7 + this.rand() * 0.6);
            intent.guard = this.setGuard("high");
          }
        }
        break;
    }

    this.updateEvasion(dt, see, intent);
    this.updateFootwork(dt, see);
    this.integrateStance(dt, see.range);

    return intent;
  }

  // Head movement
  //
  // Answering an incoming punch with a slip instead of a guard. The decision
  // is one roll deep on purpose - this is a fighter choosing between two
  // defences it already knows, not a planner.

  private updateEvasion(dt: number, see: CpuPerception, intent: CpuIntent): void {
    this.evadeCooldown = Math.max(0, this.evadeCooldown - dt);

    if (this.evasion !== "none") {
      this.evadeTimer -= dt;
      if (this.evadeTimer <= 0) {
        // A slip is a move, not a posture. Letting it expire on a clock is
        // what stops it becoming permanent invulnerability, and it is why the
        // cooldown exists as well: without one the CPU simply re-slips on the
        // next tick and is never hittable.
        this.evasion = "none";
        this.evadeCooldown = CPU_CONFIG.evadeCooldown;
        intent.evasion = "none";
      }
      return;
    }

    if (this.state === "hurt" || this.state === "telegraph") return;
    if (this.evadeCooldown > 0 || !see.opponentThrowing) return;
    // Reading the punch at all is the discipline roll; choosing to slip rather
    // than block is the nerve roll. Both have to come off, which is why a
    // rookie mostly just covers up.
    if (this.rand() >= this.profile.discipline) return;
    if (this.rand() >= this.profile.evasiveness) return;

    // A fighter who cannot tell which side it is coming from guesses, and is
    // wrong about half the time. That is the honest behaviour: the alternative
    // is an opponent that always slips the correct way, which is
    // indistinguishable from it reading the player's input.
    const side = see.incomingSide ?? (this.rand() < 0.5 ? "left" : "right");
    // Slipping away from where the punch is arriving. Slipping toward it is
    // the classic error and would look identical on screen.
    const move: Evasion =
      this.rand() < CPU_CONFIG.duckShare
        ? "duck"
        : side === "left"
          ? "slipRight"
          : "slipLeft";

    this.evasion = move;
    this.evadeTimer = CPU_CONFIG.evadeSeconds;
    intent.evasion = move;
  }

  // Footwork

  private setFootwork(f: CpuFootwork, seconds: number): void {
    this.footwork = f;
    this.footTimer = seconds;
    if (f === "circleLeft") this.circleSign = -1;
    if (f === "circleRight") this.circleSign = 1;
  }

  private updateFootwork(dt: number, see: CpuPerception): void {
    this.footTimer -= dt;

    // Mid-combination the feet follow the hands. A fighter that wandered off
    // sideways halfway through a three-piece would be throwing at nobody.
    if (this.state === "telegraph" || this.state === "recovering") {
      if (see.range > FIGHT_GEOMETRY.strikingRange) this.footwork = "advance";
      else if (this.footwork === "retreat") this.footwork = "hold";
      return;
    }

    if (this.state === "hurt") {
      this.footwork = "retreat";
      return;
    }

    if (this.footTimer > 0) return;

    const tooFar = see.range > FIGHT_GEOMETRY.preferredRange;
    const tooClose = see.range < FIGHT_GEOMETRY.clinchRange;
    const gassed = see.stamina < CPU_CONFIG.exhaustedFraction;

    let next: CpuFootwork;
    if (tooClose) {
      // Nobody fights from inside their own guard.
      next = "retreat";
    } else if (gassed) {
      // A gassed fighter buys time with its feet rather than its hands. This
      // is the visible half of the stamina rule that already stops it
      // throwing - without it, draining the opponent produces a statue.
      next =
        this.rand() < 0.6
          ? "retreat"
          : this.circleSign < 0
            ? "circleLeft"
            : "circleRight";
    } else if (tooFar) {
      next =
        this.rand() < 0.7
          ? "advance"
          : this.circleSign < 0
            ? "circleLeft"
            : "circleRight";
    } else {
      // In the pocket and able to work: circle, or reset the feet. Holding is
      // in the mix because constant motion reads as nervous rather than
      // composed, and a boxer at range is often simply set.
      const r = this.rand();
      if (r < 0.28) next = "hold";
      else if (r < 0.64) next = "circleLeft";
      else next = "circleRight";
    }

    // Do not circle straight out of the ring. At the lateral limit the only
    // circling direction available is back toward the middle.
    if (next === "circleLeft" && this.commanded.lateral <= -CPU_CONFIG.lateralLimit) {
      next = "circleRight";
    } else if (next === "circleRight" && this.commanded.lateral >= CPU_CONFIG.lateralLimit) {
      next = "circleLeft";
    }

    this.setFootwork(
      next,
      CPU_CONFIG.footworkMin +
        this.rand() * (CPU_CONFIG.footworkMax - CPU_CONFIG.footworkMin)
    );
  }

  // Stance
  //
  // Turns the two state machines above into the continuous channels the render
  // layer consumes. Commanded first, then chased - see `shown`.

  private integrateStance(dt: number, range: number): void {
    const speed = CPU_CONFIG.stepSpeed * this.profile.footSpeed * dt;
    const c = this.commanded;

    switch (this.footwork) {
      case "advance":
        c.depth += speed;
        break;
      case "retreat":
        c.depth -= speed;
        break;
      case "circleLeft":
        c.lateral -= speed;
        break;
      case "circleRight":
        c.lateral += speed;
        break;
      case "hold":
        break;
    }
    c.lateral = clamp(c.lateral, -CPU_CONFIG.lateralLimit, CPU_CONFIG.lateralLimit);
    c.depth = clamp(c.depth, -CPU_CONFIG.depthLimit, CPU_CONFIG.depthLimit);

    // Where the other fighter's side of the gap is, in this fighter's frame.
    //
    // `range` arrives measured against the current `shown.depth`, so adding it
    // back gives the half of the gap this fighter does not own - the neutral
    // separation less however far the player has stepped in. It is the thing
    // the body below has to stop short of.
    const theirSide = range + this.shown.depth;

    // Head movement rides on top of the feet rather than replacing them, which
    // is what a slip actually is: the body keeps its position and the head
    // leaves the centre line.
    let slip = 0;
    let crouch = 0;
    if (this.evasion === "slipLeft") slip = -CPU_CONFIG.slipTravel;
    else if (this.evasion === "slipRight") slip = CPU_CONFIG.slipTravel;
    else if (this.evasion === "duck") crouch = CPU_CONFIG.duckDepth;

    const targetLateral = c.lateral + slip;
    const targetLean = (slip / CPU_CONFIG.slipTravel) * CPU_CONFIG.slipLean;

    // One time constant for everything, so the whole body arrives together.
    // Separate ones let the lean land before the travel, which reads as the
    // figure tipping over rather than moving.
    const a = 1 - Math.exp(-dt / CPU_CONFIG.stanceTau);
    this.shown.lateral += (targetLateral - this.shown.lateral) * a;
    this.shown.depth += (c.depth - this.shown.depth) * a;
    this.shown.crouch += (crouch - this.shown.crouch) * a;
    this.shown.lean += (targetLean - this.shown.lean) * a;

    // A fighter cannot stand inside another fighter.
    //
    // A hard constraint on the body, applied after the chase, not a decision
    // taken before it. `clinchRange` has always been the gap inside which the
    // two are on top of each other, but the only thing that ever read it was
    // `tooClose`, which picks a retreat state - and a footwork state is held
    // for up to 1.6 seconds before it is reconsidered.
    //
    // That is survivable while the CPU owns the whole gap, and it does not: the
    // player's half is a camera measurement obeying no rule at all. A player
    // who walks in while the CPU is mid-advance closes both halves at once, and
    // the depth integrator's only bound was `depthLimit` - 1.4 torso units
    // against a starting gap of 1.66. The two figures ended up 0.17 world
    // units apart, gloves through heads, and nothing objected.
    //
    // Expressed as a ceiling on where the body may be rather than on what it
    // may want, because that is what makes it hold in the case that actually
    // breaks: a fighter already deep in the pocket when the other one steps
    // in. Being pushed back is the correct outcome - it is what a clinch is -
    // so the ceiling is allowed to drive `shown.depth` Down, and the command
    // is pulled along with it so the CPU does not spring forward the moment the
    // player gives ground.
    const ceiling = theirSide - FIGHT_GEOMETRY.clinchRange;
    if (this.shown.depth > ceiling) {
      this.shown.depth = Math.max(-CPU_CONFIG.depthLimit, ceiling);
      c.depth = Math.min(c.depth, this.shown.depth);
    }
  }

  private setGuard(g: GuardPosture): GuardPosture | undefined {
    if (this.guard === g) return undefined;
    this.guard = g;
    return g;
  }

  private beginCombo(see: CpuPerception): void {
    this.comboLeft = 1 + Math.floor(this.rand() * this.profile.maxCombo);
    this.nextInCombo(see);
  }

  private nextInCombo(see: CpuPerception): void {
    this.comboLeft--;

    // Go where the guard is not. This is the single behaviour that makes the
    // opponent feel like it is reading you rather than picking at random, and
    // it costs one branch.
    const wantHigh =
      see.opponentGuard === "low"
        ? true
        : see.opponentGuard === "high"
          ? false
          : this.rand() < 0.6;
    const pool = TARGETS.filter((t) => t.high === wantHigh);
    const pick = pool[Math.floor(this.rand() * pool.length)] ?? TARGETS[0];

    // Power falls off through a combination - the last punch of a five-piece
    // is an arm punch, not a knockout blow.
    const decay = Math.pow(CPU_CONFIG.comboPowerDecay, this.profile.maxCombo - this.comboLeft - 1);
    const power = (0.45 + this.rand() * 0.55) * decay * (0.6 + see.stamina * 0.4);

    this.pending = {
      jitter: this.rand() - 0.5,
      impact: {
        // Jitter, so repeated punches at the same target do not stack in one
        // pixel - and so the bruising spreads the way it does on a real face.
        lateral: pick.impact.lateral + (this.rand() - 0.5) * CPU_CONFIG.aimJitter,
        height: pick.impact.height + (this.rand() - 0.5) * CPU_CONFIG.aimJitter,
      },
      power: Math.max(0.1, Math.min(1, power)),
      hand: this.rand() < 0.5 ? "left" : "right",
    };
    this.state = "telegraph";
    this.timer = this.profile.telegraph;
  }
}

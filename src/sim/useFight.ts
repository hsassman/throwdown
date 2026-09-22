import { useCallback, useEffect, useRef, useState } from "react";
import {
  FightSim,
  evasionFromBody,
  guardFromBody,
  type FightEvent,
  type FightPhase,
  type FightRules,
} from "./fightState";
import { CpuOpponent, type Difficulty } from "./cpuOpponent";
import { createImpactAudio, type ImpactAudio } from "../audio/impactAudio";
import { approachOf, coarseZone, damageOf, regionAt } from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { WeightClass } from "../menu/menuModel";
import type { BodyMotion } from "../perception/bodyMotion";
import type { OpponentVisualState } from "../render/opponentAnimator";
import type { NetFightState } from "../net/protocol";
import { FIGHT_CONFIG, FIGHT_GEOMETRY, STRIKE_CONFIG } from "../config/tuning";

// Wires the pieces together: player strikes in, CPU strikes back, simulation
// keeps score, audio plays.
// Why the loop is a raf, not a react effect per tick
//
// The fight runs at 60 Hz and React state cannot. Strikes arrive at pose rate
// (~15 Hz) and the CPU is stepped every frame; routing either through a state
// setter would re-render the tree mid-combination, which is the exact mistake
// BoxerModel already avoids by draining its strike queue inside the render
// loop rather than passing hits as props.
//
// So the simulation lives in a ref and runs on its own clock, and React is
// given a snapshot a few times a second - fast enough that a health bar looks
// live, slow enough that it costs nothing.

/** The player's own outcome, from the player's side rather than the sim's. */
export type FightResult = { kind: "win" | "loss" | "draw"; reason: "ko" | "tko" | "decision" };

/** One fighter's visible condition. All three are things a spectator could
 *  see, which is the test for whether they belong in this struct. */
export interface FighterCondition {
  /** 1 while this fighter is on the canvas, 0 while they are on their feet. */
  down: number;
  /** 0-1: how hurt they are right now. Drives the wobble and the sagging
   *  guard, and decays with the sim's own `stunned` timer. */
  hurt: number;
  /** The referee's count, 0 when nobody is down. */
  count: number;
}

export interface FightCondition {
  player: FighterCondition;
  opponent: FighterCondition;
}

export interface FightHudState {
  round: number;
  clock: number;
  phase: string;
  player: { health: number; stamina: number; landed: number };
  opponent: { health: number; stamina: number; landed: number };
  cards: Record<string, number>;
  /** The most recent few events, newest first, for a feed. */
  log: string[];
  /** CPU wind-up, 0-1 - the render layer animates the telegraph from this. */
  windup: number;
  /** Gap between the fighters, torso units, for the HUD's range readout. */
  range: number;
  /** Set once the fight has a result, else null. A caller (career mode) that
   *  wants to react to the outcome watches this rather than re-deriving it
   *  from `log`'s free text. */
  result: FightResult | null;
  /**
   * The referee's count, and who is taking it. Null when nobody is down.
   *
   * A snapshot of `conditionRef`, which the render layer reads every frame -
   * the HUD only needs it ten times a second, and a count that ticks once per
   * second does not need more than that.
   */
  count: { who: "player" | "opponent"; at: number } | null;
}

const PLAYER = "player";
const OPPONENT = "opponent";

/** How high the referee's count runs before the sim stands the fighter back
 *  up. Eight rather than ten because the sim's knockdown window is what ends
 *  it, and a count that reached ten and then kept going would be a lie. */
const REFEREE_COUNT_TO = 8;

/** What the CPU would have said, when the CPU is not playing. Frozen and shared:
 *  it is read every frame of a networked fight and never changes. */
const NO_INTENT = Object.freeze({}) as ReturnType<CpuOpponent["update"]>;
const NO_STANCE = Object.freeze({
  lateral: 0,
  depth: 0,
  crouch: 0,
  lean: 0,
}) as CpuOpponent["stance"];

/**
 * Who is running the simulation.
 *
 * "cpu" is the CPU opponent and the only mode that existed. "host" is a
 * networked fight where this end owns the rules; "guest" is the other end of
 * that fight, which owns none of them and renders what it is told.
 *
 * The split exists because two ends cannot both be right. Evasion is measured
 * from each player's own camera and neither end can see the other's body, so
 * two independent simulations would disagree about which punches missed within
 * a few seconds. One authority, stated out loud, beats two that quietly drift.
 */
export type FightMode = "cpu" | "host" | "guest";

export interface UseFightOptions {
  enabled: boolean;
  rules: FightRules;
  difficulty?: Difficulty;
  playerClass?: WeightClass;
  opponentClass?: WeightClass;
  /**
   * Subscribes to resolved player strikes.
   *
   * Deliberately not the render queue. That queue is drained by whoever reads
   * it, and the renderer already drains it to play hits on the target; a second
   * drainer here would race with it and each would see about half the punches.
   * One measurement, two independent subscribers.
   */
  subscribe: (cb: (strike: StrikeEvent) => void) => () => void;
  /** Called for each CPU strike so the render layer can play it on the player's
   *  figure. Kept as a callback rather than returned state for the same
   *  re-render reason as above. */
  onOpponentStrike?: (strike: StrikeEvent) => void;
  /**
   * The player's live whole-body channels, if tracking is running.
   *
   * Read for one thing: the depth channel, which is half of the gap between
   * the fighters. The other half is the CPU's own `stance.depth`. Passing the
   * whole BodyMotion rather than a bare number keeps the fight loop honest
   * about where the value comes from - it is a camera measurement, and when
   * `tracked` is false it is not a measurement at all and the range falls back
   * to the neutral gap rather than reading a stale one.
   *
   * A ref, not a value, for the same reason everything else here is: this is
   * read 60 times a second inside a rAF and must not re-run the effect.
   */
  bodyRef?: React.RefObject<BodyMotion | null>;
  audio?: boolean;
  /** Default "cpu" - the CPU opponent, and the only mode there was. */
  mode?: FightMode;
  /**
   * Punches thrown by the remote fighter, drained by the host's fight loop.
   *
   * A queue rather than a subscription, because these arrive on the network's
   * clock and the fight has to consume them on its own - the same arrangement
   * the local player's strikes already use via `inbox`.
   */
  remoteStrikeRef?: React.RefObject<StrikeEvent[]>;
  /** Host only: hands the authoritative state out for the link to send. */
  publishState?: (s: NetFightState) => void;
  /** Guest only: the host's latest state, which is the fight as far as this
   *  end is concerned. */
  remoteStateRef?: React.RefObject<NetFightState | null>;
}

export function useFight(options: UseFightOptions) {
  const {
    enabled,
    rules,
    difficulty = "contender",
    playerClass = "middleweight",
    opponentClass = "middleweight",
    subscribe,
    onOpponentStrike,
    bodyRef,
    audio = true,
    mode = "cpu",
    remoteStrikeRef,
    publishState,
    remoteStateRef,
  } = options;

  const simRef = useRef<FightSim | null>(null);
  const cpuRef = useRef<CpuOpponent | null>(null);
  const audioRef = useRef<ImpactAudio | null>(null);
  const logRef = useRef<string[]>([]);
  const resultRef = useRef<FightResult | null>(null);
  const [hud, setHud] = useState<FightHudState | null>(null);

  const strikeCb = useRef(onOpponentStrike);
  strikeCb.current = onOpponentStrike;

  /**
   * The opponent's body, republished every tick for the renderer.
   *
   * A ref holding a mutated object rather than a fresh one per frame: this is
   * written 60 times a second, and allocating a new object each time would
   * hand the collector 3600 short-lived objects a minute for a value that is
   * read once and discarded. The renderer never keeps it past the frame.
   */
  const opponentRef = useRef<OpponentVisualState>({
    stance: { lateral: 0, depth: 0, crouch: 0, lean: 0 },
    guard: "high",
    evasion: "none",
    windup: 0,
    down: 0,
    hurt: 0,
  });
  /** Punches thrown by the opponent, for the renderer to animate and to mark
   *  the player with. Drained there, exactly like the player's own queue. */
  const opponentStrikeQueueRef = useRef<StrikeEvent[]>([]);

  /**
   * Fight events, republished for the render layer to drain.
   *
   * The same events React already gets as `hud.log`, handed over as structured
   * values rather than as the feed's free text. The renderer needs them to
   * direct the camera and to put a knocked-down fighter on the canvas, and
   * re-deriving "someone went down" by string-matching a log line is the kind
   * of coupling that breaks the moment the wording changes.
   *
   * A drained queue, like both strike queues, for the same reason: these
   * arrive on the fight's own 60 Hz clock and routing them through React would
   * re-render the tree to move a camera the render loop is already inside.
   *
   * Deliberately not a camera instruction. The simulation says what happened;
   * choosing a shot for it is the director's job and lives in the render layer.
   */
  const fightEventQueueRef = useRef<FightEvent[]>([]);

  /**
   * The live phase, readable every frame without a re-render.
   *
   * The director needs this on the frame it changes - "is a round live right
   * now" is what decides whether a discretionary cut is allowed - and the HUD
   * snapshot only lands ten times a second.
   */
  const phaseRef = useRef<FightPhase>("idle");

  /**
   * Per-fighter body state the render layer needs, refreshed every tick.
   *
   * Same mutated-object discipline as `opponentRef`: written 60 times a second
   * and read once per frame. `down` and `hurt` exist because a knockdown and a
   * stun were until now entirely invisible - the sim knew a fighter was on the
   * canvas and the figure carried on boxing.
   */
  const conditionRef = useRef<FightCondition>({
    player: { down: 0, hurt: 0, count: 0 },
    opponent: { down: 0, hurt: 0, count: 0 },
  });

  /** Browsers suspend audio until a user gesture - call this from a click. */
  const enableAudio = useCallback(async () => {
    await audioRef.current?.resume();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setHud(null);
      return;
    }

    // The guest does not simulate. It applies the host's snapshots, which is
    // the whole content of "one authority" - see FightMode. Its own punches
    // still leave over the link; they are resolved on the other end.
    if (mode === "guest") {
      let raf = 0;
      const tick = () => {
        const s = remoteStateRef?.current;
        if (s) {
          phaseRef.current = s.phase;
          // [host, guest] on the wire. This end is the guest, so the second
          // slot is the local player and the first is the opponent - the one
          // place in the code where the two names swap, and it is written out
          // rather than inferred.
          const me = conditionRef.current.player;
          const them = conditionRef.current.opponent;
          me.down = s.down[1];
          me.hurt = s.hurt[1];
          them.down = s.down[0];
          them.hurt = s.hurt[0];
          me.count = s.countOn === "guest" ? s.count : 0;
          them.count = s.countOn === "host" ? s.count : 0;
          opponentRef.current.down = them.down;
          opponentRef.current.hurt = them.hurt;
          setHud({
            round: s.round,
            clock: s.clock,
            phase: s.phase,
            player: { health: s.health[1], stamina: s.stamina[1], landed: 0 },
            opponent: { health: s.health[0], stamina: s.stamina[0], landed: 0 },
            cards: {},
            log: [],
            windup: 0,
            range: FIGHT_GEOMETRY.neutralRange,
            result: null,
            count: s.count
              ? { who: s.countOn === "guest" ? "player" : "opponent", at: s.count }
              : null,
          });
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }

    const sim = new FightSim(
      rules,
      { id: PLAYER, weightClass: playerClass },
      { id: OPPONENT, weightClass: opponentClass }
    );
    // Seeded from the ruleset rather than from Date.now(), so a fight is
    // reproducible given the same setup. Same reasoning as the CPU's own
    // determinism: rollback netcode replays frames and needs identical results.
    const ai = new CpuOpponent(difficulty, rules.rounds * 7919 + rules.roundSeconds);
    simRef.current = sim;
    cpuRef.current = ai;
    logRef.current = [];
    resultRef.current = null;
    fightEventQueueRef.current = [];
    phaseRef.current = "idle";
    // Per-fighter down/count timers. Held here rather than on FighterState
    // because they are presentation timing - how long the figure lies on the
    // canvas and what the count reads - not a rule. The rule is the sim's own
    // `stunned`, and these are derived from it.
    const downAt: Record<string, number> = {};

    if (audio) audioRef.current = createImpactAudio({ master: 0.8 });

    const unsub = sim.on((e: FightEvent) => {
      logRef.current.unshift(describe(e));
      if (logRef.current.length > 12) logRef.current.pop();
      // Republished for the render layer. Bounded for the same reason the
      // opponent's strike queue is: with no 3D view mounted nothing drains it.
      fightEventQueueRef.current.push(e);
      if (fightEventQueueRef.current.length > 32) {
        fightEventQueueRef.current.splice(0, fightEventQueueRef.current.length - 32);
      }
      if (e.type === "knockdown") downAt[e.target] = performance.now();
      if (e.type === "knockdown") audioRef.current?.bell(1);
      if (e.type === "roundEnd") audioRef.current?.bell(1);
      if (e.type === "stoppage") {
        resultRef.current = {
          kind: e.winner === PLAYER ? "win" : "loss",
          reason: e.reason,
        };
      }
      if (e.type === "decision") {
        resultRef.current = {
          kind: e.winner === null ? "draw" : e.winner === PLAYER ? "win" : "loss",
          reason: "decision",
        };
      }
    });

    sim.start();
    audioRef.current?.bell(2);

    // Player strikes arrive by subscription, at pose rate, and are buffered
    // here for the fight loop to consume on its own clock. Applying them
    // straight from the callback would work, but it would mean simulation
    // state advancing at a different cadence from the CPU's, and a punch landing
    // "between" two CPU ticks.
    const inbox: StrikeEvent[] = [];
    let throwingUntil = 0;
    /**
     * Which side of the CPU the player's last punch arrived on, in the CPU's own
     * frame.
     *
     * Honest about what it is: this is the side of the punch that just
     * Resolved, not one currently in the air. Perception reports a strike at
     * the moment it lands, so there is no earlier signal to read - the CPU is
     * therefore defending the side you have been going to rather than the one
     * you are going to now. That happens to be exactly what a boxer does with
     * a pattern, so it is a reasonable behaviour rather than a fudge, but it
     * is not a live read and should not be described as one.
     */
    let lastSide: "left" | "right" | null = null;
    const unsubscribeStrikes = subscribe((s) => {
      inbox.push(s);
      // `lane` is the puncher's right/left; the CPU's own frame is mirrored.
      lastSide =
        s.zone.lane === "right" ? "left" : s.zone.lane === "left" ? "right" : null;
      // The CPU's defensive read needs to know the player is currently throwing.
      // A strike is an instant, so it is held briefly as a window.
      throwingUntil = performance.now() + 220;
    });

    let raf = 0;
    let last = performance.now();
    let sinceHud = 0;

    const tick = () => {
      const now = performance.now();
      // Clamped: a backgrounded tab returns one enormous dt, which would
      // otherwise advance the round clock by thirty seconds in a single frame.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      // --- Player strikes ------------------------------------------------
      for (const strike of inbox) {
        // Read the guard before applying, or a hit that drops the opponent's
        // guard would be reported as having got through a guard that was up
        // when it was thrown.
        const guard = sim.fighters[OPPONENT].guard;
        const blocked =
          guard !== "none" &&
          ((guard === "high" && strike.zone.height === "head") ||
            (guard === "low" && strike.zone.height === "body"));
        sim.applyStrike(PLAYER, strike);
        audioRef.current?.play(strike, { blocked });
        if (!blocked && strike.damage > 0.9) ai.onHurt(0.45);
      }
      inbox.length = 0;

      // --- The remote fighter's punches --------------------------------
      //
      // Applied exactly where the CPU's own strike is applied below, and
      // through the same `sim.applyStrike`, so a networked punch and a CPU
      // punch cannot be worth different amounts. They were resolved on the
      // thrower's machine against their own camera, which is the only place
      // their arm was ever measured.
      const incoming = remoteStrikeRef?.current;
      if (incoming && incoming.length > 0) {
        for (const strike of incoming.splice(0, incoming.length)) {
          const guard = sim.fighters[PLAYER].guard;
          const blocked =
            guard !== "none" &&
            ((guard === "high" && strike.zone.height === "head") ||
              (guard === "low" && strike.zone.height === "body"));
          sim.applyStrike(OPPONENT, strike);
          audioRef.current?.play(strike, { blocked });
          opponentStrikeQueueRef.current.push(strike);
          if (opponentStrikeQueueRef.current.length > 32) {
            opponentStrikeQueueRef.current.splice(
              0,
              opponentStrikeQueueRef.current.length - 32
            );
          }
          strikeCb.current?.(strike);
        }
      }

      // --- CPU --------------------------------------------------------------
      const me = sim.fighters[OPPONENT];
      const you = sim.fighters[PLAYER];
      // The gap. Both fighters close it from their own side, so it is the
      // neutral separation less both depth channels - the player's from the
      // camera, the CPU's from its own footwork. An untracked player is treated
      // as standing at neutral rather than as standing on top of the opponent.
      const body = bodyRef?.current;
      const playerDepth = body?.tracked ? body.depth : 0;

      // The player's own defence. Until this line the evasion rules ran for
      // the CPU only: a player could duck under a right hand, watch their
      // character duck, and still take it flush, because nothing ever told the
      // simulation. `setEvasion` is a no-op when the state has not changed, so
      // this is only charged when the player actually commits to a movement.
      const wantEvasion = body
        ? evasionFromBody(body, sim.fighters[PLAYER].evasion)
        : "none";
      if (wantEvasion !== sim.fighters[PLAYER].evasion) {
        sim.setEvasion(PLAYER, wantEvasion);
      }

      // And their guard. `setGuard` has existed since the sim did and the CPU
      // has always used it; nothing ever called it for the player, so blocking
      // - half of boxing's defence - was unavailable to them.
      const wantGuard = body
        ? guardFromBody(body, sim.fighters[PLAYER].guard)
        : "none";
      if (wantGuard !== sim.fighters[PLAYER].guard) {
        sim.setGuard(PLAYER, wantGuard);
      }
      const range = Math.max(
        0,
        FIGHT_GEOMETRY.neutralRange - playerDepth - ai.stance.depth
      );

      // The CPU runs only when it is the opponent. In a networked fight the
      // other fighter is a person, and a CPU throwing punches alongside them
      // would be a third boxer in the ring that only one end could see.
      const intent = mode === "host" ? NO_INTENT : ai.update(dt, {
        stamina: me.stamina / me.maxStamina,
        opponentHealth: Math.max(0, you.health) / 100,
        opponentStunned: you.stunned > 0,
        opponentThrowing: now < throwingUntil,
        opponentGuard: you.guard,
        range,
        incomingSide: lastSide,
      });
      if (intent.guard) sim.setGuard(OPPONENT, intent.guard);
      if (intent.evasion !== undefined) sim.setEvasion(OPPONENT, intent.evasion);

      // Republish the body. Guard and evasion are read back off the sim rather
      // than off the intent, because the sim has the last word - it refuses
      // both while a fighter is stunned, and an animator driven from the
      // intent would show a guard the rules say is down.
      const shown = opponentRef.current;
      // In a networked fight the opponent's body comes from their own pose, so
      // there is no CPU stance to publish and no telegraph to show. Their guard
      // and evasion are still the sim's, because the sim is still what decides
      // whether a punch got through.
      shown.stance = mode === "host" ? NO_STANCE : ai.stance;
      shown.guard = me.guard;
      shown.evasion = me.evasion;
      shown.windup = mode === "host" ? 0 : ai.windup;
      if (intent.strike) {
        // The CPU produces a landing point and a power; everything else is
        // derived through the same geometry path a real punch takes. That is
        // deliberate - a CPU punch that took a shortcut around regionAt() and
        // damageOf() could be balanced differently from a player's without
        // anyone noticing.
        const region = regionAt(intent.strike.impact);
        // Jitter comes from the CPU's seeded generator, not Math.random. The
        // whole class is deterministic so that rollback netcode can replay a
        // frame and get the same fight back; a Math.random here would have
        // undone that from outside, and the punch arc it decides feeds
        // `damageOf` via the rising-chin bonus, so it is not cosmetic.
        const approach = approachOf(
          intent.strike.jitter * 0.3,
          intent.strike.impact.height > 1 ? 0.4 : -0.2,
          2.4
        );
        const strike: StrikeEvent = {
          hand: intent.strike.hand,
          zone: coarseZone(intent.strike.impact),
          impact: intent.strike.impact,
          region,
          approach,
          damage: damageOf(region, intent.strike.power, approach),
          power: intent.strike.power,
          speed: 4,
          // The CPU wears the same gloves, so its blows land from the same
          // place. Computed rather than left out: a strike whose contact point
          // was missing would be the one case where the opponent's reach
          // silently differed from the player's.
          contactReach:
            STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
          timestamp: now,
        };
        sim.applyStrike(OPPONENT, strike);
        opponentStrikeQueueRef.current.push(strike);
        // Bounded. If nothing is rendering - the tab is hidden, or the 3D view
        // failed to load - this queue has no drainer, and an unbounded one
        // would grow for the length of the fight.
        if (opponentStrikeQueueRef.current.length > 32) {
          opponentStrikeQueueRef.current.splice(
            0,
            opponentStrikeQueueRef.current.length - 32
          );
        }
        const blocked =
          you.guard !== "none" &&
          ((you.guard === "high" && strike.zone.height === "head") ||
            (you.guard === "low" && strike.zone.height === "body"));
        audioRef.current?.play(strike, { blocked });
        strikeCb.current?.(strike);
      }

      sim.tick(dt);

      // --- What the render layer reads every frame -------------------------
      //
      // Published after the tick, so the renderer sees the state the rules
      // just produced rather than the one they started from. The phase is what
      // the camera director keys its "never cut during a live exchange" rule
      // off, and one frame of lag there is one frame of cutting away from a
      // punch that is still in the air.
      phaseRef.current = sim.phase;
      for (const [slot, f] of [
        ["player", you],
        ["opponent", me],
      ] as const) {
        const c = conditionRef.current[slot];
        const since = downAt[f.id] === undefined ? Infinity : (now - downAt[f.id]) / 1000;
        const downing = since < FIGHT_CONFIG.knockdownSeconds;
        c.down = downing ? 1 : 0;
        // The count is a readout of the sim's own knockdown window, not a
        // second rule running beside it. The sim gives a downed fighter
        // `knockdownSeconds` and then stands them up; this turns that timer
        // into the number a spectator would hear. Inventing an independent
        // 1-to-10 count that did not gate anything would be theatre.
        c.count = downing
          ? Math.min(
              REFEREE_COUNT_TO,
              1 + Math.floor((since / FIGHT_CONFIG.knockdownSeconds) * REFEREE_COUNT_TO)
            )
          : 0;
        // Normalised against the knockdown stun, which is the longest one the
        // rules ever apply, so a clean hard shot reads as a fraction of being
        // dropped rather than as the same thing.
        c.hurt = downing
          ? 1
          : Math.min(1, f.stunned / FIGHT_CONFIG.knockdownSeconds);
      }
      // The opponent's figure reads the same two numbers the referee's count
      // does, published here rather than in the CPU block above so it is this
      // tick's value and not the previous one. The figure on screen and the
      // count over it can then never disagree about who is on the canvas.
      shown.down = conditionRef.current.opponent.down;
      shown.hurt = conditionRef.current.opponent.hurt;

      // --- What the other end is told --------------------------------------
      //
      // Sent on the HUD's clock rather than every frame: it is a snapshot of
      // numbers a person reads, and ten a second is already faster than anyone
      // can follow. The fighters themselves are not in here - each end draws
      // the other from their pose stream, which arrives at its own rate.
      if (mode === "host" && publishState && sinceHud + dt >= 0.1) {
        const c = conditionRef.current;
        publishState({
          round: sim.round,
          clock: Math.max(0, sim.clock),
          phase: sim.phase,
          // [host, guest]. The host is the local player on this end.
          health: [Math.max(0, you.health), Math.max(0, me.health)],
          stamina: [you.stamina / you.maxStamina, me.stamina / me.maxStamina],
          down: [c.player.down, c.opponent.down],
          hurt: [c.player.hurt, c.opponent.hurt],
          count: Math.max(c.player.count, c.opponent.count),
          countOn: c.player.count ? "host" : c.opponent.count ? "guest" : null,
        });
      }

      // --- HUD snapshot ----------------------------------------------------
      sinceHud += dt;
      if (sinceHud >= 0.1) {
        sinceHud = 0;
        setHud({
          round: sim.round,
          clock: Math.max(0, sim.clock),
          phase: sim.phase,
          player: {
            health: Math.max(0, you.health),
            stamina: you.stamina / you.maxStamina,
            landed: you.landed,
          },
          opponent: {
            health: Math.max(0, me.health),
            stamina: me.stamina / me.maxStamina,
            landed: me.landed,
          },
          cards: sim.totals(),
          log: [...logRef.current],
          windup: ai.windup,
          range,
          result: resultRef.current,
          count: conditionRef.current.player.count
            ? { who: "player", at: conditionRef.current.player.count }
            : conditionRef.current.opponent.count
              ? { who: "opponent", at: conditionRef.current.opponent.count }
              : null,
        });
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribeStrikes();
      unsub();
      audioRef.current?.dispose();
      audioRef.current = null;
      simRef.current = null;
      cpuRef.current = null;
    };
    // `rules` is a fresh object each render from most callers, so it is spread
    // into primitives - otherwise the whole fight restarts every render.
  }, [
    enabled,
    audio,
    difficulty,
    playerClass,
    opponentClass,
    subscribe,
    // A ref object, so it is stable and listing it never restarts the fight.
    // Listed rather than suppressed because it genuinely is read in here, and
    // a reader that is invisible to the dependency check is how a stale
    // closure gets in later.
    bodyRef,
    rules.rounds,
    rules.roundSeconds,
    rules.damageScale,
    rules.enforceFouls,
    rules.stoppages,
    // A different mode is a different fight: who owns the rules is not
    // something that can change while one is running.
    mode,
    remoteStrikeRef,
    remoteStateRef,
    publishState,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    rules,
  ]);

  return {
    hud,
    enableAudio,
    simRef,
    opponentRef,
    opponentStrikeQueueRef,
    fightEventQueueRef,
    phaseRef,
    conditionRef,
  };
}

function describe(e: FightEvent): string {
  switch (e.type) {
    case "land":
      return `${e.target === PLAYER ? "You are hit" : "Landed"} - ${e.region} (${e.damage.toFixed(1)})`;
    case "block":
      return `Blocked - ${e.region}`;
    case "miss":
      // Named by the move, not by "missed". A player who threw a clean punch
      // and was told only that it missed will assume the tracking dropped it;
      // being told the opponent slipped is the difference between a bug and a
      // fight.
      return e.evasion === "duck"
        ? `Ducked under it`
        : `Slipped - ${e.evasion === "slipLeft" ? "to their left" : "to their right"}`;
    case "foul":
      return `Low blow - point deducted`;
    case "knockdown":
      return `KNOCKDOWN - ${e.target === PLAYER ? "you" : "opponent"} (${e.count})`;
    case "roundEnd":
      return `End of round ${e.round}`;
    case "stoppage":
      return `${e.reason.toUpperCase()} - ${e.winner === PLAYER ? "you win" : "you lose"}`;
    case "decision":
      return e.winner === null
        ? "Draw"
        : `Decision - ${e.winner === PLAYER ? "you win" : "you lose"}`;
  }
}

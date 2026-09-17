import { useCallback, useEffect, useRef, useState } from "react";
import { FightSim, type FightEvent, type FightRules } from "./fightState";
import { AiOpponent, type Difficulty } from "./aiOpponent";
import { createImpactAudio, type ImpactAudio } from "../audio/impactAudio";
import { approachOf, coarseZone, damageOf, regionAt } from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { WeightClass } from "../menu/menuModel";
import type { BodyMotion } from "../perception/bodyMotion";
import type { OpponentVisualState } from "../render/opponentAnimator";
import { FIGHT_GEOMETRY, STRIKE_CONFIG } from "../config/tuning";

// Wires the pieces together: player strikes in, AI strikes back, simulation
// keeps score, audio plays.
// WHY THE LOOP IS A raf, NOT A REACT EFFECT PER TICK
//
// The fight runs at 60 Hz and React state cannot. Strikes arrive at pose rate
// (~15 Hz) and the AI is stepped every frame; routing either through a state
// setter would re-render the tree mid-combination, which is the exact mistake
// BoxerModel already avoids by draining its strike queue inside the render
// loop rather than passing hits as props.
//
// So the simulation lives in a ref and runs on its own clock, and React is
// given a SNAPSHOT a few times a second — fast enough that a health bar looks
// live, slow enough that it costs nothing.

export interface FightHudState {
  round: number;
  clock: number;
  phase: string;
  player: { health: number; stamina: number; landed: number };
  opponent: { health: number; stamina: number; landed: number };
  cards: Record<string, number>;
  /** The most recent few events, newest first, for a feed. */
  log: string[];
  /** AI wind-up, 0-1 — the render layer animates the telegraph from this. */
  windup: number;
  /** Gap between the fighters, torso units, for the HUD's range readout. */
  range: number;
}

const PLAYER = "player";
const OPPONENT = "opponent";

export interface UseFightOptions {
  enabled: boolean;
  rules: FightRules;
  difficulty?: Difficulty;
  playerClass?: WeightClass;
  opponentClass?: WeightClass;
  /**
   * Subscribes to resolved player strikes.
   *
   * Deliberately NOT the render queue. That queue is drained by whoever reads
   * it, and the renderer already drains it to play hits on the target; a second
   * drainer here would race with it and each would see about half the punches.
   * One measurement, two independent subscribers.
   */
  subscribe: (cb: (strike: StrikeEvent) => void) => () => void;
  /** Called for each AI strike so the render layer can play it on the player's
   *  figure. Kept as a callback rather than returned state for the same
   *  re-render reason as above. */
  onOpponentStrike?: (strike: StrikeEvent) => void;
  /**
   * The player's live whole-body channels, if tracking is running.
   *
   * Read for ONE thing: the depth channel, which is half of the gap between
   * the fighters. The other half is the AI's own `stance.depth`. Passing the
   * whole BodyMotion rather than a bare number keeps the fight loop honest
   * about where the value comes from — it is a camera measurement, and when
   * `tracked` is false it is not a measurement at all and the range falls back
   * to the neutral gap rather than reading a stale one.
   *
   * A ref, not a value, for the same reason everything else here is: this is
   * read 60 times a second inside a rAF and must not re-run the effect.
   */
  bodyRef?: React.RefObject<BodyMotion | null>;
  audio?: boolean;
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
  } = options;

  const simRef = useRef<FightSim | null>(null);
  const aiRef = useRef<AiOpponent | null>(null);
  const audioRef = useRef<ImpactAudio | null>(null);
  const logRef = useRef<string[]>([]);
  const [hud, setHud] = useState<FightHudState | null>(null);

  const strikeCb = useRef(onOpponentStrike);
  strikeCb.current = onOpponentStrike;

  /**
   * The opponent's body, republished every tick for the renderer.
   *
   * A ref holding a MUTATED object rather than a fresh one per frame: this is
   * written 60 times a second, and allocating a new object each time would
   * hand the collector 3600 short-lived objects a minute for a value that is
   * read once and discarded. The renderer never keeps it past the frame.
   */
  const opponentRef = useRef<OpponentVisualState>({
    stance: { lateral: 0, depth: 0, crouch: 0, lean: 0 },
    guard: "high",
    evasion: "none",
    windup: 0,
  });
  /** Punches thrown BY the opponent, for the renderer to animate and to mark
   *  the player with. Drained there, exactly like the player's own queue. */
  const opponentStrikeQueueRef = useRef<StrikeEvent[]>([]);

  /** Browsers suspend audio until a user gesture — call this from a click. */
  const enableAudio = useCallback(async () => {
    await audioRef.current?.resume();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setHud(null);
      return;
    }

    const sim = new FightSim(
      rules,
      { id: PLAYER, weightClass: playerClass },
      { id: OPPONENT, weightClass: opponentClass }
    );
    // Seeded from the ruleset rather than from Date.now(), so a fight is
    // reproducible given the same setup. Same reasoning as the AI's own
    // determinism: rollback netcode replays frames and needs identical results.
    const ai = new AiOpponent(difficulty, rules.rounds * 7919 + rules.roundSeconds);
    simRef.current = sim;
    aiRef.current = ai;
    logRef.current = [];

    if (audio) audioRef.current = createImpactAudio({ master: 0.8 });

    const unsub = sim.on((e: FightEvent) => {
      logRef.current.unshift(describe(e));
      if (logRef.current.length > 12) logRef.current.pop();
      if (e.type === "knockdown") audioRef.current?.bell(1);
      if (e.type === "roundEnd") audioRef.current?.bell(1);
    });

    sim.start();
    audioRef.current?.bell(2);

    // Player strikes arrive by subscription, at pose rate, and are buffered
    // here for the fight loop to consume on its own clock. Applying them
    // straight from the callback would work, but it would mean simulation
    // state advancing at a different cadence from the AI's, and a punch landing
    // "between" two AI ticks.
    const inbox: StrikeEvent[] = [];
    let throwingUntil = 0;
    /**
     * Which side of the AI the player's last punch arrived on, in the AI's own
     * frame.
     *
     * Honest about what it is: this is the side of the punch that just
     * RESOLVED, not one currently in the air. Perception reports a strike at
     * the moment it lands, so there is no earlier signal to read — the AI is
     * therefore defending the side you have been going to rather than the one
     * you are going to now. That happens to be exactly what a boxer does with
     * a pattern, so it is a reasonable behaviour rather than a fudge, but it
     * is not a live read and should not be described as one.
     */
    let lastSide: "left" | "right" | null = null;
    const unsubscribeStrikes = subscribe((s) => {
      inbox.push(s);
      // `lane` is the PUNCHER's right/left; the AI's own frame is mirrored.
      lastSide =
        s.zone.lane === "right" ? "left" : s.zone.lane === "left" ? "right" : null;
      // The AI's defensive read needs to know the player is currently throwing.
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
        // Read the guard BEFORE applying, or a hit that drops the opponent's
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

      // --- AI --------------------------------------------------------------
      const me = sim.fighters[OPPONENT];
      const you = sim.fighters[PLAYER];
      // The gap. Both fighters close it from their own side, so it is the
      // neutral separation less BOTH depth channels — the player's from the
      // camera, the AI's from its own footwork. An untracked player is treated
      // as standing at neutral rather than as standing on top of the opponent.
      const body = bodyRef?.current;
      const playerDepth = body?.tracked ? body.depth : 0;
      const range = Math.max(
        0,
        FIGHT_GEOMETRY.neutralRange - playerDepth - ai.stance.depth
      );

      const intent = ai.update(dt, {
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

      // Republish the body. Guard and evasion are read back off the SIM rather
      // than off the intent, because the sim has the last word — it refuses
      // both while a fighter is stunned, and an animator driven from the
      // intent would show a guard the rules say is down.
      const shown = opponentRef.current;
      shown.stance = ai.stance;
      shown.guard = me.guard;
      shown.evasion = me.evasion;
      shown.windup = ai.windup;
      if (intent.strike) {
        // The AI produces a landing point and a power; everything else is
        // derived through the same geometry path a real punch takes. That is
        // deliberate — an AI punch that took a shortcut around regionAt() and
        // damageOf() could be balanced differently from a player's without
        // anyone noticing.
        const region = regionAt(intent.strike.impact);
        // Jitter comes from the AI's seeded generator, NOT Math.random. The
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
          // The AI wears the same gloves, so its blows land from the same
          // place. Computed rather than left out: a strike whose contact point
          // was missing would be the one case where the opponent's reach
          // silently differed from the player's.
          contactReach:
            STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
          timestamp: now,
        };
        sim.applyStrike(OPPONENT, strike);
        opponentStrikeQueueRef.current.push(strike);
        // Bounded. If nothing is rendering — the tab is hidden, or the 3D view
        // failed to load — this queue has no drainer, and an unbounded one
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
      aiRef.current = null;
    };
    // `rules` is a fresh object each render from most callers, so it is spread
    // into primitives — otherwise the whole fight restarts every render.
  }, [
    enabled,
    audio,
    difficulty,
    playerClass,
    opponentClass,
    subscribe,
    // A ref object, so it is stable and listing it never restarts the fight.
    // Listed rather than suppressed because it genuinely IS read in here, and
    // a reader that is invisible to the dependency check is how a stale
    // closure gets in later.
    bodyRef,
    rules.rounds,
    rules.roundSeconds,
    rules.damageScale,
    rules.enforceFouls,
    rules.stoppages,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    rules,
  ]);

  /** The player's own guard, set by the dodge/posture detector. */
  const setPlayerGuard = useCallback((g: "high" | "low" | "none") => {
    simRef.current?.setGuard(PLAYER, g);
  }, []);

  return {
    hud,
    enableAudio,
    setPlayerGuard,
    simRef,
    opponentRef,
    opponentStrikeQueueRef,
  };
}

function describe(e: FightEvent): string {
  switch (e.type) {
    case "land":
      return `${e.target === PLAYER ? "You are hit" : "Landed"} — ${e.region} (${e.damage.toFixed(1)})`;
    case "block":
      return `Blocked — ${e.region}`;
    case "miss":
      // Named by the move, not by "missed". A player who threw a clean punch
      // and was told only that it missed will assume the tracking dropped it;
      // being told the opponent SLIPPED is the difference between a bug and a
      // fight.
      return e.evasion === "duck"
        ? `Ducked under it`
        : `Slipped — ${e.evasion === "slipLeft" ? "to their left" : "to their right"}`;
    case "foul":
      return `Low blow — point deducted`;
    case "knockdown":
      return `KNOCKDOWN — ${e.target === PLAYER ? "you" : "opponent"} (${e.count})`;
    case "roundEnd":
      return `End of round ${e.round}`;
    case "stoppage":
      return `${e.reason.toUpperCase()} — ${e.winner === PLAYER ? "you win" : "you lose"}`;
    case "decision":
      return e.winner === null
        ? "Draw"
        : `Decision — ${e.winner === PLAYER ? "you win" : "you lose"}`;
  }
}

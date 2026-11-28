import { ImpactClassifier, ImpactLog, impactPower } from "./impactFeedback";
import { GetUpMeter } from "./getUp";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DefenceHistory,
  FightSim,
  evasionFromBody,
  guardCovers,
  guardFromBody,
  type FightEvent,
  type FightPhase,
  type FightRules,
} from "./fightState";
import { CpuOpponent, type Difficulty } from "./cpuOpponent";
import { createImpactAudio, type ImpactAudio } from "../audio/impactAudio";
import { approachOf, coarseZone, damageOf, regionAt } from "../perception/strikeGeometry";
import type { StrikeEvent } from "../perception/strikeResolver";
import type { WeightClass } from "./attributes";
import type { BodyMotion } from "../perception/bodyMotion";
import type { OpponentVisualState } from "../render/opponentAnimator";
import { mirrorEvent, type NetDefence, type NetFightState, type NetMessage } from "../net/protocol";
import type { RemoteEvent } from "../net/usePeerChannel";
import { FIGHT_CONFIG, FIGHT_GEOMETRY, NET_CONFIG, STRIKE_CONFIG } from "../config/tuning";

// Wires the fight together: player strikes in, CPU or remote strikes back,
// the sim keeps score, audio plays. The sim runs on its own rAF and React
// gets a snapshot ten times a second.

/** The player's own outcome. */
export type FightResult = { kind: "win" | "loss" | "draw"; reason: "ko" | "tko" | "decision" };

/** One fighter's visible condition. */
export interface FighterCondition {
  /** 1 while on the canvas. */
  down: number;
  /** 0-1, decays with the sim's stun timer. */
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
  /** Recent events, newest first. */
  log: string[];
  /** CPU wind-up, 0-1. */
  windup: number;
  /** Gap between the fighters, torso units. */
  range: number;
  result: FightResult | null;
  count: { who: "player" | "opponent"; at: number } | null;
  /** Get-up meter fill while the player is down and getting up is on, else null. */
  getUp: number | null;
}

const PLAYER = "player";
const OPPONENT = "opponent";

/** The sim's knockdown window ends the count, so it never claims to reach ten. */
const REFEREE_COUNT_TO = 8;
const QUEUE_CAP = 32;

const NO_INTENT = Object.freeze({}) as ReturnType<CpuOpponent["update"]>;
const NO_STANCE = Object.freeze({ lateral: 0, depth: 0, crouch: 0, lean: 0 }) as CpuOpponent["stance"];

/**
 * "cpu": the CPU opponent. "host": a networked fight this end simulates.
 * "guest": the other end, which shows what the host sends. One authority,
 * because each end measures evasion from its own camera.
 */
export type FightMode = "cpu" | "host" | "guest";

export interface UseFightOptions {
  enabled: boolean;
  rules: FightRules;
  difficulty?: Difficulty;
  playerClass?: WeightClass;
  opponentClass?: WeightClass;
  /** Resolved player strikes. A subscription, not the render queue, so neither drains the other. */
  subscribe: (cb: (strike: StrikeEvent) => void) => () => void;
  onOpponentStrike?: (strike: StrikeEvent) => void;
  /** The player's body channels: depth for the range, guard and evasion for defence. */
  bodyRef?: React.RefObject<BodyMotion | null>;
  audio?: boolean;
  mode?: FightMode;
  /** Host: punches from the remote fighter. */
  remoteStrikeRef?: React.RefObject<StrikeEvent[]>;
  /** Host: the guest's latest guard and head movement. */
  remoteDefenceRef?: React.RefObject<NetDefence | null>;
  /** Guest: the host's latest state. */
  remoteStateRef?: React.RefObject<NetFightState | null>;
  /** Guest: the host's fight events, in order. */
  remoteEventRef?: React.RefObject<RemoteEvent[]>;
  /** Sends to the other end of a networked fight. */
  send?: (msg: NetMessage) => boolean;
  /** Round trip to the other end, ms. Sizes the guest's defence window. */
  rttMs?: number | null;
  /** A new value starts a fresh fight. */
  restartKey?: number;
  /** A downed player can get up early by holding their gloves up. CPU fights only. */
  getUp?: boolean;
  /** Holds both fighters at the neutral gap: slips and ducks only. CPU fights only. */
  locked?: boolean;
}

function pushBounded<T>(q: T[], item: T) {
  q.push(item);
  if (q.length > QUEUE_CAP) q.splice(0, q.length - QUEUE_CAP);
}

/** How long the host waits on the guest's defence before judging its own punch, ms. */
export function defendWindowMs(rttMs: number | null | undefined): number {
  const { defendWindowMinMs: lo, defendWindowMaxMs: hi } = NET_CONFIG;
  return Math.max(lo, Math.min(hi, rttMs ?? hi));
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
    remoteDefenceRef,
    remoteStateRef,
    remoteEventRef,
    send,
    rttMs = null,
    restartKey = 0,
    getUp = false,
    locked = false,
  } = options;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const getUpRef = useRef(getUp);
  getUpRef.current = getUp;
  const rttRef = useRef(rttMs);
  rttRef.current = rttMs;

  const simRef = useRef<FightSim | null>(null);
  const cpuRef = useRef<CpuOpponent | null>(null);
  const audioRef = useRef<ImpactAudio | null>(null);
  const logRef = useRef<string[]>([]);
  /** Punch outcomes from the player's side, for camera kick and words on screen. */
  const impactLogRef = useRef(new ImpactLog());
  const resultRef = useRef<FightResult | null>(null);
  const [hud, setHud] = useState<FightHudState | null>(null);

  const strikeCb = useRef(onOpponentStrike);
  strikeCb.current = onOpponentStrike;

  /** The opponent's body, mutated in place every tick for the renderer. */
  const opponentRef = useRef<OpponentVisualState>({
    stance: { lateral: 0, depth: 0, crouch: 0, lean: 0 },
    guard: "high",
    evasion: "none",
    windup: 0,
    down: 0,
    hurt: 0,
  });
  /** Opponent punches for the renderer to animate; drained there. */
  const opponentStrikeQueueRef = useRef<StrikeEvent[]>([]);
  /** Fight events for the render layer (camera director, knockdowns); drained there. */
  const fightEventQueueRef = useRef<FightEvent[]>([]);
  const phaseRef = useRef<FightPhase>("idle");
  /** Per-fighter condition for the renderer, mutated in place every tick. */
  const conditionRef = useRef<FightCondition>({
    player: { down: 0, hurt: 0, count: 0 },
    opponent: { down: 0, hurt: 0, count: 0 },
  });

  /** Browsers suspend audio until a user gesture: call this from a click. */
  const enableAudio = useCallback(async () => {
    await audioRef.current?.resume();
  }, []);

  useEffect(() => {
    if (!enabled) {
      setHud(null);
      return;
    }

    logRef.current = [];
    resultRef.current = null;
    fightEventQueueRef.current = [];
    phaseRef.current = "idle";
    if (audio) audioRef.current = createImpactAudio({ master: 0.8 });
    const impacts = new ImpactClassifier();
    let blockedTarget: string | null = null;

    /** Everything every mode does with an event: feed, render queue, words, sound, result. */
    const present = (e: FightEvent, strike?: StrikeEvent) => {
      logRef.current.unshift(describe(e));
      if (logRef.current.length > 12) logRef.current.pop();
      pushBounded(fightEventQueueRef.current, e);
      const kind = impacts.kind(e, PLAYER);
      if (kind) impactLogRef.current.push(kind, impactPower(e), performance.now());
      const a = audioRef.current;
      if (a && strike) {
        // A blocked punch emits block then land; it should sound once, muffled.
        if (e.type === "block") {
          a.play(strike, { blocked: true });
          blockedTarget = e.target;
        } else if (e.type === "land") {
          if (blockedTarget !== e.target) a.play(strike);
          blockedTarget = null;
        } else if (e.type === "miss") {
          a.whiff(strike.power);
          blockedTarget = null;
        }
      }
      if (e.type === "knockdown" || e.type === "roundEnd") a?.bell(1);
      if (e.type === "stoppage") {
        resultRef.current = { kind: e.winner === PLAYER ? "win" : "loss", reason: e.reason };
      }
      if (e.type === "decision") {
        resultRef.current = {
          kind: e.winner === null ? "draw" : e.winner === PLAYER ? "win" : "loss",
          reason: "decision",
        };
      }
    };

    const stopAudio = () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    };

    // The guest does not simulate. It shows the host's state and events, and
    // sends back its own defence, measured from its own camera.
    if (mode === "guest") {
      let raf = 0;
      let rang = false;
      let sinceHud = Infinity;
      let last = performance.now();
      let defence: NetDefence = { guard: "high", evasion: "none" };
      let defenceSentAt = -Infinity;
      const tick = () => {
        const now = performance.now();
        sinceHud += (now - last) / 1000;
        last = now;

        const q = remoteEventRef?.current;
        if (q && q.length > 0) {
          for (const { event, strike } of q.splice(0, q.length)) present(mirrorEvent(event, PLAYER, OPPONENT), strike);
        }

        const body = bodyRef?.current;
        const next: NetDefence = {
          guard: body ? guardFromBody(body, defence.guard) : "none",
          evasion: body ? evasionFromBody(body, defence.evasion) : "none",
        };
        const changed = next.guard !== defence.guard || next.evasion !== defence.evasion;
        defence = next;
        if (send && (changed || now - defenceSentAt > NET_CONFIG.defenceHeartbeatMs)) {
          if (send({ kind: "defence", defence })) defenceSentAt = now;
        }

        const s = remoteStateRef?.current;
        if (s) {
          if (!rang && s.phase === "fighting") {
            rang = true;
            audioRef.current?.bell(2);
          }
          phaseRef.current = s.phase;
          // [host, guest] on the wire; this end is the guest.
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
          if (sinceHud >= 0.1) {
            sinceHud = 0;
            setHud({
              round: s.round,
              clock: s.clock,
              phase: s.phase,
              player: { health: s.health[1], stamina: s.stamina[1], landed: s.landed[1] },
              opponent: { health: s.health[0], stamina: s.stamina[0], landed: s.landed[0] },
              cards: {},
              log: [...logRef.current],
              windup: 0,
              range: FIGHT_GEOMETRY.neutralRange,
              result: resultRef.current,
              count: s.count ? { who: s.countOn === "guest" ? "player" : "opponent", at: s.count } : null,
              getUp: null,
            });
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => {
        cancelAnimationFrame(raf);
        stopAudio();
      };
    }

    const sim = new FightSim(rules, { id: PLAYER, weightClass: playerClass }, { id: OPPONENT, weightClass: opponentClass });
    // Seeded from the ruleset, so a fight is reproducible.
    const ai = new CpuOpponent(difficulty, rules.rounds * 7919 + rules.roundSeconds);
    simRef.current = sim;
    cpuRef.current = ai;
    // Presentation timing (how long a figure lies down, what the count reads),
    // derived from the sim's own stun rather than a second rule.
    const downAt: Record<string, number> = {};
    const getUpMeter = new GetUpMeter();
    /** The strike being applied, so its events can carry it. */
    let applying: StrikeEvent | undefined;

    const unsub = sim.on((e: FightEvent) => {
      present(e, applying);
      if (mode === "host") send?.({ kind: "event", event: e, strike: applying });
      if (e.type === "knockdown") {
        downAt[e.target] = performance.now();
        if (e.target === PLAYER) getUpMeter.reset();
      }
    });

    const apply = (by: string, strike: StrikeEvent, defence?: Parameters<FightSim["applyStrike"]>[2]) => {
      applying = strike;
      sim.applyStrike(by, strike, defence);
      applying = undefined;
    };

    sim.start();
    audioRef.current?.bell(2);

    // Buffered so strikes land on the fight's own clock.
    const inbox: StrikeEvent[] = [];
    /** Host: our punches at the guest, held until the guest's defence for them has arrived. */
    const awaitingDefence: StrikeEvent[] = [];
    let throwingUntil = 0;
    /** The side the player's last punch arrived on, in the CPU's frame. The CPU
     *  defends the side you have been going to, as a boxer reads a pattern. */
    let lastSide: "left" | "right" | null = null;
    /** The opponent's recent defence, so each strike is judged as of its throw. */
    const opponentDefence = new DefenceHistory();
    const unsubscribeStrikes = subscribe((s) => {
      inbox.push(s);
      lastSide = s.zone.lane === "right" ? "left" : s.zone.lane === "left" ? "right" : null;
      throwingUntil = performance.now() + 220;
    });

    const landPlayerStrike = (strike: StrikeEvent, defence: Parameters<FightSim["applyStrike"]>[2]) => {
      const d = defence ?? sim.fighters[OPPONENT];
      apply(PLAYER, strike, d);
      if (mode === "cpu" && !guardCovers(d, strike) && strike.damage > 0.9) ai.onHurt(0.45);
    };

    let raf = 0;
    let last = performance.now();
    let sinceHud = 0;

    const tick = () => {
      const now = performance.now();
      // Clamped: a backgrounded tab returns one huge dt.
      const dt = Math.min(0.1, (now - last) / 1000);
      const wallDt = Math.min(1, (now - last) / 1000);
      last = now;

      const me = sim.fighters[OPPONENT];
      const you = sim.fighters[PLAYER];

      // --- The guest's defence (host) ---------------------------------------
      if (mode === "host") {
        const d = remoteDefenceRef?.current;
        if (d) {
          if (d.guard !== me.guard) sim.setGuard(OPPONENT, d.guard);
          if (d.evasion !== me.evasion) sim.setEvasion(OPPONENT, d.evasion);
        }
        opponentDefence.record(now, me);
      }

      // --- Player strikes ---------------------------------------------------
      for (const strike of inbox) {
        if (mode === "host") awaitingDefence.push(strike);
        else landPlayerStrike(strike, opponentDefence.at(strike.timestamp, now) ?? undefined);
      }
      inbox.length = 0;
      if (awaitingDefence.length > 0) {
        const wait = defendWindowMs(rttRef.current);
        while (awaitingDefence.length > 0 && now - awaitingDefence[0].timestamp >= wait) {
          const s = awaitingDefence.shift()!;
          landPlayerStrike(s, opponentDefence.bestAgainst(s, s.timestamp, s.timestamp + wait) ?? undefined);
        }
      }

      // --- The remote fighter's punches (host) ------------------------------
      // Through the same applyStrike as a CPU punch; resolved on the thrower's
      // machine against their own camera.
      const incoming = remoteStrikeRef?.current;
      if (mode === "host" && incoming && incoming.length > 0) {
        for (const strike of incoming.splice(0, incoming.length)) {
          apply(OPPONENT, strike);
          pushBounded(opponentStrikeQueueRef.current, strike);
          strikeCb.current?.(strike);
        }
      }

      // --- The player's body --------------------------------------------------
      const body = bodyRef?.current;
      const isLocked = lockedRef.current && mode === "cpu";
      ai.locked = isLocked;
      // The gap: neutral less both depth channels. Untracked counts as neutral.
      const playerDepth = body?.tracked && !isLocked ? body.depth : 0;
      const wantEvasion = body ? evasionFromBody(body, you.evasion) : "none";
      if (wantEvasion !== you.evasion) sim.setEvasion(PLAYER, wantEvasion);
      const wantGuard = body ? guardFromBody(body, you.guard) : "none";
      if (wantGuard !== you.guard) sim.setGuard(PLAYER, wantGuard);
      const range = Math.max(0, FIGHT_GEOMETRY.neutralRange - playerDepth - ai.stance.depth);

      // --- CPU ----------------------------------------------------------------
      const intent =
        mode === "host"
          ? NO_INTENT
          : ai.update(dt, {
              stamina: me.stamina / me.maxStamina,
              opponentHealth: Math.max(0, you.health) / 100,
              opponentStunned: you.stunned > 0,
              opponentThrowing: now < throwingUntil,
              opponentGuard: you.guard,
              range,
              incomingSide: lastSide,
            });
      if (mode === "cpu") {
        if (intent.guard) sim.setGuard(OPPONENT, intent.guard);
        if (intent.evasion !== undefined) sim.setEvasion(OPPONENT, intent.evasion);
        opponentDefence.record(now, me);
      }

      // Guard and evasion read back off the sim, which refuses both while stunned.
      const shown = opponentRef.current;
      shown.stance = mode === "host" ? NO_STANCE : ai.stance;
      shown.guard = me.guard;
      shown.evasion = me.evasion;
      shown.windup = mode === "host" ? 0 : ai.windup;
      if (intent.strike) {
        // Derived through the same geometry as a real punch, so the two balance alike.
        const region = regionAt(intent.strike.impact);
        const approach = approachOf(intent.strike.jitter * 0.3, intent.strike.impact.height > 1 ? 0.4 : -0.2, 2.4);
        const strike: StrikeEvent = {
          hand: intent.strike.hand,
          zone: coarseZone(intent.strike.impact),
          impact: intent.strike.impact,
          region,
          approach,
          damage: damageOf(region, intent.strike.power, approach),
          power: intent.strike.power,
          speed: 4,
          contactReach: STRIKE_CONFIG.reachThreshold + STRIKE_CONFIG.gloveNoseReach,
          timestamp: now,
        };
        apply(OPPONENT, strike);
        pushBounded(opponentStrikeQueueRef.current, strike);
        strikeCb.current?.(strike);
      }

      sim.tick(dt);

      // Getting up early, gloves up. Only ever shortens a knockdown.
      let getUpShown: number | null = null;
      const playerDownAt = downAt[PLAYER];
      if (getUpRef.current && mode === "cpu" && playerDownAt !== undefined && sim.phase === "fighting") {
        const sinceDown = (now - playerDownAt) / 1000;
        if (sinceDown < FIGHT_CONFIG.knockdownSeconds) {
          const rose = getUpMeter.update(wallDt, {
            sinceDown,
            tracked: !!body?.tracked,
            guardHeight: body?.guardHeight ?? 0,
          });
          if (rose) {
            sim.rise(PLAYER);
            downAt[PLAYER] = now - FIGHT_CONFIG.knockdownSeconds * 1000 - 1;
            getUpMeter.reset();
          } else {
            getUpShown = getUpMeter.progress;
          }
        }
      }

      // --- What the render layer reads every frame --------------------------
      phaseRef.current = sim.phase;
      for (const [slot, f] of [
        ["player", you],
        ["opponent", me],
      ] as const) {
        const c = conditionRef.current[slot];
        const since = downAt[f.id] === undefined ? Infinity : (now - downAt[f.id]) / 1000;
        const downing = since < FIGHT_CONFIG.knockdownSeconds;
        c.down = downing ? 1 : 0;
        // The count reads out the sim's own knockdown window.
        c.count = downing
          ? Math.min(REFEREE_COUNT_TO, 1 + Math.floor((since / FIGHT_CONFIG.knockdownSeconds) * REFEREE_COUNT_TO))
          : 0;
        c.hurt = downing ? 1 : Math.min(1, f.stunned / FIGHT_CONFIG.knockdownSeconds);
      }
      shown.down = conditionRef.current.opponent.down;
      shown.hurt = conditionRef.current.opponent.hurt;

      sinceHud += dt;
      if (sinceHud >= 0.1) {
        sinceHud = 0;
        const c = conditionRef.current;
        if (mode === "host") {
          send?.({
            kind: "state",
            state: {
              round: sim.round,
              clock: Math.max(0, sim.clock),
              phase: sim.phase,
              health: [Math.max(0, you.health), Math.max(0, me.health)],
              stamina: [you.stamina / you.maxStamina, me.stamina / me.maxStamina],
              down: [c.player.down, c.opponent.down],
              hurt: [c.player.hurt, c.opponent.hurt],
              landed: [you.landed, me.landed],
              count: Math.max(c.player.count, c.opponent.count),
              countOn: c.player.count ? "host" : c.opponent.count ? "guest" : null,
            },
          });
        }
        setHud({
          round: sim.round,
          clock: Math.max(0, sim.clock),
          phase: sim.phase,
          player: { health: Math.max(0, you.health), stamina: you.stamina / you.maxStamina, landed: you.landed },
          opponent: { health: Math.max(0, me.health), stamina: me.stamina / me.maxStamina, landed: me.landed },
          cards: sim.totals(),
          log: [...logRef.current],
          windup: ai.windup,
          range,
          result: resultRef.current,
          count: c.player.count
            ? { who: "player", at: c.player.count }
            : c.opponent.count
              ? { who: "opponent", at: c.opponent.count }
              : null,
          getUp: getUpShown,
        });
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      unsubscribeStrikes();
      unsub();
      stopAudio();
      simRef.current = null;
      cpuRef.current = null;
    };
    // `rules` is spread into primitives: callers pass a fresh object each render.
  }, [
    enabled,
    audio,
    difficulty,
    playerClass,
    opponentClass,
    subscribe,
    bodyRef,
    rules.rounds,
    rules.roundSeconds,
    rules.damageScale,
    rules.enforceFouls,
    rules.stoppages,
    mode,
    remoteStrikeRef,
    remoteDefenceRef,
    remoteStateRef,
    remoteEventRef,
    send,
    restartKey,
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
    impactLogRef,
  };
}

function describe(e: FightEvent): string {
  switch (e.type) {
    case "land":
      return `${e.target === PLAYER ? "You are hit" : "Landed"} - ${e.region} (${e.damage.toFixed(1)})`;
    case "block":
      return `Blocked - ${e.region}`;
    case "miss":
      // Named by the move, so a slipped punch never reads as dropped tracking.
      return e.evasion === "duck" ? "Ducked under it" : `Slipped - ${e.evasion === "slipLeft" ? "to their left" : "to their right"}`;
    case "foul":
      return "Low blow - point deducted";
    case "knockdown":
      return `KNOCKDOWN - ${e.target === PLAYER ? "you" : "opponent"} (${e.count})`;
    case "roundEnd":
      return `End of round ${e.round}`;
    case "stoppage":
      return `${e.reason.toUpperCase()} - ${e.winner === PLAYER ? "you win" : "you lose"}`;
    case "decision":
      return e.winner === null ? "Draw" : `Decision - ${e.winner === PLAYER ? "you win" : "you lose"}`;
  }
}

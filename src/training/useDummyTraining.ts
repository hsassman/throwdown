import { useCallback, useEffect, useRef, useState } from "react";
import type { StrikeEvent } from "../perception/strikeResolver";
import { regionAt } from "../perception/strikeGeometry";
import { Drill, type DrillOutcome, type DrillStats } from "./drill";
import type { ZoneTier } from "./hitZones";
import { recordOutcome, recordRound, type TrainingProfile } from "./profile";
import { loadProfile, saveProfile } from "./profileStore";
import {
  adaptivePick,
  calibrationFrom,
  coachingNotes,
  estimateBias,
  type BiasEstimate,
  type Calibration,
  type CoachingNote,
} from "./adaptation";
import type { LitTarget } from "./drill";

// Wires the dummy drill to the live strike stream, and to the persistent
// profile that makes it improve with use.
// One strike path, not two
//
// This subscribes to the same resolver the renderer and the fight simulation
// read (`useStrikeTraining().subscribe`). It does not run a second resolver of
// its own. Two resolvers reading the same pose would drift apart the moment
// either was reset, and the player would see a punch land on the dummy that
// the scoreboard never counted.
// Where the calibration is applied, and why it is re-resolved
//
// The adaptation loop's correction shifts the landing point. That means the
// Anatomical region has to be recomputed from the shifted point - a correction
// that moved an impact from the jaw to the temple while still reporting "jaw"
// would make the damage number disagree with the position it was derived from.
// `applyCalibration` below does both together for exactly that reason.
//
// The correction is applied here, at scoring time, and not inside
// `strikeResolver.ts`. That keeps the resolver a pure measurement, and it
// means the fight simulation is unaffected by anything learned in training.
// Extending it to the fight is a deliberate decision that has not been taken.

/** How often the profile is written to disk, in scored punches. */
const SAVE_EVERY = 8;
/** How often the derived read-outs are pushed into React state, ms. */
const REPORT_INTERVAL = 250;

export interface DummyTrainingHandle {
  /** The target currently lit, for the renderer and the HUD. */
  litRef: React.RefObject<LitTarget | null>;
  /** Outcomes the renderer has not yet played. Drained by the caller. */
  outcomeQueueRef: React.RefObject<DrillOutcome[]>;
  /** Live round statistics. */
  stats: DrillStats;
  /** Most recent scored outcome, for the pop-up readout. */
  lastOutcome: DrillOutcome | null;
  /** The persistent profile. */
  profile: TrainingProfile;
  /** What the system currently believes about the player's setup and form. */
  notes: CoachingNote[];
  bias: BiasEstimate;
  calibration: Calibration;
  /** Null unless storage is refusing to save. */
  storageError: string | null;
  running: boolean;
  start: () => void;
  stop: () => void;
  /** True once the round's target count is exhausted. */
  finished: boolean;
}

export interface DummyTrainingOptions {
  enabled: boolean;
  subscribe: (cb: (strike: StrikeEvent) => void) => () => void;
  tier?: ZoneTier;
  targets?: number;
  requireHand?: boolean;
  /** Injected in tests. Defaults to performance.now. */
  clock?: () => number;
}

/**
 * Shifts a strike's landing point by the learned correction, and re-resolves
 * everything downstream of it.
 *
 * Exported because it is the one place the adaptation actually changes a
 * measurement, which makes it the one place worth testing directly.
 */
export function applyCalibration(
  strike: StrikeEvent,
  cal: Calibration
): StrikeEvent {
  if (cal.lateral === 0 && cal.height === 0) return strike;
  const impact = {
    lateral: strike.impact.lateral + cal.lateral,
    height: strike.impact.height + cal.height,
  };
  const region = regionAt(impact);
  return {
    ...strike,
    impact,
    region,
    // Damage is region value x power; the region just changed, so the damage
    // must follow it or the two describe different punches.
    damage: region.legal ? region.damage * strike.power : 0,
  };
}

export function useDummyTraining(
  options: DummyTrainingOptions
): DummyTrainingHandle {
  const { enabled, subscribe, tier = "precise", targets, requireHand = false } = options;
  const clock = options.clock ?? (() => performance.now());

  // Loaded once, lazily. Reading localStorage on every render would be a
  // synchronous disk hit inside the render phase.
  const [loaded] = useState(() => loadProfile(Date.now()));
  const profileRef = useRef<TrainingProfile>(loaded.profile);
  const [storageError, setStorageError] = useState<string | null>(loaded.error);

  const litRef = useRef<LitTarget | null>(null);
  const outcomeQueueRef = useRef<DrillOutcome[]>([]);
  const drillRef = useRef<Drill | null>(null);
  const calRef = useRef<Calibration>(calibrationFrom(loaded.profile));
  const sinceSaveRef = useRef(0);
  /**
   * Whether the current drill has already been banked.
   *
   * `stop` is called from several places - the screen changing, the round
   * running out, the mode being disabled - and more than one of them fires on
   * a single navigation. Without this guard each call recorded another round,
   * so one visit to the dummy logged three. A round is a thing that happened
   * once; banking it is idempotent per drill.
   */
  const bankedRef = useRef(true);

  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [stats, setStats] = useState<DrillStats>({
    presented: 0,
    landed: 0,
    accuracy: 0,
    power: 0,
    timing: 0,
    score: 0,
    reactionMs: 0,
    bestStreak: 0,
    streak: 0,
    stray: 0,
  });
  const [lastOutcome, setLastOutcome] = useState<DrillOutcome | null>(null);

  // The profile is mutated in place - it is persisted state, not React state,
  // and copying it on every punch would be pointless churn. That means its
  // identity never changes, so nothing derived from it can be memoised against
  // it. Instead the derived read-outs are recomputed explicitly at the few
  // moments the profile is banked, which is also when they can actually have
  // changed enough to be worth showing.
  const [derived, setDerived] = useState(() => ({
    notes: coachingNotes(loaded.profile),
    bias: estimateBias(loaded.profile),
  }));
  const refreshDerived = useCallback(() => {
    setDerived({
      notes: coachingNotes(profileRef.current),
      bias: estimateBias(profileRef.current),
    });
  }, []);

  // Rebuilt whenever the drill's shape changes. The pick function closes over
  // the profile ref, not a snapshot, so a drill started at the beginning of a
  // session keeps adapting as that session's results come in.
  const makeDrill = useCallback(() => {
    return new Drill({
      tier,
      targets,
      requireHand,
      pick: (zones, previous) => adaptivePick(profileRef.current)(zones, previous),
    });
  }, [tier, targets, requireHand]);

  const fold = useCallback((outcome: DrillOutcome) => {
    const profile = profileRef.current;
    recordOutcome(profile, outcome, Date.now());
    outcomeQueueRef.current.push(outcome);
    if (outcome.kind === "hit") setLastOutcome(outcome);

    sinceSaveRef.current += 1;
    if (sinceSaveRef.current >= SAVE_EVERY) {
      sinceSaveRef.current = 0;
      // Recomputed on save rather than per punch: it is a median over every
      // zone, and at 15 Hz nothing changes fast enough to justify the work.
      calRef.current = calibrationFrom(profile);
      setStorageError(saveProfile(profile));
      refreshDerived();
    }
  }, [refreshDerived]);

  const start = useCallback(() => {
    const drill = makeDrill();
    drillRef.current = drill;
    drill.start(clock());
    bankedRef.current = false;
    outcomeQueueRef.current.length = 0;
    litRef.current = null;
    setFinished(false);
    setRunning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [makeDrill]);

  const stop = useCallback(() => {
    const drill = drillRef.current;
    if (drill && !bankedRef.current) {
      bankedRef.current = true;
      const s = drill.stats;
      // Only a round that actually presented something counts. Starting and
      // immediately stopping must not log a 0% round against the player.
      if (s.presented > 0) {
        recordRound(profileRef.current, s.score, Date.now());
        setStorageError(saveProfile(profileRef.current));
        calRef.current = calibrationFrom(profileRef.current);
        refreshDerived();
      }
      drill.stop();
    }
    litRef.current = null;
    setRunning(false);
  }, [refreshDerived]);

  // Strike intake.
  useEffect(() => {
    if (!enabled || !running) return;
    return subscribe((raw) => {
      const drill = drillRef.current;
      if (!drill) return;
      const strike = applyCalibration(raw, calRef.current);
      const outcome = drill.onStrike(strike, clock());
      if (outcome) fold(outcome);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, running, subscribe, fold]);

  // Clock loop: lights targets and expires them.
  useEffect(() => {
    if (!enabled || !running) return;
    let rafId = 0;
    let lastReport = 0;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      const drill = drillRef.current;
      if (!drill) return;
      const now = clock();
      const expired = drill.update(now);
      if (expired) fold(expired);
      litRef.current = drill.lit;

      // React state is updated on an interval, not per frame. The drill runs
      // at rAF rate and a setState per frame would re-render the HUD sixty
      // times a second to move numbers that change a few times a second.
      if (now - lastReport >= REPORT_INTERVAL) {
        lastReport = now;
        setStats(drill.stats);
        if (drill.finished) setFinished(true);
      }
    };
    tick();
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, running, fold]);

  // Ends the round exactly once when the target count runs out.
  useEffect(() => {
    if (finished && running) stop();
  }, [finished, running, stop]);

  // Leaving training mode must bank the round rather than discard it.
  useEffect(() => {
    if (enabled) return;
    if (drillRef.current && running) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return {
    litRef,
    outcomeQueueRef,
    stats,
    lastOutcome,
    profile: profileRef.current,
    notes: derived.notes,
    bias: derived.bias,
    calibration: calRef.current,
    storageError,
    running,
    finished,
    start,
    stop,
  };
}

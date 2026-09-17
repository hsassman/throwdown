import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PoseFrame } from "../pose/poseTypes";
import { usePunchDetection } from "../perception/usePunchDetection";
import type { PunchEvent, PunchType, Stance } from "../perception/punchTypes";
import {
  PUNCH_TYPES,
  checkBars,
  evaluate,
  formatReport,
  type Trial,
} from "../debug/confusionMatrix";
import { PERCEPTION_CONFIG } from "../config/tuning";
import { PunchGuide, PunchGuideGrid } from "./PunchGuide";
import { DodgeIndicator } from "./DodgeIndicator";
import { DetectionDiagnostics } from "./DetectionDiagnostics";

// Milestone 1 harness: webcam -> landmarks -> classifier -> on-screen label,
// plus a guided protocol that produces a real confusion matrix.
//
// The protocol runs hands-free on a fixed cadence. That is not a style choice:
// the player is standing back from the camera in a boxing stance, so anything
// requiring a click between reps would either not be collectable at all or
// would contaminate the trajectory data with reaching for the keyboard.

type Step = "calibrate" | "free" | "collect" | "results";

/** Which hand the protocol asks for, so lead/rear accuracy can be scored. */
const PROMPT_HAND: Record<PunchType, "lead" | "rear"> = {
  jab: "lead",
  cross: "rear",
  hook: "lead",
  uppercut: "rear",
};

const READY_MS = 1400;
const THROW_MS = 2000;

interface Props {
  poseRef: React.RefObject<PoseFrame | null>;
  enabled: boolean;
}

export function PunchHarness({ poseRef, enabled }: Props) {
  const [step, setStep] = useState<Step>("calibrate");
  const [stance, setStance] = useState<Stance>("orthodox");
  const [repsPerType, setRepsPerType] = useState(20);

  const detection = usePunchDetection(poseRef, enabled);
  const { phase, calibration, calibrationProgress, lastPunch, startCalibration } =
    detection;

  // ---- free play: rolling log of recent punches ----
  const [recent, setRecent] = useState<PunchEvent[]>([]);
  // Depend on the stable `onPunch` callback, not the `detection` object, whose
  // identity changes every render — that re-subscribed on every render, and a
  // punch landing between cleanup and re-subscribe would have been dropped.
  const { onPunch } = detection;
  useEffect(() => {
    return onPunch((e) => {
      setRecent((prev) => [e, ...prev].slice(0, 8));
    });
  }, [onPunch]);

  // ---- guided collection ----
  const [trials, setTrials] = useState<Trial[]>([]);
  const [trialIndex, setTrialIndex] = useState(0);
  const [windowPhase, setWindowPhase] = useState<"ready" | "throw">("ready");

  const schedule = useMemo(() => {
    const out: PunchType[] = [];
    for (const t of PUNCH_TYPES) {
      for (let i = 0; i < repsPerType; i++) out.push(t);
    }
    return out;
  }, [repsPerType]);

  // Captured punch for the trial currently in its throw window.
  //
  // `capturing` gates the subscriber to the throw window specifically. Without
  // it, an early punch thrown during the "get ready" countdown would sit in
  // `captured` and be recorded as the answer to the NEXT prompt — quietly
  // corrupting the confusion matrix rather than failing visibly.
  const captured = useRef<PunchEvent | null>(null);
  const capturing = useRef(false);
  useEffect(() => {
    return onPunch((e) => {
      if (capturing.current && !captured.current) captured.current = e;
    });
  }, [onPunch]);

  const startCollection = useCallback(() => {
    setTrials([]);
    setTrialIndex(0);
    setWindowPhase("ready");
    captured.current = null;
    capturing.current = false;
    setStep("collect");
  }, []);

  useEffect(() => {
    if (step !== "collect") return;
    if (trialIndex >= schedule.length) {
      setStep("results");
      return;
    }

    if (windowPhase === "ready") {
      capturing.current = false;
      captured.current = null;
      const id = setTimeout(() => setWindowPhase("throw"), READY_MS);
      return () => clearTimeout(id);
    }

    // Throw window open: start listening.
    capturing.current = true;
    captured.current = null;

    // Throw window closed — record whatever was (or wasn't) detected.
    const id = setTimeout(() => {
      capturing.current = false;
      const e = captured.current;
      setTrials((prev) => [
        ...prev,
        {
          prompted: schedule[trialIndex],
          detected: e ? e.type : null,
          event: e,
          at: performance.now(),
        },
      ]);
      captured.current = null;
      setTrialIndex((i) => i + 1);
      setWindowPhase("ready");
    }, THROW_MS);
    return () => clearTimeout(id);
  }, [step, windowPhase, trialIndex, schedule]);

  const abortCollection = useCallback(() => {
    setStep(trials.length > 0 ? "results" : "free");
  }, [trials.length]);

  // Escape aborts a run without losing what's been collected so far.
  useEffect(() => {
    if (step !== "collect") return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") abortCollection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, abortCollection]);

  if (!enabled) return null;

  // ---------------- calibration ----------------
  if (step === "calibrate") {
    const pct = Math.min(
      100,
      (calibrationProgress / PERCEPTION_CONFIG.calibrationMinSamples) * 100
    );
    return (
      <div className="harness">
        <h2>Calibration</h2>
        <p className="muted">
          Stand in your boxing stance with hands up in guard, fully in frame
          from hips to head. Hold still while this samples your build.
        </p>

        <div className="row">
          <label>
            Stance:{" "}
            <select
              value={stance}
              onChange={(e) => setStance(e.target.value as Stance)}
            >
              <option value="orthodox">Orthodox (left hand leads)</option>
              <option value="southpaw">Southpaw (right hand leads)</option>
            </select>
          </label>
        </div>
        <p className="muted small">
          Stance is asked rather than detected — inferring it needs shoulder
          depth, and depth is the least reliable axis here.
        </p>

        {phase === "calibrating" && (
          <>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="muted small">
              {calibrationProgress} / {PERCEPTION_CONFIG.calibrationMinSamples} good
              frames
            </p>
            <TrackingChecklist statusRef={detection.landmarkStatus} />
          </>
        )}

        {calibration ? (
          <>
            <p className="ok">
              Calibrated — torso scale {calibration.torsoScale.toFixed(3)}, guard
              extension L {calibration.guardExtension.left.toFixed(2)} / R{" "}
              {calibration.guardExtension.right.toFixed(2)}
            </p>
            <p className="muted small">
              scale reference: {calibration.scaleSource}
              {calibration.scaleSource === "shoulder-width"
                ? " — hips weren't visible, so scale is approximated from shoulder width. Step back so your hips are in frame for a more stance-robust reference."
                : ""}
            </p>
            <div className="row">
              <button onClick={() => setStep("free")}>Free practice</button>
              <button onClick={startCollection}>Start measured run</button>
            </div>
          </>
        ) : (
          <button onClick={() => startCalibration(stance)}>
            {phase === "calibrating" ? "Recalibrate" : "Begin calibration"}
          </button>
        )}
      </div>
    );
  }

  // ---------------- free practice ----------------
  if (step === "free") {
    return (
      <div className="harness">
        <h2>Free practice</h2>
        <p className="muted small">
          Throw punches and check the classifier reacts sensibly before spending
          five minutes on a measured run. Throw each one the way the guide shows
          — the measured run scores what you were asked for against what was
          detected, so matching the intended movement is what keeps the result
          meaningful.
        </p>

        <PunchGuideGrid stance={stance} />

        {/* Milestone 2 lives alongside free practice: dodge/duck is continuous
            state that should be checked while moving naturally, not measured
            in discrete prompted reps the way punches are. */}
        <DetectionDiagnostics
          diagnosticsRef={detection.diagnostics}
          onReset={detection.resetDiagnostics}
        />

        <DodgeIndicator headStateRef={detection.headState} />

        {lastPunch && <PunchGuide type={lastPunch.type} stance={stance} />}

        <div className="punch-readout">
          {lastPunch ? (
            <>
              <div className="punch-label">{lastPunch.type.toUpperCase()}</div>
              <div className="muted">
                {lastPunch.role} hand · confidence{" "}
                {(lastPunch.confidence * 100).toFixed(0)}%
              </div>
            </>
          ) : (
            <div className="muted">no punch detected yet</div>
          )}
        </div>

        {lastPunch && <FeatureTable event={lastPunch} />}

        <div className="log">
          {recent.map((e, i) => (
            <div key={`${e.timestamp}-${i}`} className="log-row">
              <span className="log-type">{e.type}</span>
              <span className="muted">
                {e.hand} · conf {(e.confidence * 100).toFixed(0)}% · in{" "}
                {e.features.inwardTravel.toFixed(2)} up{" "}
                {e.features.upwardTravel.toFixed(2)} curv{" "}
                {e.features.curvature.toFixed(2)} · {e.features.sampleCount}f
              </span>
            </div>
          ))}
        </div>

        <div className="row">
          <button onClick={() => setStep("calibrate")}>Back to calibration</button>
          <button onClick={startCollection}>Start measured run</button>
        </div>
        <label className="muted small">
          reps per punch type:{" "}
          <input
            type="number"
            min={5}
            max={40}
            value={repsPerType}
            // min/max on the element are only hints the browser may ignore.
            // Clamped here too: 4 punch types x an unclamped value is how you
            // end up committed to a two-hour run you can't easily abandon.
            onChange={(e) =>
              setRepsPerType(
                Math.max(5, Math.min(40, Math.round(Number(e.target.value)) || 20))
              )
            }
            className="reps-input"
          />
        </label>
      </div>
    );
  }

  // ---------------- guided collection ----------------
  if (step === "collect") {
    const current = schedule[trialIndex];
    const done = trialIndex;
    const next = schedule[trialIndex + 1];
    return (
      <div className="harness collect">
        <div className="muted">
          {done} / {schedule.length}
        </div>
        <div className="prompt-type">{current?.toUpperCase()}</div>
        <div className="muted">
          {PROMPT_HAND[current] === "lead" ? "lead hand" : "rear hand"}
        </div>

        {current && <PunchGuide type={current} stance={stance} />}

        {/* The player is standing back from the machine and may be looking at
            their own guard rather than the screen, so the cue is announced as
            well as shown. Without this the protocol is unusable to anyone who
            can't read the prompt at distance. */}
        <div className={`prompt ${windowPhase}`} aria-live="assertive">
          {windowPhase === "ready" ? "get ready" : "THROW"}
        </div>

        <div className="muted small">
          Return to guard between reps — the detector re-arms from guard.
        </div>
        {next && next !== current && (
          <div className="muted small next-up">next up: {next}</div>
        )}

        {/* Escape alone stranded touch users mid-run: an 80-trial protocol
            could only be escaped by reloading, losing every trial already
            collected. */}
        <div className="row" style={{ justifyContent: "center" }}>
          <button onClick={abortCollection}>Stop run (or press Esc)</button>
        </div>
      </div>
    );
  }

  // ---------------- results ----------------
  return <Results trials={trials} onRestart={startCollection} onFree={() => setStep("free")} />;
}

/**
 * Shows which required landmarks are actually tracked. Calibration silently
 * collecting zero frames is otherwise indistinguishable from a broken build —
 * in practice the cause is nearly always framing (hands below the frame, or
 * standing too close), which this makes obvious and fixable.
 */
function TrackingChecklist({
  statusRef,
}: {
  statusRef: React.RefObject<Record<string, number> | null>;
}) {
  const [status, setStatus] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    const id = setInterval(() => setStatus(statusRef.current), 250);
    return () => clearInterval(id);
  }, [statusRef]);

  if (!status) return <p className="muted small">waiting for pose…</p>;
  const min = PERCEPTION_CONFIG.minLandmarkConfidence;

  return (
    <table className="features">
      <tbody>
        {Object.entries(status).map(([name, conf]) => {
          const optional = name.includes("optional");
          const good = conf >= min;
          return (
            <tr key={name}>
              <td className={good || optional ? "muted" : "bad"}>
                {good ? "ok" : optional ? "—" : "MISSING"}
              </td>
              <td className="muted">{name}</td>
              <td>{conf.toFixed(2)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FeatureTable({ event }: { event: PunchEvent }) {
  const f = event.features;
  const rows: [string, string][] = [
    ["inward travel", f.inwardTravel.toFixed(3)],
    ["upward travel", f.upwardTravel.toFixed(3)],
    ["extension gain", f.extensionGain.toFixed(3)],
    ["peak extension", f.peakExtension.toFixed(3)],
    ["elbow open", `${f.elbowAngleStart.toFixed(0)}° → ${f.elbowAnglePeak.toFixed(0)}°`],
    ["peak speed", f.peakSpeed.toFixed(2)],
    ["curvature", f.curvature.toFixed(3)],
    ["lowest height", f.lowestHeight.toFixed(3)],
    ["excursion", f.peakExcursion.toFixed(3)],
    ["duration", `${f.durationMs.toFixed(0)} ms`],
    ["samples", String(f.sampleCount)],
  ];
  return (
    <table className="features">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="muted">{k}</td>
            <td>{v}</td>
          </tr>
        ))}
        <tr>
          <td className="muted">scores</td>
          <td>
            {PUNCH_TYPES.map((t) => `${t[0]}:${event.scores[t].toFixed(2)}`).join(" ")}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

type CopyState = "idle" | "ok" | "failed";

/**
 * Copies text and reports whether it worked.
 *
 * `navigator.clipboard` is undefined on insecure origins, which is exactly how
 * LAN play is served (plain http:// to a local IP). The old code optional-
 * chained the call away, so the button silently did nothing — losing the
 * measured numbers that are the entire point of a Milestone 1 run.
 */
async function copyText(text: string, setState: (s: CopyState) => void) {
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    setState("ok");
  } catch {
    setState("failed");
  }
}

function Results({
  trials,
  onRestart,
  onFree,
}: {
  trials: Trial[];
  onRestart: () => void;
  onFree: () => void;
}) {
  const evaluation = useMemo(() => evaluate(trials), [trials]);
  const report = useMemo(() => formatReport(evaluation), [evaluation]);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const bars = checkBars(evaluation);
  const allPass = bars.every((b) => b.pass);

  return (
    <div className="harness">
      <h2>Measured result</h2>
      <div className={allPass ? "verdict ok" : "verdict fail"}>
        {allPass
          ? "Clears every pre-set bar"
          : `Fails ${bars.filter((b) => !b.pass).length} of ${bars.length} pre-set bars`}
      </div>

      <table className="bars">
        <tbody>
          {bars.map((b) => (
            <tr key={b.label}>
              <td>{b.pass ? "PASS" : "FAIL"}</td>
              <td>{b.label}</td>
              <td>{(b.value * 100).toFixed(0)}%</td>
              <td className="muted">bar {(b.bar * 100).toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <pre className="report">{report}</pre>

      <div className="row">
        <button onClick={() => void copyText(report, setCopyState)}>
          Copy report
        </button>
        <button
          onClick={() =>
            void copyText(
              JSON.stringify({ evaluation, trials }, null, 2),
              setCopyState
            )
          }
        >
          Copy raw JSON
        </button>
        <button onClick={onRestart}>Run again</button>
        <button onClick={onFree}>Free practice</button>
      </div>
      <div className="muted small" aria-live="polite">
        {copyState === "ok" && "Copied to clipboard."}
        {copyState === "failed" &&
          "Couldn't reach the clipboard — select the report above and copy manually. " +
            "(Browsers block clipboard access on plain http:// origins, which is how LAN testing is served.)"}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, Suspense, lazy, useCallback } from "react";
import { useWebcam } from "./capture/useWebcam";
import { usePoseTracking } from "./pose/usePoseTracking";
import { PoseOverlay } from "./ui/PoseOverlay";
import { DebugHud } from "./ui/DebugHud";
import { PunchHarness } from "./ui/PunchHarness";
import { PunchGuide } from "./ui/PunchGuide";
import { DodgeIndicator } from "./ui/DodgeIndicator";
import { NEUTRAL_HEAD_STATE, type HeadState } from "./perception/dodgeDetector";
// Type-only: erased at build, so neither pulls three.js into the main bundle.
import type { BodyMotion } from "./perception/bodyMotion";
import type { LoadStatus } from "./render/BoxerModel";
import type { StageId } from "./render/ArenaView";
import { STAGES } from "./menu/shellModel";
import type { TargetDebugState } from "./render/TrainingTarget";
import { useStrikeTraining } from "./perception/useStrikeTraining";
import { useDummyTraining } from "./training/useDummyTraining";
import { TrainingHud } from "./ui/TrainingHud";
import { BodyChannels, TrackingPanel } from "./ui/TrackingPanel";
import { useFight } from "./sim/useFight";
import { FightHud } from "./ui/FightHud";
import { DEFAULT_RULES } from "./menu/menuModel";
import { ITEM_BY_ID } from "./menu/shellModel";
import type { RigDebugState } from "./render/retargeting/rigDriver";
import type { PunchType, Stance } from "./perception/punchTypes";
import "./App.css";

// Lazy-loaded: these pull in three.js and GLTFLoader, which a player who never
// leaves the menu should not have to download. Split out of the main bundle
// for the mobile bandwidth reason recorded in docs/ARCHITECTURE.md.
const BoxerModel = lazy(() =>
  import("./render/BoxerModel").then((m) => ({ default: m.BoxerModel }))
);
const ArenaView = lazy(() =>
  import("./render/ArenaView").then((m) => ({ default: m.ArenaView }))
);
const MenuShell = lazy(() =>
  import("./ui/shell/MenuShell").then((m) => ({ default: m.MenuShell }))
);

/** Where the player is. `null` is the menu. */
type Screen = string | null;

// Root view.
// ONE SCREEN AT A TIME, CHOSEN FROM THE MENU
//
// This replaces the tab strip the app grew during Milestones 0 and 1. That was
// a developer's view of the project — one tab per milestone — and it made
// every mode equally prominent regardless of whether it worked. The menu now
// owns that decision and states plainly what is ready, rough, or not built.
//
// The camera and pose pipeline are owned HERE, above the screen, and stay
// mounted across navigation. Tearing down MediaPipe on every menu press would
// cost a second of re-initialisation each way, and the menu itself is driven
// by the pose stream — so the tracking has to be running before the player can
// choose anything.

export default function App() {
  const [started, setStarted] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [screen, setScreen] = useState<Screen>(null);

  const [boxerStatus, setBoxerStatus] = useState<LoadStatus>("loading");
  const [boxerError, setBoxerError] = useState<string | null>(null);
  const [boxerDebug, setBoxerDebug] = useState<RigDebugState | null>(null);
  const [, setTargetDebug] = useState<TargetDebugState | null>(null);

  const { videoRef, status: camStatus, error: camError, info } = useWebcam(started);
  const {
    poseRef,
    rawPoseRef,
    frameIntervalStats,
    inferenceStats,
    poseFoundRatio,
    samplePredicted,
    pipelineDebugRef,
    trackingReportRef,
    status: poseStatus,
    delegate,
    errorMsg,
    resetStats,
  } = usePoseTracking(videoRef, started && camStatus === "ready");

  const onDummy = screen === "dummy" || screen === "freeplay";
  const inFight = screen === "cpu";

  // Strike resolution. ONE resolver, shared by the dummy drill, the fight
  // simulation and the renderer — see useDummyTraining on why a second one
  // would drift.
  const strike = useStrikeTraining(poseRef, onDummy || inFight);

  const training = useDummyTraining({
    enabled: onDummy,
    subscribe: strike.subscribe,
    // Free work is the same dummy with nothing lit and nothing scored.
    targets: screen === "freeplay" ? 0 : undefined,
  });

  /**
   * The player's live body channels, published BY the renderer and read by the
   * fight loop to work out the gap between the fighters.
   *
   * The one BodyMotionTracker lives in the rig driver. Passing its output
   * around by reference keeps it that way — a second tracker here would have
   * its own neutral, and the two would disagree about where the player is
   * standing, which is precisely the value the range depends on.
   */
  const bodyRef = useRef<BodyMotion | null>(null);

  /** Which venue the Stages screen is showing. */
  const [stage, setStage] = useState<StageId>("octagon");

  const fight = useFight({
    enabled: inFight,
    rules: DEFAULT_RULES,
    difficulty: "contender",
    subscribe: strike.subscribe,
    bodyRef,
  });

  // Scored rounds start when the screen does; free work never scores.
  const { start: startDrill, stop: stopDrill } = training;
  useEffect(() => {
    if (screen === "dummy") startDrill();
    else stopDrill();
  }, [screen, startDrill, stopDrill]);

  const goMenu = useCallback(() => setScreen(null), []);

  // Escape always returns to the menu. A camera-driven UI needs a guaranteed
  // way out that does not depend on the camera working — if tracking fails
  // inside a mode, dwell cannot be used to leave it.
  useEffect(() => {
    if (screen === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        goMenu();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, goMenu]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__shadowboxPose = () =>
      poseRef.current;
  }, [poseRef]);

  if (new URLSearchParams(window.location.search).has("guides")) {
    return <GuideGallery />;
  }

  if (!started) {
    return (
      <div className="gate">
        <h1>Shadow Box</h1>
        <p className="gate-sub">Webcam boxing — everything runs on this machine</p>
        <p className="gate-body">
          Grants camera access and runs pose tracking locally. No video and no
          body data ever leaves the browser.
        </p>
        <button className="gate-btn" onClick={() => setStarted(true)}>
          Enable camera
        </button>
      </div>
    );
  }

  const item = screen === null ? null : ITEM_BY_ID.get(screen);
  const stage3d = onDummy || inFight;
  const inMenu = screen === null;

  // ONE tree, ONE <video>.
  //
  // This used to early-return a separate menu tree with its own <video> in it.
  // React then unmounted one element and mounted another on every navigation,
  // the webcam ref pointed at a fresh element with no stream, and the camera
  // died the moment you entered a mode — live camera, green light, frozen
  // picture, no error. So the camera block below is rendered ONCE, at a stable
  // position in the tree, and only its class changes between screens.
  const camClass = stage3d
    ? "cam-inset"
    : inMenu || screen === "stages"
      ? "cam-hidden"
      : "cam-full";

  return (
    <div
      className={`app ${
        inMenu ? "app-menu" : stage3d ? "app-boxer" : "app-wide"
      }`}
    >
      <div className="stage">
        {inMenu && (
          <Suspense fallback={<div className="shell-boot">Loading…</div>}>
            <MenuShell
              poseRef={poseRef}
              cameraReady={poseStatus === "ready"}
              onLaunch={setScreen}
            />
          </Suspense>
        )}
        {stage3d && (
          <Suspense fallback={null}>
            <BoxerModel
              poseRef={poseRef}
              samplePose={samplePredicted}
              view="behind"
              showTarget={inFight}
              dummy={onDummy}
              litRef={training.litRef}
              outcomeQueueRef={training.outcomeQueueRef}
              strikeQueueRef={strike.strikeQueueRef}
              opponentRef={inFight ? fight.opponentRef : undefined}
              opponentStrikeQueueRef={
                inFight ? fight.opponentStrikeQueueRef : undefined
              }
              bodyOutRef={bodyRef}
              onTargetDebug={setTargetDebug}
              onStatusChange={(s, detail) => {
                setBoxerStatus(s);
                setBoxerError(detail ?? null);
              }}
              onDebug={setBoxerDebug}
            />
          </Suspense>
        )}
        {screen === "stages" && (
          <Suspense fallback={null}>
            <>
              <ArenaView stage={stage} />
              <div className="stage-picker" role="group" aria-label="Venue">
                {STAGES.filter((v) => v.id !== "gym").map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="stage-btn"
                    aria-pressed={stage === v.id}
                    onClick={() => setStage(v.id as StageId)}
                  >
                    <strong>{v.title}</strong>
                    <span>{v.blurb}</span>
                  </button>
                ))}
              </div>
            </>
          </Suspense>
        )}
        {inFight && fight.hud && <FightHud hud={fight.hud} />}

        {/* Never moved, never remounted. See the note above. */}
        <div className={camClass}>
          <video ref={videoRef} className="video" playsInline muted />
          <PoseOverlay
            poseRef={poseRef}
            rawPoseRef={rawPoseRef}
            videoRef={videoRef}
            mirrored
            showRaw={showRaw}
          />
        </div>
      </div>

      {!inMenu && (
        <div className="panel">
          <div className="screen-head">
            <button className="back-btn" onClick={goMenu}>
              ← Menu
            </button>
            <h2 className="screen-title">{item?.title ?? screen}</h2>
          </div>

          {onDummy && (
            <TrainingHud
              training={training}
              scored={screen === "dummy"}
              onRestart={startDrill}
            />
          )}

          {screen === "punchlab" && (
            <PunchHarness poseRef={poseRef} enabled={poseStatus === "ready"} />
          )}

          {stage3d && boxerStatus === "error" && (
            <p className="err">Model failed to load: {boxerError}</p>
          )}
          {stage3d && boxerStatus === "loading" && (
            <p className="muted small">Loading character…</p>
          )}
          {screen === "tracking" && <TrackingPanel reportRef={trackingReportRef} />}

          {/* The new depth / turn / crouch channels, live. Shown where the
              character is, because these are numbers a player can verify with
              their own body in two seconds — and a channel that is silently
              dead otherwise looks identical to one they are not moving
              enough to trigger. */}
          {stage3d && boxerDebug && <BodyChannels body={boxerDebug.body} />}

          <DebugHud
            frameIntervalStats={frameIntervalStats}
            inferenceStats={inferenceStats}
            poseFoundRatio={poseFoundRatio}
            poseStatus={poseStatus}
            delegate={delegate}
            camera={info}
            pipelineDebugRef={pipelineDebugRef}
            onReset={resetStats}
          />

          <label className="toggle">
            <input
              type="checkbox"
              checked={showRaw}
              onChange={(e) => setShowRaw(e.target.checked)}
            />
            show unsmoothed skeleton (orange)
          </label>

          {camStatus === "denied" && (
            <p className="err">
              Camera permission denied. Allow access and reload.
            </p>
          )}
          {camError && camStatus !== "denied" && <p className="err">{camError}</p>}
          {errorMsg && <p className="err">pose: {errorMsg}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Standalone view of the punch trajectory guides, for both stances.
 * Reachable at ?guides=1 — no camera required.
 */
function GuideGallery() {
  const [stance, setStance] = useState<Stance>("orthodox");

  const mockHead = useRef<HeadState>(NEUTRAL_HEAD_STATE);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = performance.now() / 1000;
      mockHead.current = {
        tracked: true,
        lean: Math.sin(t * 1.1),
        duck: (Math.sin(t * 0.7) + 1) / 2,
        raw: { lateral: Math.sin(t * 1.1) * 0.3, headDrop: 0, bodyDrop: 0 },
      };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="harness" style={{ maxWidth: 620, margin: "2rem auto" }}>
      <h2>Dodge indicator (synthetic preview)</h2>
      <DodgeIndicator headStateRef={mockHead} />

      <h2>Punch reference</h2>
      <p className="muted small">
        Diagrams are mirrored to match the webcam preview, so your lead hand
        appears on the same side here as it does on screen.
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
      {(["jab", "cross", "hook", "uppercut"] as PunchType[]).map((t) => (
        <div key={t}>
          <div className="guide-title">{t.toUpperCase()}</div>
          <PunchGuide type={t} stance={stance} />
        </div>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState, useDeferredValue, Suspense, lazy, useCallback } from "react";
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
import { SystemPanel } from "./ui/SystemPanel";
import { useSystemMonitor } from "./diag/useSystemMonitor";
import { useFight } from "./sim/useFight";
import { unlockAudio } from "./audio/sharedContext";
import { useWakeLock } from "./ui/useWakeLock";
import { FightHud } from "./ui/FightHud";
import { ImpactPopups } from "./ui/ImpactPopups";
import { FramingPrompt } from "./ui/FramingPrompt";
import { useFramingCoach } from "./perception/useFramingCoach";
import { useDepthMap } from "./depth/useDepthMap";
import { DepthPanel } from "./ui/DepthPanel";
import { FirstRunCard } from "./ui/FirstRunCard";
import { markFirstRunDone, shouldShowFirstRun } from "./onboarding/firstRun";
import { useFirstRun } from "./onboarding/useFirstRun";
import { DEFAULT_RULES } from "./menu/menuModel";
import { ITEM_BY_ID } from "./menu/shellModel";
import { currentOpponent, recordResult, type FightOutcome } from "./training/career";
import { loadCareerProfile, saveCareerProfile } from "./training/careerStore";
import { CareerPanel } from "./ui/CareerPanel";
import { FighterPanel } from "./ui/FighterPanel";
import { loadFighterAppearance, saveFighterAppearance, type FighterAppearance } from "./menu/fighterAppearance";
import type { PoseFrame } from "./pose/poseTypes";
import { useSession } from "./net/useSession";
import { useOnlineSession } from "./net/useOnlineSession";
import { FindMatchPanel } from "./ui/FindMatchPanel";
import { LeaderboardPanel } from "./ui/LeaderboardPanel";
import type { NetFightState } from "./net/protocol";
import { VersusChip, VersusPanel } from "./ui/VersusPanel";
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
// One screen at a time, chosen from the menu
//
// This replaces the tab strip the app grew during Milestones 0 and 1. That was
// a developer's view of the project - one tab per milestone - and it made
// every mode equally prominent regardless of whether it worked. The menu now
// owns that decision and states plainly what is ready, rough, or not built.
//
// The camera and pose pipeline are owned here, above the screen, and stay
// mounted across navigation. Tearing down MediaPipe on every menu press would
// cost a second of re-initialisation each way, and the menu itself is driven
// by the pose stream - so the tracking has to be running before the player can
// choose anything.

export default function App() {
  const [started, setStarted] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  /**
   * Developer diagnostics: FPS, frame intervals, inference cost, ROI crop.
   *
   * Off by default, and that is a correctness point as much as a cosmetic one.
   * This panel used to render on every screen, which made raw perf telemetry
   * the most visually prominent thing on screen during a fight - the player
   * read a wall of monospace numbers instead of watching the opponent. It is
   * still one keypress away, and the Tracking screen shows it unconditionally
   * because diagnosing the pipeline is that screen's entire job.
   */
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [screen, setScreen] = useState<Screen>(null);
  const [appearance, setAppearance] = useState(loadFighterAppearance);
  const [draftAppearance, setDraftAppearance] = useState<FighterAppearance | null>(null);
  const previewAppearance = useDeferredValue(draftAppearance ?? appearance);
  const previewPoseRef = useRef<PoseFrame | null>(null);

  const [boxerStatus, setBoxerStatus] = useState<LoadStatus>("loading");
  const [boxerError, setBoxerError] = useState<string | null>(null);
  const [boxerDebug, setBoxerDebug] = useState<RigDebugState | null>(null);
  const [, setTargetDebug] = useState<TargetDebugState | null>(null);

  const { videoRef, status: camStatus, error: camError, info } = useWebcam(started);
  // Phones would dim and lock mid-fight: nobody touches the screen.
  useWakeLock(started);
  const {
    poseRef,
    rawPoseRef,
    subscribeStrikePose,
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
  const inCareer = screen === "career";
  const onLan = screen === "lan";
  const onInternet = screen === "internet";
  const inFight = screen === "cpu" || inCareer || onLan || onInternet;

  // The first-run walkthrough, over the menu, once the camera is tracking.
  const [firstRunPending, setFirstRunPending] = useState(() =>
    shouldShowFirstRun(window.location.search, safeStorage())
  );
  const coaching = firstRunPending && screen === null && poseStatus === "ready";

  const [careerProfile, setCareerProfile] = useState(() => loadCareerProfile().profile);
  const [careerOutcome, setCareerOutcome] = useState<FightOutcome | null>(null);
  // Guards against folding the same fight result into the record twice - the
  // HUD snapshot ticks ten times a second and `result` stays set for all of
  // them once the fight ends.
  const careerRecordedRef = useRef(false);
  // Snapshotted once per screen visit, deliberately not recomputed the instant
  // a win advances the rank - useFight restarts the fight whenever its
  // difficulty/opponentClass change, and reacting to a rank bump mid-result
  // would yank the player into the next fight before they see who they beat.
  // Leaving and re-entering the screen is how a next or repeat fight starts,
  // the same rematch flow "Fight the CPU" already uses.
  const careerFightOpponentRef = useRef(currentOpponent(careerProfile));

  // Strike resolution. One resolver, shared by the dummy drill, the fight
  // simulation and the renderer - see useDummyTraining on why a second one
  // would drift.
  // The walkthrough runs it too: its punch step counts what a fight would.
  const strike = useStrikeTraining(subscribeStrikePose, onDummy || inFight || coaching);

  // Monocular depth, off unless asked for (?depth=1, or D in game): a second
  // network on the GPU pose needs. See DEPTH_CONFIG.
  const [depthOn, setDepthOn] = useState(
    () => new URLSearchParams(window.location.search).get("depth") === "1"
  );
  const depth = useDepthMap(
    videoRef,
    poseRef,
    subscribeStrikePose,
    depthOn && camStatus === "ready" && (onDummy || inFight)
  );

  // Tells the player when the camera cannot see them well enough to play -
  // the menu, the dummy and the fight, the screens played with the body.
  const framingIssue = useFramingCoach(
    videoRef,
    poseRef,
    camStatus === "ready" && poseStatus === "ready" && (screen === null || onDummy || inFight)
  );

  const firstRun = useFirstRun(poseRef, framingIssue, strike.subscribe, coaching);
  const { reset: resetStrikes } = strike;
  const finishFirstRun = useCallback(() => {
    markFirstRunDone(safeStorage());
    setFirstRunPending(false);
    // The walkthrough's punches must not replay on the dummy.
    resetStrikes();
  }, [resetStrikes]);
  const launch = useCallback(
    (id: string) => {
      // Choosing a mode is as good as finishing: they found the menu.
      if (firstRunPending) finishFirstRun();
      setScreen(id);
    },
    [firstRunPending, finishFirstRun]
  );

  const training = useDummyTraining({
    enabled: onDummy,
    subscribe: strike.subscribe,
    // Free work is the same dummy with nothing lit and nothing scored.
    targets: screen === "freeplay" ? 0 : undefined,
  });

  /**
   * The player's live body channels, published by the renderer and read by the
   * fight loop to work out the gap between the fighters.
   *
   * The one BodyMotionTracker lives in the rig driver. Passing its output
   * around by reference keeps it that way - a second tracker here would have
   * its own neutral, and the two would disagree about where the player is
   * standing, which is precisely the value the range depends on.
   */
  const bodyRef = useRef<BodyMotion | null>(null);

  /** Which venue the Stages screen is showing. */
  const [stage, setStage] = useState<StageId>("octagon");

  /**
   * The link to another player, when there is one.
   *
   * Nothing connects and no pose leaves the machine until the Same Network
   * screen is open - a network layer that opened itself on mount would be
   * streaming the player's tracked body somewhere before they asked for a
   * fight.
   */
  const session = useSession({
    enabled: onLan,
    poseRef,
    subscribe: strike.subscribe,
  });
  const onlineSession = useOnlineSession({
    enabled: onInternet,
    poseRef,
    subscribe: strike.subscribe,
  });
  const netOpen =
    (onLan && session.status.state === "open") ||
    (onInternet && onlineSession.linkStatus.state === "open");
  const netRole = onLan ? session.role : onInternet ? onlineSession.role : null;
  // Depends on `session.send`, not on `session`.
  //
  // The hook returns a fresh object every render, so `[session]` rebuilt this
  // callback every time - and the fight effect lists it, so the whole
  // simulation was torn down and restarted on every render. The visible
  // symptom was the round clock frozen at 2:59 in all modes, including the
  // CPU fight that has nothing to do with networking. `send` is a useCallback
  // with no dependencies, so it is stable for the life of the session.
  const sendToPeer = onInternet ? onlineSession.send : session.send;
  const publishState = useCallback(
    (state: NetFightState) => sendToPeer({ kind: "state", state }),
    [sendToPeer]
  );

  const fight = useFight({
    // A networked fight does not start until the two ends are actually
    // connected. Starting the clock on a connection that never completes would
    // run a round against nobody.
    enabled: inFight && (!(onLan || onInternet) || netOpen),
    rules: DEFAULT_RULES,
    difficulty: careerFightOpponentRef.current?.difficulty ?? "contender",
    opponentClass: careerFightOpponentRef.current?.weightClass,
    subscribe: strike.subscribe,
    bodyRef,
    mode: netOpen ? (netRole === "host" ? "host" : "guest") : "cpu",
    remoteStrikeRef: onInternet ? onlineSession.remoteStrikeQueueRef : session.remoteStrikeQueueRef,
    remoteStateRef: onInternet ? onlineSession.remoteStateRef : session.remoteStateRef,
    publishState,
  });

  // Re-snapshot the opponent and reset the double-record guard each time the
  // career screen is (re-)entered - not on every profile change, so a fight
  // in progress never has its opponent swapped out from under it.
  useEffect(() => {
    if (inCareer) {
      careerFightOpponentRef.current = currentOpponent(careerProfile);
      careerRecordedRef.current = false;
      setCareerOutcome(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCareer]);

  useEffect(() => {
    if (!inCareer || careerRecordedRef.current || !fight.hud?.result) return;
    careerRecordedRef.current = true;
    const outcome = fight.hud.result.kind;
    setCareerOutcome(outcome);
    setCareerProfile((prev) => {
      const next = { ...prev, record: { ...prev.record } };
      recordResult(next, outcome, Date.now());
      saveCareerProfile(next);
      return next;
    });
  }, [inCareer, fight.hud?.result]);

  // Scored rounds start when the screen does; free work never scores.
  const systemReportRef = useSystemMonitor({
    subscribeStrikes: strike.subscribe,
    trackingReportRef,
    strikeDebugRef: strike.debugRef,
    frameIntervalStats,
    inferenceStats,
    // null while no drill has been started, so the panel reads "not running"
    // rather than a drill that presented zero targets.
    drillStats: training.running ? training.stats : null,
  });

  const { start: startDrill, stop: stopDrill } = training;
  useEffect(() => {
    if (screen === "dummy") startDrill();
    else stopDrill();
  }, [screen, startDrill, stopDrill]);

  const goMenu = useCallback(() => {
    setDraftAppearance(null);
    setScreen(null);
  }, []);

  // Escape always returns to the menu. A camera-driven UI needs a guaranteed
  // way out that does not depend on the camera working - if tracking fails
  // inside a mode, dwell cannot be used to leave it.
  useEffect(() => {
    if (screen === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        goMenu();
      }
      // Backtick, the long-standing console key in games, and F3, the one
      // Minecraft taught a generation. Both, because neither is guessable and
      // the hint in the corner only has room to name one.
      if (e.key === "`" || e.key === "F3") {
        e.preventDefault();
        setShowDiagnostics((v) => !v);
      }
      // D for depth - but not while typing, e.g. a connection code.
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      if ((e.key === "d" || e.key === "D") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setDepthOn((v) => !v);
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
        <div className="gate-content">
          <h1>Shadow Box</h1>
          <p className="gate-body">
            Use your webcam to control your boxer. The game processes your camera
            feed in your browser.
          </p>
          <button
            className="gate-btn"
            onClick={() => {
              // The only real tap before the camera-driven menu takes over, so
              // audio is unlocked here. See audio/sharedContext.ts.
              unlockAudio();
              setStarted(true);
            }}
          >
            Enable camera
          </button>
        </div>
      </div>
    );
  }

  const item = screen === null ? null : ITEM_BY_ID.get(screen);
  const wardrobe = screen === "fighter";
  const stage3d = onDummy || inFight;
  const inMenu = screen === null;

  /**
   * Does the side panel hold anything beyond its own header?
   *
   * With the developer diagnostics hidden by default, a plain CPU fight has
   * Nothing to put in that column - it was a quarter of the screen of empty
   * background sitting beside the one thing the player is actually looking at.
   * When there is nothing to show, the stage takes the whole width and the
   * header floats over it, which is also simply the right way to present a
   * fight.
   */
  const panelExtras =
    wardrobe ||
    onDummy ||
    // The connection panel is the screen until the two ends are connected.
    // Once they are, the codes have done their job and the fight takes the
    // whole width, with a floating chip carrying the link status instead.
    ((onLan || onInternet) && !netOpen) ||
    screen === "punchlab" ||
    screen === "tracking" ||
    inCareer ||
    showDiagnostics ||
    (stage3d && boxerStatus !== "ready") ||
    camStatus === "denied" ||
    !!camError ||
    !!errorMsg;
  const immersive = !inMenu && !panelExtras;
  // Same Network or Online, not yet connected: the panel is the screen, and
  // the stage behind it has nobody to show yet. See .app-connect in App.css.
  const connecting = (onLan || onInternet) && !netOpen;

  /* The header is identical either way; only where it sits changes. Rendering
     it twice would be two things to keep in step, and the back button is the
     one control a mouse-only player cannot do without. */
  const screenHead = (
    <div className={`screen-head${immersive ? " screen-head-float" : ""}`}>
      <button className="back-btn" onClick={goMenu}>
        Main menu
      </button>
      <h2 className="screen-title">{item?.title ?? screen}</h2>
      {/* The two keys that work on every screen. Escape especially: a
          camera-driven UI needs a guaranteed way out that does not depend on
          the camera working, and a player who cannot be seen is exactly the
          player who needs to leave. */}
      <span className="screen-keys" aria-hidden="true">
        <kbd>Esc</kbd> menu
        <kbd>`</kbd> stats
      </span>
    </div>
  );

  // One tree, one <video>.
  //
  // This used to early-return a separate menu tree with its own <video> in it.
  // React then unmounted one element and mounted another on every navigation,
  // the webcam ref pointed at a fresh element with no stream, and the camera
  // died the moment you entered a mode - live camera, green light, frozen
  // picture, no error. So the camera block below is rendered once, at a stable
  // position in the tree, and only its class changes between screens.
  // The walkthrough shows the player themselves: half of it is framing.
  const camClass = stage3d
    ? "cam-inset"
    : coaching
      ? "cam-inset cam-coach"
    : inMenu || screen === "stages" || wardrobe
      ? "cam-hidden"
      : "cam-full";

  return (
    <div
      className={`app ${
        inMenu ? "app-menu" : wardrobe ? "app-boxer app-wardrobe" : stage3d ? "app-boxer" : "app-wide"
      }${immersive ? " app-immersive" : ""}${connecting ? " app-connect" : ""}`}
    >
      <div className="stage">
        {inMenu && (
          <Suspense fallback={<div className="shell-boot">Loading...</div>}>
            <MenuShell
              poseRef={poseRef}
              cameraReady={poseStatus === "ready"}
              cameraProblem={
                camStatus === "denied"
                  ? "permission denied. Allow camera access and reload."
                  : camError
              }
              pointerPaused={coaching && firstRun.step !== "ready"}
              onLaunch={launch}
            />
          </Suspense>
        )}
        {coaching && <FirstRunCard state={firstRun} onDone={finishFirstRun} />}
        {wardrobe && (
          <Suspense fallback={<p className="wardrobe-preview-hint">Loading preview…</p>}>
            <BoxerModel
              wardrobe
              appearance={previewAppearance}
              poseRef={previewPoseRef}
              view="facing"
              onStatusChange={(status, detail) => {
                setBoxerStatus(status);
                setBoxerError(detail ?? null);
              }}
            />
            <p className="wardrobe-preview-hint">Drag to rotate the fighter</p>
          </Suspense>
        )}
        {stage3d && (
          <Suspense fallback={null}>
            <BoxerModel
              poseRef={poseRef}
              appearance={appearance}
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
              // The venue the player chose on the Stages screen, built into
              // the scene the fight is actually in - it used to be built only
              // by that picker, so every fight happened in an empty dark room.
              // Null outside a fight: the dummy is gym work, and the extra
              // geometry is GPU time the pose model wants.
              stage={inFight ? stage : null}
              fightEventQueueRef={
                inFight ? fight.fightEventQueueRef : undefined
              }
              phaseRef={inFight ? fight.phaseRef : undefined}
              conditionRef={inFight ? fight.conditionRef : undefined}
              impactLogRef={inFight ? fight.impactLogRef : undefined}
              remotePoseRef={
                netOpen ? (onInternet ? onlineSession.remotePoseRef : session.remotePoseRef) : undefined
              }
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
                    <img
                      src={v.id === "ring" ? "/art/arena-night.webp" : "/art/cage-preview.webp"}
                      alt=""
                    />
                    <span className="stage-btn-copy">
                      <strong>{v.title}</strong>
                      <span>{v.blurb}</span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          </Suspense>
        )}
        {inFight && fight.hud && <ImpactPopups logRef={fight.impactLogRef} />}
        <FramingPrompt issue={framingIssue} />
        {depth.status.state !== "off" && (
          <DepthPanel status={depth.status} frameRef={depth.frameRef} />
        )}
        {inFight && fight.hud && (
          <FightHud
            hud={fight.hud}
            // No telegraph bar in a networked fight: it reads the CPU's wind-up,
            // and a person does not have one. Showing an empty meter would
            // suggest the opponent never commits to anything.
            showWindup={!netOpen}
          />
        )}
        {netOpen && (
          <VersusChip
            status={onInternet ? onlineSession.linkStatus : session.status}
            role={netRole}
            onLeave={onInternet ? onlineSession.leave : session.leave}
          />
        )}

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

      {immersive && screenHead}

      {!inMenu && panelExtras && (
        <div className="panel">
          {screenHead}
          {wardrobe && (
            <FighterPanel
              appearance={draftAppearance ?? appearance}
              onChange={setDraftAppearance}
              onSave={() => {
                const chosen = draftAppearance ?? appearance;
                setAppearance(chosen);
                return saveFighterAppearance(chosen);
              }}
            />
          )}

          {onLan && (
            <VersusPanel
              status={session.status}
              role={session.role}
              outgoingCode={session.outgoingCode}
              busy={session.busy}
              onHost={session.startHost}
              onJoin={session.join}
              onComplete={session.completeHost}
              onLeave={session.leave}
            />
          )}

          {onInternet && (
            <FindMatchPanel
              matchStatus={onlineSession.matchStatus}
              linkStatus={onlineSession.linkStatus}
              onFindMatch={onlineSession.findMatch}
              onLeave={onlineSession.leave}
            />
          )}

          {(screen === "cpu" || onInternet) && (
            <LeaderboardPanel
              result={fight.hud?.result ?? null}
              landed={fight.hud?.player.landed ?? 0}
            />
          )}

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

          {(stage3d || wardrobe) && boxerStatus === "error" && (
            <p className="err">Model failed to load: {boxerError}</p>
          )}
          {stage3d && boxerStatus === "loading" && (
            <p className="muted small">Loading character...</p>
          )}
          {screen === "tracking" && (
            <>
              <TrackingPanel reportRef={trackingReportRef} />
              <SystemPanel reportRef={systemReportRef} />
            </>
          )}

          {inCareer && (
            <CareerPanel profile={careerProfile} lastOutcome={careerOutcome} />
          )}

          {/* The new depth / turn / crouch channels, live. Shown where the
              character is, because these are numbers a player can verify with
              their own body in two seconds - and a channel that is silently
              dead otherwise looks identical to one they are not moving
              enough to trigger. */}
          {stage3d && boxerDebug && <BodyChannels body={boxerDebug.body} />}

          {(showDiagnostics || screen === "tracking") && (
            <>
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
            </>
          )}

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

/** localStorage, or null where reading it throws (blocked site data). */
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Standalone view of the punch trajectory guides, for both stances.
 * Reachable at ?guides=1 - no camera required.
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

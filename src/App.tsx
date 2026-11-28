import { DEMO_PRESET, isDemoMode } from "./config/demoMode";
import { useEffect, useRef, useState, useDeferredValue, Suspense, lazy, useCallback } from "react";
import { useWebcam } from "./capture/useWebcam";
import { usePoseTracking } from "./pose/usePoseTracking";
import { PoseOverlay } from "./ui/PoseOverlay";
import { DebugHud } from "./ui/DebugHud";
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
import { useHandsUp } from "./sim/useHandsUp";
import { DEFAULT_RULES } from "./sim/fightState";
import { unlockAudio } from "./audio/sharedContext";
import { useWakeLock } from "./ui/useWakeLock";
import { FightHud } from "./ui/FightHud";
import { ImpactPopups } from "./ui/ImpactPopups";
import { FramingPrompt } from "./ui/FramingPrompt";
import { useFramingCoach } from "./perception/useFramingCoach";
import { FirstRunCard } from "./ui/FirstRunCard";
import { markFirstRunDone, shouldShowFirstRun } from "./onboarding/firstRun";
import { useFirstRun } from "./onboarding/useFirstRun";
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
import type { StrikeEvent } from "./perception/strikeResolver";
import { VersusChip, VersusPanel } from "./ui/VersusPanel";
import type { RigDebugState } from "./render/retargeting/rigDriver";
import { BrandMark, UiIcon } from "./ui/BrandMark";
import { useUiPreferences } from "./ui/uiPreferences";
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
  const { preferences, changePreference } = useUiPreferences();
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
  // ?mode=<id> opens a mode directly: shareable links, and tools that skip the menu.
  const [screen, setScreen] = useState<Screen>(() => {
    const id = new URLSearchParams(window.location.search).get("mode");
    return id && ITEM_BY_ID.has(id) ? id : null;
  });
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

  const onDummy = screen === "dummy";
  const inCareer = screen === "career";
  const onLan = screen === "lan";
  const onInternet = screen === "internet";
  const inFight = screen === "cpu" || inCareer || onLan || onInternet;
  // First person is the default view; V switches to the camera behind the fighter.
  const [thirdPerson, setThirdPerson] = useState(false);
  const firstPerson = !thirdPerson;

  // The first-run walkthrough, over the menu, once the camera is tracking.
  const [firstRunPending, setFirstRunPending] = useState(
    () =>
      !(isDemoMode() && DEMO_PRESET.skipFirstRun) &&
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
  const net = onInternet ? onlineSession : session;
  const netOpen =
    (onLan && session.status.state === "open") ||
    (onInternet && onlineSession.linkStatus.state === "open");
  const netRole = onLan ? session.role : onInternet ? onlineSession.role : null;
  const netStatus = onInternet ? onlineSession.linkStatus : session.status;
  // CPU fights restart here; networked ones once both players have asked.
  const [cpuRematchKey, setCpuRematchKey] = useState(0);

  const fight = useFight({
    // A networked fight starts once the two ends are connected.
    enabled: inFight && (!(onLan || onInternet) || netOpen),
    rules: DEFAULT_RULES,
    difficulty: careerFightOpponentRef.current?.difficulty ?? "contender",
    opponentClass: careerFightOpponentRef.current?.weightClass,
    subscribe: strike.subscribe,
    bodyRef,
    mode: netOpen ? (netRole === "host" ? "host" : "guest") : "cpu",
    remoteStrikeRef: net.remoteStrikeQueueRef,
    remoteDefenceRef: net.remoteDefenceRef,
    remoteStateRef: net.remoteStateRef,
    remoteEventRef: net.remoteEventQueueRef,
    // `send` is stable for the life of a session; the hook object is not.
    send: net.send,
    rttMs: netStatus.latency,
    restartKey: netOpen ? net.rematchKey : cpuRematchKey,
    // First person holds both fighters on one line and lets a downed player
    // get up by raising their gloves. CPU fights only.
    getUp: firstPerson,
    locked: firstPerson,
  });

  const fightOver = inFight && !!fight.hud?.result;
  const rematch = useCallback(() => {
    if (netOpen) {
      net.requestRematch();
      return;
    }
    if (inCareer) {
      careerFightOpponentRef.current = currentOpponent(careerProfile);
      careerRecordedRef.current = false;
      setCareerOutcome(null);
    }
    setCpuRematchKey((k) => k + 1);
  }, [netOpen, net, inCareer, careerProfile]);
  useHandsUp(bodyRef, fightOver && !(netOpen && net.rematch.local), rematch);

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
      // V for the camera, but not while typing a connection code.
      const typing = e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]");
      if ((e.key === "v" || e.key === "V") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setThirdPerson((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, goMenu]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__shadowboxPose = () =>
      poseRef.current;
    // The body channels the fight reads (slip, step, crouch, guard).
    (window as unknown as Record<string, unknown>).__shadowboxBody = () =>
      bodyRef.current;
  }, [poseRef]);

  // The last strikes the resolver produced, for tools/ to measure hit
  // registration against the fake player's known punches. Read-only; one
  // more subscriber on the same stream the fight and the dummy read.
  const { subscribe: subscribeStrikes } = strike;
  useEffect(() => {
    const log: StrikeEvent[] = [];
    (window as unknown as Record<string, unknown>).__shadowboxStrikes = () => log.slice();
    return subscribeStrikes((s) => {
      log.push(s);
      if (log.length > 64) log.shift();
    });
  }, [subscribeStrikes]);
  // And the frames the resolver was given, so a run can be replayed through
  // it offline (tools/out, and the recorded fixtures in perception tests).
  useEffect(() => {
    const frames: PoseFrame[] = [];
    (window as unknown as Record<string, unknown>).__shadowboxStrikeFrames = () => frames.slice();
    return subscribeStrikePose((f) => {
      frames.push(f);
      if (frames.length > 600) frames.shift();
    });
  }, [subscribeStrikePose]);

  // Read-only view and pairing for tools/ (two-browser smoke tests).
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__shadowboxDebug = () => ({
      hud: fight.hud,
      netOpen,
      role: netRole,
      code: session.outgoingCode,
      remoteDefence: net.remoteDefenceRef.current,
      rematch: net.rematch,
    });
    w.__shadowboxNet = { host: session.startHost, join: session.join, complete: session.completeHost, rematch };
  });

  if (!started) {
    return (
      <main className="gate">
        <div className="gate-light" aria-hidden="true" />
        <div className="gate-content">
          <h1><BrandMark /></h1>
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
            <UiIcon name="camera" /> Enable camera
          </button>
        </div>
      </main>
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
        <UiIcon name="back" /><span>Main menu</span>
      </button>
      <h2 className="screen-title">{item?.title ?? screen}</h2>
      {/* The two keys that work on every screen. Escape especially: a
          camera-driven UI needs a guaranteed way out that does not depend on
          the camera working, and a player who cannot be seen is exactly the
          player who needs to leave. */}
      {/* Esc only. The backtick still toggles the diagnostics, but it is a
          developer's key, and advertising it cost the title its room: in the
          330px side panel "Dummy Work" and "Your Fighter" wrapped to two
          lines. */}
      <span className="screen-keys" aria-hidden="true">
        <kbd>Esc</kbd> menu
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
              preferences={preferences}
              onPreference={changePreference}
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
              poseIntervalStats={frameIntervalStats}
              poseInferenceStats={inferenceStats}
              appearance={appearance}
              samplePose={samplePredicted}
              view="behind"
              showTarget={inFight}
              fps={firstPerson}
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
                      src={v.id === "ring" ? "/ui/venue.webp" : "/ui/cage.webp"}
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
        {!inMenu && <FramingPrompt issue={framingIssue} />}
        {inFight && fight.hud && (
          <FightHud
            hud={fight.hud}
            rematch={fightOver ? { onRematch: rematch, waiting: netOpen && net.rematch.local, opponentReady: netOpen && net.rematch.remote } : null}
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

          {onDummy && <TrainingHud training={training} scored onRestart={startDrill} />}

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

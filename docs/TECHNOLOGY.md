# Technology

How ShadowBox turns a webcam picture into a boxing match, layer by layer, with
the measurements behind each decision.

```
 webcam (640x480, 60 fps requested)
   │  requestVideoFrameCallback, re-armed before inference
   ▼
 crop to the player (256x256) ──> MediaPipe PoseLandmarker (lite, GPU)
   │
   ▼
 skeleton solver (bone lengths, speed limit)
   │
   ├──> strike filter (fixed one-euro) ──> strike resolver ──> fight sim
   │
   └──> display filter (one-euro, auto-tuned) ──> predictor ──> rig driver ──> three.js
                                                       │
                                     body channels <───┘ (slip, rise, step, turn, crouch)
                                           │
                                           └──> guard and evasion ──> fight sim
```

---

## 1. Capture

- `getUserMedia` asks for 640x480 at an *ideal* 60 fps, so a camera that cannot
  do 60 falls back instead of failing. The resolution barely matters to the
  model (it resizes everything to 256x256); the frame rate matters a lot,
  because many webcams only offer 60 fps at lower resolutions.
- Inference runs inside `requestVideoFrameCallback`, one inference per decoded
  frame. The callback is **re-armed before inference starts**, not after. With
  36 ms of inference and a 30 fps camera, re-arming afterwards pinned the pose
  rate to every other frame (15.1 fps measured, 15.0 predicted); re-arming first
  lets the next frame queue up during inference and lifts the ceiling to
  1 / inference, about 27 fps on the development laptop.
- Effective pose rate at 36 ms inference, re-arming after: 30 fps capture
  gives 15 fps, 60 fps gives 20 fps, 120 fps gives 24 fps. Finer frame
  granularity wastes less of the gap, which is why 60 fps is requested.

## 2. Pose model

- **MediaPipe Tasks Vision PoseLandmarker, lite model**, 33 landmarks per
  frame, served from `public/` together with its WASM runtime (a version
  mismatch with a CDN copy breaks loading).
- **GPU delegate first, CPU fallback.** `?delegate=cpu|gpu` forces one for
  measurement.
- **Main thread, not a worker.** Measured with `tools/perf-ab.mjs`: a worker
  frees the main thread (render 16 to 34 fps, long tasks 600 to 0 ms/s), but
  GPU inference inside a worker took 120-400 ms against about 40 ms on the main
  thread, so the pose rate fell from about 20/s to 6/s. Pose rate decides hits,
  so the main thread stays the default; `?worker=1` re-runs the comparison.
- **Cropped to the player.** A square window around the body (generous margins
  for punches, extra headroom for the top of the head) is cut out and handed to
  the model at 256x256, so the body is magnified instead of shrunk into a
  letterboxed frame. The window grows fast and shrinks slowly; its position
  follows a slip or step at once once the body leaves a small dead band; a lost
  frame widens it about its last centre, and after four lost frames it searches
  the whole frame again. Window size and position snap to an 8-pixel grid, so a
  still player gets a bit-identical crop and no resampling jitter.

## 3. Cleaning the signal

- **Skeleton solver.** Learns each bone's length from confident frames (running
  median of 60 observations, learning only above 0.72 confidence) and pulls
  limbs back to it. A landmark moving faster than 18 torso lengths per second
  (a pro punch is about 9 m/s against a half-metre torso) is the tracker
  jumping, not a person, and is clamped and demoted.
- **Two filters, on purpose.**
  - The **display filter** (one-euro, min cutoff 1.5 Hz, beta 10) drives the
    character. Chosen by sweep against a simulated punch and a still wrist:
    +15 ms at 50% of travel and +71 ms at 90%, where the original 1.2 / 0.02
    lagged a fast straight by 334 ms ("my arm moves, but late").
  - The **strike filter** (one-euro, 2.0 Hz, beta 20) feeds hit detection. It is
    fixed: nothing that decides whether a punch landed may be auto-tuned. Chosen
    by sweep: 95-100% of synthetic straights and hooks register at 19 and 30 fps,
    with no false strikes from a still guard, a guard adjustment or a slow reach.
    `src/perception/hitRegistration.test.ts` pins it.
- **Predictor.** Extrapolates the display pose forward by the measured pipeline
  latency (up to 120 ms, at 75% strength, with a dead band), so the character
  shows where you are rather than where you were. Perception never reads the
  predicted pose.
- **Tracking monitor.** Grades the raw signal over a 90-frame window (rate,
  dropouts, jitter, limb drift) and scales only the display smoothing and the
  prediction. A test asserts it exposes exactly those two knobs. Camera Check
  shows the grade and what it changed.

## 4. From landmarks to boxing

- **Strike resolver.** A hand arms only once the fist is back in the guard (up
  at chest height or above, pulled in). It fires when the fist reaches full
  extension within 450 ms of leaving the guard, measured against the player's
  own arm span learned at runtime. The impact point is projected into a
  torso-normalised body frame (0 is the belt, 1 the shoulder line), which picks
  a region (chin, temple, jaw, solar plexus, liver, ribs and so on). Damage
  comes from the region, the power (speed) and how directly the punch arrived.
  Each strike carries a type from its path (straight, hook, uppercut) for the
  popup; hits never depend on it.
- **Body channels**, all from x/y only:

  | Channel | Measured from |
  | --- | --- |
  | Slip | Shoulder-midpoint travel, torso-normalised. |
  | Rise | The same, vertical. |
  | Step | Apparent torso size: `Δ = D·(1 − s₀/s)`. |
  | Turn | Shoulder-line foreshortening: `|yaw| = acos(w/w₀)`. |
  | Crouch | Derived from the vertical channel. |

  MediaPipe's `z` is never read; it degrades exactly along the axis a punch
  travels. A test poisons every `z` and asserts identical output.
- **Guard and evasion** come from the channels with hysteresis (separate enter
  and exit thresholds), so a guard on the edge does not flicker.

## 5. The fighter

- **Mesh.** Generated offline from Meta's MHR body model (Apache-2.0), exported
  through FBX2glTF, with gloves, shorts and boots authored in Blender
  (`blender/scripts`). 0.40 MB, one skinned body mesh plus separate eye, glove,
  shoe and shorts meshes, 18 driven joints. See `docs/ASSET-PIPELINE.md`.
- **Retargeting.** The rig driver aims each bone at its landmark using bind-pose
  directions solved from the rig itself (finger curl axes, knee bend direction,
  jaw hinge), never hand-tuned constants. Bones cannot turn faster than about
  900°/s and low-confidence elbows and wrists count as missing, so a one-frame
  glitch cannot fling an arm. Legs stand planted and bend only for a duck or a
  knockdown.
- **Ducking** bends the knees, folds the waist and drops the root by exactly the
  height the knees gave up, computed from the measured bone lengths, so the
  feet stay on the canvas.
- **Damage.** Bruises paint where strikes resolved (red, darkening to purple,
  fading over 22 s); the face swells, cuts and bleeds by region; head snap and
  jaw drop use the 14 facial bones already in the mesh.
- **Customisation.** Kit colours, matte or classic finish, laces, soles and
  wraps through a material shader (`texturing/kitDetail.ts`); hair styles and
  eyebrows painted into the head texture (`texturing/scalp.ts`).

## 6. Cameras

- **First person** (`render/fpsCamera.ts`). The camera sits at the midpoint of
  the eye bones, 6 cm back, looking along the fight line at the opponent's head.
  The head bone is scaled to nearly zero for the render (the eye position is
  read first), because from inside a head the mouth and eye sockets face the
  camera; it is restored whenever the knockdown camera shows the player from
  outside. The vertical field of view is 68° on landscape and widens on portrait
  screens so the horizontal view never drops below 70° (capped at 100°). A slip
  slides and rolls the camera slightly on top of the head's own movement.
  Smoothing is 35 ms: in first person, lag reads as motion sickness.
- **Third person** (`SHOULDER_CAMERA`). 1.35 m behind and 0.2 m above the
  head bone, looking down the same fight line with a 50° view (widened on
  portrait screens so the horizontal view stays at 62° or more). The player's
  fighter is drawn at 28% opacity in cloned Lambert materials with depth
  writes off, so the opponent always shows through; the gloves stay solid. It
  turns solid again whenever the knockdown camera shows the player from
  outside.
- **Director.** Takes the camera for knockdowns, the bell and the decision, never
  during a live exchange, and eases back to exactly where it found it.

## 7. Rendering and performance

- **three.js r185.** Procedural octagon and ring (rescaled from a single
  number), a seated crowd drawn as instanced silhouettes with camera flashes,
  arena lighting, blood decals from a bounded pool.
- **Resolution governor.** Lowers the pixel ratio under sustained frame-time
  pressure and when pose tracking is starved of GPU time, and recovers slower
  than it degrades so it never oscillates.
- **Slow-machine detector.** A fight that struggles drops shadows, the crowd and
  resolution automatically. Phones in first person start that way.
- **Hit-stop and slow motion** affect render time only; the clock, the sim and
  hit detection never slow down, and the player's own figure is never frozen.
- **Measured** (headless Chrome, fake camera, this machine): first person costs
  at most about 2-3 ms per pose against third person; hiding the camera video
  costs nothing (pose interval 45 ms either way).

## 8. The fight simulation

- **`sim/fightState.ts`.** Health, stamina, guard, evasion, knockdowns (2.4 s
  window, less health on each rise, three in a round is a TKO), fouls, rounds
  and 10-point-must scoring. Pure and deterministic; the CPU's random choices
  come from a seeded generator, so a fight replays identically.
- **CPU** (`sim/cpuOpponent.ts`). Three state machines on independent clocks:
  attack (circling, telegraph, striking, recovering, hurt), footwork and head
  movement. It manages range, telegraphs every punch (0.55, 0.38 or 0.26 s by
  difficulty), defends the side you have been attacking, and slips, ducks and
  blocks as different moves. In first person its feet stay on the fight line:
  it stands off at the preferred gap (about 0.96 m between bodies) and steps in
  to striking range (0.79 m) for each combination, arriving before the first
  punch lands. Its punch is resolved when the glove arrives
  (0.15 s after release), and the animation drives it with a shoulder turn, a
  lean and a dip into the legs on body shots.
- **Lag compensation.** Every strike is judged against the defence that was up
  when it was thrown (`DefenceHistory`, rewinding at most 150 ms). In a
  networked fight the host gives the guest's late-arriving defence the benefit
  of the doubt across one round trip (`bestAgainst`).
- **Audio** is driven by fight events: a land plays a head or body sample, a
  block plays once muffled, a miss whiffs, big shots swell the crowd.

## 9. Multiplayer

- **Transport.** WebRTC data channels, peer to peer. Offer and answer travel
  either through codes the players paste to each other (Play a Friend) or
  through the SignalR matchmaking hub (Online).
- **Wire format** (`net/protocol.ts`, version 4). Pose frames are binary: a tag,
  a float64 timestamp and four float32s per landmark, about 340 bytes at pose
  rate (about 5 KB/s). Everything else is small JSON: hello and ping, strike,
  state (10 Hz), defence (on change and every 250 ms), event (every fight
  event, with its strike), rematch, bye. A peer is untrusted input: anything that
  does not match a known message, guard or event type is dropped.
- **Authority.** The host runs the sim. The guest sends its punches and its
  guard and head movement, measured from its own camera; the host sends back
  state and events, mirrored so the guest sees itself as "player". The remote
  fighter is drawn from their live pose through the same rig driver as yours.
- **Rematch.** Each side asks; when both have, both restart on the same link.
- **Not rollback.** The guest sees the fight about one round trip late.

## 10. The server (C# on .NET 11)

| Piece | .NET feature |
| --- | --- |
| Matchmaking | SignalR hub over WebSockets: `JoinQueue`, `Matched`, `OpponentLeft`. |
| Signalling relay | `RelayOffer`, `RelayAnswer`, `RelayIceCandidate`, only between a matched pair. |
| HTTP API | Minimal APIs: `/health`, `/ice-servers`, `/leaderboard`. |
| Scoreboard | `ILeaderboardStore` with Postgres (Npgsql, Supabase) or in-memory implementations, chosen by dependency injection. |
| Protection | Rate limiter (10 submissions a minute per IP), validation, CORS locked to the game's domain. |
| Observability | OpenTelemetry traces for HTTP and hub calls. |
| Tests | xUnit with `WebApplicationFactory` and the SignalR .NET client; a load-test console app. |
| Deployment | Multi-stage Dockerfile, deployed on Render; the game on Vercel. |

## 11. Interface

- **React 19** components; the 3D scene, the fight loop and the pose pipeline
  run on their own clocks and hand React a snapshot ten times a second.
- **Camera-driven menu.** Your hand moves a cursor; holding still over a card
  fills a ring and confirms. Four defences stop accidental presses: a dwell
  time, a movement tolerance, a re-arm after each press and a dead zone on first
  hover. Keyboard, mouse and touch work everywhere, and `Esc` always leaves.
- **One `<video>` element** for the whole app, never remounted, because MediaPipe
  reads from it; hiding the camera sets it to opacity 0 rather than removing it.
- **Design.** Researched against current sports-game interfaces (see
  `docs/UI-REVIEW.md`), built with React Bits' Spotlight Card, a 3D-style CSS
  wordmark and original artwork. Safe areas (`viewport-fit=cover`), an 11 px
  text floor, 44 px touch targets, reduced-motion and high-contrast settings.

## 12. Testing

- **Unit tests:** Vitest, 775 tests across perception, pose, sim, net, render
  maths, training and UI models.
- **End to end:** Playwright drives real Chrome with a fake camera.
  `tools/fake-player.mjs` renders the game's own boxer throwing punches into a
  video file Chrome uses as its webcam, so tracking, hits and fights can be
  tested with no person in the room.
- **Smoke tests:** `npm run smoke` (the whole shell), `tools/smoke-versus.mjs`
  (two browsers, one fight), `npm run smoke:online` (two browsers through the
  real server, in CI).
- **Measurement:** `tools/perf-ab.mjs` (pose rate, render rate, long tasks),
  `npm run measure:sweep`, `tools/fight-burst.mjs` and `tools/screenshots.mjs`.
- **CI:** GitHub Actions runs lint, unit tests, the build, the .NET tests and the
  online smoke test on every push to `main` and every pull request.

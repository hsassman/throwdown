# Development

How ShadowBox was built: the phases, the workflow, and the tools that kept it
honest. Dates are 2026. The full record is `git log`.

## Phases

| When | Phase | What landed |
| --- | --- | --- |
| Jul 28 | **0. Prototype** | Webcam pose tracking in the browser (MediaPipe), smoothing, latency and frame-rate instrumentation. |
| Sep 17 | **1. A game** | Punching-dummy training with a learning profile, the camera-driven menu, a CPU opponent with footwork, two procedural venues. |
| Sep 18-22 | **2. Fights** | Fights in the arena, knockdowns and the referee's count, a system health report, same-network multiplayer over WebRTC. |
| Nov 12-16 | **3. Online and the .NET server** | CI; the ASP.NET Core server on .NET 11 (SignalR matchmaking, signalling relay, leaderboard on Supabase Postgres, ICE config, OpenTelemetry, load test); "Find a match" in the client; mobile readiness; deploy setup; a projector stage page; punch feel. |
| Nov 19 | **4. Hit detection** | Straight punches register, steady power, lag-compensated fights; the framing coach; measured worker path; lighter first load. |
| Nov 20-23 | **5. Feel and polish** | Fighters stop overlapping, impact words, hit-stop, slow-motion knockdowns, the crowd, the first-run walkthrough, phone layouts. |
| Nov 24 | **6. Art** | Generated textures, crowd, venues and UI art (Codex); the fight camera follows the opponent; the character keeps up when tracking is starved. |
| Nov 26-27 | **7. FPS Mode and responsiveness** | An over-the-shoulder duel mode with dodge lean, wind-up glow and gloves-up get-up; "Wii-style" punches (thrust from the guard within 450 ms); planted legs and steady arms; lighter graphics on struggling machines; the live site finds the deployed server. |
| Nov 28 | **8. First person, multiplayer, redesign** | See below. |

### Phase 8 (Nov 28): first person, multiplayer and the redesign

Two AI agents worked in parallel on one repository, with the user directing
both.

**Gameplay (Claude Code, branch `gameplay-pass`):**
- First person became the default, with the camera at the fighter's eyes and
  the head hidden from the inside. `V` and a setting switch to third person.
- The menu went from 13 modes to 8. Removed: FPS Mode (now the default view),
  Free Work, a locked local mode, Phone Camera, Punch Lab, the depth map and a
  guide gallery, with their dependencies (ONNX Runtime, jsQR).
- Multiplayer: the guest's guard and head movement now count (the host used to
  ignore them, so every host punch landed); the guest receives every fight
  event (result, sounds, impact words, knockdown camera); a defender window
  makes late-arriving defence fair; rematch without reconnecting; a shared
  channel hook replaced two copies of the link plumbing; a two-browser test.
- Tracking: the crop window follows a sideways move at once and widens
  immediately when the player is lost.
- CPU punches resolve when the glove arrives, not when the arm starts out; the
  player flinches only on clean hits; punches turn the shoulders and lean in.
- In first person the CPU stands off at its preferred gap between exchanges and
  steps in to striking range only to throw, instead of standing at punching
  distance all fight.
- Fights ask for first or third person before they open.
- Online: a player paired with someone who had already closed their tab goes
  straight back into the queue, and searching again after an opponent leaves
  shows the search instead of "Disconnected".
- The camera inset shows only the skeleton by default.
- Recorded sounds from Openverse with a credits file.
- A design pass against Apple's Human Interface Guidelines foundations (safe
  areas, an 11 px text floor, 44 px touch targets), audited at four screen sizes.
- About 4,000 lines of comment essays trimmed to their summaries, verified by
  transpiling every changed file and comparing the code; em dashes removed.

**Interface (Codex, in the main checkout):** research into FC 27, NBA 2K27,
WWE 2K26, UFC 5 and Undisputed; a new visual direction (charcoal, lavender,
platinum); React Bits mode cards; an animated wordmark; a settings panel with
icons; restyled HUD, panels, training recap and venue picker; phone and
short-landscape layouts; fighter customisation (laces, soles, wraps, new
hairstyles, face and skin detail). See `docs/UI-REVIEW.md`.

## Workflow

### Two agents, one repository

```
                 user
              /        \
       Claude Code      Codex
   (gameplay lane)   (interface lane)
   worktree:         main checkout:
   Boxing-game-      Boxing-game
   gameplay          (uncommitted)
         \              /
   snapshot commits of the main checkout
   (codex-ui, codex-ui-2) merged into gameplay-pass
                   │
          full test gate ──> main ──> Vercel deploy
```

- **Lanes.** Claude owned pose, perception, the sim, networking, rendering and
  tuning; Codex owned the React interface, CSS and art. `App.tsx` was shared,
  edited in small local changes. The coordination log is in
  `docs/UI-REVIEW.md`.
- **Isolation.** Claude worked in a separate git worktree so the two agents never
  edited the same file at the same moment. Codex's uncommitted work was
  captured with snapshot commits (built from a temporary git index, leaving its
  checkout untouched) and merged, with conflicts resolved by hand.
- **Babysitting.** Claude read Codex's session log as it worked, checked that it
  stayed in its lane, flagged deviations, and fixed integration issues (stale
  mode ids, a rematch button that could not be clicked, an inset over the
  gloves) through the shared notes.
- **Review.** A `/simplify` pass ran four independent reviewers (reuse,
  simplification, efficiency, altitude) over the gameplay diff; the useful
  findings were applied, the rest recorded as skipped.

### Rules every change follows

- Measure before and after; keep a change only if it helps. A/B numbers come
  from `tools/perf-ab.mjs` against the same fake camera.
- Tests stay green: never skip, disable or delete one to get there.
- The ground rules in the README hold (no mesh reads in perception, no `z`, no
  auto-tuned hit thresholds, no video over the network, licence-clean only).
- Lint, unit tests and the build before every push; CI repeats them with the
  .NET tests and the online smoke test.

## Tools

| Tool | Use |
| --- | --- |
| `tools/fake-player.mjs` | Renders the game's boxer throwing punches into a `.y4m` video that Chrome uses as a fake webcam. Variants: a high guard, moving. |
| `tools/smoke-shell.mjs` | Drives the whole app: menu, every mode, camera continuity, a local peer match. |
| `tools/smoke-versus.mjs` | Two browsers, one Play a Friend fight: defence, events, clock sync, rematch. |
| `tools/smoke-online.mjs` | Two browsers through the real .NET server (CI). |
| `tools/perf-ab.mjs` | Pose rate, render rate and long tasks under different settings. |
| `tools/fight-burst.mjs` | A burst of screenshots from a live fight. |
| `tools/screenshots.mjs` | Every screenshot in the README and docs. |
| `tools/review-art.mjs`, `tools/review-ui-states.mjs` | Codex's UI review at several viewports. |
| `npm run measure:sweep` | The pose pipeline with a real person in front of the camera. |

## What is next

- A TURN relay, so online pairings behind strict NATs connect.
- Testing on real phones (iPhone Safari, Android Chrome) with live tracking.
- Rollback or prediction for the guest, so it does not see the fight a round
  trip late.
- More fighters (body morphs by weight class are already modelled in
  `sim/attributes.ts`) and punch types for the CPU (hooks and uppercuts that
  arc).
- A server-verified leaderboard.

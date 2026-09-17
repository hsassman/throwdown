# Architecture

Shadow Box is a browser game with no server. Everything — camera, pose
inference, perception, simulation, rendering — runs in the tab.

## Layers

Data flows one way. A layer may read the one above it and never the one below.

| Layer | Directory | Responsibility |
| --- | --- | --- |
| Capture | `src/capture` | Camera access, stream lifecycle. |
| Pose | `src/pose` | MediaPipe inference, smoothing, prediction, tracking quality. |
| Perception | `src/perception` | Landmarks to meaning: strikes, body motion, dodges. |
| Simulation | `src/sim` | Health, stamina, scoring, the CPU opponent. |
| Training | `src/training` | Dummy drills, scoring, the persistent profile. |
| Menu | `src/menu` | Modes and stages as data. |
| Render | `src/render` | three.js. Draws what the layers above decided. |
| UI | `src/ui` | React. HUDs, panels, the camera-driven shell. |

The boundaries are enforced by tests, not convention. The two that matter most:

**Perception never reads the character mesh.** What you hit must not depend on
how you are drawn. Hit resolution works in a torso-normalised body frame
(`ImpactPoint`: `lateral` from the midline, `height` where 0 is the belt and
1.0 the shoulder line), which survives the player standing closer, further
away, or being a different size.

**Render never decides anything.** It is handed state and turns it into a body.
A decision made in the render layer cannot be replayed by netcode and cannot be
tested without a GPU.

## Units

Two coordinate systems meet in this project and the conversion happens in one
place each time.

- **Torso units** — perception, the strike resolver and the AI all reason in
  multiples of the player's own shoulder-to-hip distance.
- **World units** — the scene.

`RENDER_CONFIG.rigTorsoWorldLength` is the factor. Mixing them silently is a
real failure mode: the CPU opponent once believed the gap between fighters was
1.0 when it was really 1.66, so it threw punches from across the ring with
every rule working exactly as written.

## Tuning

Every threshold, gain and time constant lives in `src/config/tuning.ts`. Nothing
is tuned from a magic number at a call site.

## Ground rules

These are settled. Re-opening one needs a strong reason.

- **Client-side only.** No authoritative game server. A signalling server will
  be needed for WebRTC setup and will relay no gameplay data.
- **Only classified, discrete events cross the network** — never raw landmarks
  and never video.
- **Licence-clean stack.** MediaPipe is Apache-2.0. No copyleft models, no
  ripped game assets.
- **No Python and no GPU inference in the runtime path.** The character asset
  pipeline is offline and one-time; it ships a static `.glb`.
- **MediaPipe `z` is never read for classification.** It degrades exactly along
  the axis a punch travels. Depth comes from apparent size and foreshortening,
  both x/y measurements. A test poisons every `z` and asserts identical output.
- **No threshold that decides whether a punch landed may be auto-tuned.** The
  tracking monitor may adjust smoothing and prediction. Nothing else.

## Determinism

The CPU opponent takes all its randomness from a seeded generator held in the
object, never `Math.random`. Rollback netcode replays past frames and needs
identical results; an opponent that reached outside for a random number would
desync two peers the first time it threw a punch.

## Not in scope for v1

Ring-walk cinematics, career progression beyond the stub, clinch and grappling,
referee logic beyond knockdown counting, spectator mode.

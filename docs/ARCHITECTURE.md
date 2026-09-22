# Architecture

Shadow Box is a browser game with no server. Everything - camera, pose
inference, perception, simulation, rendering - runs in the tab.

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
| Net | `src/net` | Peer link, wire format, session. Transport only. |
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

- **Torso units** - perception, the strike resolver and the CPU all reason in
  multiples of the player's own shoulder-to-hip distance.
- **World units** - the scene.

`RENDER_CONFIG.rigTorsoWorldLength` is the factor. Mixing them silently is a
real failure mode: the CPU opponent once believed the gap between fighters was
1.0 when it was really 1.66, so it threw punches from across the ring with
every rule working exactly as written.

## Tuning

Every threshold, gain and time constant lives in `src/config/tuning.ts`. Nothing
is tuned from a magic number at a call site.

## Ground rules

These are settled. Re-opening one needs a strong reason.

- **Client-side only.** No game server, and not even a signalling one: the two
  players exchange the WebRTC offer and answer by pasting a code to each other.
- **Video never crosses the network.** Pose landmarks do.

  This replaced an earlier rule of "discrete events only, never raw landmarks".
  It was changed deliberately, not drifted past. Driving the remote fighter
  from their real pose means they duck, step and throw exactly as the person
  did, because it runs the same retargeting on the same input; a digest would
  have meant a second, lossier animation path and two things to keep in step.
  It costs about 5 KB/s.

  What that buys is worth stating plainly: in a networked fight a player's body
  landmarks reach their opponent's machine. Peer-to-peer, to someone they chose
  to fight, only while the fight is open, and never to us. The picture never
  leaves either machine.
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

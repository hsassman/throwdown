# Character asset pipeline

The boxer mesh is generated **offline, once**. Nothing here runs in the game.
The output is `public/models/boxer_lod3.glb` (0.40 MB), which ships as an
ordinary web asset.

## Where the mesh comes from

Meta's **MHR** (Momentum Human Rig) body model. Code and downloadable assets are
Apache-2.0, confirmed by reading `assets/LICENSE.txt` inside the `v1.0.1`
release archive rather than trusting the README.

The pip install path is broken upstream; the working route is a direct download
of the release archive. The rig has **127 joints** — `tools/rig-introspect.mjs`
prints the real names if the mesh is ever re-exported.

Export to glTF is via the `FBX2glTF` CLI. MHR ships no exporter of its own.

## Rig facts the runtime depends on

Verified against the shipped asset with full world transforms (summing local
translations ignores rotation and gives nonsense):

- `l_*` bones sit at **+X**, `r_*` at **−X**. The figure's own right is −X.
- The figure faces **+Z**.
- Shoulder line at y **1.419**, hip line at y **0.944** — so one torso unit is
  **0.475** world units.
- 14 facial bones including `c_jaw` as a real skin joint. Head snap and jaw drop
  are therefore bone-driven and cost nothing in asset size.

## Morph targets

The export carried 117 morph targets, all at weight 0 and all anonymous —
FBX2glTF drops names, which is what made them unusable rather than merely
unused. They were identified by skinning analysis, and the boundaries land on
MHR's documented layout: **0–19** body identity, **20–39** head identity,
**40–44** hands, **45–116** the 72 expression shapes.

`assets/mhr-export/strip-morphs.mjs` removes them: **8.09 MB → 0.40 MB**.
`--keep=expression` produces a named variant if expressions are ever wanted
(~64 KB per shape).

## Kit (gloves, trunks, boots)

Authored in Blender and baked into the exported mesh. `blender/` holds the
scripts; `blender/README.md` has the run order.

Three earlier attempts failed and are worth not repeating:

1. **Painted colour regions.** A painted glove keeps the silhouette of a bare
   hand.
2. **Fitted third-party meshes.** Mechanically worked, looked broken, and the
   glove asset turned out to be ripped game content that could never have
   shipped under the licence rule. `3D_models/` is gitignored so a download
   cannot be committed by accident.
3. **Procedural geometry at load.** Good enough to keep for a while, but kit
   authored once in Blender is cheaper at runtime and easier to art-direct.

Findings from those attempts that still apply to any incoming asset:

- Ripped exports bury geometry under wrapper nodes, are often modelled in
  millimetres, and are rarely skinned.
- Quantised positions are integers with a compensating scale/offset **on the
  node** — taking geometry alone drops a garment at the origin at hundreds of
  times its size.
- `KHR_materials_pbrSpecularGlossiness` was dropped by three.js in r165.
- `dedup()` collapses a mirrored left/right pair back into one mesh, silently
  undoing the reflection.
- Topology-based cuff detection does not work on disconnected patches: 6178 of
  7494 glove vertices sat on a boundary even after welding.

## Retargeting

`src/render/retargeting/` drives the rig from the same MediaPipe landmarks the
game already tracks. Swing-only, solved in world space and conjugated into each
bone's parent frame.

Things that are **derived or solved, never hardcoded**, because each one is a
coin flip that renders as a subtly broken character:

- Finger curl axes, from the bind pose.
- Finger adduction, by a secant solve against the closed fist, retargeted at
  the PIP joint (at a full fist the fingertip's lever arm has collapsed).
- The jaw hinge direction.
- The knee-bend direction for the duck.
- Glove vertices, emitted in geometry space from
  `skeleton.boneInverses[i].invert()` — **not** `bone.getWorldPosition()`,
  which looks nearly correct and then drifts the instant the figure moves.

## Known-good numbers

| Thing | Value |
| --- | --- |
| Shipped mesh | 0.40 MB |
| Driven joints | 18 |
| Torso tracking fidelity | 99% of requested lean, 5°–45° |
| Pose rate on the development machine | ~19 FPS median |
| Hard inference ceiling on that machine | ~27.8 FPS |

## Open

- Phone-camera framing has never been calibrated. Laptop-webcam thresholds
  should not be assumed to transfer.
- No WCAG audit has been done. This is a physical-movement game and has an
  inherent accessibility ceiling worth naming honestly.

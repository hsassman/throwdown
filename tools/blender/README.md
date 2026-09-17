# Blender pipeline

Offline, one-time asset work. **Nothing here runs at match time** — it produces
a `.glb` that ships as a normal web asset, which is what keeps it inside
the no-Python/no-GPU-at-runtime rule. Blender is
in the same category as the existing `assets/mhr-export/` step.

## Status: ready to run, never run

Blender is **not installed on this machine** and **no Blender MCP is connected**
to this session. These scripts were written against Blender's documented 4.x
Python API but have **not been executed**. Treat every output number in a
comment as an expectation, not a measurement, until someone runs them.

## Why this exists at all

The single highest-value thing in it is `00_reexport.py`, and the reason is a
specific bug:

> The shipped mesh has 117 morph targets. All 117 are **anonymous**, because
> `FBX2glTF` does not carry shape-key names through. That is what made them
> unusable rather than merely unused — you cannot drive a morph you cannot
> address.

**Blender's glTF exporter preserves shape key names.** Re-exporting through
Blender fixes that at the source, and four separate things downstream are
waiting on it:

| Waiting on named morphs | Where |
|---|---|
| Weight class body shapes | `src/sim/attributes.ts` → `morphWeightsFor()` |
| Facial expressions on impact | `src/render/TrainingTarget.ts` |
| Swollen eyes / cuts | `src/render/texturing/bodyTexture.ts` |
| Fighter customisation | not built |

## Order to run them

```
blender --background --python tools/blender/00_reexport.py
blender --background --python tools/blender/01_fist_pose.py
blender --background --python tools/blender/02_damage_uv.py
```

Each writes into `assets/blender-out/` and prints a report. Nothing overwrites
`public/models/boxer_lod3.glb` — copying the result in is a deliberate manual
step, because the current asset is the baseline every measurement in this
project was taken against.

## What each script does

**`00_reexport.py`** — imports the current `.glb`, verifies the skeleton and
UVs survived, names the morph targets according to MHR's documented layout
(0-19 body identity, 20-39 head identity, 40-44 hands, 45-116 expressions —
boundaries already established by skinning analysis), and re-exports. This is
the one that has to work first; the other two build on its output.

**`01_fist_pose.py`** — poses a closed fist on the armature and saves it as a
shape key named `fist`. Once this exists, `src/render/retargeting/handRig.ts`
can be replaced by a single morph weight, deleting ~200 lines of runtime
geometry that currently secant-solves finger adduction at load time.

**`02_damage_uv.py`** — adds a second UV layer dedicated to damage, laid out
for bruising rather than inherited from the original auto-unwrap, and bakes an
ambient-occlusion map. The current bruise system works but paints into an
auto-generated layout where the head happens to own `u 0.003-0.499`; a purpose-
built layout is what allows swelling and cuts rather than coloured blobs.

## If you connect a Blender MCP instead

These same scripts are the right content to send through it — the MCP just
removes the command-line step. Two things worth knowing before you do:

- The addon executes arbitrary Python inside your Blender session. Fine on your
  own machine; worth knowing.
- Blender must be **running** with the addon's server started. A headless
  `--background` run does not serve the MCP.

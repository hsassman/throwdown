# Blender asset pipeline

Offline, headless, automatable. Takes the exported MHR boxer mesh, fixes what
is wrong with the rig, fits real gloves / shorts / shoes onto it, adds eyeballs
and damage morph targets, and exports a GLB the game loads directly.

Nothing here runs at match time. It produces a static asset, in keeping with
the project's standing rule: no Python and no GPU inference anywhere in the
runtime path (docs/ARCHITECTURE.md).

## Why this exists

Gloves, shorts and eyes were built three times as runtime geometry - painted
texture regions, imported meshes fitted in JS, and finally fully procedural
geometry generated at load. All three were rejected on sight. The full
post-mortem is in [`docs/ASSET-PIPELINE.md`](../docs/ASSET-PIPELINE.md);
the short version is that the shape of convincing kit is modelling work, and
generating it from code was the wrong tool three times in a row.

## Run it

```bash
node blender/run.mjs              # every step in order
node blender/run.mjs 00           # just the inspection pass
node blender/run.mjs 01 02 06     # a subset
node blender/run.mjs all --ship   # everything, and overwrite public/models/
```

The runner finds Blender itself (env var `BLENDER`, then the usual install
paths, then `PATH`). Override with `--blender <path>`.

Each step is a separate Blender process that opens `out/boxer.blend`, changes
it, and saves. So a failure in step 5 leaves steps 1-4 intact, and any step can
be re-run alone while iterating.

## The steps

| Step | Script | Needs | What it does |
|------|--------|-------|--------------|
| 00 | `00_inspect.py` | - | Measures the source and writes `out/rig-facts.json`. **Read this before writing anything that depends on the rig.** Changes nothing. |
| 01 | `01_import.py` | - | Imports the GLB, flattens the importer's wrapper nodes, builds `out/boxer.blend`. |
| 02 | `02_rig_fix.py` | - | Limits to 4 influences and normalizes, purges empty vertex groups, recalculates bone roll, reports unweighted deform bones. |
| 03 | `03_gloves.py` | `assets/kit/glove.glb` | Fits and mirrors gloves, pinned rigidly to the wrists. |
| 04 | `04_shorts.py` | `assets/kit/shorts.glb` | Fits shorts, shrinkwraps clear of the skin, transfers hip/thigh weights. |
| 05 | `05_shoes.py` | `assets/kit/shoe.glb` | Fits and mirrors boots, weights clamped to foot and lower leg. |
| 06 | `06_eyes.py` | - | Builds eyeballs weighted to `l_eye`/`r_eye`, and generates named damage morph targets. |
| 07 | `07_export.py` | - | Exports GLB, re-imports it and verifies, ships only with `--ship`. |

Steps 03-05 skip cleanly with a message if their source mesh is absent, so the
pipeline runs end to end before you have sourced any kit. Steps 00, 01, 02, 06
and 07 work today with nothing added.

## Where the division of labour sits

**Automated here:** scale and unit reconciliation, placement against named
bones, skin-weight transfer, influence limiting, normals, mirroring, materials,
morph-target generation, export flags, and a verification re-import.

**Not automated, deliberately:** the modelling. Supply the glove; this fits it.
See [`assets/kit/README.md`](assets/kit/README.md) for what a usable source
mesh has to be.

## Facts measured from this rig

From `out/rig-facts.json`, regenerated on every `00` run:

- 127 bones, 5429 vertices, 1.7254 units tall, one UV layer (`UVMap`)
- **0 shape keys** - the 117 morph targets the MHR export carried were stripped
- **27 bones carry zero skin weight**, including `l_eye`, `r_eye`, `c_teeth`
  and the five `c_tongue*` bones. This is the measurement that invalidated
  bone-scaled eye swelling in the runtime, and the reason `06_eyes.py` exists.
- `c_jaw` carries 173.64 total weight across 178 dominant vertices - it *is*
  real, which is why jaw and cheek puff stayed bone-driven.

## Gotchas already paid for

- **Mirroring by negative scale flips triangle winding.** The mirrored glove
  renders as a see-through shell unless normals are recalculated. Handled in
  `03_gloves.py`; the same bug shipped in the procedural version.
- **Never run merge-by-distance across a mirrored pair** - it collapses them
  back into one mesh and silently undoes the reflection.
- **glTF carries exactly 4 influences per vertex.** A fifth is dropped at
  export and the remainder is left unnormalized, so affected vertices shrink.
  `02_rig_fix.py` limits and normalizes; `07_export.py` verifies.
- **`export_morph=True` is not the default in every preset**, and losing morph
  targets is silent - the mesh still loads.
- **Quantised meshes keep a compensating scale on the node.** Taking geometry
  alone drops a garment at the origin at hundreds of times its size.
- **Bone roll does not survive glTF.** It round-trips inside the bind matrix,
  so an imported rig has arbitrary per-bone roll until `02` recalculates it.

## Blender MCP

The Blender MCP server drives an *interactive* Blender session, which is a good
fit for sculpting and eyeballing, and a bad one for a repeatable build. The CLI
path above is the one to automate against: it is deterministic, it runs in CI,
and it fails loudly. Use MCP for the modelling work these scripts deliberately
do not do, then drop the result in `assets/kit/` and let the pipeline fit it.

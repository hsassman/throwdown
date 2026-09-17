# Kit drop folder

Put the source garment meshes here. The fit scripts look for these exact
filenames (any of `.glb`, `.gltf`, `.fbx`, `.obj` — change the `SOURCE`
constant at the top of the script if you use a different extension):

| File         | Used by          | Notes |
|--------------|------------------|-------|
| `glove.glb`  | `03_gloves.py`   | **One** glove. The other hand is mirrored automatically — do not supply a pair. |
| `shorts.glb` | `04_shorts.py`   | Boxing trunks. Modelled as a closed garment, not a cloth sheet. |
| `shoe.glb`   | `05_shoes.py`    | **One** boot. Mirrored automatically, same as the glove. |

Everything in this folder is gitignored except this README. That is deliberate:
a licence-encumbered download must not be committable by accident. This project
has already had a ripped Apex Legends glove (EA/Respawn IP) reach the working
tree once.

## What the mesh needs to be

The fit scripts handle scale, placement, weights and materials. They cannot
fix bad source geometry. Before dropping a file in here, check:

- **It is a closed, manifold shell.** Ripped game assets are usually
  disconnected patches, which breaks anything topology-based. A previous
  attempt here found 6178 of 7494 glove vertices sitting on a mesh boundary
  even after welding.
- **Units do not matter, but proportions do.** Scale is reconciled against the
  rig automatically. A garment modelled in millimetres is fine; a garment with
  the wrong *shape* is not.
- **It does not need to be skinned.** Weights are transferred from the body.
  Any armature it arrives with is discarded.
- **Its material is plain PBR.** `KHR_materials_pbrSpecularGlossiness` is not
  usable — three.js dropped support in r165, so such an asset loads untextured.
  Convert to metallic/roughness first.
- **It faces the same way the rig does.** The scripts position and scale, but
  they do not guess rotation. Orient it in Blender and re-export if needed.

## Licence

Whatever you put here ships inside `public/models/boxer_lod3.glb`. This
project's stack is licence-clean by policy (see docs/ARCHITECTURE.md), so use CC0 /
CC-BY / purchased-with-redistribution-rights assets, and record where each one
came from. Do not use game rips.

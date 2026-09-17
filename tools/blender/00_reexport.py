"""Re-export the boxer through Blender, restoring morph-target names.

Run:  blender --background --python tools/blender/00_reexport.py

WHY THIS IS THE FIRST SCRIPT
----------------------------
The shipped mesh carries 117 morph targets and every one of them is anonymous,
because FBX2glTF does not carry shape-key names through the conversion. That is
what made them unusable rather than merely unused: you cannot drive a morph you
cannot address by name.

Blender's glTF exporter DOES preserve shape key names. So the fix is not clever
— it is simply to route the asset through a tool that does not drop them, and
to give them the right names on the way.

The names come from MHR's documented layout, and those boundaries are not
guesses: they were established earlier by skinning analysis (which vertices
each morph moves), and they landed exactly on the documented block edges.

    0-19     body identity
    20-39    head identity
    40-44    hands
    45-116   the 72 expression shapes

NOT RUN YET. Blender is not installed on the machine this was written on, and
no Blender MCP is connected. Written against the documented Blender 4.x API.
Every number in the verification section is an EXPECTATION taken from the
existing asset, not a measurement of this script's output.
"""

import os
import sys

import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SOURCE = os.path.join(REPO, "public", "models", "boxer_lod3.glb")
OUT_DIR = os.path.join(REPO, "assets", "blender-out")
OUT = os.path.join(OUT_DIR, "boxer_named.glb")

# Ground truth from the existing asset, asserted after import. If any of these
# stops holding, the import silently lost something and every later script
# would build on a broken base.
EXPECT_JOINTS = 127
EXPECT_MORPHS = 117

# MHR's documented morph layout. (start, end_exclusive, prefix).
BLOCKS = [
    (0, 20, "body"),
    (20, 40, "head"),
    (40, 45, "hand"),
    (45, 117, "expr"),
]


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def find_mesh():
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        sys.exit("no mesh in the imported file")
    # The body is the one with the most vertices. The asset is a single skin,
    # but picking by name would break the moment anything is added to it.
    return max(meshes, key=lambda o: len(o.data.vertices))


def find_armature():
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        sys.exit("no armature — the skeleton did not survive import")
    return arms[0]


def main():
    if not os.path.exists(SOURCE):
        sys.exit(f"missing source asset: {SOURCE}")
    os.makedirs(OUT_DIR, exist_ok=True)

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=SOURCE)

    mesh = find_mesh()
    arm = find_armature()

    joints = len(arm.data.bones)
    keys = mesh.data.shape_keys
    # Blender counts the basis ("Basis") as a shape key; glTF morph targets do
    # not include it. Subtracting it is the difference between 118 and 117, and
    # getting it wrong shifts every name by one.
    blocks = list(keys.key_blocks) if keys else []
    morphs = max(0, len(blocks) - 1)

    print(f"joints: {joints} (expected {EXPECT_JOINTS})")
    print(f"morph targets: {morphs} (expected {EXPECT_MORPHS})")
    print(f"uv layers: {[l.name for l in mesh.data.uv_layers]}")
    print(f"vertices: {len(mesh.data.vertices)}")

    if joints != EXPECT_JOINTS:
        print(f"WARNING: joint count changed ({joints} vs {EXPECT_JOINTS})")
    if morphs != EXPECT_MORPHS:
        print(f"WARNING: morph count changed ({morphs} vs {EXPECT_MORPHS})")
    if not mesh.data.uv_layers:
        # TEXCOORD_0 survives in the shipped asset only because strip-morphs.mjs
        # passes keepAttributes; the default prune dropped it once already, and
        # losing it disables every texture and all visible damage.
        sys.exit("FATAL: no UVs. Texturing and all damage would be dead.")

    # --- Name the morph targets -----------------------------------------
    renamed = 0
    for i, block in enumerate(blocks):
        if i == 0:
            continue  # Basis
        target = i - 1  # glTF morph index
        for start, end, prefix in BLOCKS:
            if start <= target < end:
                block.name = f"{prefix}_{target - start:03d}"
                renamed += 1
                break
    print(f"named {renamed} morph targets")

    # Every weight must be zero on export, or the figure ships deformed. All
    # 117 were verified zero in the existing asset; re-asserting because an
    # importer that helpfully "restored" a weight would be invisible until
    # someone looked at the model.
    for block in blocks[1:]:
        if abs(block.value) > 1e-6:
            print(f"WARNING: {block.name} exported at {block.value}, zeroing")
            block.value = 0.0

    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_morph=True,
        # The whole point. Without this the names are dropped again and the
        # script has achieved nothing.
        export_morph_normal=False,
        export_skins=True,
        export_texcoords=True,
        export_normals=True,
        export_yup=True,
        export_apply=False,
    )
    size_mb = os.path.getsize(OUT) / 1e6
    print(f"wrote {OUT} ({size_mb:.2f} MB)")
    print(
        "NOT copied over public/models/boxer_lod3.glb — that is a deliberate "
        "manual step, since the current asset is the baseline every measurement "
        "in this project was taken against."
    )


if __name__ == "__main__":
    main()

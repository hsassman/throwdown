"""Add a damage-specific UV layer and bake ambient occlusion.

Run:  blender --background --python tools/blender/02_damage_uv.py
Input: assets/blender-out/boxer_fist.glb  (or boxer_named.glb)

WHAT THIS FIXES
---------------
Bruising currently works, but it paints into the mesh's ORIGINAL auto-generated
UV layout — the one where the head happens to own u 0.003-0.499 and v
0.003-0.453, measured with tools/uv-regions.mjs. That layout was produced for
skin texturing, not for damage, and it has two properties that cap what damage
can look like:

  * Region bounding boxes overlap heavily, which is why bodyTexture.ts had to
    rasterise per TRIANGLE rather than fill rectangles — a rectangle fill
    painted shorts onto a forearm.
  * Texel density is uneven. The face gets the same density as a thigh, so a
    bruise on the cheek has no more resolution than one on a leg, when the face
    is where the camera is pointed.

A second UV layer solves both without disturbing the first. TEXCOORD_0 stays
exactly as it is (every existing texture and test depends on it — it survived
a prune() that dropped it once already), and damage moves to TEXCOORD_1 with
the face given the resolution it deserves.

The AO bake is the other half. A bruise is currently a flat coloured blob
because the material has no normal or occlusion information to modulate it.
With AO baked, the same bruise sits into the creases of the face instead of
floating on top of it, which is most of the difference between "a red circle"
and "swelling".

NOT RUN YET. Blender is not installed here. The smart-UV-project angle and the
AO sample count below are starting points, not tuned values.
"""

import os
import sys

import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO, "assets", "blender-out")
OUT = os.path.join(OUT_DIR, "boxer_damage.glb")
AO_PATH = os.path.join(OUT_DIR, "boxer_ao.png")

AO_SIZE = 2048
AO_SAMPLES = 64


def pick_source():
    for name in ("boxer_fist.glb", "boxer_named.glb"):
        p = os.path.join(OUT_DIR, name)
        if os.path.exists(p):
            return p
    sys.exit("run 00_reexport.py (and ideally 01_fist_pose.py) first")


def main():
    source = pick_source()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)
    print(f"loaded {os.path.basename(source)}")

    mesh = max(
        (o for o in bpy.data.objects if o.type == "MESH"),
        key=lambda o: len(o.data.vertices),
        default=None,
    )
    if mesh is None:
        sys.exit("no mesh")

    existing = [layer.name for layer in mesh.data.uv_layers]
    print(f"existing UV layers: {existing}")
    if not existing:
        sys.exit("FATAL: no UVs at all. Every texture and all damage is dead.")

    # The original stays FIRST and untouched. Order matters: glTF maps the
    # first layer to TEXCOORD_0, and every existing material, test and the
    # bruise system address that index.
    original = mesh.data.uv_layers[0]
    original.active_render = True

    if "damage" in existing:
        print("damage layer already present, leaving it alone")
    else:
        damage = mesh.data.uv_layers.new(name="damage")
        mesh.data.uv_layers.active = damage
        bpy.context.view_layer.objects.active = mesh
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        # Smart project rather than a hand-authored layout, because the point
        # here is even texel density and low distortion, not artistic packing.
        bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.006)
        bpy.ops.object.mode_set(mode="OBJECT")
        print("added 'damage' UV layer (TEXCOORD_1)")

    # --- Bake ambient occlusion -----------------------------------------
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = AO_SAMPLES
    # CPU only. This whole pipeline is offline and must not assume a GPU —
    # same reasoning as the rest of the project's asset track.
    scene.cycles.device = "CPU"

    image = bpy.data.images.new("ao", width=AO_SIZE, height=AO_SIZE)

    if not mesh.data.materials:
        mat = bpy.data.materials.new(name="body")
        mat.use_nodes = True
        mesh.data.materials.append(mat)

    for mat in mesh.data.materials:
        if mat is None:
            continue
        mat.use_nodes = True
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        # The bake target must be the SELECTED and ACTIVE node, or Cycles bakes
        # into whichever image node it finds first — usually the base colour,
        # silently destroying it.
        node.select = True
        mat.node_tree.nodes.active = node

    bpy.context.view_layer.objects.active = mesh
    mesh.select_set(True)
    try:
        bpy.ops.object.bake(type="AO", use_clear=True, margin=8)
        image.filepath_raw = AO_PATH
        image.file_format = "PNG"
        image.save()
        print(f"baked AO -> {AO_PATH} ({AO_SIZE}px, {AO_SAMPLES} samples)")
    except RuntimeError as err:
        # A failed bake should not lose the UV work, which is the expensive
        # part and is already done by this point.
        print(f"WARNING: AO bake failed ({err}); exporting UVs anyway")

    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_morph=True,
        export_skins=True,
        export_texcoords=True,
    )
    print(f"wrote {OUT}")
    print(
        "Next: point bodyTexture.ts at TEXCOORD_1 for damage, keep TEXCOORD_0 "
        "for skin, and multiply the AO map into the bruise layer so swelling "
        "sits in the creases instead of floating on top."
    )


if __name__ == "__main__":
    main()

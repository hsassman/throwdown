"""
07 -- EXPORT. Writes the finished GLB, and optionally ships it.

    blender --background --python blender/scripts/07_export.py
    blender --background --python blender/scripts/07_export.py -- --ship

Without --ship the result is left in blender/out/ for inspection. With it, the
file is copied over public/models/boxer_lod3.glb, which is what the game loads.
Shipping is opt-in because overwriting the live asset from a headless run that
you have not looked at is exactly how an unnoticed regression gets in.

EXPORT FLAGS THAT MATTER HERE, AND WHY

  export_morph=True
      Carries the damage shape keys from 06_eyes.py. Off by default in some
      presets, and the loss is silent -- the mesh loads fine, the morphs simply
      are not there.

  export_skins=True, export_def_bones=False
      Keeps the skin. `export_def_bones` would prune non-deforming bones, which
      would strip l_eye/r_eye on the SOURCE rig -- they deform nothing until
      06_eyes.py runs. Leaving it off keeps the pipeline order-independent.

  export_yup=True
      glTF is Y-up, Blender is Z-up. This is the conversion 01_import.py undoes
      on the way in; it has to be reapplied on the way out or the figure ships
      lying on its back.

  export_apply=True
      Bakes remaining modifiers. Anything left live is simply not in the file.

A post-export check re-imports the result and asserts the things that have gone
wrong before -- the point is to fail here, in the pipeline, rather than in the
browser twenty minutes later.
"""

import os
import shutil
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    run,
    EXPORT_GLB, SHIP_GLB, ensure_dirs, find_armature, find_body_mesh, log,
    mesh_objects, open_work, reset_scene, script_args,
)


def export(path):
    ensure_dirs()
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_skins=True,
        export_def_bones=False,
        export_morph=True,
        export_morph_normal=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_animations=False,
        use_selection=False,
    )
    log("exported %s (%.1f KB)" % (path, os.path.getsize(path) / 1024.0))


def verify(path):
    """Re-import and check the things that have silently broken before."""
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=path)
    arm = find_armature()
    body = find_body_mesh()
    keys = ([k.name for k in body.data.shape_keys.key_blocks]
            if body.data.shape_keys else [])

    over_four = sum(
        1 for v in body.data.vertices
        if len([g for g in v.groups if g.weight > 0.0]) > 4
    )

    ok = True
    log("VERIFY bones=%d verts=%d uv=%s morphs=%d"
        % (len(arm.data.bones), len(body.data.vertices),
           [uv.name for uv in body.data.uv_layers], len(keys)))
    if not body.data.uv_layers:
        log("VERIFY FAIL: no UV layer survived -- textures cannot be applied")
        ok = False
    if over_four:
        log("VERIFY FAIL: %d verts still exceed 4 influences" % over_four)
        ok = False
    if keys:
        log("VERIFY morph targets: %s" % ", ".join(keys))
    # mesh_objects() filters the importer's bone-display helper, which is a
    # real mesh in bpy.data but is never in the file. Counting raw objects here
    # reports a phantom extra mesh on every run.
    meshes = mesh_objects()
    log("VERIFY meshes: %s" % ", ".join(o.name for o in meshes))
    return ok


def main():
    args = script_args()
    open_work()
    export(EXPORT_GLB)

    if not verify(EXPORT_GLB):
        log("NOT shipping: verification failed")
        sys.exit(1)

    if "--ship" in args:
        shutil.copyfile(EXPORT_GLB, SHIP_GLB)
        log("shipped -> %s" % SHIP_GLB)
        log("The game loads this file. Open the boxer tab and look at it.")
    else:
        log("Left in out/. Pass -- --ship to copy over public/models/.")


run(main)

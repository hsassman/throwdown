"""
01 -- IMPORT. Builds the working .blend that every later script opens.

    blender --background --python blender/scripts/01_import.py

Why a working file at all, rather than each script re-importing the GLB: the
fixes are cumulative. Rig hygiene has to survive the glove fit, which has to
survive the shorts fit. Re-importing between steps would throw all of it away.

WHAT THIS DOES BEYOND A PLAIN IMPORT

  - Drops the glTF importer's wrapper nodes. The importer parents everything
    under an empty called `RootNode` carrying the Y-up-to-Z-up conversion.
    Leaving it means every later world-space measurement is taken through a
    90-degree rotation nobody remembers is there, and a garment fitted in that
    space lands on its side.
  - Drops MHR's COLLISION PROXIES. Found by this pipeline, not previously
    known: the shipped asset carries 77 empties named `Collision 0..76` plus a
    42-vertex `Icosphere`, which are MHR's physics proxies carried through by
    FBX2glTF. They are invisible in the game because they have no material
    worth seeing, which is exactly why nobody noticed them -- but they are
    real nodes in the file and they are exported on every round trip.
  - Applies that transform for real, so rest-pose coordinates in Blender match
    what the scripts expect.
  - Names things predictably, because `find_body_mesh()` picking the "largest"
    mesh stops being reliable once a shorts mesh is in the file.
"""

import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    run,
    SOURCE_GLB, find_armature, find_body_mesh, import_glb, log, reset_scene,
    save_work, script_args, select_only,
)


def main():
    # Positional args are step-specific; FLAGS are global and forwarded to
    # every step by run.mjs, so a flag meant for another step (--ship, read by
    # 07_export.py) must not be mistaken for a source path here.
    args = [a for a in script_args() if not a.startswith("--")]
    src = args[0] if args else SOURCE_GLB

    reset_scene()
    import_glb(src)

    arm = find_armature()
    body = find_body_mesh()

    # Flatten the importer's conversion empty into the armature, then delete
    # it. `transform_apply` on the armature bakes the rotation into the bone
    # rest positions, which is what makes bone_world() usable later.
    arm.parent = None
    select_only(arm)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Strip everything that is not the body or the armature. Deliberately a
    # whitelist rather than a blacklist on the name "Collision": a blacklist
    # would silently keep the next unexpected node a re-export introduces.
    # Garments are added by later steps, so at THIS point the body is the only
    # mesh that should exist.
    strays = []
    for obj in list(bpy.data.objects):
        if obj is arm or obj is body:
            continue
        strays.append("%s(%s)" % (obj.name, obj.type))
        bpy.data.objects.remove(obj, do_unlink=True)
    if strays:
        log("removed %d stray nodes: %s%s" % (
            len(strays),
            ", ".join(strays[:6]),
            " ..." if len(strays) > 6 else "",
        ))

    arm.name = "boxer_rig"
    arm.data.name = "boxer_rig_data"
    body.name = "body"
    body.data.name = "body_mesh"

    # Nothing in this pipeline animates, and a stray action on the armature
    # would pose the figure away from rest without it being obvious in a
    # headless run -- which would then get baked into every garment fit.
    if arm.animation_data:
        arm.animation_data_clear()

    log("armature %s (%d bones), body %s (%d verts)" % (
        arm.name, len(arm.data.bones), body.name, len(body.data.vertices)
    ))
    save_work()


run(main)

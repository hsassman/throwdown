"""
02 -- RIG HYGIENE. Operates on the working file in place.

    blender --background --python blender/scripts/02_rig_fix.py

Four concrete, checkable fixes. Deliberately NOT a general "clean up the rig"
pass -- each one exists because of a specific way this asset or the glTF format
bites.

1. LIMIT TOTAL INFLUENCES TO 4, THEN NORMALIZE.
   glTF's JOINTS_0/WEIGHTS_0 carry exactly four influences per vertex. A fifth
   is dropped at export, and because the remaining four are then no longer
   normalized the affected vertices shrink toward the origin -- a subtle
   collapse, not an error. Limiting here and normalizing after means the export
   is lossless. 00_inspect reports the count so you can see whether it bit.

2. PURGE EMPTY VERTEX GROUPS.
   A group with no weight still exports as a joint and still costs a slot in
   the skeleton. The source has 27 of them (measured -- see rig-facts.json).

3. RECALCULATE BONE ROLL.
   Roll is the one bone property glTF does not carry: it round-trips as part of
   the bind matrix, so an imported rig has arbitrary per-bone roll. That is
   invisible until you try to author a garment or a constraint against a bone's
   local axes, at which point neighbouring bones point their X in unrelated
   directions. Aligned to global Z here, which is the convention the fit
   scripts assume.

4. FLAG THE UNWEIGHTED DEFORM BONES.
   Does not change them -- just reports, loudly. `l_eye` and `r_eye` carrying
   zero weight is the single fact that invalidated the previous eye
   implementation, and it should be impossible to run this pipeline without
   being told.
"""

import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    run,
    BONES, find_armature, find_body_mesh, log, open_work, save_work,
    select_only,
)

MAX_INFLUENCES = 4


def limit_and_normalize(mesh):
    select_only(mesh)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=MAX_INFLUENCES)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    log("limited to %d influences and normalized: %s" % (MAX_INFLUENCES, mesh.name))


def purge_empty_groups(mesh):
    used = set()
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.weight > 0.0:
                used.add(g.group)
    # Names captured BEFORE any removal. Removing a vertex group invalidates
    # the RNA pointers of the others, so holding the group objects and reading
    # .name afterwards raises "StructRNA of type VertexGroup has been removed".
    # That crash used to land AFTER the edits but BEFORE save_work(), throwing
    # away the whole rig-hygiene pass while Blender still exited 0.
    dead = [g.name for g in mesh.vertex_groups if g.index not in used]
    for name in dead:
        vg = mesh.vertex_groups.get(name)
        if vg is not None:
            mesh.vertex_groups.remove(vg)
    log("removed %d empty vertex groups from %s" % (len(dead), mesh.name))
    return dead


def recalc_roll(arm):
    select_only(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.armature.select_all(action="SELECT")
    bpy.ops.armature.calculate_roll(type="GLOBAL_POS_Z")
    bpy.ops.object.mode_set(mode="OBJECT")
    log("recalculated bone roll on %d bones" % len(arm.data.bones))


def main():
    open_work()
    arm = find_armature()
    body = find_body_mesh()

    limit_and_normalize(body)
    removed = purge_empty_groups(body)
    recalc_roll(arm)

    # Report, do not repair. There is no correct automatic repair for a deform
    # bone with no weight -- either it is genuinely decorative (c_tongue0) or
    # the geometry it should drive does not exist (l_eye), and those need
    # opposite responses.
    zero = []
    for b in arm.data.bones:
        vg = body.vertex_groups.get(b.name)
        if b.use_deform and vg is None:
            zero.append(b.name)
    if zero:
        log("NOTE: %d deform bones drive no geometry: %s" % (len(zero), ", ".join(sorted(zero))))
    for key in ("eye_l", "eye_r"):
        name = BONES[key]
        if name in zero or name in removed:
            log("NOTE: %s deforms nothing. Eye geometry must be AUTHORED and "
                "weighted to it (06_eyes.py) -- scaling this bone is a no-op." % name)

    save_work()


run(main)

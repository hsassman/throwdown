"""
00 -- INSPECT. Run this first, and run it again after any re-export.

Measures the source asset and writes blender/out/rig-facts.json. Nothing is
modified. The point is to have ground truth on disk before any script starts
changing things, because every failure this project has already hit on the
character track came from acting on an assumption about the rig instead of a
measurement of it:

  - eye bones assumed to be weighted; they carry zero weight
  - a garment assumed to be in metres; it was in millimetres
  - a cuff assumed to be findable by topology; the mesh was disconnected patches

Read the JSON before writing anything that depends on the rig.

    blender --background --python blender/scripts/00_inspect.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    run,
    OUT_DIR, SOURCE_GLB, find_armature, find_body_mesh, import_glb, log,
    reset_scene, world_bbox, write_json,
)


def main():
    reset_scene()
    import_glb(SOURCE_GLB)

    arm = find_armature()
    mesh = find_body_mesh()
    me = mesh.data

    lo, hi = world_bbox(mesh)

    # Per-vertex-group weight totals. This is THE measurement that matters for
    # anything bone-driven: a bone can exist, animate, and deform absolutely
    # nothing. Counting the weight is the only way to know which is which.
    totals = {g.name: 0.0 for g in mesh.vertex_groups}
    dominant = {g.name: 0 for g in mesh.vertex_groups}
    idx_to_name = {g.index: g.name for g in mesh.vertex_groups}
    over_four = 0
    for v in me.vertices:
        gs = [g for g in v.groups if g.weight > 0.0]
        if len(gs) > 4:
            over_four += 1
        for g in gs:
            name = idx_to_name.get(g.group)
            if name is not None:
                totals[name] += g.weight
        if gs:
            top = max(gs, key=lambda g: g.weight)
            name = idx_to_name.get(top.group)
            if name is not None:
                dominant[name] += 1

    bones = []
    for b in arm.data.bones:
        bones.append({
            "name": b.name,
            "parent": b.parent.name if b.parent else None,
            "head": list(b.head_local),
            "tail": list(b.tail_local),
            "length": b.length,
            "roll": getattr(b, "roll", 0.0),
            "weightTotal": round(totals.get(b.name, 0.0), 4),
            "dominantVerts": dominant.get(b.name, 0),
            "deforms": bool(b.use_deform),
        })

    shape_keys = []
    if me.shape_keys:
        shape_keys = [k.name for k in me.shape_keys.key_blocks]

    facts = {
        "source": os.path.basename(SOURCE_GLB),
        "armature": arm.name,
        "mesh": {
            "name": mesh.name,
            "vertices": len(me.vertices),
            "triangles": len(me.loop_triangles) or sum(
                max(0, len(p.vertices) - 2) for p in me.polygons
            ),
            "uvLayers": [uv.name for uv in me.uv_layers],
            "materials": [m.name if m else None for m in me.materials],
            "bboxMin": list(lo),
            "bboxMax": list(hi),
            "height": hi.z - lo.z,
        },
        # glTF permits at most 4 joint influences per vertex in one JOINTS_0
        # set. Anything above that is silently dropped or split on export, and
        # the symptom is a garment that deforms subtly wrong rather than an
        # error -- so it is counted here where it is visible.
        "verticesOverFourInfluences": over_four,
        "shapeKeys": shape_keys,
        "shapeKeyCount": len(shape_keys),
        "boneCount": len(bones),
        "bones": bones,
        "unweightedBones": sorted(
            b["name"] for b in bones if b["weightTotal"] == 0.0
        ),
    }

    out = os.path.join(OUT_DIR, "rig-facts.json")
    write_json(out, facts)

    log("armature %s, %d bones" % (arm.name, len(bones)))
    log("mesh %s, %d verts, height %.4f" % (mesh.name, len(me.vertices), facts["mesh"]["height"]))
    log("uv layers: %s" % (facts["mesh"]["uvLayers"] or "NONE"))
    log("shape keys: %d" % len(shape_keys))
    log("verts with >4 influences: %d" % over_four)
    log("bones carrying ZERO weight (%d): %s" % (
        len(facts["unweightedBones"]),
        ", ".join(facts["unweightedBones"][:12]) or "none",
    ))


run(main)

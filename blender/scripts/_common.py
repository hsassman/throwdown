"""
Shared helpers for every script in this pipeline.

Run nothing from here directly. Each NN_*.py script imports this, so that the
things that are easy to get subtly wrong -- where files live, which object is
the armature, what glTF export flags this project needs -- are decided in ONE
place rather than re-derived per script.

Every script is designed to run headless:

    blender --background --python blender/scripts/00_inspect.py -- [args]

The `--` matters: Blender consumes everything before it. `script_args()` below
returns only what came after.
"""

import json
import os
import sys

import bpy
from mathutils import Vector

# --------------------------------------------------------------------------
# Paths. Resolved from this file's location, NOT from the current working
# directory, because Blender's cwd depends on how it was launched and a script
# that only works when launched from the repo root is a trap.
# --------------------------------------------------------------------------

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(SCRIPTS_DIR)
REPO_DIR = os.path.dirname(BLENDER_DIR)

SOURCE_DIR = os.path.join(BLENDER_DIR, "source")
KIT_DIR = os.path.join(BLENDER_DIR, "assets", "kit")
OUT_DIR = os.path.join(BLENDER_DIR, "out")

SOURCE_GLB = os.path.join(SOURCE_DIR, "boxer_lod3.glb")
WORK_BLEND = os.path.join(OUT_DIR, "boxer.blend")
EXPORT_GLB = os.path.join(OUT_DIR, "boxer_lod3.glb")
SHIP_GLB = os.path.join(REPO_DIR, "public", "models", "boxer_lod3.glb")

# The rig's real bone names, measured from the shipped asset rather than
# guessed. `tools/rig-introspect.mjs` in the repo root prints these, and
# 00_inspect.py re-derives them here. If a re-export renames anything, every
# script below fails loudly on a missing bone instead of silently doing
# nothing to the wrong one.
BONES = {
    "pelvis": "root",
    "spine": "c_spine0",
    "head": "c_head",
    "jaw": "c_jaw",
    "eye_l": "l_eye",
    "eye_r": "r_eye",
    "hand_l": "l_wrist",
    "hand_r": "r_wrist",
    "lowarm_l": "l_lowarm",
    "lowarm_r": "r_lowarm",
    "upleg_l": "l_upleg",
    "upleg_r": "r_upleg",
    "lowleg_l": "l_lowleg",
    "lowleg_r": "r_lowleg",
    "foot_l": "l_foot",
    "foot_r": "r_foot",
}


def log(msg):
    """Print, flushed. Blender buffers stdout in background mode, so an
    unflushed print from a script that later errors is simply lost."""
    print("[pipeline] %s" % msg, flush=True)


def fail(msg):
    log("FAILED: %s" % msg)
    sys.exit(1)


def run(main):
    """Invoke a step, turning ANY unhandled exception into exit code 1.

    Blender does not reliably propagate a Python exception into its own exit
    code -- a step can raise, print a traceback, and still exit 0. That is how
    02_rig_fix.py once crashed after its edits but before save_work(),
    silently discarding the whole rig-hygiene pass while run.mjs carried on to
    the next step none the wiser. Every NN_*.py calls run(main) so that class
    of silent failure cannot recur.
    """
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        sys.exit(1)


def descendants_of(armature, root_name):
    """Every bone at or below root_name, by name.

    Used to clamp a garment to one limb. Naming those bones by hand is a trap
    on this rig: the foot alone is split across l_ball, l_transversetarsal and
    l_subtalar, and l_foot itself carries NO weight -- so a hand-written
    {l_foot, l_lowleg} clamp set strips every real weight off a boot and
    collapses it to the origin.
    """
    root = armature.data.bones.get(root_name)
    if root is None:
        fail("bone not found: %s" % root_name)
    out = {root.name}
    stack = [root]
    while stack:
        b = stack.pop()
        for c in b.children:
            out.add(c.name)
            stack.append(c)
    return out


def script_args():
    """Arguments after the `--` separator."""
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def ensure_dirs():
    for d in (OUT_DIR, KIT_DIR):
        os.makedirs(d, exist_ok=True)


# --------------------------------------------------------------------------
# Scene access
# --------------------------------------------------------------------------

def reset_scene():
    """Empty .blend, including orphaned data. `bpy.ops.wm.read_factory_settings`
    rather than deleting objects: deleting objects leaves their meshes,
    materials and armature data behind, and a second import then silently
    picks up `Armature.001`."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path=None):
    path = path or SOURCE_GLB
    if not os.path.exists(path):
        fail("no such file: %s" % path)
    bpy.ops.import_scene.gltf(filepath=path)
    log("imported %s" % path)


def find_armature():
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            return obj
    fail("no armature in the scene")


def find_body_mesh():
    """The character's own skin.

    BY NAME first ("body" -- 01_import.py renames it on the way in), falling
    back to the largest skinned mesh only if that name is absent.

    This used to be "largest skinned mesh, no other signal" -- which was
    correct only as long as the body was the biggest thing in the file. It
    stopped being true the moment a real-world shorts asset (37679 verts,
    after weight transfer) landed in the scene: it dwarfs the body's 5429, so
    the size heuristic silently pointed 06_eyes.py at the SHORTS and every
    damage shape key was built on the wrong mesh -- 0 vertices affected on
    all six, discovered only by checking the pipeline's own log output rather
    than assuming a clean run meant a correct one."""
    named = bpy.data.objects.get("body")
    if named is not None and named.type == "MESH":
        return named
    best = None
    best_n = -1
    for obj in bpy.data.objects:
        if obj.type != "MESH" or is_helper(obj):
            continue
        if not any(m.type == "ARMATURE" for m in obj.modifiers):
            continue
        n = len(obj.data.vertices)
        if n > best_n:
            best, best_n = obj, n
    if best is None:
        fail("no skinned mesh in the scene")
    return best


# Blender's glTF importer creates a 42-vertex "Icosphere" as a BONE DISPLAY
# SHAPE and parks it in this reserved collection. It is never exported and it
# is not part of the character -- but it IS a mesh object in bpy.data, so any
# code that counts meshes sees a phantom fourth one. Verified on this asset:
# the exported GLB contains exactly three meshes while the re-import shows
# four. Filtered here so a later step cannot mistake it for a garment.
HELPER_COLLECTION = "glTF_not_exported"


def is_helper(obj):
    return any(c.name == HELPER_COLLECTION for c in obj.users_collection)


def mesh_objects(exclude=()):
    return [
        o for o in bpy.data.objects
        if o.type == "MESH" and o not in exclude and not is_helper(o)
    ]


def bone_world(armature, name):
    """World-space head position of a bone in the REST pose.

    Rest, not pose: every fit in this pipeline happens at bind, and reading the
    posed position would bake whatever pose the file happens to be in into the
    garment's placement."""
    bone = armature.data.bones.get(name)
    if bone is None:
        fail("bone not found: %s" % name)
    return armature.matrix_world @ bone.head_local


def select_only(objs):
    bpy.ops.object.select_all(action="DESELECT")
    objs = objs if isinstance(objs, (list, tuple)) else [objs]
    for o in objs:
        o.select_set(True)
    if objs:
        bpy.context.view_layer.objects.active = objs[-1]


def world_bbox(obj):
    """World-space bounds.

    Computed from the VERTICES for a mesh, not from `obj.bound_box`.
    `bound_box` is a cache that Blender only refreshes on a depsgraph update,
    so straight after a join, a mirror or a transform_apply it still describes
    the PREVIOUS geometry. That is not a hypothetical: it made 03_gloves.py
    read the glove's axis order wrongly and mount the glove across the
    knuckles at 90 degrees, with the search dutifully confirming the choice.
    """
    if obj.type == "MESH" and len(obj.data.vertices):
        pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
        lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        return lo, hi
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


# --------------------------------------------------------------------------
# Save / export
# --------------------------------------------------------------------------

def save_work(path=None):
    ensure_dirs()
    path = path or WORK_BLEND
    bpy.ops.wm.save_as_mainfile(filepath=path)
    log("saved %s" % path)


def open_work(path=None):
    path = path or WORK_BLEND
    if not os.path.exists(path):
        fail("no working file at %s -- run 01_import.py first" % path)
    bpy.ops.wm.open_mainfile(filepath=path)
    log("opened %s" % path)


def write_json(path, data):
    ensure_dirs()
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    log("wrote %s" % path)

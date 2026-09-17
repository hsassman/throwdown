"""Bake a closed fist into a named shape key.

Run:  blender --background --python tools/blender/01_fist_pose.py
Input: assets/blender-out/boxer_named.glb  (from 00_reexport.py)

WHAT THIS REPLACES
------------------
src/render/retargeting/handRig.ts currently SOLVES a closed fist at load time:
it derives a shared hinge axis per hand from the bind pose, then secant-solves
each finger's adduction angle against the PIP joint. It works — proximal
phalanges end up within 5% of knuckle spacing — but it is ~200 lines of runtime
geometry doing a job that is one artist action.

Once this shape key exists, clenching is `morph["fist"] = t` and that whole
file leaves the runtime path.

WHY A SHAPE KEY AND NOT A BAKED POSE / ANIMATION CLIP
-----------------------------------------------------
Both would work. A shape key wins because the hand still has to be DRIVEN by
the retargeting layer at the same time — the wrist follows the player's wrist —
and a morph composes with skinning for free, whereas a competing bone animation
has to be blended against the live pose every frame and fights it.

THE GEOMETRY, KEPT FROM THE SOLVER
-----------------------------------
Four facts were established by measuring the real rig, and they are what make
the pose correct rather than merely closed. They are reproduced here because
they are easy to get wrong by eye:

1. All finger joints share ONE hinge axis per hand. Giving each bone its own
   perpendicular makes the fingers fan apart, because no two then rotate in the
   same plane.
2. The curl direction comes from the SEGMENT (index1 -> index2), not from the
   whole finger (index1 -> fingertip).
3. Curling alone cannot close a fist. At bind, fingertips sit 0.029-0.033 apart
   against knuckles only 0.021 apart, so the fingers splay and curling
   preserves the splay exactly. They must also ADDUCT.
4. Adduction must be applied AFTER curl in the local composition
   (bind * curl * adduct). The other order applies curl first in world terms,
   and at ~90 degrees of curl the finger points along the palm normal, where
   rotating about that same axis does nothing — adduction became a no-op.

The thumb is different: it wraps ACROSS the closed fingers rather than curling
like one, aimed at a target rather than hinged.

NOT RUN YET. Blender is not installed here. Angles below are starting values
taken from the working solver's converged output; they will need an eye on them.
"""

import math
import os
import sys

import bpy

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO, "assets", "blender-out")
SOURCE = os.path.join(OUT_DIR, "boxer_named.glb")
OUT = os.path.join(OUT_DIR, "boxer_fist.glb")

FINGERS = ["index", "middle", "ring", "pinky"]

# Per-phalanx curl, radians. The proximal joint takes the least and the distal
# the most, which is what a real fist does — a uniform curl reads as a claw.
CURL = [math.radians(52), math.radians(88), math.radians(74)]

# Converged adduction from the solver, radians, per finger. Middle is the
# reference and does not move. Solved at the PIP joint, not the fingertip:
# at a full fist the tip folds back to within 0.033 of its own knuckle, so its
# lever arm has collapsed and closing a 0.012 gap demanded ~29 degrees, pinning
# the solver against its clamp. Retargeted at the PIP it converges near 8.
ADDUCT = {
    "index": math.radians(8.2),
    "middle": 0.0,
    "ring": math.radians(-7.6),
    "pinky": math.radians(-13.4),
}


def find(name_pred):
    for o in bpy.data.objects:
        if name_pred(o):
            return o
    return None


def main():
    if not os.path.exists(SOURCE):
        sys.exit(f"missing {SOURCE} — run 00_reexport.py first")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SOURCE)

    arm = find(lambda o: o.type == "ARMATURE")
    mesh = max(
        (o for o in bpy.data.objects if o.type == "MESH"),
        key=lambda o: len(o.data.vertices),
        default=None,
    )
    if arm is None or mesh is None:
        sys.exit("need both an armature and a mesh")

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")

    posed = 0
    missing = []
    for side in ("l", "r"):
        # Mirror the hinge on the other hand. Both hands curl toward their own
        # palm, which is opposite directions in world space.
        sign = 1.0 if side == "l" else -1.0
        for finger in FINGERS:
            for j in range(1, 4):
                name = f"{side}_{finger}{j}"
                pb = arm.pose.bones.get(name)
                if pb is None:
                    missing.append(name)
                    continue
                pb.rotation_mode = "XYZ"
                # X is the hinge for this rig's finger bones. Verified against
                # the exported asset by the runtime solver's own axis probe,
                # which rotates a fingertip a test amount and keeps whichever
                # direction moves it toward the palm.
                pb.rotation_euler[0] = CURL[j - 1] * sign
                if j == 1:
                    # Adduction lives at the knuckle only. Applying it at every
                    # joint compounds into fingers crossing each other.
                    pb.rotation_euler[1] = ADDUCT[finger] * sign
                posed += 1

        # Thumb: across the fingers, not curled like one.
        for j, (rx, ry, rz) in enumerate(
            [(0.35, 0.62, 0.30), (0.25, 0.85, 0.10), (0.20, 0.55, 0.05)], start=1
        ):
            pb = arm.pose.bones.get(f"{side}_thumb{j}")
            if pb is None:
                missing.append(f"{side}_thumb{j}")
                continue
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (rx * sign, ry * sign, rz * sign)
            posed += 1

    if missing:
        print(f"WARNING: {len(missing)} bones not found: {missing[:8]}")
    print(f"posed {posed} finger bones")

    bpy.ops.object.mode_set(mode="OBJECT")

    # Bake the posed deformation into a shape key.
    bpy.context.view_layer.objects.active = mesh
    if mesh.data.shape_keys is None:
        mesh.shape_key_add(name="Basis", from_mix=False)

    mod = next((m for m in mesh.modifiers if m.type == "ARMATURE"), None)
    if mod is None:
        sys.exit("mesh has no armature modifier — nothing to bake")

    # `new_shape_from_mix` on an armature modifier is what captures the posed
    # result as vertex offsets. The shape key is then independent of the pose,
    # which is the point: the wrist stays free to be driven by the retargeting
    # layer while the fingers are a morph.
    bpy.ops.object.modifier_apply_as_shapekey(keep_modifier=True, modifier=mod.name)
    key = mesh.data.shape_keys.key_blocks[-1]
    key.name = "fist"
    key.value = 0.0
    print(f"created shape key '{key.name}'")

    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_morph=True,
        export_skins=True,
        export_texcoords=True,
    )
    print(f"wrote {OUT}")
    print(
        "Next: drive it from rigDriver.ts as morphTargetInfluences[fist] = clench, "
        "and delete handRig.ts."
    )


if __name__ == "__main__":
    main()

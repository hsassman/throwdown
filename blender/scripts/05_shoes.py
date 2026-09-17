"""
05 -- SHOES. Fits a supplied boxing-boot mesh to both feet.

    blender --background --python blender/scripts/05_shoes.py

Needs blender/assets/kit/shoe.glb.

HOW A BOXING BOOT IS ACTUALLY WORN

  - The SOLE sits on the ground, under the foot. The previous fit centred the
    boot on the knee-to-ankle span, which put it halfway up the shin as a red
    patch with a bare foot below it.
  - It runs along the FOOT: heel at the back, toe at the front. On this rig
    the foot points -Y, measured as normalize(l_ball.head - l_foot.head)
    projected flat, about (0.11, -0.99, 0).
  - The SHAFT runs UP THE SHIN. That is a second, independent direction, so
    the boot needs a two-axis orientation: one axis alone would let the shaft
    swing out sideways from the ankle.
  - Boot length slightly exceeds foot length -- there is a toe box.

The foot is measured from the body MESH, not from bone-to-bone distance. Bone
distance measures the skeleton; the boot has to fit the flesh, and the heel
extends behind the ankle joint where there is no bone at all.

WHICH BONES THE FOOT ACTUALLY IS -- measured, and not what the names suggest:

    l_ball               71 dominant verts     forefoot and toes
    l_transversetarsal   62                    midfoot
    l_subtalar           41                    heel and ankle
    l_foot                0                    nothing at all

`l_foot` carries NO weight -- the same class of defect as the eye bones. The
first version of this script measured only l_foot and l_ball and got a foot
0.0790 long; with the real set it is 0.2449, which is 24.5 cm and correct for
a 1.7254 m figure. A boot built on the first number was a third of the size it
should have been.

WEIGHTS: between the glove case and the shorts case. The foot inside a boot is
effectively rigid, but the shaft has to bend with the ankle or it shears
through the leg on every step. So weights are transferred, then clamped to
EVERYTHING BELOW THE KNEE -- taken from the bone hierarchy with
descendants_of(), never hand-listed. A hand-written {l_foot, l_lowleg} clamp
set strips every real weight off the boot (because l_foot has none) and
collapses it to the origin.
"""

import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kitfit  # noqa: E402
from _common import (  # noqa: E402
    BONES, bone_world, descendants_of, log, open_work, save_work,
    select_only, run,
)

SOURCE = "shoe.glb"

# Boot length as a multiple of the measured foot length (the toe box).
LENGTH_OF_FOOT = 1.08
# Clearance kept between skin and boot.
SKIN_OFFSET = 0.004
# Fraction of the foot the boot must actually contain to be accepted.
# How much wider than the foot the boot is cut.
WIDTH_OF_FOOT = 1.15

LEATHER = (0.40, 0.04, 0.05)

FEET = [
    ("shoe_L", "l", BONES["foot_l"], BONES["lowleg_l"], False),
    ("shoe_R", "r", BONES["foot_r"], BONES["lowleg_r"], True),
]


def foot_frame(arm, body, side):
    """Foot direction, shin direction, and the foot's real extent."""
    ankle = bone_world(arm, "%s_foot" % side)
    ball = bone_world(arm, "%s_ball" % side)
    knee = bone_world(arm, "%s_lowleg" % side)

    # Flattened: the ball sits lower than the ankle, so the raw vector points
    # downward and would tip the boot nose-first into the floor.
    forward = Vector((ball.x - ankle.x, ball.y - ankle.y, 0.0))
    if forward.length < 1e-6:
        forward = Vector((0.0, -1.0, 0.0))
    forward.normalize()

    # Up the shin, which is what the shaft follows.
    up = (knee - ankle).normalized()

    # Every bone below the knee, from the hierarchy. See the module docstring:
    # the foot is l_ball + l_transversetarsal + l_subtalar, and l_foot is not
    # part of it in any way that matters.
    # The FOOT: l_foot and everything under it (talocrural -> subtalar ->
    # transversetarsal -> ball). NOT "everything below the knee" -- that also
    # pulls in l_lowleg_twist1..4, which are spread up the SHIN, giving a
    # "foot" 0.4387 tall instead of 0.0716. Scored against that set no boot can
    # ever pass, because no boot contains a shin; it capped out at 48%.
    pts = kitfit.region_points(body, descendants_of(arm, "%s_foot" % side))
    return ankle, ball, knee, forward, up, pts


def build(arm, body, source_meshes, name, side, foot_bone, leg_bone, mirror):
    select_only(source_meshes)
    bpy.ops.object.duplicate()
    obj = kitfit.join(list(bpy.context.selected_objects), name)

    ankle, ball, knee, forward, up, foot_pts = foot_frame(arm, body, side)
    if not foot_pts:
        log("FAILED: no body vertices weighted to the %s foot" % side)
        sys.exit(1)

    heel_t, toe_t = kitfit.extent_along(foot_pts, forward)
    foot_len = toe_t - heel_t
    sole_z = min(p.z for p in foot_pts)
    # HORIZONTAL, from forward x Z -- not up.cross(forward). `up` follows the
    # shin, which leans, so up.cross(forward) is tilted out of the horizontal
    # and is not orthogonal to Z. place_axes sums its constraints assuming
    # orthogonality, so that tilt leaked into the vertical placement and
    # floated the boot off the floor. place_axes now rejects such a set.
    across = forward.cross(Vector((0.0, 0.0, 1.0))).normalized()
    foot_centre_across = sum(p.dot(across) for p in foot_pts) / len(foot_pts)

    boot_len = foot_len * LENGTH_OF_FOOT

    # MIRROR FIRST, THEN ORIENT -- see 03_gloves.py. Reflecting after the
    # orientation throws it onto the other foot's frame.
    if mirror:
        kitfit.mirror_x(obj)
        log("mirrored %s in its own frame, normals rebuilt outward" % name)

    # A boot must clear the foot in EVERY direction, and a uniform scale keyed
    # to length cannot guarantee that. Measured: this source boot is 2.87:1
    # long-to-wide while the figure's foot is 2.51:1, so scaling to length left
    # the boot 0.092 wide around a 0.0976-wide foot -- narrower than the foot
    # inside it. Length and shaft keep the source's proportions; only the width
    # is stretched, which is the least distortion that actually fits.
    across_lo, across_hi = kitfit.extent_along(foot_pts, across)
    boot_width = (across_hi - across_lo) * WIDTH_OF_FOOT

    def prepare(o, prim_axis, sec_axis):
        third = 3 - prim_axis - sec_axis
        lo, hi = kitfit.world_bbox(o)
        size = hi - lo
        along_scale = boot_len / max(1e-9, size[prim_axis])
        factors = [along_scale, along_scale, along_scale]
        factors[third] = boot_width / max(1e-9, size[third])
        kitfit.scale_garment(o, *factors)

    # Heel at the heel, sole on the floor, centred across the foot.
    heel_point = heel_t - (boot_len - foot_len) * 0.5

    def anchor(o):
        kitfit.place_axes(o, [
            (forward, 0.0, heel_point),
            (Vector((0.0, 0.0, 1.0)), 0.0, sole_z),
            (across, 0.5, foot_centre_across),
        ])

    # The boot's orientation is SEARCHED, not deduced. This mesh arrives as 26
    # disconnected boundary loops, so the hole-finding that used to pick toe
    # from heel had nothing coherent to read and returned an arbitrary answer.
    #
    # SCORED ON ANATOMY: a boot's shaft rises over the HEEL, never over the
    # toes. So the rear third of the boot must sit higher than the front third,
    # and the orientation that maximises that difference is the right one.
    #
    # points_inside() is deliberately NOT the score here. On this mesh it tops
    # out near 50% for every orientation, and the escaping vertices scatter
    # evenly along the whole foot (0.00..1.00, mean 0.58) rather than bunching
    # where a real defect would put them -- the signature of surface normals
    # that carry no consistent inside/outside, which is what 26 disconnected
    # patches give you. Reassuringly, both metrics still pick the SAME winner.
    def score(o):
        pts = kitfit.mesh_points(o)
        lo_f, hi_f = kitfit.extent_along(pts, forward)
        span = hi_f - lo_f
        rear = [p.z for p in pts if p.dot(forward) < lo_f + span * 0.33]
        front = [p.z for p in pts if p.dot(forward) > lo_f + span * 0.67]
        if not rear or not front:
            return -1e9
        return sum(rear) / len(rear) - sum(front) / len(front)

    kitfit.fit_orientation(obj, forward, up, anchor, score, name,
                           prepare=prepare)

    kitfit.push_out_penetration(obj, body, SKIN_OFFSET)
    kitfit.transfer_weights(obj, body, arm)
    kitfit.clamp_groups(obj, descendants_of(arm, leg_bone))
    kitfit.set_material(obj, name + "_leather", LEATHER, roughness=0.45)

    log("%s: foot %.4f -> boot %.4f, sole z=%.4f" % (name, foot_len, boot_len, sole_z))
    ok = kitfit.extent_contains(obj, foot_pts, [
        ("heel-toe", forward),
        ("across", across),
        ("vertical", Vector((0.0, 0.0, 1.0))),
    ], name)
    log("%s %s" % ("VERIFY ok" if ok else "VERIFY FAIL", name))
    return obj, ok


def main():
    open_work()
    arm, body = kitfit.context()

    kitfit.clear_previous(["shoe_L", "shoe_R"])
    source = kitfit.import_kit(SOURCE)
    if source is None:
        kitfit.missing(SOURCE, "shoes")
        return

    results = [build(arm, body, source, *spec) for spec in FEET]

    select_only(source)
    bpy.ops.object.delete()

    log("built %s" % ", ".join(o.name for o, _ in results))
    if not all(ok for _, ok in results):
        log("FAILED: boot placement verification did not pass")
        sys.exit(1)
    save_work()


run(main)

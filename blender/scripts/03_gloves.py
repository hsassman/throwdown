"""
03 -- GLOVES. Fits a supplied glove mesh onto both hands.

    blender --background --python blender/scripts/03_gloves.py

Needs blender/assets/kit/glove.glb. Skips cleanly if absent.

HOW A BOXING GLOVE IS ACTUALLY WORN, AND HOW THAT MAPS TO THE RIG

  - It runs along the HAND, not along the forearm. Its long axis points from
    the wrist toward the fingertips: on this rig, normalize(l_middle3.tail -
    l_wrist.head), measured as roughly (0.50, -0.57, -0.66).
  - The CUFF is the anchor. It wraps the wrist and about 10-12 cm of forearm
    behind it. Nothing about the glove is centred on anything.
  - The fist is fully ENCLOSED. If the fingers are visible, the glove is in
    the wrong place -- which is exactly what the previous fit produced, with
    the glove parked on the mid-forearm and a bare hand sticking out of it.
  - It is RIGID. The hand inside does not articulate it, so all weight goes on
    the wrist bone. Blending onto the finger bones lets the glove fold in half.
  - The thumb has its own chamber on the inside edge. That is why this needs a
    two-axis orientation: one axis alone leaves the glove free to spin about
    the hand, putting the thumb underneath.

Real 16oz glove: ~30 cm long overall. This figure is 1.7254 units for a whole
human, so units are metres and the numbers below land near 0.30.

MIRRORED, NOT IMPORTED TWICE. One source mesh reflected in X. Two imports
drift: a tweak has to be made twice and one gets forgotten.
"""

import os
import sys

import bpy
from mathutils import Matrix, Vector
from math import radians

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kitfit  # noqa: E402
from _common import (  # noqa: E402
    BONES, bone_world, descendants_of, log, open_work, save_work,
    select_only, run,
)

SOURCE = "glove.glb"

# How far the cuff runs back up the forearm, as a fraction of forearm length.
# 0.40 of a 0.27 forearm is ~11 cm, which is a real glove cuff.
CUFF_OF_FOREARM = 0.40
# How far the nose extends past the fingertips, as a fraction of hand length.
NOSE_OF_HAND = 0.30
# Fraction of the hand the glove must contain to be accepted.
#
# Scored over the fingers and palm but NOT the thumb. Measured, the escaping
# vertices are overwhelmingly thumb on both hands:
#
#     l_thumb_null 44/46   l_thumb1 23/35   l_thumb2 26/58   l_thumb3 19/30
#     r_thumb_null 46/46   r_thumb1 29/35   r_thumb2 55/58   r_thumb3 30/30
#
# That is the BIND pose, where the thumb is relaxed and splayed clear of the
# fingers. The game never draws it: handRig.ts clenches the fist every frame
# and wraps the thumb ACROSS the fingers, tucking it into the mitt. Scoring a
# pose that is never rendered would mean either a threshold so low it catches
# nothing, or rejecting an orientation that is right in play.
#
# Excluding the thumb, enclosure is 95% left and 86% right. The gap is the rig
# itself rather than the fit -- it is not symmetric (hand length 0.1578 against
# 0.1501), so the two gloves are not the same size.
MIN_ENCLOSED = 0.95
# Overall size trim. 1.0 is the anatomically-derived length; below that simply
# reads as a smaller glove.
SIZE = 0.90
# Roll about the hand axis, degrees.
#
# There is no feature in this source mesh to derive it from -- the glove is
# very nearly symmetric about its length, with per-slice asymmetry wandering
# between -0.81 and +0.68 and no consistent thumb lobe. So it is a look
# decision, and it is a dial rather than a pretend measurement.
#
# ZERO reproduces the orientation shipped before this dial existed, so the
# value reads as "how far round from that". 180 puts the knuckles and the
# curl of the fist the other way up, which is the correct way round.
#
# For this to mean anything, SEC_SIGN below must stay pinned: flipping the
# secondary sign and adding 180 here are the same operation, so while the
# search was free to choose the sign it simply cancelled whatever was set.
ROLL_DEGREES = 180.0
# Pinned so ROLL_DEGREES is the only thing controlling roll. -1 is the value
# the free search used to settle on, which is what makes ROLL_DEGREES = 0 the
# previously-shipped orientation.
SEC_SIGN = -1
# Cross-section widening, applied to the two axes that are NOT the glove's
# length. A boxing glove is a loose shell around a fist, and the last few
# percent of the hand that still escaped after centring were lateral -- so the
# shell wants to be slightly fatter, not longer. Length and silhouette are
# unchanged, which keeps the size the glove was trimmed to.
GIRTH = 1.06

LEATHER = (0.42, 0.045, 0.05)

HANDS = [
    ("glove_L", "l", BONES["hand_l"], BONES["lowarm_l"], False),
    ("glove_R", "r", BONES["hand_r"], BONES["lowarm_r"], True),
]


def hand_frame(arm, side):
    """The two directions that define how a glove sits on this hand."""
    wrist = bone_world(arm, "%s_wrist" % side)
    elbow = bone_world(arm, "%s_lowarm" % side)

    # NOTE ON THIS RIG'S ASYMMETRY, because it decides the whole structure of
    # this script.
    #
    # Bone HEADS are defined symmetrically -- every hand bone matches its
    # mirror to 0.000004 -- and bone lengths match exactly (0.02349 a side).
    # But the TAILS do not: the two `middle3` tails differ by 0.04698, which is
    # precisely twice that bone length, so the two bones point opposite ways.
    #
    # Reading the tail therefore gives a different hand axis and a different
    # hand length per side (0.15778 left against 0.15009 right, axes 7.6-9.7
    # degrees apart). Fitting each glove independently against that produced a
    # pair that was visibly NOT a mirrored pair.
    #
    # Switching to the symmetric head would fix the symmetry but swing the hand
    # axis by 7.64 degrees on the right -- moving a glove that is already
    # right. So the tail stays, ONE glove is fitted, and the other is mirrored
    # from it. See main().
    tip_bone = arm.data.bones.get("%s_middle3" % side)
    tip = arm.matrix_world @ tip_bone.tail_local

    # Along the hand: wrist to middle fingertip. NOT elbow-to-wrist -- the
    # wrist is bent relative to the forearm in this rest pose, and the glove
    # encloses the hand, so it is the hand the glove must follow.
    along = (tip - wrist).normalized()

    # Across the knuckles: index to pinky. This is the axis that decides where
    # the thumb ends up, and it is why a single-axis fit is not enough.
    index = bone_world(arm, "%s_index1" % side)
    pinky = bone_world(arm, "%s_pinky1" % side)
    across = (pinky - index).normalized()

    return wrist, elbow, tip, along, across


def build(arm, body, source_meshes, name, side, hand_bone, arm_bone, mirror):
    select_only(source_meshes)
    bpy.ops.object.duplicate()
    obj = kitfit.join(list(bpy.context.selected_objects), name)

    wrist, elbow, tip, along, across = hand_frame(arm, side)
    hand_len = (tip - wrist).length
    forearm_len = (wrist - elbow).length
    # SIZE trims the cuff and the mitt together. Trimming only the total while
    # leaving the cuff at full length eats the trim entirely out of the mitt --
    # the part that has to cover the hand -- and enclosure fell from 100% to
    # 83% with the fingertips sitting flush against the nose.
    cuff_back = forearm_len * CUFF_OF_FOREARM * SIZE
    glove_len = (forearm_len * CUFF_OF_FOREARM
                 + hand_len * (1.0 + NOSE_OF_HAND)) * SIZE

    # MIRROR FIRST, THEN ORIENT. This order is not cosmetic.
    #
    # The previous version oriented the glove onto the target hand and mirrored
    # it afterwards, which reflected that carefully-built orientation straight
    # back onto the OTHER hand's frame. Measured: the left glove enclosed 100%
    # of its hand and the right one 19%, which is what "bare fingers poking out
    # of the glove" looks like as a number. A glove is chiral; the reflection
    # belongs in the garment's own frame, before it is aimed at anything.
    if mirror:
        kitfit.mirror_x(obj)
        log("mirrored %s in its own frame, normals rebuilt outward" % name)

    lo, hi = kitfit.world_bbox(obj)
    size = hi - lo
    order = sorted(range(3), key=lambda i: size[i], reverse=True)
    long_axis, wide_axis = order[0], order[1]
    scale = glove_len / max(1e-9, size[long_axis])
    factors = [scale * GIRTH] * 3
    factors[long_axis] = scale
    kitfit.scale_garment(obj, *factors)

    # The CUFF is the anchor: it wraps the wrist and runs back up the forearm.
    # Nothing about a glove is centred on anything.
    cuff_point = wrist - along * cuff_back
    side_dir = along.cross(Vector((0.0, 0.0, 1.0)))
    if side_dir.length < 1e-6:
        side_dir = Vector((1.0, 0.0, 0.0))
    side_dir.normalize()
    up_dir = along.cross(side_dir).normalized()

    # Fingers and palm; the thumb is excluded for the reason given at
    # MIN_ENCLOSED. It is still expected to end up inside once clenched -- it
    # is simply not measurable from the bind pose.
    hand_bones = descendants_of(arm, "%s_wrist" % side)
    thumb_bones = descendants_of(arm, "%s_thumb0" % side)
    # The `*_wrist` group is excluded as well, and not to flatter the number.
    # A glove is OPEN at the cuff -- that is the hole the arm goes in by -- so
    # vertices there are genuinely outside the shell and points_inside() is
    # right to say so. Proof it is the opening and not a tight fit: widening
    # the shell by 6% moved that count by exactly zero vertices, because you
    # cannot close a hole by making the surface around it fatter.
    fist_bones = hand_bones - thumb_bones - {"%s_wrist" % side}
    hand_pts = kitfit.region_points(body, fist_bones)

    # Centred LATERALLY on the HAND, not on the wrist joint.
    #
    # The wrist is a point on the skeleton; the hand hanging off it is not
    # centred on that point. Lining the glove's cross-section up with the joint
    # therefore leaves the hand sitting off to one side inside the shell, and
    # poking out through it. Measured, every escape was lateral -- wrist and
    # pinky side, never the fingertips -- which is the signature of an offset
    # rather than of a glove that is too short.
    #
    # This moves the glove by a few millimetres. It changes no orientation, no
    # length and no scale.
    # Centred on the FIST -- the knuckles and fingers -- not on the whole hand
    # group. The `*_wrist` vertex group runs back up the forearm, well past
    # anything a cuff covers, and including it drags the centroid toward the
    # narrow end of the glove and tips the wide end off the knuckles.
    hand_centre = kitfit.centroid(hand_pts)

    def anchor(o):
        kitfit.place_axes(o, [
            (along, 0.0, cuff_point.dot(along)),
            (side_dir, 0.5, hand_centre.dot(side_dir)),
            (up_dir, 0.5, hand_centre.dot(up_dir)),
        ])

    def score(o):
        return kitfit.points_inside(o, hand_pts) / float(max(1, len(hand_pts)))

    # The glove's LONGEST axis runs along the hand and its next-longest across
    # the knuckles. Both are anatomically certain, so they are fixed rather
    # than searched; only the two signs are left to the search.
    # WHICH END IS THE CUFF is a fact about the glove, identical for both
    # hands -- mirroring in X cannot change the polarity of the long axis. It
    # is read from the garment's biggest boundary loop, then pinned.
    #
    # Left to the search it was decided per hand on a near-tie, and the two
    # came out opposite: glove_L took sign +1 and glove_R sign -1, so the
    # right glove wore its cuff at the far end and jammed its nose against the
    # wrist. That is the "right glove is even worse" in the render.
    cuff_end = kitfit.largest_hole_end(obj, long_axis)
    if cuff_end == 0:
        cuff_end = -1
        log("%s: no boundary loops, assuming cuff at the axis minimum" % name)
    prim_sign = -cuff_end

    roll = Matrix.Rotation(radians(ROLL_DEGREES), 4, along)
    knuckles = (roll @ across).normalized()
    covered = kitfit.fit_orientation(obj, along, knuckles, anchor, score, name,
                                     prim_axes=[long_axis],
                                     sec_axes=[wide_axis],
                                     prim_signs=[prim_sign],
                                     sec_signs=[SEC_SIGN])

    kitfit.pin_to_bone(obj, hand_bone, arm)
    kitfit.set_material(obj, name + "_leather", LEATHER, roughness=0.42)

    log("%s: hand %.4f, forearm %.4f -> glove %.4f (cuff back %.4f)"
        % (name, hand_len, forearm_len, glove_len, cuff_back))
    # A real threshold on a real measurement. The bounding-box check this
    # replaces passed happily on a glove enclosing 19% of its hand.
    ok = covered >= MIN_ENCLOSED
    log("%s %s: encloses %.0f%% of the hand (need %.0f%%)"
        % ("VERIFY ok" if ok else "VERIFY FAIL", name,
           covered * 100.0, MIN_ENCLOSED * 100.0))
    return obj, ok


def mirror_pair(source_obj, name, bone, arm):
    """Build the opposite glove as a true reflection of the fitted one.

    Not a second independent fit. The rig's hand bone heads are mirror-exact,
    so reflecting a correctly-fitted glove in world X lands it correctly on the
    other hand -- and it is the only way to guarantee the pair actually
    matches, given the per-side bone-tail asymmetry documented in hand_frame().

    mirror_x() rebuilds the normals, which is not optional: a negative scale
    reverses triangle winding, and without the rebuild the reflected glove is
    entirely backfacing and renders as a see-through shell.
    """
    select_only(source_obj)
    bpy.ops.object.duplicate()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name + "_mesh"
    kitfit.mirror_x(obj)
    kitfit.pin_to_bone(obj, bone, arm)
    kitfit.set_material(obj, name + "_leather", LEATHER, roughness=0.42)
    log("%s: mirrored from %s" % (name, source_obj.name))
    return obj


def main():
    open_work()
    arm, body = kitfit.context()

    kitfit.clear_previous(["glove_L", "glove_R"])
    source = kitfit.import_kit(SOURCE)
    if source is None:
        kitfit.missing(SOURCE, "gloves")
        return

    # Fit the RIGHT glove only.
    right, ok = build(arm, body, source, "glove_R", "r",
                      BONES["hand_r"], BONES["lowarm_r"], True)
    # The LEFT is its reflection, so the two cannot drift apart.
    left = mirror_pair(right, "glove_L", BONES["hand_l"], arm)

    # The imported original is a template; leaving it exports a third glove
    # floating at the origin.
    select_only(source)
    bpy.ops.object.delete()

    # The mirror is verified against the LEFT hand independently -- reflecting
    # a good fit is only as good as the rig's symmetry, so it is measured
    # rather than assumed.
    hand_bones = descendants_of(arm, "l_wrist")
    thumb_bones = descendants_of(arm, "l_thumb0")
    left_pts = kitfit.region_points(body, hand_bones - thumb_bones - {"l_wrist"})
    covered = kitfit.points_inside(left, left_pts) / float(max(1, len(left_pts)))
    ok_left = covered >= MIN_ENCLOSED
    log("%s glove_L: encloses %.0f%% of the hand (need %.0f%%)"
        % ("VERIFY ok" if ok_left else "VERIFY FAIL", covered * 100.0,
           MIN_ENCLOSED * 100.0))

    log("built glove_R (fitted), glove_L (mirrored)")
    if not (ok and ok_left):
        log("FAILED: glove placement verification did not pass")
        sys.exit(1)
    save_work()


run(main)

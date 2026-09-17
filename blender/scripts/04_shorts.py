"""
04 -- SHORTS. Fits a supplied trunks mesh to the hips.

    blender --background --python blender/scripts/04_shorts.py

Needs blender/assets/kit/shorts.glb.

HOW BOXING TRUNKS ARE ACTUALLY WORN

  - The waistband sits HIGH -- at the natural waist, above the hip bone and
    well above where everyday shorts sit. That is the sport's silhouette, and
    it is also why a garment anchored at the pelvis looks wrong even when the
    length is right.
  - The hem finishes just ABOVE the knee.
  - They are SYMMETRIC about the body's centre line. The previous fit centred
    them on the span root -> l_lowleg, which ends at the LEFT knee, so they
    were pushed to x = +0.066 and hung off one hip.
  - They are LOOSE. The cut clears the hips rather than following them.

WHY THE SHRINKWRAP IS GONE

The previous version ran a Shrinkwrap modifier to push the garment clear of
the skin. Shrinkwrap moves EVERY vertex onto the target surface, so it
vacuum-formed the trunks onto the thighs and destroyed the drape. Replaced
with kitfit.push_out_penetration(), which only moves vertices that are
genuinely inside the body.

The source mesh here arrives with 37679 vertices -- nearly seven times the
body's 5429 -- so it is decimated first. That also stopped it being mistaken
for the body by the old "largest skinned mesh" heuristic.
"""

import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kitfit  # noqa: E402
from _common import (  # noqa: E402
    BONES, bone_world, descendants_of, log, open_work, save_work, run,
)

SOURCE = "shorts.glb"

# Waistband height, as a fraction of the way from the pelvis up to the chest.
# Boxing trunks sit at the natural waist, which is well above the hip joint.
WAIST_ABOVE_PELVIS = 0.62
# Hem clearance above the knee, as a fraction of thigh length.
HEM_ABOVE_KNEE = 0.14
# How much wider than the hips the trunks are cut.
LOOSENESS = 1.16
# Clearance kept between skin and cloth.
SKIN_OFFSET = 0.006
# Vertex budget. The body is 5429; trunks do not warrant more.
MAX_VERTS = 6000

CLOTH_COLOUR = (0.30, 0.045, 0.07)


def main():
    open_work()
    arm, body = kitfit.context()

    kitfit.clear_previous(["shorts"])
    source = kitfit.import_kit(SOURCE)
    if source is None:
        kitfit.missing(SOURCE, "shorts")
        return

    obj = kitfit.join(source, "shorts")
    kitfit.decimate(obj, MAX_VERTS)

    # --- where the garment has to go, measured off the body -----------------
    pelvis = bone_world(arm, BONES["pelvis"])
    chest = bone_world(arm, "c_spine2")
    knee_l = bone_world(arm, BONES["lowleg_l"])
    hip_l = bone_world(arm, BONES["upleg_l"])

    waist_z = pelvis.z + (chest.z - pelvis.z) * WAIST_ABOVE_PELVIS
    thigh = abs(hip_l.z - knee_l.z)
    hem_z = knee_l.z + thigh * HEM_ABOVE_KNEE
    height = waist_z - hem_z
    if height <= 1e-6:
        log("FAILED: degenerate waist-to-hem height")
        sys.exit(1)

    # Hip width from the MESH, not the skeleton: the bone-to-bone distance
    # measures the joints, and the trunks have to clear the flesh around them.
    #
    # Restricted to LOWER-BODY bones. A plain height band does not work on a
    # figure in T-pose, because the arms hang at exactly this height -- the
    # first version measured a "hip width" of 1.3061, and the dominant bones in
    # that band were l_middle1, l_pinky1, l_index1 and the rest of both HANDS.
    # It scaled the trunks about 3.2x too wide. Lower body only gives 0.4051.
    # NOT descendants_of("root"): `root` is the skeleton's hierarchy root as
    # well as the pelvis (body_world -> root -> l_upleg / r_upleg / c_spine0),
    # so its descendants are the ENTIRE figure, arms included. Taking the two
    # thigh chains and stopping at the knee is what actually isolates the hips.
    lower = {BONES["pelvis"]}
    for up, low in ((BONES["upleg_l"], BONES["lowleg_l"]),
                    (BONES["upleg_r"], BONES["lowleg_r"])):
        lower |= descendants_of(arm, up) - descendants_of(arm, low)
    band = [p for p in kitfit.region_points(body, lower)
            if hem_z <= p.z <= waist_z]
    if not band:
        log("FAILED: no body vertices between hem and waist")
        sys.exit(1)
    hip_w = max(p.x for p in band) - min(p.x for p in band)
    hip_d = max(p.y for p in band) - min(p.y for p in band)
    y_centre = (max(p.y for p in band) + min(p.y for p in band)) / 2.0

    # --- fit ----------------------------------------------------------------
    lo, hi = kitfit.world_bbox(obj)
    size = hi - lo

    # Source trunks are modelled standing, Z up, waist at the top. Confirmed
    # rather than assumed: the waist is a single boundary loop and the two leg
    # openings are two more, so the end with ONE loop is the waist.
    loops = kitfit.boundary_loops(obj)
    up_sign = 1
    if len(loops) >= 2:
        mid_z = (lo.z + hi.z) / 2.0
        upper = sum(1 for lp in loops if kitfit.centroid(lp).z > mid_z)
        lower = len(loops) - upper
        if upper == 1 and lower >= 2:
            up_sign = 1
        elif lower == 1 and upper >= 2:
            up_sign = -1
        log("shorts: %d boundary loops (%d upper, %d lower) -> waist at %s"
            % (len(loops), upper, lower, "+Z" if up_sign > 0 else "-Z"))

    # Height and girth scale independently: matching only the longest axis
    # would leave the trunks either strangling the hips or hanging off them.
    sz = height / max(1e-9, size.z)
    girth = (hip_w * LOOSENESS) / max(1e-9, size.x)
    kitfit.scale_garment(obj, girth, girth, sz)

    # Primary axis points DOWN the body, waist first.
    down = Vector((0.0, 0.0, -1.0))
    kitfit.orient_garment(obj, kitfit.Z, -up_sign, down,
                          kitfit.X, 1, Vector((1.0, 0.0, 0.0)))

    # Waist at the waist, centred on the body's own centre line.
    kitfit.place_axes(obj, [
        (down, 0.0, down.dot(Vector((0.0, 0.0, waist_z)))),
        (Vector((1.0, 0.0, 0.0)), 0.5, 0.0),
        (Vector((0.0, 1.0, 0.0)), 0.5, y_centre),
    ])

    kitfit.push_out_penetration(obj, body, SKIN_OFFSET)
    kitfit.transfer_weights(obj, body, arm)
    kitfit.set_material(obj, "shorts_cloth", CLOTH_COLOUR, roughness=0.78)

    log("shorts: waist z=%.4f hem z=%.4f height=%.4f hips %.4f x %.4f"
        % (waist_z, hem_z, height, hip_w, hip_d))

    lo, hi = kitfit.world_bbox(obj)
    x_centre = (lo.x + hi.x) / 2.0
    ok = True
    if abs(x_centre) > 0.02:
        log("VERIFY FAIL shorts: off centre, x=%.4f" % x_centre)
        ok = False
    if hi.z < waist_z - 0.03 or lo.z > hem_z + 0.03:
        log("VERIFY FAIL shorts: z span %.4f..%.4f, wanted %.4f..%.4f"
            % (lo.z, hi.z, hem_z, waist_z))
        ok = False
    # Must straddle both legs, not hang off one.
    if not (lo.x < -hip_w * 0.3 and hi.x > hip_w * 0.3):
        log("VERIFY FAIL shorts: does not cover both hips (x %.4f..%.4f)"
            % (lo.x, hi.x))
        ok = False
    if ok:
        log("VERIFY ok shorts: centred x=%.4f, z %.4f..%.4f"
            % (x_centre, lo.z, hi.z))
    else:
        sys.exit(1)

    log("built %s (%d verts)" % (obj.name, len(obj.data.vertices)))
    save_work()


run(main)

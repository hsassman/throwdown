"""
The shared garment fitter. Imported by 03_gloves / 04_shorts / 05_shoes.

WHAT IS AUTOMATED HERE, AND WHAT IS NOT

Automated: unit/scale reconciliation, ORIENTATION, anatomical placement, skin
weight transfer, penetration removal, influence limiting, decimation,
mirroring, materials.

NOT automated: the modelling. You supply the mesh; this fits it.

---------------------------------------------------------------------------
WHY THIS WAS REWRITTEN (2026-09-16, second pass)

The first version fitted a garment by scaling its bounding box to a BONE SPAN
and centring it on that span's MIDPOINT, with no rotation at all. Every part
of that is wrong, and the render showed all three failures at once:

    glove   span l_lowarm -> l_wrist, midpoint = mid-FOREARM
    shorts  span root -> l_lowleg,    midpoint = mid-THIGH
    shoe    span l_lowleg -> l_foot,  midpoint = mid-SHIN

So the gloves sat on the forearms with bare hands poking out past them, the
trunks hung off the thighs, and the boots were patches on the shins. The
shorts were also pushed sideways to x = +0.066, because the span ended at the
LEFT knee and nothing made the garment symmetric.

Three principles come out of that, and they are what this file now implements:

1. A GARMENT IS ORIENTED, NOT JUST SCALED. A glove runs along the hand, a boot
   runs along the foot and up the shin. Both need a real rotation built from
   two body directions, not a bounding-box match.

2. A GARMENT IS ANCHORED AT A LANDMARK, NOT CENTRED ON A SPAN. A glove's CUFF
   goes at the wrist. A boot's HEEL goes at the heel and its SOLE at the
   ground. Trunks hang from the WAIST. Centring anything on a midpoint puts it
   half a limb away from where it belongs.

3. THE BODY IS MEASURED, NOT ASSUMED. Foot length, hand size and hip width all
   come from the body MESH -- the vertices actually weighted to those bones --
   rather than from bone-to-bone distances, which measure the skeleton and not
   the flesh around it.

WHY SHRINKWRAP WAS REMOVED

04_shorts.py used a Shrinkwrap modifier to push the garment clear of the skin.
Shrinkwrap moves EVERY vertex onto the target surface, so it vacuum-formed the
trunks onto the legs and destroyed the garment's own shape. Replaced with
push_out_penetration(), which moves only the vertices that are actually inside
the body and leaves the drape alone.
---------------------------------------------------------------------------
"""

import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    KIT_DIR, fail, find_armature, find_body_mesh, log, select_only, world_bbox,
)

AXES = (Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0)), Vector((0.0, 0.0, 1.0)))
X, Y, Z = 0, 1, 2


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def import_kit(filename):
    """Import one garment file and return its mesh objects.

    Handles glb/gltf/fbx/obj because you do not control what a source asset
    arrives as.
    """
    path = os.path.join(KIT_DIR, filename)
    if not os.path.exists(path):
        return None

    before = set(bpy.data.objects)
    ext = os.path.splitext(filename)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        fail("unsupported kit format: %s" % filename)

    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        fail("%s contained no mesh" % filename)

    # Bake wrapper-node transforms down. Ripped and exported assets bury
    # geometry under empties carrying scale, and a quantised mesh keeps its
    # compensating scale on the NODE -- geometry taken alone lands at the
    # origin at hundreds of times its size. Already hit here once: a 564-unit
    # garment against a 1.725-unit rig.
    #
    # ORDER MATTERS, AND IT WAS WRONG. This used to transform_apply FIRST and
    # then clear the parent with a bare `o.parent = None`. Two faults:
    #
    #   - transform_apply on a parented object bakes only the object's own
    #     matrix; the parent's contribution stays on the parent. Clearing the
    #     parent afterwards then DISCARDS it.
    #   - assigning `.parent` from Python does not refresh matrix_world, so
    #     anything measuring the object before the next depsgraph update reads
    #     the old transform.
    #
    # Together those made the glove measure (6.02, 6.98, 9.99) immediately
    # after import and (602.09, 999.31, 697.85) once an operator forced an
    # update -- 100x larger with Y and Z swapped, which is precisely the glTF
    # Y-up-to-Z-up node transform reappearing. Any axis ordering taken in that
    # window is simply wrong.
    #
    # Clearing with KEEP_TRANSFORM folds the parent's matrix into the object
    # first, so the subsequent apply bakes the REAL world transform into the
    # mesh and every later measurement agrees.
    for o in meshes:
        for m in list(o.modifiers):
            if m.type == "ARMATURE":
                o.modifiers.remove(m)

    parented = [o for o in meshes if o.parent is not None]
    if parented:
        select_only(parented)
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")

    select_only(meshes)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()
    for o in new:
        if o.type == "ARMATURE":
            bpy.data.objects.remove(o, do_unlink=True)

    log("imported kit %s: %s" % (filename, ", ".join(o.name for o in meshes)))
    return meshes


def clear_previous(names):
    """Delete garments from an earlier run of this step.

    Without this the steps are not idempotent: re-running 04 on a file that
    already has trunks in it produces a second pair called "shorts.001",
    sitting inside the first. Since each step is designed to be re-runnable in
    isolation while tuning, that is a trap rather than an edge case.
    """
    gone = []
    for n in names:
        obj = bpy.data.objects.get(n)
        if obj is not None:
            gone.append(n)
            bpy.data.objects.remove(obj, do_unlink=True)
    if gone:
        log("replaced previous %s" % ", ".join(gone))


def join(meshes, name):
    select_only(meshes)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name + "_mesh"
    return obj


def decimate(obj, target_verts):
    """Reduce a heavyweight source mesh before anything else touches it.

    Source garments are modelled for offline rendering: the shorts used here
    arrive with 37679 vertices against a 5429-vertex body. Decimating FIRST
    means the weight transfer, the penetration pass and the export all run on
    the smaller mesh.
    """
    n = len(obj.data.vertices)
    if n <= target_verts:
        return
    mod = obj.modifiers.new(name="decimate", type="DECIMATE")
    mod.ratio = float(target_verts) / float(n)
    select_only(obj)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    log("decimated %s: %d -> %d verts" % (obj.name, n, len(obj.data.vertices)))


# ---------------------------------------------------------------------------
# Measuring the garment
# ---------------------------------------------------------------------------

def mesh_points(obj):
    mw = obj.matrix_world
    return [mw @ v.co for v in obj.data.vertices]


def centroid(points):
    c = Vector((0.0, 0.0, 0.0))
    for p in points:
        c += p
    return c / max(1, len(points))


def extent_along(points, direction):
    d = direction.normalized()
    ts = [p.dot(d) for p in points]
    return min(ts), max(ts)


def boundary_loops(obj):
    """Connected components of the mesh's boundary edges, as point lists.

    Used to tell one END of a garment from the other. A glove has one hole:
    the cuff. A pair of shorts has three: one waist and two legs. That is a
    property of the garment itself rather than of how it happens to be
    oriented in its source file, which makes it a far better signal than
    "assume the modeller pointed it up".
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()

    adj = {}
    for e in bm.edges:
        if not e.is_boundary:
            continue
        a, b = e.verts[0].index, e.verts[1].index
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)

    mw = obj.matrix_world
    seen = set()
    loops = []
    for start in adj:
        if start in seen:
            continue
        stack = [start]
        comp = []
        seen.add(start)
        while stack:
            v = stack.pop()
            comp.append(mw @ bm.verts[v].co)
            for nb in adj[v]:
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        loops.append(comp)
    bm.free()
    return loops


def largest_hole_end(obj, axis):
    """Which end of `axis` the garment's BIGGEST opening sits at: -1 or +1.

    For a glove that opening is the cuff, and this is how the cuff is found.

    The largest loop specifically, not the centroid of all boundary vertices.
    These meshes are not clean shells -- the glove has four boundary loops, and
    only one of them is the cuff:

        loop 0  104 verts  radius 2.99  at 0.14 along the axis   <- the cuff
        loop 1   80 verts  radius 3.22  at 0.46                  interior seam
        loop 2   72 verts  radius 3.22  at 0.47                  interior seam
        loop 3   32 verts  radius 2.26  at 0.01

    Averaging all of them lands near the middle and gives an answer that is
    essentially arbitrary, which is what hole_polarity() did.

    Returns 0 when the mesh has no boundary at all.
    """
    loops = boundary_loops(obj)
    if not loops:
        return 0
    biggest = max(loops, key=len)
    pts = mesh_points(obj)
    d = AXES[axis]
    lo, hi = extent_along(pts, d)
    if hi - lo < 1e-9:
        return 0
    return 1 if centroid(biggest).dot(d) > (lo + hi) / 2.0 else -1


def hole_polarity(obj, axis, expect_holes_at="min"):
    """Which way along `axis` the garment's opening faces.

    Returns +1 if the opening is at the axis MAXIMUM, -1 if at the minimum,
    or 0 when the mesh is closed and gives no signal.
    """
    loops = boundary_loops(obj)
    if not loops:
        return 0
    pts = [p for loop in loops for p in loop]
    d = AXES[axis]
    lo, hi = extent_along(mesh_points(obj), d)
    if hi - lo < 1e-9:
        return 0
    mid = (lo + hi) / 2.0
    opening = centroid(pts).dot(d)
    return 1 if opening > mid else -1


# ---------------------------------------------------------------------------
# Measuring the BODY -- from the mesh, not the skeleton
# ---------------------------------------------------------------------------

def region_points(body, bone_names):
    """World points of body vertices whose dominant weight is one of `bone_names`.

    Dominant weight, not any weight: a vertex with a trace of foot influence
    can sit halfway up the shin, and including it would stretch every foot
    measurement upward.
    """
    want = set(bone_names)
    idx = {g.index: g.name for g in body.vertex_groups}
    mw = body.matrix_world
    pts = []
    for v in body.data.vertices:
        gs = [g for g in v.groups if g.weight > 0.0]
        if not gs:
            continue
        top = max(gs, key=lambda g: g.weight)
        if idx.get(top.group) in want:
            pts.append(mw @ v.co)
    return pts


def band_points(body, z_lo, z_hi):
    """World points of body vertices within a height band."""
    mw = body.matrix_world
    out = []
    for v in body.data.vertices:
        p = mw @ v.co
        if z_lo <= p.z <= z_hi:
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# Orient / scale / place
# ---------------------------------------------------------------------------

def scale_garment(obj, sx, sy, sz):
    """Scale in the garment's OWN frame. Must run before orient_garment()."""
    obj.scale = (obj.scale.x * sx, obj.scale.y * sy, obj.scale.z * sz)
    bpy.context.view_layer.update()
    select_only(obj)
    bpy.ops.object.transform_apply(scale=True)


def orient_garment(obj, prim_axis, prim_sign, prim_target,
                   sec_axis, sec_sign, sec_target):
    """Rotate the garment so two of its own axes land on two body directions.

    Two axes, not one. One axis leaves the garment free to spin about it --
    which for a glove decides whether the thumb points up or down, and for a
    boot decides whether the shaft runs up the shin or sideways out of the
    ankle. A single-axis fit cannot express either.

    The secondary target is orthogonalised against the primary, so the caller
    can pass two roughly-perpendicular anatomical directions without having to
    make them exactly perpendicular first.
    """
    u = AXES[prim_axis] * prim_sign
    w = AXES[sec_axis] * sec_sign
    w = (w - u * w.dot(u)).normalized()
    src = Matrix((u, w, u.cross(w))).transposed()

    big_u = prim_target.normalized()
    big_w = sec_target.normalized()
    big_w = (big_w - big_u * big_w.dot(big_u))
    if big_w.length < 1e-6:
        fail("secondary direction is parallel to the primary")
    big_w.normalize()
    dst = Matrix((big_u, big_w, big_u.cross(big_w))).transposed()

    rot = (dst @ src.transposed()).to_4x4()
    obj.matrix_world = rot @ obj.matrix_world
    bpy.context.view_layer.update()
    select_only(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def place_axes(obj, constraints):
    """Position the garment by pinning it along several orthogonal directions.

    `constraints` is a list of (direction, fraction, target) where `fraction`
    picks a plane through the garment's extent along that direction -- 0.0 is
    the near end, 0.5 the centre, 1.0 the far end -- and `target` is the world
    coordinate that plane should land on, as a dot product with the direction.

    This is what replaces "centre the bounding box on the span midpoint". A
    boot is pinned by its HEEL and its SOLE; a glove by its CUFF; trunks by
    their WAIST. Each is a landmark a tailor would actually use.

    Directions must be mutually orthogonal, so the components can simply be
    summed rather than solved -- and that is CHECKED, not merely documented.
    It was documented before and still went wrong: 05_shoes.py passed an
    `across` axis built as up.cross(forward), where `up` followed the shin.
    Because the shin leans, across.dot(Z) came to 0.1246, so an eighth of the
    sideways correction leaked into the vertical one and floated the boot 2.9
    cm above the floor with the foot poking out underneath. Silent, and only
    caught by measuring the shipped file.
    """
    for i in range(len(constraints)):
        for j in range(i + 1, len(constraints)):
            a = constraints[i][0].normalized()
            b = constraints[j][0].normalized()
            if abs(a.dot(b)) > 1e-4:
                fail("place_axes directions are not orthogonal: %s . %s = %.4f"
                     % (tuple(round(c, 3) for c in a),
                        tuple(round(c, 3) for c in b), a.dot(b)))

    pts = mesh_points(obj)
    delta = Vector((0.0, 0.0, 0.0))
    for direction, fraction, target in constraints:
        d = direction.normalized()
        lo, hi = extent_along(pts, d)
        here = lo + (hi - lo) * fraction
        delta += d * (target - here)
    obj.location = obj.location + delta
    bpy.context.view_layer.update()
    select_only(obj)
    bpy.ops.object.transform_apply(location=True)


def snapshot(obj):
    """Vertex coordinates and transform, so a trial fit can be undone."""
    return ([v.co.copy() for v in obj.data.vertices], obj.matrix_world.copy())


def restore(obj, snap):
    coords, mw = snap
    for v, c in zip(obj.data.vertices, coords):
        v.co = c
    obj.matrix_world = mw
    bpy.context.view_layer.update()


def points_inside(obj, points):
    """How many of `points` lie inside the garment's surface.

    Inside/outside from the sign of the surface normal at the closest point.
    This is the test that actually means something -- "is the hand in the
    glove" -- as opposed to the axis-aligned bounding-box check it replaces,
    which a garment can pass while being rotated 180 degrees.
    """
    inv = obj.matrix_world.inverted()
    nm = obj.matrix_world.to_3x3().inverted().transposed()
    n = 0
    for p in points:
        ok, loc, nor, _ = obj.closest_point_on_mesh(inv @ p)
        if not ok:
            continue
        surface = obj.matrix_world @ loc
        if (p - surface).dot((nm @ nor).normalized()) < 0:
            n += 1
    return n


def fit_orientation(obj, prim_target, sec_target, anchor, score, label,
                    prepare=None, prim_axes=None, sec_axes=None,
                    prim_signs=None, sec_signs=None):
    """Find the orientation that actually puts the body part inside the garment.

    Tries every assignment of the garment's three local axes to the two target
    directions, with both signs -- 24 candidates -- places each one through
    `anchor`, and keeps whichever encloses the most of `score_points`.

    WHY A SEARCH RATHER THAN A RULE

    The previous version worked out which end of a garment was its opening by
    finding the mesh's boundary edges, on the reasoning that a glove's one hole
    is its cuff. Measured on the real assets, that reasoning does not survive
    contact with a ripped mesh:

        glove_L    4 boundary loops
        shoe_L    26 boundary loops

    These are disconnected patches, not shells, so the "opening" centroid is
    meaningless and the polarity it returned was arbitrary. This project's own
    history already recorded the same lesson once -- 6178 of 7494 glove
    vertices sat on a boundary even after welding -- and the rule was written
    anyway.

    A search needs no such assumption. It does not care how the modeller
    oriented the file, whether the mesh is closed, or whether it is one piece.

    `score(obj) -> float` is supplied by the caller, because what makes an
    orientation right is different per garment and the scoring has to say so:

      - a GLOVE is scored on how much of the hand ends up inside it, which
        points_inside() measures well (100% for the right answer against 2%
        for the worst).
      - a BOOT is scored on whether its shaft rises over the HEEL rather than
        over the toes, because points_inside() is not trustworthy on that mesh:
        it is 26 disconnected patches, so surface normals give no coherent
        inside/outside and the escaping points scatter evenly along the whole
        foot instead of clustering where a real defect would be. Both metrics
        happen to agree on the winning orientation, which is what gives
        confidence the geometric one is sound.
    """
    snap = snapshot(obj)
    lo, hi = world_bbox(obj)
    size = hi - lo

    # `prim_axes` / `sec_axes` restrict the search when the answer is known
    # anatomically. A boxing glove is unambiguously longest along the hand, so
    # letting the search choose freely is not open-mindedness, it is a licence
    # to be wrong: it picked the glove's 6.98-wide axis as the hand direction
    # over its 9.99-long one, mounting the glove across the knuckles at 90
    # degrees. Enclosure could not object, because a near-cylindrical glove
    # swallows the hand about as well either way.
    prim_axes = range(3) if prim_axes is None else prim_axes
    sec_axes = range(3) if sec_axes is None else sec_axes
    # `sec_signs` pins the roll about the primary axis. It has to be pinnable,
    # because flipping the secondary SIGN and rotating the secondary TARGET by
    # 180 degrees are the same operation -- so while the sign is searched, a
    # caller's roll offset is silently cancelled by the search choosing the
    # opposite sign, and the dial does nothing.
    sec_signs = (1, -1) if sec_signs is None else sec_signs
    # `prim_signs` pins which END of the garment leads. Left free, the search
    # decided it PER HAND on a near-tie and chose opposite answers for the two
    # gloves -- so one glove wore its cuff at the wrist and the other wore its
    # nose there. Which end is the cuff is a property of the garment, not of
    # the hand, so it must not be re-decided per side.
    prim_signs = (1, -1) if prim_signs is None else prim_signs

    trials = []
    for prim_axis in prim_axes:
        if size[prim_axis] <= 1e-9:
            continue
        for prim_sign in prim_signs:
            for sec_axis in sec_axes:
                if sec_axis == prim_axis or size[sec_axis] <= 1e-9:
                    continue
                for sec_sign in sec_signs:
                    restore(obj, snap)
                    # Scaling can depend on WHICH axis turned out to be the
                    # length and which the height, so it happens per trial, in
                    # the garment's own frame, before the rotation.
                    if prepare is not None:
                        prepare(obj, prim_axis, sec_axis)
                    orient_garment(obj, prim_axis, prim_sign, prim_target,
                                   sec_axis, sec_sign, sec_target)
                    anchor(obj)
                    trials.append((score(obj),
                                   prim_axis, prim_sign, sec_axis, sec_sign))

    if not trials:
        fail("%s: no viable orientation" % label)
    trials.sort(key=lambda t: -t[0])
    best = trials[0]
    worst = trials[-1]

    restore(obj, snap)
    if prepare is not None:
        prepare(obj, best[1], best[3])
    orient_garment(obj, best[1], best[2], prim_target, best[3], best[4], sec_target)
    anchor(obj)

    log("%s: orientation search kept axis %d sign %+d / axis %d sign %+d "
        "-- score %.4f, worst candidate %.4f"
        % (label, best[1], best[2], best[3], best[4], best[0], worst[0]))
    return best[0]


def mirror_x(obj):
    """Reflect in X for the opposite limb, rebuilding normals.

    A negative scale reverses triangle winding, so without the normals rebuild
    the mirrored copy is entirely backfacing and renders as a see-through
    shell. That exact bug shipped in this project's procedural gloves.

    Never run merge-by-distance across the resulting pair: it collapses them
    back into one mesh and silently undoes the reflection.
    """
    obj.scale.x *= -1.0
    bpy.context.view_layer.update()
    select_only(obj)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------------------
# Skinning
# ---------------------------------------------------------------------------

def push_out_penetration(obj, body, offset):
    """Move only the garment vertices that are INSIDE the body.

    Replaces the Shrinkwrap modifier, which moved every vertex onto the body
    surface and so vacuum-formed the trunks onto the legs. Here a vertex is
    only touched when it is on the wrong side of the body surface, so the
    garment's own drape survives.

    Inside/outside comes from the sign of the body's surface normal at the
    closest point, which is reliable for a closed mesh and degrades gracefully
    for an open one (a wrong call moves a vertex by `offset` and no more).
    """
    deps = bpy.context.evaluated_depsgraph_get()
    body_eval = body.evaluated_get(deps)
    to_body = body.matrix_world.inverted()
    from_body = body.matrix_world
    normal_mat = body.matrix_world.to_3x3().inverted().transposed()

    moved = 0
    for v in obj.data.vertices:
        world = obj.matrix_world @ v.co
        ok, loc, nor, _ = body_eval.closest_point_on_mesh(to_body @ world)
        if not ok:
            continue
        surface = from_body @ loc
        normal = (normal_mat @ nor).normalized()
        depth = (world - surface).dot(normal)
        if depth < offset:
            target = surface + normal * offset
            v.co = obj.matrix_world.inverted() @ target
            moved += 1
    log("pushed %d of %d verts of %s clear of the skin (offset %.4f)"
        % (moved, len(obj.data.vertices), obj.name, offset))


def transfer_weights(obj, body, armature):
    """Copy skin weights from the body, then bind to the armature.

    POLYINTERP_NEAREST interpolates across the nearest body FACE rather than
    snapping to the nearest vertex. At a waistband, nearest-vertex quantises
    the weights into bands that crease visibly when the hips rotate.

    Joint indices carry over because both meshes address the armature by
    vertex-group NAME, which also means this survives a re-export that
    reorders bones.
    """
    for g in body.vertex_groups:
        if g.name not in obj.vertex_groups:
            obj.vertex_groups.new(name=g.name)

    select_only([body, obj])
    bpy.context.view_layer.objects.active = obj

    mod = obj.modifiers.new(name="kit_weights", type="DATA_TRANSFER")
    mod.object = body
    mod.use_vert_data = True
    mod.data_types_verts = {"VGROUP_WEIGHTS"}
    mod.vert_mapping = "POLYINTERP_NEAREST"
    mod.layers_vgroup_select_src = "ALL"
    mod.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.datalayout_transfer(modifier=mod.name)
    bpy.ops.object.modifier_apply(modifier=mod.name)

    select_only(obj)
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL",
                                              lock_active=False)
    _bind(obj, armature)
    log("transferred weights onto %s" % obj.name)


def pin_to_bone(obj, bone_name, armature):
    """Force ALL weight onto one bone.

    Correct for rigid kit. A boxing glove does not deform with the fingers
    inside it; blending it across the finger bones lets it fold in half.
    """
    for g in list(obj.vertex_groups):
        obj.vertex_groups.remove(g)
    vg = obj.vertex_groups.new(name=bone_name)
    vg.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    _bind(obj, armature)
    log("pinned %s rigidly to %s" % (obj.name, bone_name))


def clamp_groups(obj, keep):
    """Drop every weight outside an allowed bone set, then renormalize."""
    dropped = 0
    for g in list(obj.vertex_groups):
        if g.name not in keep:
            obj.vertex_groups.remove(g)
            dropped += 1
    select_only(obj)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL",
                                              lock_active=False)
    log("clamped %s to %s (dropped %d groups)"
        % (obj.name, ", ".join(sorted(keep)), dropped))


def _bind(obj, armature):
    for m in list(obj.modifiers):
        if m.type == "ARMATURE":
            obj.modifiers.remove(m)
    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = armature
    obj.parent = armature
    obj.matrix_parent_inverse = armature.matrix_world.inverted()


def set_material(obj, name, base_colour, roughness=0.55, metallic=0.0):
    """A plain glTF-safe Principled material.

    Principled BSDF only: glTF exports a narrow fixed set of node setups and
    anything fancier silently exports as flat grey. Note this project also
    cannot use KHR_materials_pbrSpecularGlossiness -- three.js dropped it in
    r165, so such an asset loads untextured.
    """
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = tuple(base_colour) + (1.0,)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return mat


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def extent_contains(obj, points, axes, label, margin=0.002):
    """Does the garment's extent contain the body part's, on each named axis?

    Acceptance test for garments whose mesh defeats points_inside(). It needs
    no surface normals and no closed shell -- only that along the anatomical
    directions the garment genuinely reaches past what it has to cover. That
    catches a boot that is too short, too narrow, or flipped end-for-end (the
    heel is anchored, so a flipped boot fails to reach the toes).

    Strictly weaker than true containment, and it replaces an AABB check that
    was weaker still: a world-axis-aligned box on a rotated garment passed
    while a boot enclosed a third of its foot.
    """
    pts = mesh_points(obj)
    ok = True
    for name, axis in axes:
        g_lo, g_hi = extent_along(pts, axis)
        b_lo, b_hi = extent_along(points, axis)
        if g_lo > b_lo + margin or g_hi < b_hi - margin:
            log("VERIFY FAIL %s: %s extent %.4f..%.4f does not cover %.4f..%.4f"
                % (label, name, g_lo, g_hi, b_lo, b_hi))
            ok = False
        else:
            log("   %s %s: garment %.4f..%.4f covers body %.4f..%.4f"
                % (label, name, g_lo, g_hi, b_lo, b_hi))
    return ok


def assert_covers(obj, points, label, tolerance=0.0):
    """Check the garment's bounding box actually contains a body landmark.

    Cheap, and it catches the whole class of failure that shipped last time:
    a glove that is not over the hand, a boot that is not over the foot. The
    bounding box is generous, so passing this is a floor and not a guarantee.
    """
    lo, hi = world_bbox(obj)
    bad = []
    for name, p in points:
        inside = all(
            lo[i] - tolerance <= p[i] <= hi[i] + tolerance for i in range(3)
        )
        if not inside:
            bad.append(name)
    if bad:
        log("VERIFY FAIL %s: does not cover %s" % (label, ", ".join(bad)))
        return False
    log("VERIFY ok %s covers %s" % (label, ", ".join(n for n, _ in points)))
    return True


def context():
    return find_armature(), find_body_mesh()


def missing(filename, what):
    log("SKIPPED %s: drop a source mesh at blender/assets/kit/%s first "
        "(see the README in that folder)." % (what, filename))

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildArenaLighting, buildOctagon } from "./arena/Octagon";
import { OCTAGON } from "./arena/octagonSpec";
import { buildRing } from "./arena/Ring";
import { RING, platformHalfSpan } from "./arena/ringSpec";

// Standalone dim-lit view of the octagon. No character, no camera feed, no
// pose tracking - this exists so the arena can be judged on its own, which
// every previous visual problem in this project would have been caught by.
//
// Lazy-loaded by App like BoxerModel, for the same reason: it pulls three.js.

export type StageId = "octagon" | "ring";

interface Props {
  /** Which venue to build. Rebuilds the scene when it changes, which is
   *  correct - it is a different structure, not a different setting. */
  stage?: StageId;
  /** Slowly orbits the camera. Off by default so the arena can be inspected
   *  from a fixed angle without fighting the animation. */
  autoRotate?: boolean;
  /** Hide the chain-link, leaving the structure. Useful for camera work. */
  fencing?: boolean;
  onReady?: () => void;
}

export function ArenaView({
  stage = "octagon",
  autoRotate = true,
  fencing = true,
  onReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Mirrored into refs so toggling them never tears down and rebuilds the
  // whole arena - the same pattern BoxerModel uses for its props.
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // A fight arena is a high-dynamic-range subject: blown-out truss spots
    // over near-black surroundings. Without tone mapping the canvas clips to
    // flat white directly under the key light and the cage crushes to solid
    // black everywhere else.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070a);
    // Fog does the work the crowd would: everything past the far wall falls
    // away into black, so the cage reads as sitting in a dark hall rather than
    // floating in a void. Tied to the arena's own size so it stays correct if
    // the cage is ever rescaled.
    // Sized off whichever venue is being shown, so the haze sits at the same
    // distance relative to the structure in both.
    const span = stage === "ring" ? platformHalfSpan() * 2 : OCTAGON.acrossFlats;
    scene.fog = new THREE.Fog(0x05070a, span * 0.8, span * 3.2);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

    const venue = stage === "ring" ? buildRing() : buildOctagon({ fencing });
    scene.add(venue.group);
    // One number both venues can be framed and lit from: how far the structure
    // reaches from the middle. The octagon reports it directly; a ring's is
    // half its platform.
    const arenaRadius =
      "radius" in venue ? venue.radius : platformHalfSpan();
    const lighting = buildArenaLighting(arenaRadius);
    scene.add(lighting.group);

    // The hall floor the platform stands on. Large, dark, and just reflective
    // enough to catch the truss spots - without it the platform legs end in
    // nothing.
    const floorGeo = new THREE.PlaneGeometry(120, 120);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0a0c10,
      roughness: 0.82,
      metalness: 0.15,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y =
      -(stage === "ring" ? RING.platformHeight : OCTAGON.platformHeight);
    floor.receiveShadow = true;
    scene.add(floor);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    // Stop the camera dropping under the hall floor, where the scene is just
    // the underside of a slab.
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.minDistance = arenaRadius * 0.4;
    controls.maxDistance = arenaRadius * 5;
    controls.target.set(0, 1.0, 0);

    // Open on a broadcast-style three-quarter view: outside the cage, above
    // head height, looking down at the canvas.
    camera.position.set(arenaRadius * 1.9, arenaRadius * 1.15, arenaRadius * 2.1);
    controls.update();

    let raf = 0;
    let disposed = false;
    const clock = new THREE.Clock();

    const resize = () => {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    const tick = () => {
      if (disposed) return;
      const dt = clock.getDelta();
      if (autoRotateRef.current) {
        // Orbit by rotating the camera about the target rather than spinning
        // the arena: spinning the arena would carry the lighting rig with it,
        // and the whole point of a fixed truss is that the highlights stay put
        // while the view moves.
        const a = dt * 0.06;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const dx = camera.position.x - controls.target.x;
        const dz = camera.position.z - controls.target.z;
        camera.position.x = controls.target.x + dx * cos - dz * sin;
        camera.position.z = controls.target.z + dx * sin + dz * cos;
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    readyRef.current?.();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      venue.dispose();
      lighting.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // `fencing` and `stage` rebuild the scene because they change what
    // geometry exists; `autoRotate` does not, and is read from a ref above.
  }, [fencing, stage]);

  return (
    <div
      ref={containerRef}
      className="arena-view"
      role="img"
      aria-label={
        stage === "ring"
          ? "Boxing ring, twenty feet inside the ropes, dim broadcast lighting"
          : "Octagon arena, regulation dimensions, dim broadcast lighting"
      }
    />
  );
}

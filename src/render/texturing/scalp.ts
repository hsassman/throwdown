import * as THREE from "three";

/** Bind-space hairline follows the rig through animation. Its face points +Z. */
export function applyScalp(
  material: THREE.MeshStandardMaterial,
  geometry: THREE.BufferGeometry,
  dominantBones: Int32Array,
  boneNames: string[],
  hair: THREE.Texture,
  tint: string,
  cropped: boolean,
) {
  const positions = geometry.getAttribute("position");
  const bounds = new THREE.Box3();
  const point = new THREE.Vector3();
  for (let i = 0; i < positions.count; i++) {
    if (!/^c_(head|jaw)$/i.test(boneNames[dominantBones[i]] ?? "")) continue;
    point.set(positions.getX(i), positions.getY(i), positions.getZ(i));
    bounds.expandByPoint(point);
  }
  if (bounds.isEmpty()) return;
  const span = bounds.getSize(new THREE.Vector3());
  if (span.y <= 0 || span.z <= 0) return;

  material.onBeforeCompile = shader => {
    shader.uniforms.scalpMap = { value: hair };
    shader.uniforms.scalpTint = { value: new THREE.Color(tint) };
    shader.uniforms.scalpCrop = { value: cropped ? 1 : 0 };
    shader.uniforms.scalpBounds = { value: new THREE.Vector4(bounds.min.y, span.y, bounds.min.z, span.z) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vScalpPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvScalpPosition = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vScalpPosition;
        uniform sampler2D scalpMap;
        uniform vec3 scalpTint;
        uniform float scalpCrop;
        uniform vec4 scalpBounds;`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        float headHeight = (vScalpPosition.y - scalpBounds.x) / scalpBounds.y;
        float headFront = clamp((vScalpPosition.z - scalpBounds.z) / scalpBounds.w, 0.0, 1.0);
        float hairline = mix(0.56, 0.8, smoothstep(0.16, 0.75, headFront));
        hairline -= scalpCrop * (0.04 + 0.014 * sin(vScalpPosition.x * 110.0));
        float coverage = smoothstep(hairline - 0.018, hairline + 0.034, headHeight);
        if (coverage > 0.0) {
          vec2 hairUv = vec2(vScalpPosition.x + vScalpPosition.z * 0.46, vScalpPosition.y);
          vec3 hairGrain = texture2D(scalpMap, hairUv * mix(12.0, 5.0, scalpCrop)).rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, scalpTint * (0.55 + hairGrain * 5.0), coverage * 0.97);
        }`);
  };
  material.customProgramCacheKey = () => "shadowbox-scalp";
}

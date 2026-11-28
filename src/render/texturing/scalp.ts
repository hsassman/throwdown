import * as THREE from "three";
import type { FighterAppearance } from "../../menu/fighterAppearance";

type HairStyle = FighterAppearance["hair"];
const HAIR_PROFILE: Record<HairStyle, number> = { shaved: 0, buzz: 1, crop: 2, taper: 3, part: 4 };

/** The bind-space face and scalp details follow the rig through animation. */
export function applyHeadDetail(
  material: THREE.MeshStandardMaterial,
  geometry: THREE.BufferGeometry,
  dominantBones: Int32Array,
  boneNames: string[],
  hair: THREE.Texture,
  tint: string,
  style: HairStyle,
  eyes: { left: THREE.Vector3; right: THREE.Vector3 } | null,
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
    shader.uniforms.scalpStyle = { value: HAIR_PROFILE[style] };
    shader.uniforms.scalpBounds = { value: new THREE.Vector4(bounds.min.y, span.y, bounds.min.z, span.z) };
    shader.uniforms.faceEyes = {
      value: eyes ? new THREE.Vector4(eyes.left.x, eyes.left.y, eyes.right.x, eyes.right.y) : new THREE.Vector4(),
    };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vScalpPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvScalpPosition = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vScalpPosition;
        uniform sampler2D scalpMap;
        uniform vec3 scalpTint;
        uniform float scalpStyle;
        uniform vec4 scalpBounds, faceEyes;
        float browShape(vec2 point, vec2 eye) {
          float side = sign(eye.x);
          float x = (point.x - eye.x) * side;
          float taper = clamp(1.0 - abs(x + 0.002) / 0.023, 0.0, 1.0);
          float arch = eye.y + 0.0205 + 0.0034 * cos((x + 0.002) * 83.0) - x * 0.085;
          float filaments = 0.68 + 0.32 * sin(point.x * 3500.0 + point.y * 800.0);
          return taper * (1.0 - smoothstep(0.001, 0.0042, abs(point.y - arch))) * filaments;
        }`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        float headHeight = (vScalpPosition.y - scalpBounds.x) / scalpBounds.y;
        float headFront = clamp((vScalpPosition.z - scalpBounds.z) / scalpBounds.w, 0.0, 1.0);
        vec2 facePoint = vScalpPosition.xy;
        float brows = max(browShape(facePoint, faceEyes.xy), browShape(facePoint, faceEyes.zw));
        brows *= smoothstep(0.60, 0.82, headFront) * step(1.0, faceEyes.y);
        vec2 cheekOffset = vec2((abs(facePoint.x) - 0.048) / 0.025,
          (facePoint.y - (faceEyes.y - 0.030)) / 0.018);
        float cheek = exp(-dot(cheekOffset, cheekOffset));
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.04, 0.91, 0.88), cheek * headFront * 0.40);
        diffuseColor.rgb = mix(diffuseColor.rgb, scalpTint * 0.72, brows * 0.78);

        float crop = 1.0 - step(0.5, abs(scalpStyle - 2.0));
        float fade = 1.0 - step(0.5, abs(scalpStyle - 3.0));
        float part = step(3.5, scalpStyle);
        float temple = smoothstep(0.025, 0.077, abs(vScalpPosition.x));
        float hairline = mix(0.56, 0.79, smoothstep(0.16, 0.75, headFront));
        hairline += fade * (0.035 + 0.085 * temple);
        hairline -= crop * (0.035 + 0.010 * sin(vScalpPosition.x * 110.0));
        hairline += part * (0.022 * sin(vScalpPosition.x * 58.0) + 0.05 * temple);
        float hairCoverage = smoothstep(hairline - 0.030 - 0.12 * fade, hairline + 0.034, headHeight)
          * step(0.5, scalpStyle);
        if (hairCoverage > 0.0) {
          vec2 hairUv = vec2(vScalpPosition.x + vScalpPosition.z * 0.46, vScalpPosition.y);
          vec3 grain = texture2D(scalpMap, hairUv * mix(12.0, 5.0, crop)).rgb;
          float partLine = part * (1.0 - smoothstep(0.0012, 0.0036, abs(
            vScalpPosition.x - 0.032 + (headFront - 0.65) * 0.032)));
          float strands = 0.93 + 0.07 * sin(hairUv.x * 1800.0 - cos(hairUv.y * 123.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, scalpTint * (0.55 + grain * 4.0) * strands,
            hairCoverage * (0.97 - partLine * 0.72));
        }`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.93, hairCoverage * 0.85);
      `);
  };
  material.customProgramCacheKey = () => "shadowbox-head-detail";
}

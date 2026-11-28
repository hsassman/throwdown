import * as THREE from "three";

// Fit to the sculpted lids of boxer_lod3.glb. The eye bone is above the
// middle of the opening. Mirror the tilt so both outer corners sit higher.
export const eyeOpeningShader = `
  float eyeOpening(vec2 point, vec2 eye) {
    vec2 offset = point - eye;
    float across = offset.x * sign(eye.x) / 0.0136;
    float arch = max(0.0, 1.0 - across * across);
    float height = offset.y + 0.0055 - across * 0.0011;
    float lid = min(arch * 0.0050 - height, height + arch * 0.0040);
    return min(lid, (1.0 - abs(across)) * 0.0136);
  }
`;

/** Detail the two skinned globes baked into the boxer asset. */
export function textureEyes(
  figure: THREE.Object3D,
  iris: string,
  retired: Set<THREE.Material>,
) {
  const eyes = ["eye_L", "eye_R"].map(name => figure.getObjectByName(name));
  const globes = eyes.filter((eye): eye is THREE.SkinnedMesh =>
    (eye as THREE.SkinnedMesh | undefined)?.isSkinnedMesh === true,
  );
  if (globes.length !== eyes.length) return false;

  for (const eye of globes) {
    eye.geometry.computeBoundingBox();
    const center = eye.geometry.boundingBox!.getCenter(new THREE.Vector3());
    const material = new THREE.MeshPhysicalMaterial({
      roughness: 0.32,
      clearcoat: 0.55,
      clearcoatRoughness: 0.16,
    });
    const old = Array.isArray(eye.material) ? eye.material : [eye.material];
    for (const previous of old) retired.add(previous);
    eye.material = material;
    // The globes are too small to cast useful shadows in the arenas.
    eye.castShadow = false;
    material.customProgramCacheKey = () => "shadowbox-iris";
    material.onBeforeCompile = shader => {
      shader.uniforms.eyeCenter = { value: center };
      shader.uniforms.irisTint = { value: new THREE.Color(iris) };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>
          varying vec3 vEyePosition;
          uniform vec3 eyeCenter;`)
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>
          objectNormal.x = objectNormal.x / 1.20 + sign(eyeCenter.x) * 0.33 * objectNormal.z;`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>
          vEyePosition = position - eyeCenter;
          // The baked globes sit behind a skin shell. Bring them up to the
          // lid opening and taper their depth along the temple.
          vEyePosition.x *= 1.20;
          vEyePosition.y -= 0.0020;
          transformed = eyeCenter + vEyePosition;
          transformed.z += 0.0042 - vEyePosition.x * sign(eyeCenter.x) * 0.33;`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vEyePosition;
          uniform vec3 eyeCenter;
          uniform vec3 irisTint;
          ${eyeOpeningShader}`)
        .replace("#include <map_fragment>", `#include <map_fragment>
          vec2 eyePoint = vEyePosition.xy;
          float lidDepth = eyeOpening(eyePoint + eyeCenter.xy, eyeCenter.xy);
          // Overlap the skin rim so the curved globe still fills the opening
          // when the two surfaces are viewed from the side.
          if (lidDepth < -0.0034 || vEyePosition.z < 0.0) discard;
          vec2 irisPoint = (eyePoint + vec2(0.0, 0.0036)) / 0.0064;
          float radius = length(irisPoint);
          float edge = max(fwidth(radius), 0.035);
          float pupil = 1.0 - smoothstep(0.43 - edge, 0.43 + edge, radius);
          float iris = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, radius);
          float angle = atan(irisPoint.y, irisPoint.x + 0.00001);
          float fibres = 1.0 + (sin(angle * 27.0 + radius * 8.0) * 0.20
            + sin(angle * 53.0 - radius * 4.0) * 0.12)
            * (1.0 - smoothstep(0.04, 0.21, edge));
          vec3 irisColor = irisTint * fibres * mix(1.16, 0.28, smoothstep(0.70, 1.02, radius));
          irisColor = mix(irisColor, vec3(0.009, 0.007, 0.006), pupil);
          float corner = smoothstep(0.005, 0.014, abs(eyePoint.x));
          vec3 sclera = mix(vec3(0.57, 0.52, 0.46), vec3(0.29, 0.14, 0.13), corner * 0.58);
          diffuseColor.rgb = mix(sclera, irisColor, iris)
            * mix(0.54, 1.0, smoothstep(-0.0015, 0.0027, lidDepth));`);
    };
  }
  return true;
}

import * as THREE from "three";

type Slot = "glove" | "trunks" | "boots";

export interface KitTrim {
  laces: string;
  soles: string;
  wraps: string;
}

// Project detail in bind space so it follows the skinned kit and crosses UV seams.
const detail: Record<Slot, string> = {
  boots: `
    float outsole = 1.0 - smoothstep(0.087, 0.115, gear.y);
    float welt = gearBand(gear.y, 0.123, 0.013);
    float laceHeight = smoothstep(0.28, 0.33, gear.y) * (1.0 - smoothstep(0.82, 0.86, gear.y));
    float tongueFront = mix(0.54, 0.34, smoothstep(0.30, 0.51, gear.y));
    float tongue = laceHeight * smoothstep(tongueFront, tongueFront + 0.035, gear.z)
      * (1.0 - smoothstep(0.18, 0.255, abs(gear.x - 0.5)));
    float laceRow = fract((gear.y - 0.31) * 13.7);
    float lace = gearBand(laceRow, 0.25 + (gear.x - 0.5) * 0.9, 0.10)
      + gearBand(laceRow, 0.67 - (gear.x - 0.5) * 0.9, 0.085);
    float eyelet = gearBand(abs(gear.x - 0.5), 0.164, 0.032) * gearBand(laceRow, 0.45, 0.14);
    float toeSeam = gearBand(gear.z, 0.77 - 0.9 * gear.y, 0.009) * (1.0 - smoothstep(0.31, 0.37, gear.y));
    float tread = mix(0.64, 1.0, smoothstep(0.2, 0.55, fract(gear.z * 24.0)));
    diffuseColor.rgb = mix(diffuseColor.rgb, gearSoles * tread, outsole);
    diffuseColor.rgb = mix(diffuseColor.rgb, gearSoles * 1.14, welt * 0.88);
    diffuseColor.rgb *= 1.0 - 0.37 * tongue - 0.22 * toeSeam;
    diffuseColor.rgb = mix(diffuseColor.rgb, gearSoles * 1.25, tongue * eyelet);
    diffuseColor.rgb = mix(diffuseColor.rgb, gearLaces, tongue * min(1.0, lace) * 0.96);
    float gearFabric = max(outsole, tongue);
  `,
  glove: `
    float lengthAlongHand = dot(vec3(gear.x, 1.0 - gear.y, gear.z), vec3(0.38, 0.32, 0.30));
    float cuff = 1.0 - smoothstep(0.40, 0.46, lengthAlongHand);
    float rib = smoothstep(0.29, 0.53, fract(lengthAlongHand * 92.0));
    float cuffSeam = gearBand(lengthAlongHand, 0.42, 0.01) * step(0.32, fract(gear.z * 30.0));
    float laceFace = (1.0 - smoothstep(0.27, 0.53, gear.z))
      * (1.0 - smoothstep(0.16, 0.235, abs(gear.y - 0.7)));
    float laceRow = fract(lengthAlongHand * 29.0);
    float cord = gearBand(laceRow, 0.33 + (gear.y - 0.7) * 1.9, 0.10)
      + gearBand(laceRow, 0.69 - (gear.y - 0.7) * 1.9, 0.08);
    float lacedLength = smoothstep(0.17, 0.20, lengthAlongHand) * (1.0 - smoothstep(0.36, 0.40, lengthAlongHand));
    diffuseColor.rgb = mix(diffuseColor.rgb, gearWraps * mix(0.33, 0.53, rib), cuff);
    diffuseColor.rgb = mix(diffuseColor.rgb, gearWraps * 0.83, cuffSeam * 0.70);
    vec3 cordColour = mix(gearWraps, vec3(0.76, 0.71, 0.63), 0.45);
    diffuseColor.rgb = mix(diffuseColor.rgb, cordColour, laceFace * lacedLength * min(1.0, cord));
    float gearFabric = cuff;
  `,
  trunks: `
    float waist = smoothstep(0.84, 0.87, gear.y);
    float waistbandRib = smoothstep(0.2, 0.5, fract((gear.x + gear.z * 0.54) * 95.0));
    float outerSide = abs(gear.x - 0.5);
    float sidePanel = smoothstep(0.34, 0.42, outerSide) * (1.0 - waist);
    float piping = gearBand(outerSide, 0.377, 0.008) * (1.0 - waist);
    float hem = gearBand(gear.y, 0.064, 0.016);
    float stitch = gearBand(gear.y, 0.85, 0.007) * step(0.38, fract((gear.x + gear.z * 0.48) * 65.0));
    diffuseColor.rgb *= 1.0 - 0.39 * sidePanel - 0.22 * hem;
    diffuseColor.rgb *= 1.0 - waist * mix(0.43, 0.58, waistbandRib);
    vec3 thread = mix(diffuseColor.rgb, vec3(0.57, 0.54, 0.52), 0.45);
    diffuseColor.rgb = mix(diffuseColor.rgb, thread, max(piping * 0.70, stitch * 0.76));
    float gearFabric = max(waist, sidePanel);
  `,
};

export function styleKitDetail(
  material: THREE.MeshStandardMaterial,
  geometry: THREE.BufferGeometry,
  slot: Slot,
  trim: KitTrim,
  mirror: boolean,
) {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds || bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3());
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.gearMin = { value: bounds.min };
    shader.uniforms.gearSize = { value: size };
    shader.uniforms.gearMirror = { value: mirror ? 1 : 0 };
    shader.uniforms.gearLaces = { value: new THREE.Color(trim.laces) };
    shader.uniforms.gearSoles = { value: new THREE.Color(trim.soles) };
    shader.uniforms.gearWraps = { value: new THREE.Color(trim.wraps) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vGearBind;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGearBind = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vGearBind;
        uniform vec3 gearMin, gearSize, gearLaces, gearSoles, gearWraps;
        uniform float gearMirror;
        float gearBand(float value, float centre, float width) {
          return 1.0 - smoothstep(width * 0.45, width, abs(value - centre));
        }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 gear = clamp((vGearBind - gearMin) / gearSize, 0.0, 1.0);
        gear.x = mix(gear.x, 1.0 - gear.x, gearMirror);
        ${detail[slot]}
      `)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.9, gearFabric * 0.8);
      `);
  };
  material.customProgramCacheKey = () => "shadowbox-kit-" + slot;
}

import * as THREE from "three";

/** Each venue owns its textures; no shared GPU resource can be disposed by another view. */
export function artTexture(name: string, repeat = 1): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const texture = new THREE.TextureLoader().load(`/art/${name}.webp`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 4;
  return texture;
}

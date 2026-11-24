import * as THREE from "three";
import { artTexture } from "./artTextures";

/** Static gym dressing. No animation, extra lights or shadow maps compete with tracking. */
export function buildTrainingRoom(centerZ: number) {
  const group = new THREE.Group();
  group.name = "training-room";
  group.position.z = centerZ;
  const resources: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(resource: T): T => {
    resources.push(resource);
    return resource;
  };
  const texture = (name: string, repeat = 1) => {
    const map = artTexture(name, repeat);
    if (map) own(map);
    return map;
  };
  const floor = new THREE.Mesh(
    own(new THREE.PlaneGeometry(10, 10)),
    own(new THREE.MeshStandardMaterial({ map: texture("rubber", 5), color: 0x777d88, roughness: 0.95 })),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.012;
  group.add(floor);

  const wallGeometry = own(new THREE.PlaneGeometry(10, 4));
  const wallMap = texture("brick");
  wallMap?.repeat.set(3, 1.2);
  const wallMaterial = own(new THREE.MeshStandardMaterial({ map: wallMap, color: 0x66616a, roughness: 1 }));
  const beamGeometry = own(new THREE.BoxGeometry(0.12, 4, 0.12));
  const beamMaterial = own(new THREE.MeshStandardMaterial({ map: texture("steel", 2), color: 0x717680, metalness: 0.65, roughness: 0.6 }));
  const signGeometry = own(new THREE.PlaneGeometry(4.5, 1.5));
  const signMaterial = own(new THREE.MeshBasicMaterial({ map: texture("fight-banner"), color: 0x9c8f80 }));
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(Math.sin(angle) * 5, 2, Math.cos(angle) * 5);
    wall.rotation.y = angle + Math.PI;
    group.add(wall);
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.position.set(Math.sin(angle + Math.PI / 4) * 7.02, 2, Math.cos(angle + Math.PI / 4) * 7.02);
    group.add(beam);
    if (i % 2 === 0) {
      const sign = new THREE.Mesh(signGeometry, signMaterial);
      sign.position.set(0, 2.3, Math.cos(angle) * 4.97);
      sign.rotation.y = angle + Math.PI;
      group.add(sign);
    }
  }
  // Framed worldbuilding artwork on the side walls, away from the target.
  const artGeometry = own(new THREE.PlaneGeometry(3, 1.5));
  const artMaterial = own(new THREE.MeshBasicMaterial({ map: texture("gym"), color: 0x888888 }));
  for (const side of [-1, 1]) {
    const art = new THREE.Mesh(artGeometry, artMaterial);
    art.position.set(side * 4.97, 2, 0);
    art.rotation.y = -side * Math.PI / 2;
    group.add(art);
  }
  return { group, dispose() { resources.forEach(resource => resource.dispose()); } };
}

import type * as THREE from 'three';

/**
 * The current lighting tier, for modules that build materials (vehicles, world, fx). Updated by the
 * renderer *before* other 'quality:changed' listeners run (it subscribes first).
 * - `pbr`: High/Ultra — use physically based materials (MeshStandard/Physical) and the sky environment.
 * - `env`: the PMREM sky environment (also on `scene.environment`), or null on Low/Medium.
 */
export const look: { pbr: boolean; env: THREE.Texture | null } = { pbr: false, env: null };

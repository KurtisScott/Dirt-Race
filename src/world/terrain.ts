import * as THREE from 'three';
import { Group, groups, RAPIER, type PhysicsWorld } from '../core/physics';
import { CELL, type CourseData, WALL_END } from './course';
import { makeTerrainLayers, TERRAIN_LAYER_COUNT } from './textures';

/**
 * Terrain: one Rapier heightfield for physics, and a chunked mesh for rendering that uses exactly the
 * same vertices and triangle split, blended from 8 procedural layers in a single texture array.
 *
 * Chunks far from the road (beyond the valley walls) are built at 1/4 resolution with skirts to hide
 * cracks. Each chunk is one draw call; frustum culling drops the rest.
 */
const CHUNK = 40; // cells per chunk side (80 m)
const FAR_STEP = 4;

export interface TerrainHandles {
  mesh: THREE.Group;
  material: THREE.MeshLambertMaterial;
  layers: THREE.DataArrayTexture;
  dispose(): void;
}

export function createTerrainCollider(physics: PhysicsWorld, c: CourseData): RAPIER.Collider {
  const w = (c.NX - 1) * CELL;
  const d = (c.NZ - 1) * CELL;
  const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.x0 + w / 2, 0, c.z0 + d / 2));
  const desc = RAPIER.ColliderDesc.heightfield(c.NZ - 1, c.NX - 1, c.heights, { x: w, y: 1, z: d }, RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES)
    .setFriction(0.9)
    .setCollisionGroups(groups(Group.GROUND, 0xffff));
  const col = physics.world.createCollider(desc, body);
  physics.tag(col, { kind: 'ground' });
  return col;
}

export function createTerrainMesh(c: CourseData, textureSize: number): TerrainHandles {
  const layers = makeTerrainLayers(textureSize);
  const material = makeTerrainMaterial(layers);
  const group = new THREE.Group();
  group.name = 'terrain';
  const nxC = Math.ceil((c.NX - 1) / CHUNK);
  const nzC = Math.ceil((c.NZ - 1) / CHUNK);
  const wts = new Float32Array(TERRAIN_LAYER_COUNT);
  for (let cx = 0; cx < nxC; cx++) {
    for (let cz = 0; cz < nzC; cz++) {
      const j0 = cx * CHUNK;
      const i0 = cz * CHUNK;
      const j1 = Math.min(c.NX - 1, j0 + CHUNK);
      const i1 = Math.min(c.NZ - 1, i0 + CHUNK);
      // Nearest road distance within the chunk decides the resolution.
      let minD = Infinity;
      for (let j = j0; j <= j1; j += 2) for (let i = i0; i <= i1; i += 2) minD = Math.min(minD, c.dist[i + j * c.NZ]);
      if (minD > WALL_END + 150) continue; // never visible (outside the valley, hidden by the walls & fog)
      let geo: THREE.BufferGeometry;
      if (minD >= WALL_END + 10) geo = buildChunk(c, j0, i0, j1, i1, FAR_STEP, wts);
      else {
        // Mixed chunk: full resolution (= exactly the physics surface) in 8×8-cell blocks near the
        // road/river/hill; half resolution (with short skirts hiding T-junction cracks) elsewhere.
        const parts: THREE.BufferGeometry[] = [];
        const B = 8;
        for (let bj = j0; bj < j1; bj += B) {
          for (let bi = i0; bi < i1; bi += B) {
            const ej = Math.min(j1, bj + B);
            const ei = Math.min(i1, bi + B);
            let near = Infinity;
            let flatness = 0;
            for (let j = bj; j <= ej; j += 2)
              for (let i = bi; i <= ei; i += 2) {
                const k = i + j * c.NZ;
                near = Math.min(near, c.dist[k] - c.halfWidthAt(c.nearS[k]));
                flatness = Math.max(flatness, Math.abs(c.heights[k] - c.heights[Math.min(c.heights.length - 1, k + 1)]));
              }
            const x = c.x0 + bj * CELL;
            const z = c.z0 + bi * CELL;
            const rc = c.riverCoords(x + B, z + B);
            const river = Math.abs(rc.a) < 22 && rc.b > c.river.bMin - 20 && rc.b < c.river.bMax + 20;
            const hill = c.hillU(x + B, z + B).h > 0.5 || c.hillU(x, z).h > 0.5;
            const full = near < 14 || river || hill;
            parts.push(buildChunk(c, bj, bi, ej, ei, full ? 1 : 2, wts, !full));
          }
        }
        geo = mergeChunkParts(parts);
      }
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  return {
    mesh: group,
    material,
    layers,
    dispose() {
      layers.dispose();
      material.dispose();
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    },
  };
}

function buildChunk(c: CourseData, j0: number, i0: number, j1: number, i1: number, step: number, wts: Float32Array, forceSkirt = false, skirtDepth = 4): THREE.BufferGeometry {
  const cols: number[] = [];
  const rows: number[] = [];
  for (let j = j0; j < j1; j += step) cols.push(j);
  cols.push(j1);
  for (let i = i0; i < i1; i += step) rows.push(i);
  rows.push(i1);
  const nC = cols.length;
  const nR = rows.length;
  const skirt = step > 1 || forceSkirt;
  const sd = forceSkirt && step <= 2 ? 1.2 : skirtDepth;
  const nV = nC * nR + (skirt ? 2 * (nC + nR) : 0);
  const pos = new Float32Array(nV * 3);
  const nrm = new Float32Array(nV * 3);
  const wA = new Uint8Array(nV * 4);
  const wB = new Uint8Array(nV * 4);
  const H = c.heights;
  const NZ = c.NZ;
  const hAt = (i: number, j: number): number => H[THREE.MathUtils.clamp(i, 0, NZ - 1) + THREE.MathUtils.clamp(j, 0, c.NX - 1) * NZ];
  let v = 0;
  const writeV = (i: number, j: number, yOff: number): void => {
    const x = c.x0 + j * CELL;
    const z = c.z0 + i * CELL;
    const y = hAt(i, j);
    pos[v * 3] = x;
    pos[v * 3 + 1] = y + yOff;
    pos[v * 3 + 2] = z;
    const s = step;
    const dx = (hAt(i, j + s) - hAt(i, j - s)) / (2 * s * CELL);
    const dz = (hAt(i + s, j) - hAt(i - s, j)) / (2 * s * CELL);
    const l = Math.hypot(dx, 1, dz);
    nrm[v * 3] = -dx / l;
    nrm[v * 3 + 1] = 1 / l;
    nrm[v * 3 + 2] = -dz / l;
    c.layerWeights(x, z, y, Math.hypot(dx, dz), wts);
    for (let k = 0; k < 4; k++) {
      wA[v * 4 + k] = Math.round(wts[k] * 255);
      wB[v * 4 + k] = Math.round(wts[k + 4] * 255);
    }
    v++;
  };
  for (let a = 0; a < nC; a++) for (let b = 0; b < nR; b++) writeV(rows[b], cols[a], 0);
  const idx: number[] = [];
  const id = (a: number, b: number): number => a * nR + b; // a = column (x), b = row (z)
  for (let a = 0; a < nC - 1; a++) {
    for (let b = 0; b < nR - 1; b++) {
      const v00 = id(a, b);
      const v01 = id(a + 1, b); // x+
      const v10 = id(a, b + 1); // z+
      const v11 = id(a + 1, b + 1);
      // Same diagonal as Rapier's heightfield: (x+, z) – (x, z+). CCW seen from above (+Y).
      idx.push(v00, v10, v01, v01, v10, v11);
    }
  }
  if (skirt) {
    // Skirts hang 4 m down from every border vertex.
    const edge = (list: number[]): void => {
      const base = v;
      for (const e of list) {
        const a = Math.floor(e / nR);
        const b = e % nR;
        writeV(rows[b], cols[a], -sd);
      }
      for (let k = 0; k < list.length - 1; k++) idx.push(list[k], base + k, list[k + 1], list[k + 1], base + k, base + k + 1);
    };
    const bottom: number[] = [];
    const top: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    for (let a = 0; a < nC; a++) {
      bottom.push(id(a, 0));
      top.push(id(nC - 1 - a, nR - 1));
    }
    for (let b = 0; b < nR; b++) {
      right.push(id(nC - 1, b));
      left.push(id(0, nR - 1 - b));
    }
    edge(bottom);
    edge(right);
    edge(top);
    edge(left);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, v * 3), 3));
  geo.setAttribute('wA', new THREE.BufferAttribute(wA.subarray(0, v * 4), 4, true));
  geo.setAttribute('wB', new THREE.BufferAttribute(wB.subarray(0, v * 4), 4, true));
  geo.setIndex(nV > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

function mergeChunkParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.attributes.position.count;
    ni += p.index!.count;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const wA = new Uint8Array(nv * 4);
  const wB = new Uint8Array(nv * 4);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let ov = 0;
  let oi = 0;
  for (const p of parts) {
    const n = p.attributes.position.count;
    pos.set(p.attributes.position.array as Float32Array, ov * 3);
    nrm.set(p.attributes.normal.array as Float32Array, ov * 3);
    wA.set(p.attributes.wA.array as Uint8Array, ov * 4);
    wB.set(p.attributes.wB.array as Uint8Array, ov * 4);
    const src = p.index!.array;
    for (let k = 0; k < src.length; k++) idx[oi + k] = src[k] + ov;
    ov += n;
    oi += src.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('wA', new THREE.BufferAttribute(wA, 4, true));
  g.setAttribute('wB', new THREE.BufferAttribute(wB, 4, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Lambert material whose diffuse colour is a per-vertex blend of up to 8 texture-array layers. */
function makeTerrainMaterial(layers: THREE.DataArrayTexture): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.name = 'terrain';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLayers = { value: layers };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 wA; attribute vec4 wB;
        varying vec4 vWA; varying vec4 vWB; varying vec2 vXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWA = wA; vWB = wB; vXZ = position.xz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uLayers;
        varying vec4 vWA; varying vec4 vWB; varying vec2 vXZ;
        vec3 tl(float l, vec2 uv) { return texture(uLayers, vec3(uv, l)).rgb; }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec2 uv = vXZ * 0.25;          // 4 m tiles
          vec2 uvR = vXZ * 0.125;        // larger tiles for rock
          vec3 c = vec3(0.0);
          float wsum = 0.0;
          if (vWA.x > 0.01) { c += tl(0.0, uv) * vWA.x; wsum += vWA.x; }
          if (vWA.y > 0.01) { c += tl(1.0, uv) * vWA.y; wsum += vWA.y; }
          if (vWA.z > 0.01) { c += tl(2.0, uv * 1.6) * vWA.z; wsum += vWA.z; }
          if (vWA.w > 0.01) { c += tl(3.0, uv) * vWA.w; wsum += vWA.w; }
          if (vWB.x > 0.01) { c += tl(4.0, uv * 0.7) * vWB.x; wsum += vWB.x; }
          if (vWB.y > 0.01) { c += tl(5.0, uvR) * vWB.y; wsum += vWB.y; }
          if (vWB.z > 0.01) { c += tl(6.0, uv) * vWB.z; wsum += vWB.z; }
          if (vWB.w > 0.01) { c += tl(7.0, uv) * vWB.w; wsum += vWB.w; }
          c /= max(wsum, 0.001);
          // Large-scale brightness variation breaks up visible tiling.
          float macro = texture(uLayers, vec3(vXZ * 0.013, 1.0)).r;
          c *= 0.78 + macro * 0.5;
          diffuseColor.rgb *= c;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'dirt-race-terrain-v1';
  return mat;
}

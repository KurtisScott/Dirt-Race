import * as THREE from 'three';
import type { PBRSet } from './pbrTextures';
import { windTime as windTimeRef } from './vegetation';

/**
 * Round 2 terrain material for High/Ultra: MeshStandardMaterial (sun + sky IBL + soft shadows) whose
 * albedo / roughness / normal come from a 12-layer splat of the photographic-style texture set:
 *
 *  - height-based blending (stones poke through dirt, grass covers soil unevenly instead of cross-fading)
 *  - per-layer tile size, roughness and normal strength; a second, larger-scale albedo sample far away
 *    plus low-frequency macro variation to hide tiling
 *  - triplanar projection for the rock layers on steep slopes (canyon / valley walls don't stretch)
 *  - wet mud puddles (glossy, flat, dark → reflect the sky), wet river bed, snow sparkle
 *  - road detail from the per-vertex road weight + lateral offset (aRoad): darker compacted wheel ruts
 *    (dirty slush ruts on the snowy pass) and loose berms at the edges, so every road reads clearly
 *
 * Layer order = world/course.ts LAYERS: grass, dirt, gravel, mud, sand, rock, riverbed, field, snow,
 * forest, redrock, track.
 */
const TILE = [3.2, 4, 2.6, 5, 5.5, 8, 3, 3.2, 6, 4, 9, 4];
const ROUGH = [0.96, 0.92, 0.86, 0.5, 0.93, 0.78, 0.45, 0.95, 0.6, 0.95, 0.84, 0.9];
const NSTR = [1.0, 1.1, 1.3, 0.8, 0.9, 1.3, 1.2, 1.0, 0.8, 1.1, 1.3, 1.0];
const f = (a: number[]): string => `float[12](${a.map((x) => x.toFixed(3)).join(', ')})`;

export function makeTerrainPBRMaterial(set: PBRSet): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'terrain-pbr';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAlb = { value: set.albedo };
    sh.uniforms.uNH = { value: set.nh };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 wA; attribute vec4 wB; attribute vec4 wC; attribute vec2 aRoad;
        varying vec4 vWA; varying vec4 vWB; varying vec4 vWC; varying vec2 vRoad;
        varying vec3 vTPos; varying vec3 vTNrm;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWA = wA; vWB = wB; vWC = wC; vRoad = aRoad;
        vTPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vTNrm = normalize(mat3(modelMatrix) * normal);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAlb;
        uniform sampler2DArray uNH;
        varying vec4 vWA; varying vec4 vWB; varying vec4 vWC; varying vec2 vRoad;
        varying vec3 vTPos; varying vec3 vTNrm;
        const float TILE[12] = ${f(TILE)};
        const float ROUGH[12] = ${f(ROUGH)};
        const float NSTR[12] = ${f(NSTR)};
        float th21(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
        float tvn(vec2 p) {
          vec2 i = floor(p); vec2 g = fract(p); g = g * g * (3.0 - 2.0 * g);
          return mix(mix(th21(i), th21(i + vec2(1, 0)), g.x), mix(th21(i + vec2(0, 1)), th21(i + vec2(1, 1)), g.x), g.y);
        }
        vec3 tNrmW; float tRough; vec3 tSpark;
        // Tangent-space normal (xy from the map) on a projection plane → world space (whiteout-style).
        vec3 tPerturb(vec4 nh, vec3 N, vec3 T, vec3 B, float k) {
          vec2 xy = (nh.rg * 2.0 - 1.0) * k;
          return T * xy.x + B * xy.y + N * sqrt(max(1.0 - dot(xy, xy), 0.05));
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          float W[12];
          W[0] = vWA.x; W[1] = vWA.y; W[2] = vWA.z; W[3] = vWA.w;
          W[4] = vWB.x; W[5] = vWB.y; W[6] = vWB.z; W[7] = vWB.w;
          W[8] = vWC.x; W[9] = vWC.y; W[10] = vWC.z; W[11] = vWC.w;
          vec3 N = normalize(vTNrm);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
          vec3 B = cross(T, N);
          float dist = length(vTPos - cameraPosition);
          float farK = smoothstep(22.0, 90.0, dist);
          float nFade = 1.0 - smoothstep(35.0, 160.0, dist);
          float steep = smoothstep(0.86, 0.62, N.y);
          vec2 axz = abs(N.xz) + 1e-3;
          axz /= (axz.x + axz.y);

          // Pass 1: sample every active layer, height-weighted score.
          vec3 A[12]; vec3 NW[12]; float S[12];
          float best = -10.0;
          for (int i = 0; i < 12; i++) {
            S[i] = -10.0;
            if (W[i] < 0.012) continue;
            float fi = float(i);
            vec2 uv = vTPos.xz / TILE[i];
            vec4 nh; vec3 a;
            if ((i == 5 || i == 10) && steep > 0.01) {
              // Triplanar for rock walls: top + the two side planes.
              vec2 ux = vTPos.zy / TILE[i];
              vec2 uz = vTPos.xy / TILE[i];
              vec4 n0 = texture(uNH, vec3(uv, fi));
              vec4 nx = texture(uNH, vec3(ux, fi));
              vec4 nz = texture(uNH, vec3(uz, fi));
              vec3 a0 = texture(uAlb, vec3(uv, fi)).rgb;
              vec3 ax = texture(uAlb, vec3(ux, fi)).rgb;
              vec3 az = texture(uAlb, vec3(uz, fi)).rgb;
              vec3 w3 = vec3((1.0 - steep), steep * axz.x, steep * axz.y);
              a = a0 * w3.x + ax * w3.y + az * w3.z;
              nh = n0 * w3.x + nx * w3.y + nz * w3.z;
              float k = NSTR[i] * nFade;
              vec3 sx = sign(N.x + 1e-4) * vec3(0.0, 0.0, 1.0);
              vec3 sz = sign(N.z + 1e-4) * vec3(1.0, 0.0, 0.0);
              NW[i] = normalize(tPerturb(n0, N, T, B, k) * w3.x
                + tPerturb(nx, N, normalize(sx - N * dot(sx, N)), vec3(0.0, 1.0, 0.0), k) * w3.y
                + tPerturb(nz, N, normalize(sz - N * dot(sz, N)), vec3(0.0, 1.0, 0.0), k) * w3.z);
            } else {
              nh = texture(uNH, vec3(uv, fi));
              a = texture(uAlb, vec3(uv, fi)).rgb;
              if (farK > 0.0) {
                // Larger-scale second sample far away: no visible repeats across the valley.
                vec3 a2 = texture(uAlb, vec3(uv * 0.27 + vec2(0.37, 0.71), fi)).rgb;
                a = mix(a, a2, farK * 0.6);
              }
              NW[i] = tPerturb(nh, N, T, B, NSTR[i] * nFade);
            }
            A[i] = a;
            // Wheel-polished ruts on roads sit lower: loose stuff (gravel/sand) builds up beside them.
            S[i] = W[i] * 1.6 + nh.b * 0.55;
            best = max(best, S[i]);
          }
          // Pass 2: blend the layers within a narrow height band of the winner.
          vec3 alb = vec3(0.0); vec3 nrm = vec3(0.0); float rough = 0.0; float wsum = 0.0;
          float mudWet = 0.0; float snowW = 0.0; float wetW = 0.0;
          for (int i = 0; i < 12; i++) {
            float bw = max(S[i] - (best - 0.28), 0.0);
            if (bw <= 0.0) continue;
            vec3 a = A[i];
            float r = ROUGH[i];
            vec3 nw = NW[i];
            if (i == 3) {
              // Mud: puddles in the low spots — dark, glossy, flat (they mirror the sky).
              float hh = clamp((S[i] - W[i] * 1.6) / 0.55, 0.0, 1.0);
              float pud = smoothstep(0.42, 0.3, hh) * (0.6 + 0.4 * tvn(vTPos.xz * 0.35));
              a *= mix(1.0, 0.42, pud);
              r = mix(r, 0.05, pud);
              nw = normalize(mix(nw, N, pud));
              mudWet += bw * pud;
            }
            if (i == 6) { a *= 0.78; wetW += bw; }
            if (i == 8) snowW += bw;
            alb += a * bw; nrm += nw * bw; rough += r * bw; wsum += bw;
          }
          alb /= max(wsum, 1e-4);
          nrm = normalize(nrm);
          rough /= max(wsum, 1e-4);
          snowW /= max(wsum, 1e-4);

          // Macro variation (no texture fetch): large soft patches of lighter/darker, drier/greener ground.
          float m1 = tvn(vTPos.xz * 0.018);
          float m2 = tvn(vTPos.xz * 0.061 + 7.0);
          alb *= 0.84 + 0.22 * m1 + 0.12 * m2 - 0.06;
          alb = mix(alb, alb * vec3(1.06, 1.0, 0.9), smoothstep(0.55, 0.85, m2) * (1.0 - snowW));

          // Roads: two pairs of wheel ruts (darker, smoother; dirty slush on snow) + loose berms at the edges.
          float road = clamp(vRoad.x, 0.0, 1.0);
          if (road > 0.01) {
            float lat = vRoad.y * 24.0;
            float al = abs(lat);
            float brk = 0.65 + 0.35 * tvn(vTPos.xz * 0.21);
            float rut = (1.0 - smoothstep(0.22, 0.5, abs(al - 1.05))) + (1.0 - smoothstep(0.22, 0.5, abs(al - 2.75)));
            rut *= road * brk;
            vec3 slush = vec3(0.30, 0.29, 0.28);
            alb = mix(alb * (1.0 - 0.16 * rut), mix(alb, slush, 0.55), rut * snowW);
            rough = mix(rough, mix(rough * 0.9, 0.32, snowW), rut);
            nrm = normalize(mix(nrm, N, rut * 0.45));
            float edge = road * (1.0 - road) * 4.0;
            alb *= 1.0 - 0.1 * edge;
          }
          // Snow sparkle: tiny glints that come and go as the camera moves.
          tSpark = vec3(0.0);
          if (snowW > 0.05) {
            vec2 g = floor(vTPos.xz * 55.0);
            float h = th21(g + floor(cameraPosition.xz * 0.8));
            tSpark = vec3(1.0, 0.98, 0.95) * step(0.9965, h) * snowW * (1.0 - smoothstep(8.0, 45.0, dist)) * 1.6;
          }
          tNrmW = nrm;
          tRough = clamp(rough, 0.04, 1.0);
          diffuseColor.rgb *= alb;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tNrmW, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += tSpark;');
  };
  mat.customProgramCacheKey = () => 'dirt-race-terrain-pbr-v1';
  return mat;
}

/**
 * PBR asphalt for the town road and the end-jump run-up: aggregate texture in world space, darker polished
 * wheel paths, and road markings drawn from the ribbon's UV (u across 0..1, v along = s / 12 m): solid
 * white edge lines and a dashed white centre line.
 */
export function makeAsphaltPBRMaterial(set: PBRSet): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  mat.name = 'asphalt-pbr';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAA = { value: set.asphaltAlbedo };
    sh.uniforms.uAN = { value: set.asphaltNH };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n varying vec3 vAPos; varying vec2 vAUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vAPos = (modelMatrix * vec4(position, 1.0)).xyz; vAUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uAA; uniform sampler2D uAN;
        varying vec3 vAPos; varying vec2 vAUv;
        vec3 aNrmW; float aRough;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec2 uv = vAPos.xz / 4.0;
          vec3 a = texture2D(uAA, uv).rgb;
          vec4 nh = texture2D(uAN, uv);
          float dist = length(vAPos - cameraPosition);
          a = mix(a, texture2D(uAA, uv * 0.29 + 0.31).rgb, smoothstep(25.0, 90.0, dist) * 0.5);
          float u = vAUv.x;
          float v = vAUv.y;
          // Polished wheel paths (both lanes).
          float wp = 0.0;
          wp += 1.0 - smoothstep(0.02, 0.05, abs(u - 0.17));
          wp += 1.0 - smoothstep(0.02, 0.05, abs(u - 0.33));
          wp += 1.0 - smoothstep(0.02, 0.05, abs(u - 0.67));
          wp += 1.0 - smoothstep(0.02, 0.05, abs(u - 0.83));
          a *= 1.0 - 0.12 * wp;
          float r = 0.86 - 0.18 * wp;
          // Markings.
          float aa = fwidth(u) * 1.5;
          float edge = smoothstep(0.035 - aa, 0.035, u) * (1.0 - smoothstep(0.058, 0.058 + aa, u))
                     + smoothstep(0.942 - aa, 0.942, u) * (1.0 - smoothstep(0.965, 0.965 + aa, u));
          float dash = step(0.5, fract(v * 1.0));
          float centre = (1.0 - smoothstep(0.009, 0.009 + aa, abs(u - 0.5))) * dash;
          float paint = clamp(edge + centre, 0.0, 1.0);
          // Worn paint: aggregate shows through.
          paint *= 0.75 + 0.25 * smoothstep(0.3, 0.7, nh.b);
          a = mix(a, vec3(0.86, 0.86, 0.82), paint);
          r = mix(r, 0.62, paint);
          vec2 xy = (nh.rg * 2.0 - 1.0) * (1.0 - paint * 0.7) * (1.0 - smoothstep(30.0, 140.0, dist));
          aNrmW = normalize(vec3(xy.x, sqrt(max(1.0 - dot(xy, xy), 0.05)), xy.y));
          aRough = r;
          diffuseColor.rgb *= a;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = aRough;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(aNrmW, 0.0)).xyz);');
  };
  mat.customProgramCacheKey = () => 'dirt-race-asphalt-pbr-v1';
  return mat;
}

/**
 * River water for High/Ultra: glossy PBR surface reflecting the sky environment, two scrolling normal
 * layers, colour and opacity from the depth under each vertex (clear and sandy-green in the shallows, dark
 * teal in the middle), and foam lines where it meets the banks.
 */
export function makeWaterPBRMaterial(normal: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, depthWrite: false, envMapIntensity: 1.2 });
  mat.name = 'water-pbr';
  const time = { value: 0 };
  mat.userData.time = time;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWN = { value: normal };
    sh.uniforms.uWTime = windTimeRef;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n attribute float aDepth; varying float vDepth; varying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vDepth = aDepth; vWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uWN; uniform float uWTime; varying float vDepth; varying vec3 vWPos; float wFoam;
        float wh(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
        float wn(vec2 p) { vec2 i = floor(p); vec2 g = fract(p); g = g * g * (3.0 - 2.0 * g);
          return mix(mix(wh(i), wh(i + vec2(1, 0)), g.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), g.x), g.y); }`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          float d = max(vDepth, 0.0);
          vec3 shallow = vec3(0.16, 0.20, 0.12);
          vec3 deep = vec3(0.012, 0.045, 0.05);
          diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 1.1, d));
          diffuseColor.a = mix(0.25, 0.9, smoothstep(0.0, 0.9, d));
          float n = wn(vWPos.xz * 1.3 + vec2(uWTime * 0.35, uWTime * 0.12)) * 0.6 + wn(vWPos.xz * 4.1 - uWTime * 0.5) * 0.4;
          wFoam = smoothstep(0.32, 0.02, d) * smoothstep(0.35, 0.75, n + (0.25 - d));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.86), wFoam * 0.85);
          diffuseColor.a = max(diffuseColor.a, wFoam * 0.9);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.04, 0.7, wFoam);')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec2 uv = vWPos.xz * 0.11;
          vec3 n1 = texture2D(uWN, uv + vec2(uWTime * 0.021, uWTime * 0.034)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uWN, uv * 2.3 - vec2(uWTime * 0.031, -uWTime * 0.017)).xyz * 2.0 - 1.0;
          vec2 xy = (n1.xy + n2.xy) * 0.32;
          vec3 nw = normalize(vec3(xy.x, 1.0, xy.y));
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'dirt-race-water-pbr-v1';
  return mat;
}

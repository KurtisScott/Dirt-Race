import * as THREE from 'three';

/**
 * Round 2 atmosphere: ONE analytic sky colour function (GLSL) shared by
 *  - the sky dome (plus clouds and the sun disc on High/Ultra),
 *  - the fog of every material (aerial perspective: distant things fade into exactly the sky colour
 *    behind them, warmer toward the sun, bluer overhead), and
 *  - the PMREM environment map (image-based lighting and reflections on High/Ultra).
 *
 * The sun never moves, so its direction and the sky colours are baked into the shader chunks as
 * constants when `installAtmosphere` patches three's fog chunks (once, before anything compiles).
 */

/** Direction *towards* the sun (normalised): afternoon, from the south-west, fairly high. */
export const SUN_DIR = new THREE.Vector3(-0.45, 0.62, 0.55).normalize();

/** Linear-RGB sky palette. `horizon` is also the fog colour uniform (scene.fog.color). */
export const ATMOS = {
  zenith: new THREE.Color(0x2f78cf),
  horizon: new THREE.Color(0xc9dcea),
  haze: new THREE.Color(0xffe2bb), // warm Mie glow around the sun
  // Below the horizon (env map only: what the sunlit grass/dirt bounces). Warm and fairly bright, or
  // walls and cars in shade see only the blue sky and turn lavender.
  ground: new THREE.Color(0x7c7656),
  sun: new THREE.Color(0xfff1dc),
};

const v3 = (c: THREE.Color, k = 1): string => `vec3(${(c.r * k).toFixed(4)}, ${(c.g * k).toFixed(4)}, ${(c.b * k).toFixed(4)})`;

/** GLSL: `vec3 atmosphere(vec3 dir, vec3 horizon)`; dir normalised, world space. Linear RGB. */
export function atmosphereGLSL(): string {
  const s = SUN_DIR;
  return /* glsl */ `
  #ifndef ATMOS_DEFINED
  #define ATMOS_DEFINED
  const vec3 ATMOS_SUN = vec3(${s.x.toFixed(5)}, ${s.y.toFixed(5)}, ${s.z.toFixed(5)});
  vec3 atmosphere(vec3 d, vec3 horizon) {
    float h = max(d.y, 0.0);
    float s = max(dot(d, ATMOS_SUN), 0.0);
    // Rayleigh-ish gradient: pale at the horizon, deep blue overhead.
    vec3 c = mix(horizon, ${v3(ATMOS.zenith)}, pow(min(h * 1.35, 1.0), 0.6));
    // Mie forward scattering: warm haze around the sun, strongest low in the sky.
    float lowSky = 1.0 - min(h * 1.6, 1.0);
    c = mix(c, ${v3(ATMOS.haze)}, pow(s, 5.0) * 0.5 * lowSky);
    c += ${v3(ATMOS.haze, 0.35)} * pow(s, 18.0);
    // The far side of the sky (away from the sun) is a touch darker and bluer.
    c *= 0.9 + 0.1 * s;
    return c;
  }
  #endif
  `;
}

let installed = false;

/**
 * Replace three's fog chunks (all materials, all quality levels) with distance + direction fog:
 * exponential with distance between fog.near and fog.far, coloured by `atmosphere(view direction)`, thinner
 * looking up. Costs one vec3 varying and a handful of ALU ops per pixel.
 */
export function installAtmosphere(): void {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif
`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // View-space offset rotated back to world space (camera → fragment).
  vFogWorld = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif
`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${atmosphereGLSL()}
#endif
`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    float fd = length(vFogWorld);
    vec3 fdir = vFogWorld / max(fd, 1e-4);
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * fd * fd );
    #else
      // Aerial perspective: exponential haze from fogNear, ~96 % at fogFar (geometry ends there).
      float fogFactor = 1.0 - exp( - max( fd - fogNear * 0.75, 0.0 ) * 2.6 / max( fogFar - fogNear * 0.75, 1.0 ) );
      fogFactor = min( fogFactor * 1.08, 1.0 );
    #endif
    // Thinner looking up (height falloff): the hill tops stay crisper than the valley floor far away.
    fogFactor *= clamp( 1.0 - fdir.y * 1.2, 0.45, 1.0 );
    vec3 fogTint = atmosphere( normalize( vec3( fdir.x, max( fdir.y, 0.0 ), fdir.z ) ), fogColor );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
  }
#endif
`;
}

/**
 * Sky dome material. `clouds` adds a procedural cloud layer (High/Ultra) and `env` renders the version
 * used for the environment map (below-horizon ground colour, softer sun).
 */
export function makeSkyMaterial(opts: { clouds: boolean; env?: boolean; sunIntensity?: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    defines: { ...(opts.clouds ? { CLOUDS: 1 } : {}), ...(opts.env ? { ENV: 1 } : {}) },
    uniforms: {
      horizon: { value: ATMOS.horizon.clone() },
      ground: { value: ATMOS.ground.clone() },
      sunColor: { value: ATMOS.sun.clone().multiplyScalar(opts.sunIntensity ?? 40) },
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunColor; uniform float time;
      varying vec3 vDir;
      ${atmosphereGLSL()}
      #ifdef CLOUDS
      float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float vn(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
      #endif
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = atmosphere(vec3(d.x, max(d.y, 0.0), d.z), horizon);
        float s = max(dot(d, ATMOS_SUN), 0.0);
        #ifdef CLOUDS
        if (d.y > 0.0) {
          // Cumulus layer on a plane: coverage from fbm, lit side toward the sun, fading to the horizon.
          vec2 uv = d.xz / (d.y + 0.12) * 1.6 + vec2(time * 0.004, time * 0.0015);
          float n = fbm(uv);
          float cov = smoothstep(0.6, 0.86, n);
          float edge = smoothstep(0.52, 0.95, n);
          float lit = 0.75 + 0.35 * fbm(uv * 1.9 + 3.0) + 0.25 * pow(s, 4.0);
          vec3 cloud = mix(vec3(0.72, 0.76, 0.84), vec3(1.25, 1.22, 1.16), lit * (1.0 - 0.3 * edge));
          float fade = smoothstep(0.02, 0.22, d.y);
          c = mix(c, cloud * (0.85 + 0.25 * horizon.b), cov * fade * 0.9);
        }
        #endif
        #ifdef ENV
        // Below the horizon: the sunlit ground the world bounces back.
        c = mix(c, ground, smoothstep(0.0, -0.08, d.y));
        #endif
        // Sun disc + tight glow.
        c += sunColor * (smoothstep(0.99985, 0.99993, s) + pow(s, 2200.0) * 0.08);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

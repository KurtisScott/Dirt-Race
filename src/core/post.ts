import * as THREE from 'three';
import { BlendFunction, BloomEffect, Effect, EffectAttribute, EffectComposer, EffectPass, RenderPass, SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';

/**
 * Round 2 post-processing (High = 'light', Ultra = 'full'), on the `postprocessing` package:
 *
 *   RenderPass (HalfFloat HDR buffer)
 *   → N8AO ambient occlusion (Ultra, half resolution, depth-only: no extra scene pass)
 *   → EffectPass: bloom (mip blur, HDR threshold) · speed blur (Ultra) · exposure · AgX tone mapping · grade + vignette
 *   → EffectPass: SMAA (medium preset on Ultra, low on High)
 *
 * The renderer's own tone mapping is off while this is active (it all happens here).
 */
export type PostMode = 'light' | 'full';

/** Exposure (pre tone-mapping) + subtle radial speed blur from the screen centre. */
class SpeedBlurEffect extends Effect {
  constructor() {
    super(
      'SpeedBlur',
      /* glsl */ `
      uniform float strength;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec2 d = uv - vec2(0.5, 0.56);
        float r = length(d);
        float k = strength * smoothstep(0.12, 0.75, r);
        if (k < 0.0005) { outputColor = inputColor; return; }
        vec4 acc = inputColor;
        for (int i = 1; i <= 5; i++) acc += texture2D(inputBuffer, uv - d * k * float(i) * 0.2);
        outputColor = acc / 6.0;
      }`,
      { attributes: EffectAttribute.CONVOLUTION, uniforms: new Map([['strength', new THREE.Uniform(0)]]) },
    );
  }
}

class ExposureEffect extends Effect {
  constructor(exposure: number) {
    super(
      'Exposure',
      /* glsl */ `
      uniform float exposure;
      uniform vec3 whiteBalance;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = vec4(inputColor.rgb * exposure * whiteBalance, inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        uniforms: new Map<string, THREE.Uniform>([
          ['exposure', new THREE.Uniform(exposure)],
          ['whiteBalance', new THREE.Uniform(new THREE.Vector3(1.02, 1.0, 0.97))],
        ]),
      },
    );
  }
}

/** Display-space grade: contrast S-curve, saturation, warm highlights / cool shadows, vignette. */
class GradeEffect extends Effect {
  constructor() {
    super(
      'Grade',
      /* glsl */ `
      uniform float contrast;
      uniform float saturation;
      uniform float vignette;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, saturation);
        // Gentle S-curve around mid grey.
        c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
        // Split tone: shadows a hair cooler, highlights a hair warmer.
        c += (vec3(-0.012, -0.002, 0.014) * (1.0 - l) + vec3(0.012, 0.004, -0.012) * l);
        vec2 d = uv - 0.5;
        c *= 1.0 - vignette * smoothstep(0.35, 0.95, dot(d, d) * 2.2);
        outputColor = vec4(c, inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        uniforms: new Map<string, THREE.Uniform>([
          ['contrast', new THREE.Uniform(0.22)],
          ['saturation', new THREE.Uniform(1.08)],
          ['vignette', new THREE.Uniform(0.22)],
        ]),
      },
    );
  }
}

/**
 * n8ao 2.0.1's multi-render-target helper overrides `texture` to return the whole `textures` array, which
 * three r187's setupRenderTarget can't handle (`texture.mipmaps` of an array). Restore the standard getter
 * (first texture) on that helper class; n8ao itself only uses `.textures[i]` on r162+.
 */
function patchN8AOTargets(ao: N8AOPostPass): void {
  const t = (ao as unknown as { depthDownsampleTarget?: object }).depthDownsampleTarget;
  if (!t) return;
  const proto = Object.getPrototypeOf(t) as object;
  if ((proto as { __dirtPatched?: boolean }).__dirtPatched) return;
  Object.defineProperty(proto, 'texture', {
    configurable: true,
    get(this: { textures: THREE.Texture[] }) {
      return this.textures[0];
    },
    set(this: { textures: THREE.Texture[] }, v: THREE.Texture) {
      this.textures[0] = v;
    },
  });
  (proto as { __dirtPatched?: boolean }).__dirtPatched = true;
}

export class PostFX {
  readonly composer: EffectComposer;
  private ao: N8AOPostPass | null = null;
  private speed: SpeedBlurEffect | null = null;
  private exposure: ExposureEffect;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    readonly mode: PostMode,
  ) {
    const full = mode === 'full';
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
      stencilBuffer: false,
    });
    this.composer.addPass(new RenderPass(scene, camera));
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (full) {
      const ao = new N8AOPostPass(scene, camera, size.x, size.y);
      ao.setQualityMode('Low');
      const c = ao.configuration;
      c.halfRes = true;
      c.depthAwareUpsampling = true;
      c.aoRadius = 1.4;
      c.distanceFalloff = 0.35;
      c.intensity = 1.6;
      c.gammaCorrection = false;
      c.color = new THREE.Color(0x0a0c10);
      // No transparency pass: it re-renders the transparent objects (water, particles) into two more
      // full-resolution targets every frame (~48 MB, a second partial scene render).
      c.transparencyAware = false;
      (ao as unknown as { autoDetectTransparency: boolean }).autoDetectTransparency = false;
      patchN8AOTargets(ao);
      this.ao = ao;
      this.composer.addPass(ao as unknown as EffectPass);
    }
    const bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.1, luminanceSmoothing: 0.25, intensity: full ? 0.55 : 0.4, radius: 0.7, levels: full ? 6 : 4, resolutionScale: 0.5 });
    this.exposure = new ExposureEffect(1.15);
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const grade = new GradeEffect();
    const effects: Effect[] = [bloom];
    if (full) {
      this.speed = new SpeedBlurEffect();
      // Convolution effects can't share a pass with each other; speed blur goes first on its own.
      this.composer.addPass(new EffectPass(camera, this.speed));
    }
    effects.push(this.exposure, tone, grade);
    this.composer.addPass(new EffectPass(camera, ...effects));
    this.composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: full ? SMAAPreset.MEDIUM : SMAAPreset.LOW })));
  }

  /** 0..1 radial blur strength (Ultra only; set from the player's speed). */
  setSpeedBlur(k: number): void {
    if (this.speed) (this.speed.uniforms.get('strength') as THREE.Uniform<number>).value = THREE.MathUtils.clamp(k, 0, 1) * 0.045;
  }

  setExposure(e: number): void {
    (this.exposure.uniforms.get('exposure') as THREE.Uniform<number>).value = e;
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h, false);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    (this.ao as unknown as { dispose?: () => void } | null)?.dispose?.();
  }
}

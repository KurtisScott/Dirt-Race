// Minimal typings for the parts of n8ao (ISC) used by core/post.ts.
declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three';
  import type { Pass } from 'postprocessing';
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoSamples: number;
      aoRadius: number;
      denoiseSamples: number;
      denoiseRadius: number;
      distanceFalloff: number;
      intensity: number;
      color: Color;
      gammaCorrection: boolean;
      halfRes: boolean;
      depthAwareUpsampling: boolean;
      screenSpaceRadius: boolean;
      transparencyAware: boolean;
    };
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  }
}

import type { SurfaceProps, SurfaceType } from '../core/types';

/**
 * Surface physics table (SPEC "Surfaces"). Vehicles combine this with their own
 * stats (e.g. off-road rating reduces drag/grip loss). Tune here.
 */
export const SURFACES: Record<SurfaceType, SurfaceProps> = {
  asphalt: { grip: 1.0, drag: 0.0, rolling: 0.15 },
  dirt: { grip: 0.82, drag: 0.04, rolling: 0.35 },
  gravel: { grip: 0.7, drag: 0.05, rolling: 0.45 },
  mud: { grip: 0.5, drag: 0.22, rolling: 1.6 },
  sand: { grip: 0.6, drag: 0.12, rolling: 1.0 },
  water: { grip: 0.72, drag: 0.15, rolling: 0.8 },
};

/** Colours used for placeholder ground/debug rendering. */
export const SURFACE_COLORS: Record<SurfaceType, number> = {
  asphalt: 0x4a4d52,
  dirt: 0x8a6a45,
  gravel: 0x9a9286,
  mud: 0x4f3a24,
  sand: 0xe0c98f,
  water: 0x4f8fb5,
};

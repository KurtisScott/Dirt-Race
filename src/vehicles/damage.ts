/**
 * Damage rules (SPEC Round 2 item 2). Pure functions + one tuning table, so tests can check thresholds
 * without physics. The vehicle (vehicle.ts) detects hits; the model (models/damageFx.ts) shows them.
 *
 * Damage is 0..100 (%) per car. It only goes up during a race (Reset does not repair) and every race
 * builds fresh cars, so each race starts at 0.
 */
export const DAMAGE = {
  /** Approach speed (m/s, along the contact normal) below which a hit does nothing (≈ 16 km/h). */
  impactMin: 4.5,
  /** Damage per m/s of approach speed above `impactMin` (%). A 50 km/h head-on into a boulder ≈ 16%. */
  impactK: 1.7,
  /** Most damage a single hit can do (%). */
  hitCap: 30,
  /** Car vs car: multiplier on top of the mass share (a heavier car hurts you more). */
  vehicleK: 0.8,
  /** Hard landings: % per m/s of downward speed above the car's landing tolerance (jump stat). */
  landingK: 2.2,
  landingCap: 18,
  /** Damaging animals (bear, moose, bull, boar, croc): % per m/s above `animalMin`. */
  animalMin: 3,
  animalK: 1.1,
  animalCap: 16,
  /** Ignore repeat contacts with the same thing for this long (a hit fires several contact events). */
  cooldownS: 0.4,
  /** Fraction of top speed and engine force lost at 100% damage. The car never stops. */
  maxPerformanceLoss: 0.25,
  /** Steering pull at 100% damage (radians of extra steer to one side). */
  pullRad: 0.02,
  /** Hits smaller than this (%) are ignored (no event, no dent). */
  minHit: 0.25,
} as const;

/** Damage (%) from a hit at `approach` m/s (relative speed along the contact normal). */
export function impactDamage(approach: number, scale = 1): number {
  if (!(approach > DAMAGE.impactMin)) return 0;
  return Math.min(DAMAGE.hitCap, DAMAGE.impactK * (approach - DAMAGE.impactMin)) * scale;
}

/** Car vs car: my share depends on how heavy the other car is (2·m_other / (m_me + m_other), 0..2). */
export function vehicleImpactDamage(approach: number, myMass: number, otherMass: number, scale = 1): number {
  const share = (2 * otherMass) / Math.max(1, myMass + otherMass);
  return Math.min(DAMAGE.hitCap, impactDamage(approach) * DAMAGE.vehicleK * share) * scale;
}

/** Damage (%) from a landing at `impact` m/s downward, for a car tolerating `tolerance` m/s. */
export function landingDamage(impact: number, tolerance: number, scale = 1): number {
  if (!(impact > tolerance)) return 0;
  return Math.min(DAMAGE.landingCap, DAMAGE.landingK * (impact - tolerance)) * scale;
}

/** Damage (%) from bumping a damaging animal at `speed` m/s; harmless animals do nothing. */
export function animalDamage(speed: number, damaging: boolean, scale = 1): number {
  if (!damaging || !(speed > DAMAGE.animalMin)) return 0;
  return Math.min(DAMAGE.animalCap, DAMAGE.animalK * (speed - DAMAGE.animalMin)) * scale;
}

/** Multiplier on top speed and engine force at this damage (1 → 0.75). Never zero. */
export function performanceFactor(damage: number): number {
  const d = Math.min(100, Math.max(0, damage)) / 100;
  return 1 - DAMAGE.maxPerformanceLoss * d;
}

/** Checks tilt math for both landscape orientations and several pitches. Run: npx tsx scripts/tilt-test.ts */
import * as THREE from 'three';

const DEG = Math.PI / 180;
// Build W3C beta/gamma from a physical pose: device held in landscape (screen angle o), tipped back by `pitch`,
// rotated like a wheel by `wheel` (positive = right side down from the user's view).
function poseToBetaGamma(o: number, pitch: number, wheel: number): { beta: number; gamma: number } {
  // Gravity in screen coords (x right, y up, z out of screen) for an upright screen tipped back by pitch, rotated by wheel.
  const gScreen = new THREE.Vector3(Math.sin(wheel) * Math.cos(pitch), -Math.cos(wheel) * Math.cos(pitch), -Math.sin(pitch));
  // screen → device: rotate by +o about z
  // screen → device: window.orientation o = device rotated CCW by o, so screen axes are device axes rotated by −o.
  const g = gScreen.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -o);
  // W3C: g_device = (cos b sin g, -sin b, -cos b cos g)
  const beta = Math.atan2(-g.y, Math.hypot(g.x, g.z));
  const gamma = Math.atan2(g.x, -g.z);
  return { beta: beta / DEG, gamma: gamma / DEG };
}
function tilt(beta: number, gamma: number, oDeg: number): number {
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  const b = beta * DEG, g = gamma * DEG;
  const dx = Math.cos(b) * Math.sin(g);
  const dy = -Math.sin(b);
  const o = oDeg * DEG;
  const sx = dx * Math.cos(o) - dy * Math.sin(o);
  const sy = -(dx * Math.sin(o) + dy * Math.cos(o));
  const inPlane = Math.hypot(sx, sy);
  const wheel = Math.atan2(sx, sy);
  const flat = Math.asin(clamp(sx, -1, 1));
  const w = clamp((inPlane - 0.2) / 0.25, 0, 1);
  return (w * wheel + (1 - w) * flat) / DEG;
}
let bad = 0;
for (const o of [90, -90, 0]) for (const pitch of [0, 30, 60]) for (const wheel of [-30, -10, 0, 10, 30]) {
  const { beta, gamma } = poseToBetaGamma(o * DEG, pitch * DEG, wheel * DEG);
  const got = tilt(beta, gamma, o);
  const ok = Math.abs(got - wheel) < 0.5;
  if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} o=${o} pitch=${pitch} wheel=${wheel} → beta=${beta.toFixed(1)} gamma=${gamma.toFixed(1)} → ${got.toFixed(2)}`);
}
process.exit(bad ? 1 : 0);

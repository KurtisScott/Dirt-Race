/** Dev-only spin screen preview over a backdrop: /src/ui/spin/dev.html?speed=4&seed=3 */
import '../../style.css';
import { rng } from '../../core/math';
import { runVehicleSpin } from '.';

const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') ?? 7);
document.body.style.background = 'linear-gradient(#5f9ad6, #cfe3f0 55%, #7c9a4a 56%, #556b2f)';
const w = window as unknown as { __spin: unknown };
w.__spin = { done: false, ticks: 0 };
runVehicleSpin(document.getElementById('ui')!, {
  rand: rng(seed),
  speed: Number(q.get('speed') ?? 1),
  onTick: () => (w.__spin as { ticks: number }).ticks++,
}).then((r) => (w.__spin = { done: true, player: r.player.spec.kind, cpu: r.cpu.spec.kind }));

import { events } from '../../core/events';
import type { RacerId, VehicleKind, VehicleStats } from '../../core/types';
import { VEHICLES, VEHICLE_KINDS, randomVehicle, renderVehicleThumbnails, type VehicleSpec } from '../../vehicles';
import { onTap } from '../screens';
import './spin.css';

export interface SpinPick {
  spec: VehicleSpec;
  paint: number;
}
export interface SpinResult {
  player: SpinPick;
  cpu: SpinPick;
}
export interface SpinOptions {
  /** Random source (tests). */
  rand?: () => number;
  /** Force the outcome (tests / debug). */
  force?: { player?: SpinPick; cpu?: SpinPick };
  /** Names shown above the reels. */
  playerName?: string;
  cpuName?: string;
  /** Speed-up factor for tests (1 = normal). */
  speed?: number;
  /** Called when a card passes the window (audio can also listen to 'spin:tick'). */
  onTick?(racer: RacerId): void;
  /** Aborting removes the overlay; the promise then never resolves (the race flow has moved on). */
  signal?: AbortSignal;
}

const STAT_ROWS: { key: keyof VehicleStats; label: string }[] = [
  { key: 'topSpeed', label: 'Top speed' },
  { key: 'accel', label: 'Accel' },
  { key: 'grip', label: 'Grip' },
  { key: 'offroad', label: 'Off-road' },
  { key: 'jump', label: 'Jump' },
];

/**
 * The vehicle spin (SPEC game flow step 3). Full-screen HTML overlay with two slot-machine reels:
 * Brooks's reel spins and lands first, then the Computer's. Each card is a rendered thumbnail of the
 * real 3D model (in its paint colour) + name. Stat bars fill in as each reel lands; GO appears when
 * both are done. Resolves with both picks when GO is tapped.
 *
 *   const { player, cpu } = await runVehicleSpin(uiRoot);
 *
 * Also emits 'spin:tick' (each card passing, for reel clatter), 'spin:land' and 'spin:done'.
 */
export function runVehicleSpin(root: HTMLElement, opts: SpinOptions = {}): Promise<SpinResult> {
  const rand = opts.rand ?? Math.random;
  const speed = opts.speed ?? 1;
  const player = opts.force?.player ?? randomVehicle(rand);
  const cpu = opts.force?.cpu ?? randomVehicle(rand);

  // Thumbnails: one random paint per kind for the reel filler cards plus the two picks (16 kinds × 3 paints
  // would be 48 renders on the first spin). Rendered once and cached, so later spins add only a few.
  const reelPaint = new Map(VEHICLE_KINDS.map((kind) => [kind, VEHICLES[kind].paints[Math.floor(rand() * 3)]]));
  const need = [...VEHICLE_KINDS.map((kind) => ({ kind, paint: reelPaint.get(kind)! })), { kind: player.spec.kind, paint: player.paint }, { kind: cpu.spec.kind, paint: cpu.paint }];
  const thumbs = new Map(renderVehicleThumbnails(need).map((t) => [`${t.kind}:${t.paint}`, t.url]));
  const thumb = (kind: VehicleKind, paint: number) => thumbs.get(`${kind}:${paint}`) ?? '';

  const el = document.createElement('div');
  el.className = 'screen vspin-screen';
  el.dataset.screen = 'spin';
  el.innerHTML = `
    <div class="vspin-wrap">
      <h2 class="vspin-title">Spin for your ride!</h2>
      <div class="vspin-cols">
        ${col('player', opts.playerName ?? 'Brooks')}
        <div class="vspin-vs">VS</div>
        ${col('cpu', opts.cpuName ?? 'Computer')}
      </div>
      <button class="big-btn vspin-go" data-tap="spin-go" disabled>GO!</button>
    </div>`;
  root.appendChild(el);

  const reels: Record<RacerId, Reel> = {
    player: new Reel(el.querySelector('[data-reel="player"]')!, thumb, rand, (k) => reelPaint.get(k)!),
    cpu: new Reel(el.querySelector('[data-reel="cpu"]')!, thumb, rand, (k) => reelPaint.get(k)!),
  };

  const go = el.querySelector<HTMLButtonElement>('[data-tap="spin-go"]')!;
  const fillStats = (racer: RacerId, pick: SpinPick) => {
    const box = el.querySelector<HTMLElement>(`[data-stats="${racer}"]`)!;
    box.classList.add('on');
    box.querySelector('.vspin-blurb')!.textContent = pick.spec.blurb;
    STAT_ROWS.forEach((r, i) => {
      const bar = box.querySelector<HTMLElement>(`[data-stat="${r.key}"]`)!;
      bar.style.setProperty('--v', String(pick.spec.stats[r.key] / 5));
      bar.style.transitionDelay = `${i * 90}ms`;
      bar.dataset.v = String(pick.spec.stats[r.key]);
    });
  };

  opts.signal?.addEventListener('abort', () => el.remove(), { once: true });
  return new Promise<SpinResult>((resolve) => {
    const tick = (racer: RacerId) => {
      events.emit('spin:tick', { racer });
      opts.onTick?.(racer);
    };
    const land = (racer: RacerId, pick: SpinPick) => {
      el.querySelector(`[data-col="${racer}"]`)!.classList.add('landed');
      fillStats(racer, pick);
      events.emit('spin:land', { racer, kind: pick.spec.kind });
    };
    // Brooks first, then the Computer after a beat.
    setTimeout(() => {
      reels.player.spin(player, 2600 / speed, () => tick('player'), () => {
        land('player', player);
        setTimeout(() => {
          reels.cpu.spin(cpu, 2200 / speed, () => tick('cpu'), () => {
            land('cpu', cpu);
            go.disabled = false;
            go.classList.add('ready');
          });
        }, 700 / speed);
      });
    }, 350 / speed);

    onTap(go, () => {
      if (go.disabled) return;
      go.disabled = true;
      events.emit('spin:done', { player: { kind: player.spec.kind, paint: player.paint }, cpu: { kind: cpu.spec.kind, paint: cpu.paint } });
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 250);
      resolve({ player, cpu });
    });
  });
}

function col(racer: RacerId, name: string): string {
  return `
    <div class="vspin-col" data-col="${racer}">
      <div class="vspin-name ${racer}">${name}</div>
      <div class="vspin-reel" data-reel="${racer}"><div class="vspin-strip"><div class="vspin-card vspin-mystery"><b>?</b><span>Mystery ride</span></div></div><div class="vspin-glare"></div></div>
      <div class="vspin-stats" data-stats="${racer}">
        <p class="vspin-blurb">&nbsp;</p>
        ${STAT_ROWS.map((r) => `<div class="vspin-stat"><span>${r.label}</span><i data-stat="${r.key}"><b></b></i></div>`).join('')}
      </div>
    </div>`;
}

/**
 * One reel: a vertical strip of cards that scrolls past a window with ease-out, landing on the target.
 * Uses transform (GPU composited) and requestAnimationFrame; no layout thrash per frame.
 */
class Reel {
  private strip: HTMLElement;
  constructor(
    private el: HTMLElement,
    private thumb: (k: VehicleKind, p: number) => string,
    private rand: () => number,
    private paintFor: (k: VehicleKind) => number,
  ) {
    this.strip = el.querySelector('.vspin-strip')!;
  }

  private card(kind: VehicleKind, paint: number): string {
    return `<div class="vspin-card" data-kind="${kind}"><img alt="" src="${this.thumb(kind, paint)}"><span>${VEHICLES[kind].name}</span></div>`;
  }

  spin(target: SpinPick, ms: number, onTick: () => void, onDone: () => void): void {
    // Build a strip: ~20 random cards then the target card last.
    const cards: { kind: VehicleKind; paint: number }[] = [];
    // About 20 cards scroll past (≈ the same speed as the original 3 laps of 6 kinds).
    const count = 20;
    let last: VehicleKind | null = null;
    for (let i = 0; i < count; i++) {
      let kind = VEHICLE_KINDS[Math.floor(this.rand() * VEHICLE_KINDS.length)];
      if (kind === last) kind = VEHICLE_KINDS[(VEHICLE_KINDS.indexOf(kind) + 1) % VEHICLE_KINDS.length];
      last = kind;
      cards.push({ kind, paint: this.paintFor(kind) });
    }
    if (cards[cards.length - 1].kind === target.spec.kind) cards.pop();
    cards.push({ kind: target.spec.kind, paint: target.paint });
    this.strip.innerHTML = this.strip.innerHTML.includes('vspin-mystery') ? this.strip.innerHTML + cards.map((c) => this.card(c.kind, c.paint)).join('') : cards.map((c) => this.card(c.kind, c.paint)).join('');
    const n = this.strip.children.length;
    const first = this.strip.firstElementChild as HTMLElement | null;
    const h = first?.offsetHeight || this.el.clientHeight || 220;
    const total = (n - 1) * h;
    this.el.classList.add('spinning');
    const t0 = performance.now();
    let lastIdx = -1;
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      // easeOutBack-ish: fast start, slow landing with a little overshoot bounce.
      const e = t < 1 ? 1 - Math.pow(1 - t, 3.2) + Math.sin(t * Math.PI) * 0.012 * (1 - t) : 1;
      const y = e * total;
      this.strip.style.transform = `translate3d(0, ${-y}px, 0)`;
      const idx = Math.round(y / h);
      if (idx !== lastIdx) {
        lastIdx = idx;
        onTick();
      }
      // Motion blur feel while fast.
      this.el.classList.toggle('fast', t < 0.55);
      if (t < 1) requestAnimationFrame(frame);
      else {
        this.el.classList.remove('spinning', 'fast');
        this.el.classList.add('stopped');
        onDone();
      }
    };
    requestAnimationFrame(frame);
  }
}

/**
 * Adapter for the race flow (`RaceFlowDeps.showSpin`): the race has already picked both vehicles;
 * this plays the reels landing on exactly those picks and resolves when GO is tapped.
 */
export function showVehicleSpin(root: HTMLElement, picks: SpinResult, opts: Omit<SpinOptions, 'force'> = {}): Promise<void> {
  return runVehicleSpin(root, { ...opts, force: picks }).then(() => undefined);
}

/** A `SpinFn`-compatible random pick (same as the race's stub): independent random vehicle + paint for each racer. */
export function pickVehicles(rand: () => number = Math.random): SpinResult {
  return { player: randomVehicle(rand), cpu: randomVehicle(rand) };
}

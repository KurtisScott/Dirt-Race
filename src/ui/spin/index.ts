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
}

const STAT_ROWS: { key: keyof VehicleStats; label: string }[] = [
  { key: 'topSpeed', label: 'Top speed' },
  { key: 'accel', label: 'Acceleration' },
  { key: 'grip', label: 'Grip' },
  { key: 'offroad', label: 'Off-road' },
  { key: 'hillClimb', label: 'Hill climb' },
];

/**
 * The vehicle spin (SPEC game flow step 3). Full-screen HTML overlay with two slot-machine reels:
 * Brooks's reel spins and lands first, then the Computer's. Each card is a rendered thumbnail of the
 * real 3D model (in its paint colour) + name. Stat bars fill in as each reel lands; GO appears when
 * both are done. Resolves with both picks when GO is tapped.
 *
 *   const { player, cpu } = await runVehicleSpin(uiRoot);
 *
 * Also emits 'spin:tick' (each card passing, for reel clatter), 'spin:landed' and 'spin:done'.
 */
export function runVehicleSpin(root: HTMLElement, opts: SpinOptions = {}): Promise<SpinResult> {
  const rand = opts.rand ?? Math.random;
  const speed = opts.speed ?? 1;
  const player = opts.force?.player ?? randomVehicle(rand);
  const cpu = opts.force?.cpu ?? randomVehicle(rand);

  // Thumbnails: every kind in every paint (the reel shows varied colours), rendered once and cached.
  const all = VEHICLE_KINDS.flatMap((kind) => VEHICLES[kind].paints.map((paint) => ({ kind, paint })));
  const thumbs = new Map(renderVehicleThumbnails(all).map((t) => [`${t.kind}:${t.paint}`, t.url]));
  const thumb = (kind: VehicleKind, paint: number) => thumbs.get(`${kind}:${paint}`) ?? '';

  const el = document.createElement('div');
  el.className = 'screen spin-screen';
  el.dataset.screen = 'spin';
  el.innerHTML = `
    <div class="spin-wrap">
      <h2 class="spin-title">Spin for your ride!</h2>
      <div class="spin-cols">
        ${col('player', opts.playerName ?? 'Brooks')}
        <div class="spin-vs">VS</div>
        ${col('cpu', opts.cpuName ?? 'Computer')}
      </div>
      <button class="big-btn spin-go" data-tap="spin-go" disabled>GO!</button>
    </div>`;
  root.appendChild(el);

  const reels: Record<RacerId, Reel> = {
    player: new Reel(el.querySelector('[data-reel="player"]')!, thumb, rand),
    cpu: new Reel(el.querySelector('[data-reel="cpu"]')!, thumb, rand),
  };

  const go = el.querySelector<HTMLButtonElement>('[data-tap="spin-go"]')!;
  const fillStats = (racer: RacerId, pick: SpinPick) => {
    const box = el.querySelector<HTMLElement>(`[data-stats="${racer}"]`)!;
    box.classList.add('on');
    box.querySelector('.spin-blurb')!.textContent = pick.spec.blurb;
    STAT_ROWS.forEach((r, i) => {
      const bar = box.querySelector<HTMLElement>(`[data-stat="${r.key}"]`)!;
      bar.style.setProperty('--v', String(pick.spec.stats[r.key] / 5));
      bar.style.transitionDelay = `${i * 90}ms`;
      bar.dataset.v = String(pick.spec.stats[r.key]);
    });
  };

  return new Promise<SpinResult>((resolve) => {
    const tick = (racer: RacerId) => {
      events.emit('spin:tick', { racer });
      opts.onTick?.(racer);
    };
    const land = (racer: RacerId, pick: SpinPick) => {
      el.querySelector(`[data-col="${racer}"]`)!.classList.add('landed');
      fillStats(racer, pick);
      events.emit('spin:landed', { racer, kind: pick.spec.kind, paint: pick.paint });
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
    <div class="spin-col" data-col="${racer}">
      <div class="spin-name ${racer}">${name}</div>
      <div class="spin-reel" data-reel="${racer}"><div class="spin-strip"><div class="spin-card spin-mystery"><b>?</b><span>Mystery ride</span></div></div><div class="spin-glare"></div></div>
      <div class="spin-stats" data-stats="${racer}">
        <p class="spin-blurb">&nbsp;</p>
        ${STAT_ROWS.map((r) => `<div class="spin-stat"><span>${r.label}</span><i data-stat="${r.key}"><b></b></i></div>`).join('')}
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
  ) {
    this.strip = el.querySelector('.spin-strip')!;
  }

  private card(kind: VehicleKind, paint: number): string {
    return `<div class="spin-card" data-kind="${kind}"><img alt="" src="${this.thumb(kind, paint)}"><span>${VEHICLES[kind].name}</span></div>`;
  }

  spin(target: SpinPick, ms: number, onTick: () => void, onDone: () => void): void {
    // Build a strip: ~3 shuffled laps then the target card last.
    const cards: { kind: VehicleKind; paint: number }[] = [];
    const laps = 3;
    let last: VehicleKind | null = null;
    for (let i = 0; i < laps * VEHICLE_KINDS.length; i++) {
      let kind = VEHICLE_KINDS[Math.floor(this.rand() * VEHICLE_KINDS.length)];
      if (kind === last) kind = VEHICLE_KINDS[(VEHICLE_KINDS.indexOf(kind) + 1) % VEHICLE_KINDS.length];
      last = kind;
      cards.push({ kind, paint: VEHICLES[kind].paints[Math.floor(this.rand() * 3)] });
    }
    if (cards[cards.length - 1].kind === target.spec.kind) cards.pop();
    cards.push({ kind: target.spec.kind, paint: target.paint });
    this.strip.innerHTML = this.strip.innerHTML.includes('spin-mystery') ? this.strip.innerHTML + cards.map((c) => this.card(c.kind, c.paint)).join('') : cards.map((c) => this.card(c.kind, c.paint)).join('');
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

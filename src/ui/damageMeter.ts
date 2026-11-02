import { events, type GamePhase } from '../core/events';
import './damageMeter.css';

const SHOWN: ReadonlySet<GamePhase> = new Set(['countdown', 'racing', 'bonus', 'freeDrive']);

/** Kid-readable colour steps: green → yellow → orange → red. */
export function damageColor(damage: number): string {
  return damage < 10 ? '#7ee07e' : damage < 35 ? '#ffd23f' : damage < 65 ? '#ff9a3d' : '#ff4d4d';
}

/**
 * Small damage meter above the speedometer (SPEC Round 2 item 2): a car icon that turns
 * green → yellow → orange → red, with the percentage underneath. Purely event-driven
 * ('car:damage' for Brooks's car, 'phase:changed', 'app:paused'), so it needs no wiring beyond `new`.
 */
export class DamageMeter {
  readonly el: HTMLElement;
  private icon: SVGElement;
  private pct: HTMLElement;
  private phase: GamePhase = 'title';
  private paused = false;
  private offs: (() => void)[] = [];
  private hitTimer = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'dmg-meter';
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Car damage');
    this.el.innerHTML = `
      <svg viewBox="0 0 64 34" aria-hidden="true">
        <path class="dmg-body" d="M6 22c0-3 2-5 5-5.6l6-1.2 7-6.6c1.2-1.1 2.8-1.6 4.4-1.6h11c1.8 0 3.4.8 4.6 2.1l5.4 6.1 6.4 1.4c2.4.5 4.2 2.6 4.2 5.1V26c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2z"/>
        <path class="dmg-glass" d="M26 10.6c.6-.5 1.3-.8 2.1-.8h5.4v6.2H20.8zM36.5 9.8h3.2c1 0 2 .4 2.6 1.2l4.2 5H36.5z"/>
        <circle class="dmg-wheel" cx="17" cy="27" r="5.2"/><circle class="dmg-wheel" cx="47" cy="27" r="5.2"/>
        <circle class="dmg-hub" cx="17" cy="27" r="2"/><circle class="dmg-hub" cx="47" cy="27" r="2"/>
      </svg>
      <b>0%</b>`;
    parent.appendChild(this.el);
    this.icon = this.el.querySelector('svg')!;
    this.pct = this.el.querySelector('b')!;
    this.set(0);
    this.offs.push(
      events.on('car:damage', ({ racer, damage }) => {
        if (racer !== 'player') return;
        this.set(damage);
        this.el.classList.remove('hit');
        void this.el.offsetWidth;
        this.el.classList.add('hit');
        clearTimeout(this.hitTimer);
        this.hitTimer = window.setTimeout(() => this.el.classList.remove('hit'), 600);
      }),
      events.on('phase:changed', ({ to }) => {
        // A new race (spin → countdown) always starts with a fresh car.
        if (to === 'spin' || to === 'countdown' || to === 'title') this.set(0);
        this.phase = to;
        this.refresh();
      }),
      events.on('app:paused', ({ paused }) => {
        this.paused = paused;
        this.refresh();
      }),
    );
  }

  /** Show `damage` (0..100). */
  set(damage: number): void {
    const d = Math.max(0, Math.min(100, Math.round(damage)));
    this.pct.textContent = `${d}%`;
    this.icon.style.setProperty('--dmg', damageColor(d));
    this.el.dataset.level = d < 10 ? 'ok' : d < 35 ? 'low' : d < 65 ? 'mid' : 'high';
  }

  private refresh(): void {
    this.el.hidden = this.paused || !SHOWN.has(this.phase);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.el.remove();
  }
}

import type { InputAction } from './types';

/**
 * Large multi-touch on-screen controls: gas (bottom right), brake/reverse (bottom left),
 * optional left/right steering buttons (fallback when tilt is unavailable). With the steering buttons
 * showing (`.with-steer`), ◀ ▶ sit side by side bottom-left and brake stacks above gas on the right,
 * so each thumb has one job (CSS only; the elements and pointer tracking are the same),
 * and top buttons (reset top-left, pause top-right, camera).
 *
 * Uses Pointer Events with per-pointer tracking so gas + steer work simultaneously.
 * A finger sliding off a pedal releases it; sliding onto another control does not press it
 * (keeps things predictable for a kid).
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  throttle = 0;
  brake = 0;
  steerLeft = false;
  steerRight = false;
  private steerWrap: HTMLDivElement;
  private speedEl: HTMLDivElement;

  constructor(parent: HTMLElement, onAction: (a: InputAction) => void) {
    this.root = el('div', 'touch-controls');
    this.root.innerHTML = `
      <button class="tc-btn tc-reset" data-action="reset" aria-label="Reset car">⟲</button>
      <button class="tc-btn tc-camera" data-action="camera" aria-label="Camera">🎥</button>
      <button class="tc-btn tc-pause" data-action="pause" aria-label="Pause">Ⅱ</button>
      <div class="tc-pedal tc-brake" data-hold="brake"><span>BRAKE</span><small>hold to reverse</small></div>
      <div class="tc-pedal tc-gas" data-hold="gas"><span>GAS</span></div>
      <div class="tc-steer">
        <div class="tc-steer-btn" data-hold="left">◀</div>
        <div class="tc-steer-btn" data-hold="right">▶</div>
      </div>
      <div class="tc-speed"><b>0</b><small>km/h</small></div>
    `;
    parent.appendChild(this.root);
    this.steerWrap = this.root.querySelector('.tc-steer') as HTMLDivElement;
    this.speedEl = this.root.querySelector('.tc-speed') as HTMLDivElement;

    for (const b of this.root.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.classList.add('down');
        onAction(b.dataset.action as InputAction);
      });
      const up = (): void => b.classList.remove('down');
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    }

    for (const h of this.root.querySelectorAll<HTMLDivElement>('[data-hold]')) this.bindHold(h);
    this.showSteerButtons(false);
  }

  private bindHold(target: HTMLDivElement): void {
    const pointers = new Set<number>();
    const kind = target.dataset.hold;
    const set = (on: boolean): void => {
      target.classList.toggle('down', on);
      if (kind === 'gas') this.throttle = on ? 1 : 0;
      else if (kind === 'brake') this.brake = on ? 1 : 0;
      else if (kind === 'left') this.steerLeft = on;
      else if (kind === 'right') this.steerRight = on;
    };
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // Don't capture: pointerleave must fire when the finger slides off.
      try {
        target.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      pointers.add(e.pointerId);
      set(true);
    });
    const release = (e: PointerEvent): void => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) set(false);
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', release);
    target.addEventListener('pointerleave', release);
    // Safety: if the app loses focus mid-press, release everything.
    window.addEventListener('blur', () => {
      pointers.clear();
      set(false);
    });
  }

  get steer(): number {
    return (this.steerRight ? 1 : 0) - (this.steerLeft ? 1 : 0);
  }

  showSteerButtons(show: boolean): void {
    this.steerWrap.style.display = show ? '' : 'none';
    this.root.classList.toggle('with-steer', show);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  /** Speedometer between the pedals (SPEC HUD). `unit` picks the display unit (input is always km/h). */
  setSpeed(kmh: number, unit: 'kmh' | 'mph' = 'kmh'): void {
    const b = this.speedEl.firstElementChild as HTMLElement;
    const v = String(Math.round(Math.abs(unit === 'mph' ? kmh * 0.621371 : kmh)));
    if (b.textContent !== v) b.textContent = v;
    const label = this.speedEl.lastElementChild as HTMLElement;
    const l = unit === 'mph' ? 'mph' : 'km/h';
    if (label.textContent !== l) label.textContent = l;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

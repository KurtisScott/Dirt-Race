import type { InputAction } from './types';

/** Desktop/dev keyboard: arrows/WASD, Space = brake, R reset, C camera, P/Esc pause. */
export class KeyboardInput {
  private down = new Set<string>();
  constructor(private onAction: (a: InputAction) => void) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      if (e.code === 'KeyR') this.onAction('reset');
      else if (e.code === 'KeyC') this.onAction('camera');
      else if (e.code === 'KeyP' || e.code === 'Escape') this.onAction('pause');
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }
  private has(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }
  get steer(): number {
    return (this.has('ArrowRight', 'KeyD') ? 1 : 0) - (this.has('ArrowLeft', 'KeyA') ? 1 : 0);
  }
  get throttle(): number {
    return this.has('ArrowUp', 'KeyW') ? 1 : 0;
  }
  get brake(): number {
    return this.has('ArrowDown', 'KeyS', 'Space') ? 1 : 0;
  }
  get anySteer(): boolean {
    return this.steer !== 0;
  }
}

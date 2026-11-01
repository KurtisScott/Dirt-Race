import type { GameLoop } from './loop';
import type { PhysicsWorld } from './physics';
import type { QualityManager } from './quality';
import type { Renderer } from './renderer';

/**
 * The bundle of engine services passed to every module's constructor/factory.
 * Modules should depend on this (and on the small interfaces in other modules'
 * `types.ts`) — never on main.ts.
 */
export interface GameContext {
  physics: PhysicsWorld;
  renderer: Renderer;
  loop: GameLoop;
  quality: QualityManager;
  /** Root element for HTML overlays (UI, touch controls). */
  overlay: HTMLElement;
}

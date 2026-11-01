import { registerSW } from 'virtual:pwa-register';

/**
 * Registers the service worker (precaches every built asset → fully offline after first load).
 *
 * Update policy: registerType 'prompt' so a new version never reloads the page mid-race.
 * When an update is waiting, `canUpdateNow()` is consulted (main passes "are we on the title
 * screen?"); if not now, we apply it the next time `applyPendingUpdate()` is called from the menu.
 */
let pending: ((reload?: boolean) => Promise<void>) | null = null;

export function registerPWA(canUpdateNow: () => boolean = () => false): void {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
  try {
    const update = registerSW({
      immediate: true,
      onNeedRefresh() {
        pending = update;
        if (canUpdateNow()) applyPendingUpdate();
      },
      onOfflineReady() {
        console.info('[pwa] ready to work offline');
      },
    });
  } catch (e) {
    console.warn('[pwa] service worker registration failed', e);
  }
}

/** Activate a waiting service worker and reload (only call from menus). */
export function applyPendingUpdate(): void {
  if (!pending) return;
  const p = pending;
  pending = null;
  void p(true);
}

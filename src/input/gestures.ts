/**
 * Stop iOS Safari gestures from interfering with play: pinch-zoom, double-tap zoom,
 * rubber-band overscroll, text selection, long-press callouts, context menus.
 * CSS does most of the work (see style.css: touch-action, user-select, -webkit-touch-callout,
 * overscroll-behavior); these listeners catch what CSS can't on iOS.
 * Elements with class `allow-touch` (e.g. a scrollable settings panel) are left alone.
 */
export function preventBrowserGestures(): void {
  const allowed = (t: EventTarget | null): boolean => t instanceof Element && !!t.closest('.allow-touch');
  const opts: AddEventListenerOptions = { passive: false };

  // iOS-specific pinch events.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), opts);
  }
  // Multi-finger moves (pinch) and any page scrolling.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!allowed(e.target) || e.touches.length > 1) e.preventDefault();
    },
    opts,
  );
  // Double-tap zoom: swallow a second touchend within 350 ms (except on form controls).
  let lastEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      const t = e.target as Element | null;
      // Buttons rely on touch-action: manipulation (CSS) instead, so their clicks are never eaten.
      const isControl = !!t?.closest('input, select, textarea, label, button, a, [data-tap]');
      if (!isControl && now - lastEnd < 350 && e.cancelable) e.preventDefault();
      lastEnd = now;
    },
    opts,
  );
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => {
    if (!allowed(e.target)) e.preventDefault();
  });
  document.addEventListener('dblclick', (e) => e.preventDefault(), opts);
}

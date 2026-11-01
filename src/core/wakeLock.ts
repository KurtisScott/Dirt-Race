/** Screen Wake Lock (feature-detected). Keeps the iPad awake while driving. */
type Sentinel = { release(): Promise<void>; addEventListener(t: 'release', fn: () => void): void };
type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<Sentinel> } };

let sentinel: Sentinel | null = null;
let wanted = false;

async function acquire(): Promise<void> {
  const nav = navigator as WakeLockNav;
  if (!nav.wakeLock || sentinel || document.visibilityState !== 'visible') return;
  try {
    sentinel = await nav.wakeLock.request('screen');
    sentinel.addEventListener('release', () => (sentinel = null));
  } catch {
    sentinel = null; // denied / unsupported in this context: harmless
  }
}

document.addEventListener('visibilitychange', () => {
  if (wanted && document.visibilityState === 'visible') void acquire();
});

export function setWakeLock(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else if (sentinel) {
    void sentinel.release().catch(() => {});
    sentinel = null;
  }
}

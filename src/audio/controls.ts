import { events } from '../core/events';
import { settings, updateSettings } from '../core/settings';

/**
 * Music / Effects volume rows for a settings screen, using the existing `.seg` segmented-control CSS
 * (Off / Low / Med / High: big kid-friendly targets, no fiddly sliders). Self-contained so the UI
 * module doesn't need audio knowledge: `mountVolumeControls(gridElement)` appends label + control
 * pairs to a 2-column `.settings-grid`. Values persist through `updateSettings` (localStorage).
 */
const STEPS: [string, number][] = [['Off', 0], ['Low', 0.35], ['Med', 0.65], ['High', 1]];

export function mountVolumeControls(grid: Element): () => void {
  const rows: { key: 'musicVolume' | 'sfxVolume'; seg: HTMLElement }[] = [];
  for (const [label, key] of [['Music', 'musicVolume'], ['Sound effects', 'sfxVolume']] as const) {
    const span = document.createElement('span');
    span.textContent = label;
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.dataset.vol = key;
    for (const [name, v] of STEPS) {
      const b = document.createElement('button');
      b.textContent = name;
      b.dataset.v = String(v);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        updateSettings({ [key]: v });
      });
      seg.appendChild(b);
    }
    grid.append(span, seg);
    rows.push({ key, seg });
  }
  const refresh = (): void => {
    for (const { key, seg } of rows) {
      const cur = settings[key];
      // Highlight the nearest step (settings may hold any 0..1 value).
      let best = 0;
      for (let i = 1; i < STEPS.length; i++) if (Math.abs(STEPS[i][1] - cur) < Math.abs(STEPS[best][1] - cur)) best = i;
      seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === best));
    }
  };
  refresh();
  return events.on('settings:changed', refresh);
}

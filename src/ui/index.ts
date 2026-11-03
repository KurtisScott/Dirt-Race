import { events, type TiltStatus } from '../core/events';
import { settings, updateSettings } from '../core/settings';
import type { Difficulty, QualityLevel, Sensitivity, SpeedUnit } from '../core/types';
import { ResultsScreen } from './raceHud';
import { onTap, Screen } from './screens';

export { Screen, h, onTap } from './screens';
export { RaceHud, ResultsScreen, RACER_NAME, formatClock, formatDistance, type HudTrack } from './raceHud';
export { DamageMeter, damageColor } from './damageMeter';

const QUALITY_NAMES: Record<QualityLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };

export type ScreenName = 'title' | 'calibrate' | 'pause' | 'help' | 'results';

/** Callbacks main.ts provides. UI never touches physics/vehicles directly. */
export interface UIHandlers {
  /** Start tap: MUST synchronously kick off permission request + audio unlock (user gesture). */
  onStart(): Promise<TiltStatus>;
  /** Resolves when the course is built; Ready waits for it (Start does not). */
  courseReady?: Promise<void>;
  /** Ready tap on the calibration screen. */
  onReady(): void;
  onResume(): void;
  onMenu(): void;
  onRecalibrate(): void;
  onQuality(level: QualityLevel): void;
  /** Results screen: start a new race (new spin). */
  onRaceAgain?(): void;
  /** Results screen: back to the title. Defaults to onMenu. */
  onResultsMenu?(): void;
  /** Debug readout for the pause screen. */
  debugInfo(): string;
}

/** Running as an installed home-screen app (no Safari toolbar)? */
export function isStandalone(): boolean {
  try {
    return (navigator as { standalone?: boolean }).standalone === true || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
  } catch {
    return false;
  }
}

function isTouch(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
  } catch {
    return false;
  }
}

/** The "DIRT RACE" logo: inline SVG (crisp at any size, no font download), animated with CSS. */
const LOGO_SVG = `
<svg class="logo-svg" viewBox="0 0 640 300" role="img" aria-label="Dirt Race">
  <defs>
    <linearGradient id="lg-dirt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff6dc"/><stop offset="1" stop-color="#ffd98a"/>
    </linearGradient>
    <linearGradient id="lg-race" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#ff6a00"/>
    </linearGradient>
    <pattern id="lg-check" width="20" height="20" patternUnits="userSpaceOnUse">
      <rect width="20" height="20" fill="#fff"/><rect width="10" height="10" fill="#1d2733"/><rect x="10" y="10" width="10" height="10" fill="#1d2733"/>
    </pattern>
  </defs>
  <g class="logo-dust">
    <ellipse cx="120" cy="250" rx="70" ry="22" fill="#d9b98a" opacity=".55"/>
    <ellipse cx="70" cy="238" rx="44" ry="16" fill="#e8cfa6" opacity=".5"/>
    <ellipse cx="30" cy="226" rx="26" ry="10" fill="#f0dcbc" opacity=".45"/>
  </g>
  <g class="logo-tilt" transform="rotate(-4 320 150)">
    <text class="logo-word logo-dirt" x="320" y="128" text-anchor="middle" fill="url(#lg-dirt)" stroke="#7a3d00" stroke-width="10" paint-order="stroke" stroke-linejoin="round">DIRT</text>
    <text class="logo-word logo-race" x="320" y="250" text-anchor="middle" fill="url(#lg-race)" stroke="#5a2400" stroke-width="10" paint-order="stroke" stroke-linejoin="round">RACE</text>
    <rect class="logo-flag" x="520" y="20" width="80" height="50" fill="url(#lg-check)" stroke="#1d2733" stroke-width="4" rx="4"/>
    <rect x="512" y="16" width="8" height="120" rx="3" fill="#e9e3d6" stroke="#1d2733" stroke-width="3"/>
  </g>
</svg>`;

/**
 * HTML screens: title (logo, loading bar, Start, How to play, first-launch tip), calibrate
 * ("hold it like a wheel"), how-to-play card, pause/settings, results, toast.
 */
function hasDebugFlag(): boolean {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

export class UI {
  readonly root: HTMLElement;
  readonly title: Screen;
  readonly calibrate: Screen;
  readonly help: Screen;
  readonly pause: Screen;
  readonly results: ResultsScreen;
  private toastEl: HTMLDivElement;
  private toastTimer = 0;
  private slowEl: HTMLDivElement;
  private slowTimer = 0;
  private slowSuggest: QualityLevel = 'high';
  private helpReturn: ScreenName = 'title';
  private courseLoaded = false;
  /** Developer stats on the pause screen, only with `?debug=1` (never shown to a kid). */
  private readonly showDebug = hasDebugFlag();

  constructor(
    root: HTMLElement,
    private handlers: UIHandlers,
  ) {
    this.root = root;

    this.title = new Screen(
      root,
      `<div class="title-screen">
         <h1 class="logo">${LOGO_SVG}</h1>
         <div class="load" data-role="load">
           <div class="load-bar"><i class="load-fill"></i><span class="load-car" aria-hidden="true">🚙</span></div>
           <p class="load-label" data-role="load-label">Loading…</p>
         </div>
         <button class="big-btn start-btn" data-tap="start">START</button>
         <button class="mid-btn ghost" data-tap="help">How to play</button>
         <div class="tip" data-role="tip" hidden>
           <b>Tips for the best ride</b>
           <span>🔒 Turn on <b>Rotation Lock</b> (swipe down from the top-right corner) so the screen doesn't flip while you steer.</span>
           <span data-role="tip-a2hs">📲 In Safari, tap <b>Share</b> → <b>Add to Home Screen</b> to play full-screen, even offline.</span>
           <button class="mid-btn" data-tap="tip-ok">Got it</button>
         </div>
       </div>`,
      'title',
    );

    this.calibrate = new Screen(
      root,
      `<div class="calibrate-screen">
         <div class="wheel-icon" aria-hidden="true"><div class="ipad"></div></div>
         <h2>Hold it like a steering wheel</h2>
         <p data-role="cal-msg">Hold the iPad up in front of you, nice and level, then tap Ready.</p>
         <button class="big-btn" data-tap="ready">READY</button>
         <p class="hint" data-role="cal-tilt"></p>
       </div>`,
      'calibrate',
    );

    this.help = new Screen(
      root,
      `<div class="help-screen">
         <h2>How to play</h2>
         <div class="help-grid">
           <div class="help-card"><div class="help-ico tilt" aria-hidden="true"><i></i></div><b>Tilt to steer</b><span>Hold the iPad like a steering wheel and turn it left or right.</span></div>
           <div class="help-card"><div class="help-ico pedals" aria-hidden="true"><i class="brake">BRAKE</i><i class="gas">GAS</i></div><b>Gas and brake</b><span>Hold <b>GAS</b> (right) to go. Hold <b>BRAKE</b> (left) to slow down, keep holding to back up.</span></div>
           <div class="help-card"><div class="help-ico reset" aria-hidden="true">⟲</div><b>Stuck? Reset!</b><span>Tap the reset button (top left). Your car goes back to the last checkpoint.</span></div>
           <div class="help-card"><div class="help-ico jump" aria-hidden="true">🚀</div><b>Bonus jump</b><span>First across the 🏁 wins a point. Then floor it up the big ramp and land past the gold line for <b>+1 bonus!</b></span></div>
         </div>
         <button class="big-btn" data-tap="help-ok">GOT IT!</button>
       </div>`,
      'help',
    );

    this.pause = new Screen(
      root,
      `<div class="pause-screen">
         <h2>Paused</h2>
         <div class="row">
           <button class="big-btn" data-tap="resume">RESUME</button>
         </div>
         <div class="settings-grid">
           <span>Tilt sensitivity</span>
           <div class="seg" data-seg="sensitivity">
             <button data-v="low">Low</button><button data-v="medium">Med</button><button data-v="high">High</button>
           </div>
           <span>Tilt direction</span>
           <div class="seg" data-seg="tiltInvert">
             <button data-v="normal">Normal</button><button data-v="flipped">Flipped</button>
           </div>
           <span>Steering</span>
           <div class="seg" data-seg="steer">
             <button data-v="tilt">Tilt</button><button data-v="buttons">Buttons</button>
           </div>
           <span>Computer</span>
           <div class="seg" data-seg="difficulty">
             <button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button>
           </div>
           <span>Graphics</span>
           <div class="seg" data-seg="quality">
             <button data-v="low">Low</button><button data-v="medium">Med</button><button data-v="high">High</button><button data-v="ultra">Ultra</button><button data-v="auto">Auto</button>
           </div>
           <span>Speed in</span>
           <div class="seg" data-seg="speedUnit">
             <button data-v="mph">mph</button><button data-v="kmh">km/h</button>
           </div>
         </div>
         <div class="row">
           <button class="mid-btn" data-tap="recal">Recalibrate tilt</button>
           <button class="mid-btn" data-tap="pause-help">How to play</button>
           <button class="mid-btn" data-tap="menu">Menu</button>
         </div>
         <pre class="debug" data-role="debug" hidden></pre>
       </div>`,
      'pause',
    );

    this.results = new ResultsScreen(root, {
      onRaceAgain: () => this.handlers.onRaceAgain?.(),
      onMenu: () => (this.handlers.onResultsMenu ?? this.handlers.onMenu)(),
    });

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.toastEl.hidden = true;
    root.appendChild(this.toastEl);

    this.slowEl = document.createElement('div');
    this.slowEl.className = 'slow-prompt';
    this.slowEl.hidden = true;
    this.slowEl.innerHTML = `<span>🐢 Game running slow — lower the graphics?</span>
      <button data-tap="slow-lower">Lower</button><button data-tap="slow-keep">Keep</button>`;
    root.appendChild(this.slowEl);

    this.bind();
    events.on('settings:changed', () => this.refreshSegments());
    events.on('quality:prompt', ({ suggest }) => this.showSlowPrompt(suggest));
    events.on('quality:changed', ({ level, auto }) => {
      this.refreshSegments();
      if (auto) this.toast(`Graphics lowered to ${level} for smoother driving`);
    });
    handlers.courseReady?.then(() => {
      this.courseLoaded = true;
      this.title.el.classList.add('loaded');
      const ready = this.calibrate.q<HTMLButtonElement>('[data-tap="ready"]');
      ready.disabled = false;
      ready.textContent = 'READY';
    });
  }

  private bind(): void {
    const startBtn = this.title.q('[data-tap="start"]');
    onTap(startBtn, () => {
      if (startBtn.hasAttribute('disabled')) return;
      startBtn.setAttribute('disabled', '');
      // Call synchronously inside the gesture.
      void this.handlers.onStart().then((status) => {
        startBtn.removeAttribute('disabled');
        this.showTiltStatus(status);
      });
    });
    const ready = this.calibrate.q<HTMLButtonElement>('[data-tap="ready"]');
    if (this.handlers.courseReady) {
      ready.disabled = true;
      ready.textContent = 'LOADING…';
    }
    onTap(ready, () => {
      if (ready.disabled) return;
      this.handlers.onReady();
    });
    onTap(this.title.q('[data-tap="help"]'), () => this.showHelp('title'));
    onTap(this.pause.q('[data-tap="pause-help"]'), () => this.showHelp('pause'));
    onTap(this.help.q('[data-tap="help-ok"]'), () => this.show(this.helpReturn));
    onTap(this.title.q('[data-tap="tip-ok"]'), () => {
      updateSettings({ seenRotationTip: true });
      this.title.q('[data-role="tip"]').hidden = true;
    });
    onTap(this.slowEl.querySelector('[data-tap="slow-lower"]')!, () => {
      this.hideSlowPrompt();
      updateSettings({ slowPrompt: 'lowered', autoQuality: false });
      this.handlers.onQuality(this.slowSuggest);
      this.toast(`Graphics set to ${QUALITY_NAMES[this.slowSuggest]} (change it any time in Settings)`, 3500);
    });
    onTap(this.slowEl.querySelector('[data-tap="slow-keep"]')!, () => {
      this.hideSlowPrompt();
      updateSettings({ slowPrompt: 'kept' });
    });
    onTap(this.pause.q('[data-tap="resume"]'), () => this.handlers.onResume());
    onTap(this.pause.q('[data-tap="recal"]'), () => this.handlers.onRecalibrate());
    onTap(this.pause.q('[data-tap="menu"]'), () => this.handlers.onMenu());

    for (const seg of this.pause.el.querySelectorAll<HTMLElement>('[data-seg]')) {
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
        onTap(b, () => {
          const v = b.dataset.v!;
          const kind = seg.dataset.seg;
          if (kind === 'sensitivity') updateSettings({ sensitivity: v as Sensitivity });
          else if (kind === 'tiltInvert') {
            updateSettings({ tiltInvert: v === 'flipped' });
            this.toast(v === 'flipped' ? 'Tilt flipped: tip right to steer left' : 'Tilt normal: tip right to steer right');
          } else if (kind === 'quality') {
            this.hideSlowPrompt();
            if (v === 'auto') {
              updateSettings({ autoQuality: true });
              this.toast('Graphics: automatic (lowers itself if the game gets slow)');
            } else {
              updateSettings({ autoQuality: false });
              this.handlers.onQuality(v as QualityLevel);
              if (v === 'high') this.toast('High graphics: smoothest edges after the game restarts');
              if (v === 'ultra') this.toast('Ultra graphics: the most realistic look (may be slower)');
            }
          } else if (kind === 'steer') updateSettings({ steerButtons: v === 'buttons' });
          else if (kind === 'difficulty') {
            const changed = settings.difficulty !== v;
            updateSettings({ difficulty: v as Difficulty });
            if (changed) this.toast('Computer difficulty changes from the next race');
          } else if (kind === 'speedUnit') updateSettings({ speedUnit: v as SpeedUnit });
          this.refreshSegments();
        });
      }
    }
    this.refreshSegments();
  }

  private refreshSegments(): void {
    const current: Record<string, string[]> = {
      sensitivity: [settings.sensitivity],
      tiltInvert: [settings.tiltInvert ? 'flipped' : 'normal'],
      quality: settings.autoQuality ? [settings.quality, 'auto'] : [settings.quality],
      steer: [settings.steerButtons ? 'buttons' : 'tilt'],
      difficulty: [settings.difficulty],
      speedUnit: [settings.speedUnit],
    };
    for (const seg of this.pause.el.querySelectorAll<HTMLElement>('[data-seg]')) {
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', current[seg.dataset.seg!]?.includes(b.dataset.v!) ?? false);
    }
  }

  /**
   * The one-time "game running slow" prompt (Round 2): a small card under the timer that doesn't pause the
   * race. Lower → `suggest`; Keep → never ask again. Unanswered, it hides after 20 s and is not asked again
   * this session (the quality manager only raises it once per session).
   */
  private showSlowPrompt(suggest: QualityLevel): void {
    if (settings.slowPrompt !== 'unasked') return;
    this.slowSuggest = suggest;
    this.slowEl.hidden = false;
    clearTimeout(this.slowTimer);
    this.slowTimer = window.setTimeout(() => this.hideSlowPrompt(), 20000);
  }

  private hideSlowPrompt(): void {
    clearTimeout(this.slowTimer);
    this.slowEl.hidden = true;
  }

  /** Title-screen loading bar (0..1) and a friendly label. At 1 the bar hides and Start glows. */
  setLoading(f: number, label: string): void {
    this.title.el.style.setProperty('--load', Math.max(0, Math.min(1, f)).toFixed(3));
    if (label) this.title.q('[data-role="load-label"]').textContent = label;
  }

  private showHelp(from: ScreenName): void {
    this.helpReturn = from;
    this.show('help');
  }

  showTiltStatus(status: TiltStatus): void {
    const msg = this.calibrate.q('[data-role="cal-msg"]');
    if (status === 'granted') {
      msg.textContent = 'Hold the iPad up in front of you, nice and level, then tap Ready.';
    } else if (status === 'denied') {
      msg.innerHTML =
        'Tilt steering is switched off, so you can use the <b>◀ ▶ buttons</b> instead.<br>' +
        '<small>To use tilt: close the game, open it again and tap <b>Allow</b> when asked. ' +
        (isStandalone()
          ? 'If it never asks: delete the Dirt Race icon from the Home Screen, then add it again from Safari (Share → Add to Home Screen).'
          : 'If it never asks: Settings → Safari → Advanced → Website Data, remove this site, and reopen. ' +
            'Tilt only works on the https:// address.') +
        '</small>';
    } else {
      msg.innerHTML = 'No tilt sensor here, so steer with the <b>◀ ▶ buttons</b> (or arrow keys on a keyboard).';
    }
  }

  /** Live tilt readout on the calibrate screen (degrees). */
  setTiltReadout(text: string): void {
    const el = this.calibrate.el.querySelector('[data-role="cal-tilt"]');
    if (el && el.textContent !== text) el.textContent = text;
  }

  show(name: ScreenName | null): void {
    for (const s of [this.title, this.calibrate, this.help, this.pause, this.results.screen]) {
      if (s.name === name) s.show();
      else s.hide();
    }
    if (name !== 'results') this.results.hide();
    if (name === 'pause') {
      const pre = this.pause.q('[data-role="debug"]');
      pre.hidden = !this.showDebug;
      pre.textContent = this.showDebug ? this.handlers.debugInfo() : '';
    }
    if (name === 'title') this.maybeShowTip();
  }

  /** First launch on a touch device: Rotation Lock tip (+ Add to Home Screen when not installed). */
  private maybeShowTip(): void {
    const tip = this.title.q('[data-role="tip"]');
    const force = /[?&]tip=1/.test(location.search);
    tip.hidden = !(force || (!settings.seenRotationTip && isTouch()));
    this.title.q('[data-role="tip-a2hs"]').hidden = isStandalone();
  }

  /** True once the course has finished building. */
  get loaded(): boolean {
    return this.courseLoaded;
  }

  toast(text: string, ms = 2500): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), ms);
  }
}

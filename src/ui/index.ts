import { events, type TiltStatus } from '../core/events';
import { settings, updateSettings } from '../core/settings';
import type { Difficulty, QualityLevel, Sensitivity, SpeedUnit } from '../core/types';
import { ResultsScreen, SpinCard } from './raceHud';
import { onTap, Screen } from './screens';

export { Screen, h, onTap } from './screens';
export { RaceHud, ResultsScreen, SpinCard, RACER_NAME, formatClock, formatDistance, type HudTrack } from './raceHud';

export type ScreenName = 'title' | 'calibrate' | 'pause' | 'spin' | 'results';

/** Callbacks main.ts provides. UI never touches physics/vehicles directly. */
export interface UIHandlers {
  /** Start tap: MUST synchronously kick off permission request + audio unlock (user gesture). */
  onStart(): Promise<TiltStatus>;
  /** Ready tap on the calibration screen. */
  onReady(): void;
  onResume(): void;
  onMenu(): void;
  onRecalibrate(): void;
  onQuality(level: QualityLevel): void;
  /** Results screen: start a new race (new spin). Optional so older wiring still compiles. */
  onRaceAgain?(): void;
  /** Results screen: back to the title. Defaults to onMenu. */
  onResultsMenu?(): void;
  /** Debug readout for the pause screen. */
  debugInfo(): string;
}

/**
 * Screens for M1: title, calibrate ("hold it like a wheel"), pause/settings, rotate overlay, toast.
 *
 * TODO(ui agent):
 *  - Vehicle spin reel screen (slot machine, stat bars) — after calibrate, before countdown.
 *  - Countdown overlay (listen to race:countdown / race:go).
 *  - HUD: position + timer top, progress strip with both cars + hill (RaceView.progress, track.length),
 *    "Resetting…" indicator (RaceController.isResetting).
 *  - Results screen (race:results): winner, distances, bonus, session score, Race Again / Menu.
 *  - Settings: music/sfx volume, difficulty, sensitivity, graphics, steer buttons, recalibrate.
 *  - First-launch Rotation Lock tip (settings.seenRotationTip).
 */
export class UI {
  readonly root: HTMLElement;
  readonly title: Screen;
  readonly calibrate: Screen;
  readonly pause: Screen;
  /** Placeholder vehicle reveal (until the vehicles spin screen is merged). */
  readonly spin: SpinCard;
  readonly results: ResultsScreen;
  private toastEl: HTMLDivElement;
  private toastTimer = 0;

  constructor(
    root: HTMLElement,
    private handlers: UIHandlers,
  ) {
    this.root = root;

    this.title = new Screen(
      root,
      `<div class="title-screen">
         <h1 class="logo">DIRT<span>RACE</span></h1>
         <button class="big-btn" data-tap="start">START</button>
         <p class="hint" data-role="title-hint"></p>
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
           <span>Graphics</span>
           <div class="seg" data-seg="quality">
             <button data-v="low">Low</button><button data-v="medium">Med</button><button data-v="high">High</button>
           </div>
           <span>Steering</span>
           <div class="seg" data-seg="steer">
             <button data-v="tilt">Tilt</button><button data-v="buttons">Buttons</button>
           </div>
           <span>Computer</span>
           <div class="seg" data-seg="difficulty">
             <button data-v="easy">Easy</button><button data-v="normal">Normal</button><button data-v="hard">Hard</button>
           </div>
           <span>Speed in</span>
           <div class="seg" data-seg="speedUnit">
             <button data-v="mph">mph</button><button data-v="kmh">km/h</button>
           </div>
         </div>
         <div class="row">
           <button class="mid-btn" data-tap="recal">Recalibrate tilt</button>
           <button class="mid-btn" data-tap="menu">Menu</button>
         </div>
         <pre class="debug" data-role="debug"></pre>
       </div>`,
      'pause',
    );

    this.spin = new SpinCard(root);
    this.results = new ResultsScreen(root, {
      onRaceAgain: () => this.handlers.onRaceAgain?.(),
      onMenu: () => (this.handlers.onResultsMenu ?? this.handlers.onMenu)(),
    });

    this.toastEl = document.createElement('div');
    this.toastEl.className = 'toast';
    this.toastEl.hidden = true;
    root.appendChild(this.toastEl);

    this.bind();
    events.on('settings:changed', () => this.refreshSegments());
    events.on('quality:changed', ({ level, auto }) => {
      this.refreshSegments();
      if (auto) this.toast(`Graphics lowered to ${level} for smoother driving`);
    });
  }

  private bind(): void {
    const startBtn = this.title.q('[data-tap="start"]');
    onTap(startBtn, () => {
      startBtn.setAttribute('disabled', '');
      // Call synchronously inside the gesture.
      void this.handlers.onStart().then((status) => {
        startBtn.removeAttribute('disabled');
        this.showTiltStatus(status);
      });
    });
    onTap(this.calibrate.q('[data-tap="ready"]'), () => this.handlers.onReady());
    onTap(this.pause.q('[data-tap="resume"]'), () => this.handlers.onResume());
    onTap(this.pause.q('[data-tap="recal"]'), () => this.handlers.onRecalibrate());
    onTap(this.pause.q('[data-tap="menu"]'), () => this.handlers.onMenu());

    for (const seg of this.pause.el.querySelectorAll<HTMLElement>('[data-seg]')) {
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) {
        onTap(b, () => {
          const v = b.dataset.v!;
          if (seg.dataset.seg === 'sensitivity') updateSettings({ sensitivity: v as Sensitivity });
          else if (seg.dataset.seg === 'quality') {
            updateSettings({ autoQuality: false });
            this.handlers.onQuality(v as QualityLevel);
          } else if (seg.dataset.seg === 'steer') updateSettings({ steerButtons: v === 'buttons' });
          else if (seg.dataset.seg === 'difficulty') {
            const changed = settings.difficulty !== v;
            updateSettings({ difficulty: v as Difficulty });
            if (changed) this.toast('Computer difficulty changes from the next race');
          } else if (seg.dataset.seg === 'speedUnit') updateSettings({ speedUnit: v as SpeedUnit });
          this.refreshSegments();
        });
      }
    }
    this.refreshSegments();
  }

  private refreshSegments(): void {
    const current: Record<string, string> = {
      sensitivity: settings.sensitivity,
      quality: settings.quality,
      steer: settings.steerButtons ? 'buttons' : 'tilt',
      difficulty: settings.difficulty,
      speedUnit: settings.speedUnit,
    };
    for (const seg of this.pause.el.querySelectorAll<HTMLElement>('[data-seg]')) {
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.v === current[seg.dataset.seg!]);
    }
  }

  showTiltStatus(status: TiltStatus): void {
    const msg = this.calibrate.q('[data-role="cal-msg"]');
    if (status === 'granted') {
      msg.textContent = 'Hold the iPad up in front of you, nice and level, then tap Ready.';
    } else if (status === 'denied') {
      msg.innerHTML =
        'Tilt steering is switched off, so you can use the <b>◀ ▶ buttons</b> instead.<br>' +
        '<small>To use tilt: close the game, open it again and tap <b>Allow</b> when asked. ' +
        'If it never asks: Settings → Safari → Advanced → Website Data, remove this site, and reopen.</small>';
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
    for (const s of [this.title, this.calibrate, this.pause, this.spin.screen, this.results.screen]) {
      if (s.name === name) s.show();
      else s.hide();
    }
    if (name === 'pause') this.pause.q('[data-role="debug"]').textContent = this.handlers.debugInfo();
  }

  toast(text: string, ms = 2500): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), ms);
  }
}

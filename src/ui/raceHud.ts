import { events, type RaceResults } from '../core/events';
import { settings } from '../core/settings';
import type { RacerId, SpeedUnit, System } from '../core/types';
import type { RaceView } from '../race/types';
import { damageColor } from './damageMeter';
import { h, onTap, Screen } from './screens';

/** Display names (SPEC: "Brooks vs Computer"). */
export const RACER_NAME: Record<RacerId, string> = {
  player: 'Brooks',
  cpu: 'Computer',
};

const M_TO_FT = 3.28084;

/** "1:05" */
export function formatClock(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Distance in the chosen unit family: metres for km/h, feet for mph. */
export function formatDistance(m: number, unit: SpeedUnit = settings.speedUnit): string {
  return unit === 'mph' ? `${Math.round(m * M_TO_FT).toLocaleString('en-US')} ft` : `${Math.round(m).toLocaleString('en-US')} m`;
}

/** Track geometry the HUD needs for the progress strip (end jump: ramp lip and bonus line). */
export interface HudTrack {
  length: number;
  finishS: number;
  jumpS: number;
  bonusS: number;
}

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

/**
 * In-race HUD (SPEC "HUD: position + timer top, progress strip with both cars and the end jump"):
 *  - position badge (1st/2nd) and race clock (counts down from 8:00, red in the last 30 s)
 *  - progress strip: start → finish flag → jump ramp → bonus star, with both cars
 *  - bonus-jump banner with its own countdown
 *  - big 3-2-1-GO overlay, "Resetting…" pill, short centre messages ("You took the lead!")
 * Reads RaceView only; never touches physics. Cheap: text/style writes only when values change.
 */
export class RaceHud implements System {
  readonly el: HTMLElement;
  private posEl: HTMLElement;
  private clockEl: HTMLElement;
  private stripEl: HTMLElement;
  private markers: Record<RacerId, HTMLElement>;
  private bonusEl: HTMLElement;
  private bonusClock: HTMLElement;
  private bonusMsg: HTMLElement;
  private countEl: HTMLElement;
  private resetEl: HTMLElement;
  private msgEl: HTMLElement;
  private msgTimer = 0;
  private countText = '';
  private last: Record<string, string> = {};
  private track: HudTrack | null = null;

  constructor(
    parent: HTMLElement,
    private race: RaceView & { isResetting?(r: RacerId): boolean },
  ) {
    this.el = h(`
      <div class="race-hud" hidden>
        <div class="rh-top">
          <div class="rh-pos" data-r="pos">1<sup>st</sup></div>
          <div class="rh-clock" data-r="clock">4:00</div>
        </div>
        <div class="rh-strip" data-r="strip">
          <div class="rh-track"></div>
          <div class="rh-jump"></div>
          <div class="rh-flag rh-finish" title="Finish">🏁</div>
          <div class="rh-flag rh-star" title="Jump bonus line">⭐</div>
          <div class="rh-car rh-cpu" data-r="cpu"><span>CPU</span></div>
          <div class="rh-car rh-player" data-r="player"><span>YOU</span></div>
        </div>
        <div class="rh-bonus" data-r="bonus" hidden>
          <b>BONUS JUMP</b>
          <span class="rh-bonus-clock" data-r="bonusClock">0:45</span>
          <small data-r="bonusMsg">Full speed at the ramp! Land past the gold line for +1!</small>
        </div>
        <div class="rh-reset" data-r="reset" hidden>Resetting…</div>
        <div class="rh-msg" data-r="msg" hidden></div>
        <div class="rh-count" data-r="count" hidden></div>
      </div>`);
    parent.appendChild(this.el);
    const q = (r: string): HTMLElement => this.el.querySelector(`[data-r="${r}"]`) as HTMLElement;
    this.posEl = q('pos');
    this.clockEl = q('clock');
    this.stripEl = q('strip');
    this.markers = { player: q('player'), cpu: q('cpu') };
    this.bonusEl = q('bonus');
    this.bonusClock = q('bonusClock');
    this.bonusMsg = q('bonusMsg');
    this.countEl = q('count');
    this.resetEl = q('reset');
    this.msgEl = q('msg');

    events.on('race:lead', ({ leader }) =>
      this.message(leader === 'player' ? 'You took the lead!' : 'Computer passed you!', leader === 'player' ? 'good' : 'bad'),
    );
    events.on('race:finish', ({ racer, winner }) => {
      if (racer === 'player') this.message(winner ? 'YOU WIN THE RACE! +1' : 'Finished!', winner ? 'good' : '', 3000);
      else if (winner) this.message('Computer finished first', 'bad', 2500);
    });
    events.on('race:jump', ({ racer, distanceM, bonus, crashed }) => {
      const d = formatDistance(distanceM);
      if (racer === 'player') {
        if (bonus) this.message(`${d} JUMP! +1 BONUS`, 'gold', 3200);
        else if (crashed) this.message(`Crash landing! (${d}) No bonus`, 'bad', 2800);
        else this.message(`${d} jump. So close!`, '', 2800);
      } else if (bonus) this.message(`Computer jumped ${d}: +1 bonus`, 'bad', 2500);
    });
    events.on('race:timeout', () => this.message("TIME'S UP!", '', 2500));
  }

  /** Set track geometry (call when the world/track changes). */
  setTrack(t: HudTrack): void {
    this.track = t;
    const pct = (s: number): string => `${(100 * s) / Math.max(1, t.length)}%`;
    (this.stripEl.querySelector('.rh-finish') as HTMLElement).style.left = pct(t.finishS);
    (this.stripEl.querySelector('.rh-star') as HTMLElement).style.left = pct(t.bonusS);
    // A little ramp wedge whose lip sits at the take-off point.
    (this.stripEl.querySelector('.rh-jump') as HTMLElement).style.left = pct(t.jumpS);
  }

  /** Marker colours = car paint (helps a kid match the dot to the car). */
  setCarColors(colors: Record<RacerId, number>): void {
    for (const r of ['player', 'cpu'] as RacerId[]) this.markers[r].style.setProperty('--car', hex(colors[r]));
  }

  setVisible(v: boolean): void {
    this.el.hidden = !v;
    if (!v) {
      this.countEl.hidden = true;
      this.countText = '';
      this.msgEl.hidden = true;
    }
  }

  private set(key: string, el: HTMLElement, html: string): void {
    if (this.last[key] === html) return;
    this.last[key] = html;
    el.innerHTML = html;
  }

  /** Big 3-2-1-GO, driven by race state (sim time) so it stays in sync even on slow frames. */
  private updateCount(): void {
    const r = this.race;
    let text = '';
    if (r.phase === 'countdown') text = String(Math.max(1, Math.ceil(r.countdownLeftS ?? 0)));
    else if (r.phase === 'racing' && r.elapsedS < 0.9) text = 'GO!';
    if (text === this.countText) return;
    this.countText = text;
    this.countEl.hidden = !text;
    if (!text) return;
    this.countEl.textContent = text;
    this.countEl.classList.toggle('go', text === 'GO!');
    // Restart the pop animation.
    this.countEl.classList.remove('pop');
    void this.countEl.offsetWidth;
    this.countEl.classList.add('pop');
  }

  /** Short centre message. */
  message(text: string, tone: '' | 'good' | 'bad' | 'gold' = '', ms = 1800): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `rh-msg ${tone}`;
    this.msgEl.hidden = false;
    clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => (this.msgEl.hidden = true), ms);
  }

  update(): void {
    if (this.el.hidden) return;
    const r = this.race;
    const me = r.progress.player;
    const phase = r.phase;
    this.updateCount();
    const live = phase === 'racing' || phase === 'bonus';
    this.set('pos', this.posEl, live || phase === 'results' ? (me.position === 1 ? '1<sup>st</sup>' : '2<sup>nd</sup>') : '');
    this.posEl.classList.toggle('second', me.position === 2);
    const left = phase === 'countdown' ? (r.config?.timeLimitS ?? 240) : r.timeLeftS;
    this.set('clock', this.clockEl, formatClock(left));
    this.clockEl.classList.toggle('low', live && left <= 30);

    const t = this.track;
    if (t) {
      for (const id of ['player', 'cpu'] as RacerId[]) {
        const p = r.progress[id];
        const s = phase === 'countdown' ? 0 : Math.max(0, Math.min(t.length, p.stage === 'done' ? p.bestS : p.s));
        const pct = ((100 * s) / Math.max(1, t.length)).toFixed(1);
        if (this.last[`m${id}`] !== pct) {
          this.last[`m${id}`] = pct;
          this.markers[id].style.left = `${pct}%`;
        }
      }
    }

    const inBonus = me.stage === 'bonus';
    this.bonusEl.hidden = !inBonus;
    if (inBonus) {
      this.set('bonus', this.bonusClock, formatClock(me.bonusLeftS));
      this.bonusEl.classList.toggle('low', me.bonusLeftS <= 10);
      const msg =
        me.jump === 'air' || me.jump === 'landing' ? 'Hang on… land on your wheels!' : me.bonusLeftS <= 10 ? 'Hurry! Keep the gas down!' : 'Full speed at the ramp! Land past the gold line for +1!';
      this.set('bonusMsg', this.bonusMsg, msg);
    }
    this.resetEl.hidden = !(r.isResetting?.('player') ?? false);
  }
}

/** Results screen (SPEC step 8): winner, distances, bonus points, session score, Race Again / Menu. */
export class ResultsScreen {
  readonly screen: Screen;
  constructor(root: HTMLElement, handlers: { onRaceAgain(): void; onMenu(): void }) {
    this.screen = new Screen(
      root,
      `<div class="results-screen">
         <div class="res-confetti" data-r="confetti" aria-hidden="true"></div>
         <div class="res-trophy" data-r="trophy" aria-hidden="true"></div>
         <h1 class="results-title" data-r="title">YOU WIN!</h1>
         <p class="results-sub" data-r="sub"></p>
         <div class="row results-row" data-r="cards"></div>
         <div class="session" data-r="session"></div>
         <div class="row">
           <button class="big-btn" data-tap="again">RACE AGAIN</button>
           <button class="mid-btn" data-tap="menu">Menu</button>
         </div>
       </div>`,
      'results',
    );
    onTap(this.screen.q('[data-tap="again"]'), () => handlers.onRaceAgain());
    onTap(this.screen.q('[data-tap="menu"]'), () => handlers.onMenu());
  }

  show(res: RaceResults, colors?: Partial<Record<RacerId, number>>): void {
    const s = this.screen;
    const title = s.q('[data-r="title"]');
    title.textContent = res.winner === 'player' ? 'YOU WIN!' : res.winner === 'cpu' ? 'COMPUTER WINS' : "IT'S A TIE!";
    title.className = `results-title ${res.winner === 'player' ? 'win' : res.winner === 'cpu' ? 'lose' : ''}`;
    s.q('[data-r="sub"]').textContent =
      res.reason === 'distance'
        ? `Time ran out, so the car that got farthest wins.`
        : res.reason === 'tie'
          ? 'Time ran out with both cars in the same place.'
          : res.winner === 'player'
            ? 'First across the finish line!'
            : 'The computer crossed the finish line first.';
    const finish = res.finishM ?? 1;
    const total = Math.max(finish, 1);
    s.q('[data-r="cards"]').innerHTML = res.racers
      .map((r) => {
        const won = res.winner === r.racer;
        const pct = Math.min(100, (100 * r.distanceM) / total);
        const how = r.finished ? `Finished in ${formatClock(r.timeS ?? 0)}` : `Reached ${formatDistance(r.distanceM)}`;
        const c = colors?.[r.racer];
        return `<div class="res-card ${won ? 'winner' : ''}">
            <div class="res-who">${won ? '🏆 ' : ''}${RACER_NAME[r.racer]}</div>
            <div class="res-car">${c !== undefined ? `<i class="dot" style="background:${hex(c)}"></i>` : ''}${r.vehicle}</div>
            <div class="res-bar"><i style="width:${pct.toFixed(1)}%"></i><b style="left:${((100 * finish) / total).toFixed(1)}%">🏁</b></div>
            <div class="res-line">${how}</div>
            <div class="res-line">${jumpLine(r, res.jumpBonusM)}</div>
            ${r.damage !== undefined ? `<div class="res-line res-damage">🔧 Damage <b style="color:${damageColor(r.damage)}">${Math.round(r.damage)}%</b></div>` : ''}
            <div class="res-points">+${r.points} <small>point${r.points === 1 ? '' : 's'}</small></div>
          </div>`;
      })
      .join('');
    s.q('[data-r="session"]').innerHTML = `<span>Brooks</span><b>${res.session.player}</b><em>–</em><b>${res.session.cpu}</b><span>Computer</span>`;
    // Celebration: CSS confetti rain + bouncing trophy when Brooks wins; a smaller star shower for a
    // jump bonus; an encouraging line otherwise. Pure CSS animations (compositor only), removed on hide.
    const me = res.racers.find((r) => r.racer === 'player');
    const won = res.winner === 'player';
    const party = won || !!me?.bonus;
    const conf = s.q('[data-r="confetti"]');
    conf.innerHTML = party ? confettiHtml(won ? 46 : 22, won ? CONFETTI_COLORS : ['#ffd34d', '#ffe680', '#fff2b0']) : '';
    s.q('[data-r="trophy"]').textContent = won ? '🏆' : me?.bonus ? '⭐' : '';
    s.el.classList.toggle('celebrate', party);
    if (!won && res.winner === 'cpu') s.q('[data-r="sub"]').textContent += me?.bonus ? ' But you got the jump bonus!' : ' So close! Race again?';
    s.show();
  }

  hide(): void {
    this.screen.hide();
    this.screen.q('[data-r="confetti"]').innerHTML = '';
  }
}

/** Results line for the end jump: distance, and whether it earned the bonus. */
function jumpLine(r: RaceResults['racers'][number], bonusM?: number): string {
  if (r.jumpM === null || r.jumpM === undefined) return r.finished ? 'No jump' : '&nbsp;';
  const d = formatDistance(r.jumpM);
  if (r.bonus) return `⭐ ${d} jump: bonus!`;
  if (r.jumpCrashed) return `💥 ${d} jump (crash landing)`;
  return `🛬 ${d} jump${bonusM ? ` (needed ${formatDistance(bonusM)})` : ''}`;
}

const CONFETTI_COLORS = ['#ff4d4d', '#ffd23f', '#3fb6ff', '#6ee06e', '#ff8ad8', '#ffffff', '#ff9a3d'];

/** Absolutely positioned confetti pieces with randomised CSS variables (animation lives in style.css). */
function confettiHtml(n: number, colors: string[]): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = (Math.random() * 100).toFixed(1);
    const d = (2.4 + Math.random() * 2.2).toFixed(2);
    const delay = (Math.random() * 1.6).toFixed(2);
    const rot = Math.round(Math.random() * 720 - 360);
    const drift = Math.round(Math.random() * 80 - 40);
    const c = colors[i % colors.length];
    out += `<i style="--x:${x}%;--d:${d}s;--delay:${delay}s;--r:${rot}deg;--dx:${drift}px;--c:${c}"></i>`;
  }
  return out;
}

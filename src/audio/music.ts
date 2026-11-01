/**
 * Procedural music: a tiny step sequencer that schedules short oscillator/noise notes ahead of time.
 * Songs are hand-written (not random) so they stay pleasant on repeat: 16-bar forms with an A/B
 * structure, and the race song drops its lead in the B section to give the ears a rest.
 *
 * CPU: a handful of short-lived nodes per 16th step; nothing runs between notes.
 * Works with any BaseAudioContext, so scripts can render it with an OfflineAudioContext.
 */

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** "C5", "F#4", "Bb3" → MIDI. */
export function midi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return 12 * (Number(m[3]) + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const hz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** A bar of 8 eighth-notes: note names, "-" = hold previous, "." = rest. */
type Bar8 = string;
interface Section {
  chords: string[]; // one chord per bar, e.g. "C", "Am", "F#m", "G7"
  lead?: Bar8[]; // same length as chords (or omitted)
  arp?: boolean; // play a chord arpeggio instead of a lead
  drums: 'light' | 'full' | 'break';
}
export interface Song {
  bpm: number;
  swing: number; // 0..0.3 delay of off-beat 16ths
  sections: Section[];
  lead: 'bell' | 'square' | 'saw';
  bassStyle: 'walk' | 'octave';
  level: number;
}

const CHORD_Q: Record<string, number[]> = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], sus: [0, 5, 7] };
function chordNotes(c: string, octave = 4): number[] {
  const m = /^([A-G][#b]?)(.*)$/.exec(c)!;
  const root = midi(`${m[1]}${octave}`);
  return (CHORD_Q[m[2]] ?? CHORD_Q['']).map((i) => root + i);
}

// ---------------------------------------------------------------- songs

export const MENU_SONG: Song = {
  bpm: 104,
  swing: 0.12,
  lead: 'bell',
  bassStyle: 'walk',
  level: 0.8,
  sections: [
    { chords: ['C', 'Am', 'F', 'G'], drums: 'light', lead: ['G4 C5 E5 G5 - E5 C5 .', 'A4 C5 E5 A5 - G5 E5 .', 'F5 - E5 F5 A5 - G5 F5', 'D5 - - . G4 . B4 .'] },
    { chords: ['C', 'Am', 'F', 'G'], drums: 'light', lead: ['G4 C5 E5 G5 - E5 C5 .', 'A4 C5 E5 A5 - G5 E5 .', 'F5 - E5 F5 A5 - G5 F5', 'D5 E5 F5 D5 B4 - G4 .'] },
    { chords: ['F', 'G', 'Em', 'Am'], drums: 'light', arp: true, lead: ['A5 - G5 - F5 - C5 -', 'B4 - D5 - G5 - F5 -', 'E5 - G5 - B5 - G5 -', 'A5 - - - E5 - C5 -'] },
    { chords: ['F', 'G', 'C', 'C'], drums: 'light', lead: ['F5 - A5 - C6 - A5 -', 'G5 - F5 - D5 - B4 -', 'C5 - E5 - G5 - E5 -', 'C5 - - - . . . .'] },
  ],
};

export const RACE_SONG: Song = {
  bpm: 146,
  swing: 0,
  lead: 'square',
  bassStyle: 'octave',
  level: 0.62,
  sections: [
    { chords: ['G', 'Em', 'C', 'D'], drums: 'full', lead: ['D5 D5 G5 D5 B4 D5 G5 A5', 'B5 - A5 G5 E5 - G5 -', 'C5 E5 G5 E5 C6 - B5 A5', 'A5 - F#5 - D5 - . .'] },
    { chords: ['G', 'Em', 'C', 'D'], drums: 'full', lead: ['D5 D5 G5 D5 B4 D5 G5 A5', 'B5 - A5 G5 E5 - G5 -', 'C5 E5 G5 E5 C6 - B5 A5', 'A5 B5 A5 F#5 D5 F#5 A5 -'] },
    { chords: ['C', 'D', 'Bm', 'Em'], drums: 'break', arp: true },
    { chords: ['C', 'D', 'G', 'G'], drums: 'full', arp: true, lead: ['. . E5 - G5 - C6 -', 'B5 - A5 - F#5 - D5 -', 'G5 - B5 - D6 - B5 -', 'G5 - - - . . . .'] },
  ],
};

// ---------------------------------------------------------------- sequencer

interface Step {
  bar: number; // global bar index
  s16: number; // 0..15
  section: Section;
  barInSection: number;
}

/**
 * Plays a Song into `out`. Call `pump(now)` regularly (every frame is fine): it schedules everything
 * up to `now + lookahead`. For offline rendering call `pump(endTime)` once.
 */
export class Sequencer {
  readonly gain: GainNode;
  private step = 0;
  private nextT: number;
  private readonly stepDur: number;
  private readonly bars: number;
  private noise: AudioBuffer;
  private stopped = false;
  private readonly nodes = new Set<AudioScheduledSourceNode>();

  constructor(
    private ctx: BaseAudioContext,
    readonly song: Song,
    out: AudioNode,
    startAt = ctx.currentTime + 0.06,
    fadeIn = 0.6,
  ) {
    this.gain = ctx.createGain();
    this.gain.gain.setValueAtTime(0, startAt);
    this.gain.gain.linearRampToValueAtTime(song.level, startAt + fadeIn);
    this.gain.connect(out);
    this.nextT = startAt;
    this.stepDur = 60 / song.bpm / 4;
    this.bars = song.sections.reduce((n, s) => n + s.chords.length, 0);
    this.noise = noiseBuffer(ctx);
  }

  get loopSeconds(): number {
    return this.bars * 16 * this.stepDur;
  }

  pump(until: number): void {
    if (this.stopped) return;
    // If we fell far behind (tab was throttled), skip ahead instead of bursting notes.
    if (this.nextT < this.ctx.currentTime - 0.2) this.nextT = this.ctx.currentTime + 0.05;
    while (this.nextT < until) {
      const swing = this.step % 2 === 1 ? this.song.swing * this.stepDur : 0;
      this.playStep(this.locate(this.step), this.nextT + swing);
      this.nextT += this.stepDur;
      this.step = (this.step + 1) % (this.bars * 16);
    }
  }

  stop(at = this.ctx.currentTime, fade = 0.5): void {
    if (this.stopped) return;
    this.stopped = true;
    const g = this.gain.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(0, at + fade);
    for (const n of this.nodes) {
      try {
        n.stop(at + fade + 0.02);
      } catch {
        /* not started yet or already stopped */
      }
    }
    setTimeout(() => this.gain.disconnect(), (fade + 0.3) * 1000);
  }

  private locate(step: number): Step {
    let bar = Math.floor(step / 16);
    const s16 = step % 16;
    const global = bar;
    for (const section of this.song.sections) {
      if (bar < section.chords.length) return { bar: global, s16, section, barInSection: bar };
      bar -= section.chords.length;
    }
    return { bar: global, s16, section: this.song.sections[0], barInSection: 0 };
  }

  private playStep(st: Step, t: number): void {
    const { section, barInSection, s16 } = st;
    const chord = section.chords[barInSection];
    const race = this.song.bassStyle === 'octave';
    const beat = s16 % 4 === 0;

    // ---- drums
    const d = section.drums;
    if (d === 'full') {
      if (beat) this.kick(t, 0.9);
      if (s16 === 4 || s16 === 12) this.snare(t, 0.55);
      if (s16 % 2 === 0) this.hat(t, s16 % 4 === 2 ? 0.22 : 0.12, 0.035);
      if (barInSection === section.chords.length - 1 && s16 >= 12) this.snare(t, 0.25 + (s16 - 12) * 0.08); // fill
    } else if (d === 'light') {
      if (s16 === 0 || s16 === 10) this.kick(t, 0.55);
      if (s16 === 4 || s16 === 12) this.snare(t, 0.22, true);
      if (s16 % 4 === 2) this.hat(t, 0.1, 0.03);
    } else {
      if (s16 === 0 || s16 === 8) this.kick(t, 0.6);
      if (s16 % 4 === 2) this.hat(t, 0.12, 0.05);
    }

    // ---- bass
    const notes = chordNotes(chord, 2);
    const root = notes[0];
    if (race) {
      if (s16 % 2 === 0) this.bass(t, hz(s16 % 4 === 0 ? root : root + 12), this.stepDur * 1.6, 0.5);
    } else if (s16 % 4 === 0) {
      const walk = [root, notes[2], root + 12, notes[2]];
      this.bass(t, hz(walk[s16 / 4]), this.stepDur * 3.2, 0.45);
    }

    // ---- chords (soft stabs on the off-beats for menu, on 1 and the "and of 2" for race)
    const stab = race ? s16 === 0 || s16 === 6 || s16 === 8 || s16 === 14 : s16 === 2 || s16 === 6 || s16 === 10 || s16 === 14;
    if (stab && !(section.arp && race)) {
      for (const n of chordNotes(chord, 4)) this.pad(t, hz(n), this.stepDur * (race ? 1.5 : 1.8), race ? 0.06 : 0.07);
    }
    if (section.arp && s16 % 2 === 0) {
      const ns = chordNotes(chord, race ? 5 : 4);
      const seq = [0, 1, 2, 1, 0, 1, 2, 1];
      const n = ns[seq[(s16 / 2) % 8]] + (s16 >= 8 && race ? 12 : 0);
      this.pluck(t, hz(n), this.stepDur * 1.8, race ? 0.1 : 0.12);
    }

    // ---- lead (eighths)
    if (section.lead && s16 % 2 === 0) {
      const toks = section.lead[barInSection].trim().split(/\s+/);
      const i = s16 / 2;
      const tok = toks[i];
      if (tok && tok !== '-' && tok !== '.') {
        let len = 1;
        while (toks[i + len] === '-') len++;
        this.lead(t, hz(midi(tok)), len * 2 * this.stepDur);
      }
    }
  }

  // ---------------------------------------------------------- instruments

  private track(n: AudioScheduledSourceNode, start: number, stop: number): void {
    n.start(start);
    n.stop(stop);
    this.nodes.add(n);
    n.onended = () => this.nodes.delete(n);
  }

  private env(t: number, peak: number, a: number, decay: number, dur: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(0, t + a, decay);
    g.gain.setTargetAtTime(0, t + dur, 0.02);
    g.connect(this.gain);
    return g;
  }

  private kick(t: number, v: number): void {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    o.connect(this.env(t, v * 0.9, 0.002, 0.07, 0.3));
    this.track(o, t, t + 0.35);
  }

  private snare(t: number, v: number, soft = false): void {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = soft ? 'bandpass' : 'highpass';
    f.frequency.value = soft ? 2500 : 1400;
    n.connect(f).connect(this.env(t, v * 0.5, 0.001, soft ? 0.03 : 0.05, 0.22));
    this.track(n, t, t + 0.25);
    if (!soft) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(160, t + 0.06);
      o.connect(this.env(t, v * 0.35, 0.001, 0.035, 0.12));
      this.track(o, t, t + 0.14);
    }
  }

  private hat(t: number, v: number, dur: number): void {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    n.connect(f).connect(this.env(t, v * 0.45, 0.001, dur / 3, dur));
    this.track(n, t, t + dur + 0.05);
  }

  private bass(t: number, f: number, dur: number, v: number): void {
    const o = this.ctx.createOscillator();
    o.type = this.song.bassStyle === 'octave' ? 'sawtooth' : 'triangle';
    o.frequency.value = f;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(this.song.bassStyle === 'octave' ? 900 : 1200, t);
    lp.frequency.setTargetAtTime(300, t, 0.06);
    o.connect(lp).connect(this.env(t, v, 0.005, dur * 0.6, dur));
    this.track(o, t, t + dur + 0.1);
  }

  private pad(t: number, f: number, dur: number, v: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(this.env(t, v, 0.01, dur * 0.5, dur));
    this.track(o, t, t + dur + 0.1);
  }

  private pluck(t: number, f: number, dur: number, v: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.setTargetAtTime(600, t, 0.05);
    o.connect(lp).connect(this.env(t, v, 0.003, 0.08, dur));
    this.track(o, t, t + dur + 0.1);
  }

  private lead(t: number, f: number, dur: number): void {
    const kind = this.song.lead;
    const o = this.ctx.createOscillator();
    o.frequency.value = f;
    if (kind === 'bell') {
      // Sine + quiet 3rd partial = soft music-box/marimba.
      o.type = 'sine';
      const o2 = this.ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = f * 3;
      const g2 = this.env(t, 0.05, 0.002, 0.05, dur);
      o2.connect(g2);
      this.track(o2, t, t + dur + 0.1);
      o.connect(this.env(t, 0.26, 0.004, Math.min(0.5, dur * 0.7), dur));
    } else {
      o.type = kind === 'square' ? 'square' : 'sawtooth';
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      lp.Q.value = 2;
      o.connect(lp).connect(this.env(t, 0.1, 0.006, Math.max(0.08, dur * 0.8), dur * 0.92));
    }
    this.track(o, t, t + dur + 0.1);
  }
}

const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const d = b.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < d.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      d[i] = (s / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, b);
  }
  return b;
}

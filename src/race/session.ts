import { loadJSON, saveJSON } from '../core/storage';
import type { RacerId } from '../core/types';

const KEY = 'dirtrace.session.v1';

/** Running session score (Brooks vs Computer), persisted in localStorage (SPEC). */
export const session = {
  score: loadJSON<Record<RacerId, number>>(KEY, { player: 0, cpu: 0 }),
  add(racer: RacerId, points: number): void {
    this.score[racer] += points;
    saveJSON(KEY, this.score);
  },
  clear(): void {
    this.score = { player: 0, cpu: 0 };
    saveJSON(KEY, this.score);
  },
};

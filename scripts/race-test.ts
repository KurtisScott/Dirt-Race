/**
 * Headless race test (no browser): full races on TestGround with the real RaceController, RaceFlow,
 * AIDriver, vehicles and Rapier. Run: npm run race-test
 *
 *  1. For each difficulty: the computer races a "stand-in Brooks" (an AI on Normal) in identical pickups.
 *     Checks the state machine (countdown frozen → GO → finish → bonus → results), points, session score.
 *  2. Brooks does nothing (full 8-minute timer): computer finishes and should win; results arrive at the timer.
 *  3. Nobody finishes before a short timer: farthest along the centre-line wins.
 *  4. Both idle: tie, no points. Reset button: respawn after 2 s.
 *  6. End-jump rules on a scripted straight (fake cars): bonus landing, short landing, crash landing,
 *     no take-off, one attempt only, window running out, reset mid-jump.
 */
import * as THREE from 'three';

// ---- minimal DOM/localStorage shims (TestGround draws a grass texture on a canvas; session uses localStorage)
const store = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => undefined, set: () => true }),
  }),
};

const { initRapier, PhysicsWorld, PHYSICS_DT } = await import('../src/core/physics');
const { events } = await import('../src/core/events');
const { TestGround } = await import('../src/world/testGround');
const { RaceCourse } = await import('../src/world/raceCourse');
/** WORLD=race runs the same races on the real course (default: the M1 test ground, fast). */
const USE_RACE_COURSE = process.env.WORLD === 'race';
/** Scale for the short solo timers (the test loop is ~560 m; the real course ~4.6 km to the finish). */
const SOLO_T = USE_RACE_COURSE ? 5 : 1;
const { RaceController, RaceFlow, session, DEFAULT_RACE_CONFIG } = await import('../src/race');
const { PolylineTrack } = await import('../src/world/polylineTrack');
const { AIDriver, createPhysicsSensor } = await import('../src/ai');
const { createVehicle } = await import('../src/vehicles/vehicle');
const { VEHICLES } = await import('../src/vehicles/catalog');
type Difficulty = import('../src/core/types').Difficulty;
type RacerId = import('../src/core/types').RacerId;
type RaceResults = import('../src/core/events').RaceResults;
type VehicleKind = import('../src/core/types').VehicleKind;

await initRapier();

let failures = 0;
const check = (ok: boolean, msg: string): void => {
  console.log(`${ok ? '  ok ' : ' FAIL'} ${msg}`);
  if (!ok) failures++;
};

interface Opts {
  cpuDifficulty: Difficulty;
  /** 'ai' = stand-in Brooks driven by an AI on Normal; 'idle' = no input. */
  player: 'ai' | 'idle';
  cpuIdle?: boolean;
  timeLimitS?: number;
  kinds?: [VehicleKind, VehicleKind];
  maxSimS?: number;
  seed?: number;
  /** Called every step with sim time (for poking at the race mid-way). */
  each?: (t: number, h: Harness) => void;
}
interface Harness {
  race: InstanceType<typeof RaceController>;
  flow: InstanceType<typeof RaceFlow>;
  world: InstanceType<typeof TestGround> | InstanceType<typeof RaceCourse>;
}

function runRace(o: Opts) {
  const physics = new PhysicsWorld();
  const scene = new THREE.Scene();
  const ctx = {
    physics,
    renderer: { scene },
    quality: { preset: { textureSize: 64, detail: 0.5 } },
  } as never;
  const world = USE_RACE_COURSE ? new RaceCourse(ctx) : new TestGround(ctx);
  // The test loop has no ramp after its finish: a short miss distance ends the (ramp-less) attempt quickly.
  const race = new RaceController(world, { ...(o.timeLimitS ? { timeLimitS: o.timeLimitS } : {}), ...(USE_RACE_COURSE ? {} : { jumpMissM: 8 }) });
  const playerInput = {
    state: { steer: 0, throttle: 0, brake: 0 },
    enabled: false,
  };
  let standIn = null as InstanceType<typeof AIDriver> | null;
  const kinds = o.kinds ?? ['pickup', 'pickup'];
  const flow = new RaceFlow({
    race,
    world,
    player: playerInput,
    spin: () => ({
      player: { spec: VEHICLES[kinds[0]], paint: 0xff0000 },
      cpu: { spec: VEHICLES[kinds[1]], paint: 0x0000ff },
    }),
    createVehicle: (racer, pick, spawn) =>
      createVehicle({
        physics,
        surfaces: world,
        spec: pick.spec,
        paint: pick.paint,
        racer,
        spawn,
      }),
    createComputer: (cpu, gap) => {
      const ai = new AIDriver(cpu, world, o.cpuDifficulty, o.seed ?? 1234);
      ai.sensor = createPhysicsSensor(physics, 'cpu');
      ai.rival = { gapM: gap };
      if (o.cpuIdle) ai.fixedUpdate = () => {};
      return ai;
    },
  });

  // Event log.
  const log: { t: number; type: string; payload: unknown }[] = [];
  let simT = 0;
  const offs = (
    [
      'race:countdown',
      'race:go',
      'race:finish',
      'race:jump',
      'race:timeout',
      'race:results',
      'race:lead',
      'race:bonus',
      'race:done',
      'race:checkpoint',
      'race:resetting',
      'phase:changed',
      'vehicle:flipped',
    ] as const
  ).map((type) => events.on(type, (payload: unknown) => log.push({ t: simT, type, payload })));

  void flow.newRace(); // no showSpin → straight to countdown (synchronously up to the await)
  const systems: import('../src/core/types').System[] = [world, race, flow.aiSystem, flow.vehicleSystem];

  // Stand-in Brooks: drives the player's car through the same PlayerInput.state object.
  const startStandIn = (): void => {
    if (o.player !== 'ai' || standIn) return;
    standIn = new AIDriver(flow.vehicles.player!, world, 'normal', 99);
    standIn.sensor = createPhysicsSensor(physics, 'player');
    standIn.onRequestReset = () => race.requestReset('player');
  };

  const h: Harness = { race, flow, world };
  let results: RaceResults | null = null;
  const offRes = events.on('race:results', (r) => (results = r));
  let positionsDuringCountdown: { x: number; z: number }[] | null = null;
  let movedInCountdown = 0;
  const maxSteps = Math.round((o.maxSimS ?? DEFAULT_RACE_CONFIG.timeLimitS + 90) / PHYSICS_DT);
  let resultsAt = -1;
  for (let i = 0; i < maxSteps; i++) {
    simT = i * PHYSICS_DT;
    if (race.phase === 'countdown') {
      const pv = flow.vehicles.player!;
      const cv = flow.vehicles.cpu!;
      if (!positionsDuringCountdown)
        positionsDuringCountdown = [
          { x: pv.position.x, z: pv.position.z },
          { x: cv.position.x, z: cv.position.z },
        ];
      // Try to cheat during the countdown: player stomps the gas.
      playerInput.state.throttle = 1;
      movedInCountdown = Math.max(
        movedInCountdown,
        Math.hypot(pv.position.x - positionsDuringCountdown[0].x, pv.position.z - positionsDuringCountdown[0].z),
        Math.hypot(cv.position.x - positionsDuringCountdown[1].x, cv.position.z - positionsDuringCountdown[1].z),
      );
    } else if (o.player === 'idle') {
      playerInput.state.throttle = 0;
    }
    if (race.phase === 'racing' || race.phase === 'bonus') startStandIn();
    if (standIn) {
      standIn.enabled = playerInput.enabled;
      standIn.fixedUpdate(PHYSICS_DT);
      Object.assign(playerInput.state, standIn.input);
    }
    for (const s of systems) s.fixedUpdate?.(PHYSICS_DT);
    physics.step();
    for (const s of systems) s.postPhysics?.(PHYSICS_DT);
    for (const s of systems) s.update?.(PHYSICS_DT, 1);
    o.each?.(simT, h);
    if (results && resultsAt < 0) resultsAt = simT;
    if (resultsAt >= 0 && simT > resultsAt + 1) break;
  }
  offs.forEach((f) => f());
  offRes();
  const out = {
    results: results as RaceResults | null,
    log,
    race,
    flow,
    movedInCountdown,
    resultsAt,
    progress: structuredClone(race.progress),
  };
  for (const v of Object.values(flow.vehicles)) v?.dispose();
  race.dispose();
  physics.dispose();
  return out;
}

const count = (log: { type: string }[], type: string): number => log.filter((e) => e.type === type).length;
const first = (log: { t: number; type: string; payload: unknown }[], type: string, pred: (p: never) => boolean = () => true) =>
  log.find((e) => e.type === type && pred(e.payload as never));
const fmt = (r: RaceResults | null): string =>
  r
    ? `winner=${r.winner} (${r.reason}) ` +
      r.racers
        .map((x) => `${x.racer}: ${x.distanceM} m ${x.finished ? `fin ${x.timeS?.toFixed(1)} s` : 'dnf'}${x.jumpM !== null && x.jumpM !== undefined ? ` jump ${x.jumpM} m` : ''}${x.bonus ? ' +bonus' : ''} pts ${x.points}`)
        .join(' | ') +
      ` session ${r.session.player}-${r.session.cpu}`
    : 'no results';

const sessionBefore = (): Record<RacerId, number> => ({ ...session.score });
session.clear();

// -------------------------------------------------------------- 1. difficulties
const cpuTimes: Record<string, number> = {};
for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
  console.log(`\n=== race: computer on ${d} vs stand-in Brooks (AI normal), pickup vs pickup ===`);
  const before = sessionBefore();
  const r = runRace({ cpuDifficulty: d, player: 'ai' });
  const res = r.results;
  console.log(`  ${fmt(res)}`);
  const go = first(r.log, 'race:go');
  check(count(r.log, 'race:countdown') === 3 && !!go && Math.abs(go.t - 3) < 0.05, `countdown 3-2-1 then GO at ${go?.t.toFixed(2)} s`);
  check(r.movedInCountdown < 0.3, `cars frozen during countdown even with gas held (moved ${r.movedInCountdown.toFixed(2)} m)`);
  check(!!res, 'results emitted');
  if (!res) continue;
  check(count(r.log, 'race:results') === 1, 'race:results emitted once');
  const finishes = r.log.filter((e) => e.type === 'race:finish') as {
    t: number;
    payload: { racer: RacerId; winner: boolean };
  }[];
  check(finishes.length >= 1, `someone finished (${finishes.map((f) => `${f.payload.racer}@${(f.t - 3).toFixed(1)}s`).join(', ')})`);
  const firstFin = finishes[0];
  check(res.winner === firstFin?.payload.racer && firstFin.payload.winner && res.reason === 'finish', 'first across the line wins');
  check(finishes.filter((f) => f.payload.winner).length === 1, 'exactly one race:finish with winner=true');
  const phases = r.log.filter((e) => e.type === 'phase:changed').map((e) => (e.payload as { to: string }).to);
  check(phases.join(',') === 'spin,countdown,racing,bonus,results', `phases: ${phases.join(' → ')}`);
  for (const rr of res.racers) {
    const expected = (res.winner === rr.racer ? 1 : 0) + (rr.bonus ? 1 : 0);
    check(rr.points === expected, `${rr.racer} points ${rr.points} = win ${res.winner === rr.racer ? 1 : 0} + jump bonus ${rr.bonus ? 1 : 0}`);
  }
  check(
    res.session.player === before.player + res.racers[0].points && res.session.cpu === before.cpu + res.racers[1].points,
    `session score updated ${before.player}-${before.cpu} → ${res.session.player}-${res.session.cpu}`,
  );
  const saved = JSON.parse(store.get('dirtrace.session.v1') ?? '{}');
  check(saved.player === res.session.player && saved.cpu === res.session.cpu, 'session score persisted to localStorage');
  const cpuFin = res.racers[1];
  check(cpuFin.finished, `computer (${d}) finished: ${cpuFin.timeS?.toFixed(1)} s`);
  const jumps = r.log.filter((e) => e.type === 'race:jump') as { payload: { racer: RacerId; bonus: boolean; distanceM: number } }[];
  check(jumps.filter((e) => e.payload.bonus).length === res.racers.filter((x) => x.bonus).length, `race:jump bonus events (${jumps.length} jumps) match bonus flags`);
  check(jumps.every((e) => res.racers.find((x) => x.racer === e.payload.racer)?.jumpM === e.payload.distanceM), 'results carry each jump distance');
  check(new Set(jumps.map((e) => e.payload.racer)).size === jumps.length, 'at most one jump per racer');
  if (USE_RACE_COURSE) {
    for (const rr of res.racers) if (rr.finished && rr.racer === 'cpu') check(rr.jumpM !== null && rr.jumpM !== undefined && rr.jumpM > 20, `${rr.racer} (finished) jumped ${rr.jumpM} m`);
  }
  const cpuResets = r.log.filter((e) => e.type === 'race:resetting' && (e.payload as { racer: string }).racer === 'cpu').length;
  check(cpuResets <= 2, `computer needed ${cpuResets} reset(s)`);
  console.log(
    `  lead changes: ${count(r.log, 'race:lead')}, checkpoints: ${count(r.log, 'race:checkpoint')}, results ${(r.resultsAt - 3).toFixed(1)} s after GO`,
  );
}
// Pace with nobody in the way (head-to-head times include bumping into the other car).
for (const d of ['easy', 'normal', 'hard'] as Difficulty[]) {
  const r = runRace({
    cpuDifficulty: d,
    player: 'idle',
    timeLimitS: 100 * SOLO_T,
    maxSimS: 120 * SOLO_T,
  });
  const t = r.results?.racers[1].timeS;
  if (t) cpuTimes[d] = t;
}
check(
  cpuTimes.hard !== undefined &&
    cpuTimes.normal !== undefined &&
    cpuTimes.easy !== undefined &&
    cpuTimes.hard < cpuTimes.normal &&
    cpuTimes.normal < cpuTimes.easy &&
    cpuTimes.easy !== undefined &&
    cpuTimes.hard < cpuTimes.easy,
  `solo pace Hard < Normal < Easy (Easy eases off when far ahead) (${cpuTimes.hard?.toFixed(1)} s vs ${cpuTimes.easy?.toFixed(1)} s; normal ${cpuTimes.normal?.toFixed(1)} s)`,
);

// -------------------------------------------------------------- 1b. every vehicle can get round on Normal
console.log('\n=== computer on Normal in every vehicle (player idle, 100 s timer) ===');
for (const kind of ['sports', 'muscle', 'pickup', 'monster', 'buggy', 'sedan'] as VehicleKind[]) {
  const r = runRace({
    cpuDifficulty: 'normal',
    player: 'idle',
    kinds: ['pickup', kind],
    timeLimitS: 100 * SOLO_T,
    maxSimS: 120 * SOLO_T,
  });
  const cpu = r.results?.racers[1];
  const resets = r.log.filter((e) => e.type === 'race:resetting' && (e.payload as { racer: string }).racer === 'cpu').length;
  check(!!cpu?.finished, `${kind}: finished ${cpu?.timeS?.toFixed(1)} s, jump ${cpu?.jumpM ?? '—'} m${cpu?.bonus ? ' +bonus' : ''}, resets ${resets}`);
}

// -------------------------------------------------------------- 2. player does nothing (full timer)
console.log('\n=== race: Brooks does nothing, computer on easy, full 8-minute timer ===');
{
  const before = sessionBefore();
  const r = runRace({ cpuDifficulty: 'easy', player: 'idle' });
  const res = r.results;
  console.log(`  ${fmt(res)}`);
  check(!!res && res.winner === 'cpu' && res.reason === 'finish', 'computer wins by finishing');
  check(!!first(r.log, 'race:timeout'), 'race:timeout fired for Brooks');
  const T = DEFAULT_RACE_CONFIG.timeLimitS;
  check(T === 480, 'time limit is 8 minutes');
  check(Math.abs(r.resultsAt - 3 - T - 1.5) < 0.2, `results at the 8-minute mark (+1.5 s celebration): ${(r.resultsAt - 3).toFixed(1)} s after GO`);
  check(res?.racers[0].points === 0 && !res?.racers[0].finished && (res?.racers[0].distanceM ?? 99) < 5, `Brooks: 0 points, ${res?.racers[0].distanceM} m`);
  check(res?.session.player === before.player && res?.session.cpu === before.cpu + (res?.racers[1].points ?? 0), 'session: only the computer scores');
}

// -------------------------------------------------------------- 3. nobody finishes: farthest wins
console.log('\n=== race: short 20 s timer, Brooks idle, computer drives → farthest wins ===');
{
  const before = sessionBefore();
  const r = runRace({
    cpuDifficulty: 'normal',
    player: 'idle',
    timeLimitS: 20,
    maxSimS: 40,
  });
  const res = r.results;
  console.log(`  ${fmt(res)}`);
  check(!!res && res.winner === 'cpu' && res.reason === 'distance', 'nobody finished → farthest (computer) wins');
  check(res?.racers[1].points === 1 && res?.racers[0].points === 0, 'computer gets 1 point for distance');
  check((res?.racers[1].distanceM ?? 0) > 100, `computer distance ${res?.racers[1].distanceM} m`);
  check(res?.session.cpu === before.cpu + 1 && res?.session.player === before.player, 'session +1 computer');
  check(count(r.log, 'race:finish') === 0 && count(r.log, 'race:timeout') === 1, 'no race:finish, one race:timeout');
}
console.log('\n=== race: short 20 s timer, Brooks drives, computer idle → Brooks wins on distance ===');
{
  const r = runRace({
    cpuDifficulty: 'normal',
    player: 'ai',
    cpuIdle: true,
    timeLimitS: 20,
    maxSimS: 40,
  });
  console.log(`  ${fmt(r.results)}`);
  check(r.results?.winner === 'player' && r.results.reason === 'distance' && r.results.racers[0].points === 1, 'Brooks wins on distance, +1');
}
console.log('\n=== race: both idle, 10 s timer → tie ===');
{
  const before = sessionBefore();
  const r = runRace({
    cpuDifficulty: 'normal',
    player: 'idle',
    cpuIdle: true,
    timeLimitS: 10,
    maxSimS: 20,
  });
  console.log(`  ${fmt(r.results)}`);
  check(r.results?.winner === null && r.results.reason === 'tie', 'tie: no winner');
  check(r.results?.session.player === before.player && r.results?.session.cpu === before.cpu, 'tie: no points');
}

// -------------------------------------------------------------- 4. reset button
console.log('\n=== reset: requestReset waits 2 s then returns to the last checkpoint ===');
{
  let requestedAt = -1;
  let resetAt = -1;
  let respawnS = -1;
  const offReset = events.on('vehicle:reset', ({ racer }) => {
    if (racer === 'player' && requestedAt >= 0 && resetAt < 0) resetAt = tNow;
  });
  let tNow = 0;
  runRace({
    cpuDifficulty: 'normal',
    player: 'ai',
    timeLimitS: 30 * (USE_RACE_COURSE ? 2 : 1),
    maxSimS: 30 * (USE_RACE_COURSE ? 2 : 1),
    each: (t, h) => {
      tNow = t;
      if (requestedAt < 0 && h.race.progress.player.checkpoint >= 1) {
        requestedAt = t;
        h.race.requestReset('player');
        respawnS = h.world.checkpoints[h.race.progress.player.checkpoint].s;
      }
      if (resetAt >= 0 && resetAt === t) {
        const s = h.race.progress.player.s;
        check(Math.abs(s - respawnS) < 3, `respawned at checkpoint s=${respawnS.toFixed(0)} (now s=${s.toFixed(1)})`);
      }
    },
  });
  offReset();
  check(requestedAt >= 0 && resetAt >= 0 && Math.abs(resetAt - requestedAt - 2) < 0.05, `reset after ${(resetAt - requestedAt).toFixed(2)} s`);
}

// -------------------------------------------------------------- 5. shortcut (Hard only) + CPU cost
console.log('\n=== shortcut: Hard takes a world-exposed shortcut, Easy/Normal do not; AI CPU cost ===');
for (const d of ['easy', 'hard'] as Difficulty[]) {
  const physics = new PhysicsWorld();
  const world = new TestGround({
    physics,
    renderer: { scene: new THREE.Scene() },
    quality: { preset: { textureSize: 64 } },
  } as never);
  // A straight chord across the first bend (stands in for the log bridge).
  const a = 150;
  const b = 230;
  const pa = world.track.pointAt(a);
  const pb = world.track.pointAt(b);
  const mid = world.track.pointAt((a + b) / 2);
  const chord = pa.distanceTo(pb);
  const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => pa.clone().lerp(pb, t));
  Object.assign(world, {
    shortcuts: [
      {
        id: 'log-bridge',
        startS: a,
        endS: b,
        points: pts,
        halfWidth: 2,
        maxSpeed: 20,
      },
    ],
  });
  const v = createVehicle({
    physics,
    surfaces: world,
    spec: VEHICLES.pickup,
    paint: 0,
    racer: 'cpu',
    spawn: world.spawns.cpu,
  });
  const ai = new AIDriver(v, world, d, 3);
  ai.sensor = createPhysicsSensor(physics, 'cpu');
  ai.enabled = true;
  v.input = ai.input;
  let minMidDist = Infinity;
  let reached = false;
  let aiMs = 0;
  let steps = 0;
  for (let i = 0; i < 60 * 40 && !reached; i++) {
    const t0 = performance.now();
    ai.fixedUpdate(PHYSICS_DT);
    aiMs += performance.now() - t0;
    steps++;
    v.fixedUpdate!(PHYSICS_DT);
    physics.step();
    v.postPhysics!(PHYSICS_DT);
    v.update!(PHYSICS_DT, 1);
    const s = world.track.project(v.position).s;
    // How close does the car get to the centre-line's apex (far from the chord)?
    if (s > a + 10 && s < b - 10) minMidDist = Math.min(minMidDist, Math.hypot(v.position.x - mid.x, v.position.z - mid.z));
    if (s > b + 5) reached = true;
  }
  const chordMid = pa.clone().lerp(pb, 0.5);
  const apexGap = chordMid.distanceTo(mid);
  const took = minMidDist > apexGap * 0.5;
  check(
    reached && (d === 'hard' ? took : !took),
    `${d}: ${took ? 'took' : 'skipped'} the shortcut (chord ${chord.toFixed(0)} m vs ${b - a} m road; closest to road apex ${minMidDist.toFixed(1)} m), rejoined: ${reached}`,
  );
  check(aiMs / steps < 0.1, `${d}: AI cost ${((aiMs / steps) * 1000).toFixed(0)} µs per step (Node, incl. ray casts)`);
  physics.dispose();
}

// -------------------------------------------------------------- 6. end-jump rules (scripted, fake cars)
console.log('\n=== end jump rules (scripted straight track, fake cars) ===');
{
  // A 600 m straight: finish at 300, lip at 400, bonus line +60 m.
  const pts = Array.from({ length: 61 }, (_, i) => new THREE.Vector3(0, 0, i * 10));
  const track = new PolylineTrack(pts, 6, 300);
  const lipS = 400;
  const fakeWorld = {
    track,
    zones: [{ id: 'test', startS: 0, endS: 600 }],
    checkpoints: [],
    spawns: { player: { x: -2, y: 0, z: 5, yaw: 0 }, cpu: { x: 2, y: 0, z: 5, yaw: 0 } },
    jump: { lipS, bonusM: 60, bonusS: lipS + 60, runoffS: 540, markerStepM: 10, lip: new THREE.Vector3(0, 2, lipS), bonusLine: new THREE.Vector3(0, 0, lipS + 60) },
    surfaceAt: () => 'asphalt',
    heightAt: () => 0,
    zoneAt: () => ({ id: 'test', startS: 0, endS: 600 }),
    resetDynamic: () => {},
  } as never;
  const fakeCar = (racer: RacerId) => ({
    racer,
    spec: { name: 'Fake' },
    position: new THREE.Vector3(0, 0, 5),
    quaternion: new THREE.Quaternion(),
    speed: 0,
    wheelsOnGround: 4,
    airTime: 0,
    flipped: false,
    input: { steer: 0, throttle: 0, brake: 0 },
    reset(sp: { x: number; z: number }) {
      this.position.set(sp.x, 0, sp.z);
      this.wheelsOnGround = 4;
      this.airTime = 0;
      this.quaternion.identity();
    },
  });
  /** Script: z(t) positions and air/landing flags for the player; the cpu sits still. */
  type Step = (t: number, car: ReturnType<typeof fakeCar>, race: InstanceType<typeof RaceController>) => void;
  const scenario = (name: string, script: Step, maxT = 40) => {
    const race = new RaceController(fakeWorld, { bonusTimeS: 20 });
    const p = fakeCar('player');
    const c = fakeCar('cpu');
    race.setVehicle('player', p as never);
    race.setVehicle('cpu', c as never);
    const evs: { type: string; payload: unknown }[] = [];
    const offs = (['race:jump', 'race:takeoff', 'race:done', 'race:finish'] as const).map((type) => events.on(type, (payload: unknown) => evs.push({ type, payload })));
    race.startCountdown();
    for (let t = 0; t < maxT; t += PHYSICS_DT) {
      if (race.phase === 'racing' || race.phase === 'bonus') script(t, p, race);
      race.fixedUpdate(PHYSICS_DT);
      race.postPhysics(PHYSICS_DT);
      if (race.progress.player.stage === 'done') break;
    }
    offs.forEach((f) => f());
    const jumpsEv = evs.filter((e) => e.type === 'race:jump').map((e) => e.payload as { distanceM: number; bonus: boolean; crashed: boolean });
    const pr = race.progress.player;
    console.log(`  ${name}: jump ${pr.jumpM ?? '—'} m, bonus ${pr.jumpBonus}, crashed ${pr.jumpCrashed}, points ${pr.points}, events ${jumpsEv.length}`);
    race.dispose();
    return { pr, jumpsEv, takeoffs: evs.filter((e) => e.type === 'race:takeoff').length };
  };
  // Drive at 30 m/s; fly from the lip, land `land` m past it; optionally roll over after landing.
  const flight = (land: number, opts: { roll?: boolean; secondJump?: boolean } = {}): Step => {
    let z = 280;
    return (_t, car) => {
      z += 30 * PHYSICS_DT;
      car.position.z = z;
      car.speed = 30;
      const air = z > lipS && z < lipS + land;
      const air2 = opts.secondJump && z > lipS + land + 20 && z < lipS + land + 60;
      car.wheelsOnGround = air || air2 ? 0 : 4;
      car.airTime = air || air2 ? car.airTime + PHYSICS_DT : 0;
      if (opts.roll && z > lipS + land + 3) car.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI * 0.8);
    };
  };
  {
    const r = scenario('clean 72 m landing', flight(72));
    check(r.pr.jumpBonus && r.pr.points === 2 && Math.abs((r.pr.jumpM ?? 0) - 72) < 1.5 && r.jumpsEv.length === 1 && r.jumpsEv[0].bonus && r.takeoffs === 1, 'land on the wheels past the bonus line: +1 (plus the win), distance recorded');
    check(r.pr.stage === 'done', 'attempt over → racer done (car held in the run-off)');
  }
  {
    const r = scenario('short 45 m landing', flight(45));
    check(!r.pr.jumpBonus && r.pr.points === 1 && Math.abs((r.pr.jumpM ?? 0) - 45) < 1.5 && !r.pr.jumpCrashed, 'short of the bonus line: no bonus, distance recorded');
  }
  {
    const r = scenario('crash landing at 75 m', flight(75, { roll: true }));
    check(!r.pr.jumpBonus && r.pr.jumpCrashed && r.pr.points === 1 && Math.abs((r.pr.jumpM ?? 0) - 75) < 1.5, 'rollover after touchdown: crash, no bonus even past the line');
  }
  {
    const r = scenario('second jump ignored', flight(30, { secondJump: true }));
    check(r.jumpsEv.length === 1 && !r.pr.jumpBonus && Math.abs((r.pr.jumpM ?? 0) - 30) < 1.5, 'one attempt per racer (a second big air does not count)');
  }
  {
    const r = scenario('never takes off', (_t, car) => {
      car.position.z += 30 * PHYSICS_DT;
      car.speed = 30;
    });
    check(r.pr.jumpM === 0 && !r.pr.jumpBonus && r.jumpsEv.length === 1, 'driving past the lip without leaving the ground ends the attempt at 0 m');
  }
  {
    let z = 280;
    const r = scenario('stops before the ramp', (_t, car) => {
      if (z < 330) z += 30 * PHYSICS_DT;
      car.position.z = z;
    });
    check(r.pr.jumpM === null && r.jumpsEv.length === 0 && r.pr.stage === 'done' && r.pr.points === 1, 'bonus window runs out without an attempt: no jump, racer done');
  }
  {
    let z = 280;
    let asked = false;
    const r = scenario('reset in mid-air', (_t, car, race) => {
      z += 30 * PHYSICS_DT;
      if (z > lipS + 1) {
        car.wheelsOnGround = 0;
        car.airTime += PHYSICS_DT;
        if (!asked) {
          asked = true;
          race.requestReset('player', 0.3);
        }
      }
      car.position.z = Math.min(z, lipS + 40);
    });
    check(r.pr.jumpCrashed && !r.pr.jumpBonus && r.jumpsEv.length === 1, 'a reset mid-jump ends the attempt as a crash');
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall race checks passed');
process.exit(failures ? 1 : 0);

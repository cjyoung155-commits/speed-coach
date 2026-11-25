// Run: node test/core.test.js
const assert = require('assert');
const C = require('../core.js');
const { makeFixture } = require('./fixture.js');

let pass = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

const fx = makeFixture();
const route = C.buildRoute(fx.osrm.routes[0]);
const step = C.sampleStepFor(route.total);
const samples = C.sampleRoute(route, step);
const prof = C.buildProfile(route.total, step, samples.map(p => fx.elevAtPoint(p)));
const limits = C.buildLimits(route, fx.overpass.elements);
const S = { band: 5, eco: 0, fallback: 45 };
const at = (d, speed, extra) => C.suggest(Object.assign({ route, profile: prof, limits, d, speed, settings: S }, extra || {}));

console.log('core');
t('route length ~10 km', () => assert(Math.abs(route.total - 10000) < 30, route.total));
t('node pairs line up with geometry', () => assert(route.segPairs && route.segPairs.length === route.pts.length - 1));
t('maneuvers: turn at ~7 km and arrival', () => {
  const turn = route.maneuvers.find(m => m.type === 'turn');
  assert(turn && Math.abs(turn.d - 7000) < 25, JSON.stringify(turn));
  assert.strictEqual(turn.slow, 15);
  assert.strictEqual(route.maneuvers[route.maneuvers.length - 1].type, 'arrive');
});
t('snap finds a point 20 m off the road', () => {
  const p = C.pointAt(route, 4321); const off = [p[0], p[1] + 20 / (111320 * Math.cos(p[0] * Math.PI / 180))];
  const s = C.snap(route, off, null);
  assert(Math.abs(s.d - 4321) < 3 && Math.abs(s.dist - 20) < 1.5, JSON.stringify(s));
});
t('grade on the climb is ~5%', () => { const g = C.gradeAvg(prof, 2300, 2700); assert(g > 4.3 && g < 5.7, g); });
t('grade on the downhill is ~-4%', () => { const g = C.gradeAvg(prof, 3400, 3800); assert(g < -3.3 && g > -4.7, g); });
t('maxspeed parsing', () => {
  assert.strictEqual(C.parseMaxspeed('55 mph'), 55);
  assert.strictEqual(C.parseMaxspeed('100'), 60);
  assert.strictEqual(C.parseMaxspeed('35 mph;25 mph'), 35);
  assert.strictEqual(C.parseMaxspeed('US:urban'), null);
  assert.strictEqual(C.parseMaxspeed('none'), null);
});
t('limits: 55 posted, then 25 estimated', () => {
  assert.deepStrictEqual([C.limitAt(route, limits, 1000).mph, C.limitAt(route, limits, 1000).src], [55, 'posted']);
  assert.deepStrictEqual([C.limitAt(route, limits, 8000).mph, C.limitAt(route, limits, 8000).src], [25, 'est']);
  assert(limits.postedShare > 0.55 && limits.postedShare < 0.65, limits.postedShare);
});
t('flat road: cruise at the limit', () => {
  const s = at(1000, 50); assert.strictEqual(s.mode, 'cruise'); assert.strictEqual(s.target, 55);
  assert.strictEqual(C.speedState(50, s), 'under'); assert.strictEqual(C.speedState(54, s), 'on');
});
t('eco offset lowers cruise only', () => {
  const s = at(1000, 50, { settings: { band: 5, eco: 3, fallback: 45 } }); assert.strictEqual(s.target, 52);
});
t('hill ahead: build to the limit', () => {
  const s = at(1650, 50); assert.strictEqual(s.mode, 'preclimb', s.msg); assert.strictEqual(s.target, 55);
});
t('on the climb: let it sag a few mph', () => {
  const s = at(2500, 55); assert.strictEqual(s.mode, 'climb', s.msg);
  assert(s.target >= 50 && s.target <= 53, s.target); assert.strictEqual(C.speedState(48, s), 'hold');
});
t('near the top: ease off', () => {
  const s = at(2950, 52, { prevMode: 'climb' }); assert.strictEqual(s.mode, 'crest', s.msg + ' g=' + s.gNow);
  assert.strictEqual(s.target, 50);
});
t('downhill: off the gas, roll to the limit', () => {
  const s = at(3600, 48); assert.strictEqual(s.mode, 'descent', s.msg); assert.strictEqual(s.target, 55);
});
t('limit drop: cue starts ~100 m before', () => {
  assert.notStrictEqual(at(5880, 55).mode, 'slowdown');
  const s = at(5910, 55); assert.strictEqual(s.mode, 'slowdown', s.msg); assert.strictEqual(s.target, 25);
  assert.strictEqual(C.speedState(20, s), 'on');
});
t('slowdown stays on while coasting down', () => {
  assert.strictEqual(at(5800, 34, { prevMode: 'slowdown' }).mode, 'slowdown');
  assert.notStrictEqual(at(6050, 25, { prevMode: 'slowdown' }).mode, 'slowdown');
});
t('turn stays on while coasting in', () => {
  assert.strictEqual(at(6960, 16, { prevMode: 'turn' }).mode, 'turn');
});
t('crest stays on over the top', () => {
  const s = at(3000, 50, { prevMode: 'crest' }); assert(s.mode === 'crest' || s.mode === 'descent' || s.mode === 'predescent', s.mode);
});
t('manual override replaces the limit', () => {
  const s = at(8000, 30, { override: 35 }); assert.strictEqual(s.base, 35); assert.strictEqual(s.src, 'manual');
});
t('turn: cue starts ~100 m before', () => {
  assert.notStrictEqual(at(6880, 25).mode, 'turn');
  const s = at(6910, 25); assert.strictEqual(s.mode, 'turn', s.msg); assert.strictEqual(s.target, 15);
});
t('step speed: gentle ramp up on flat road', () => {
  const st = C.stepSpeed(at(1000, 15), 15, 3); assert.deepStrictEqual(st, { mph: 25, dir: 'up' });
});
t('step speed: smaller steps on a climb', () => {
  const s = at(2500, 15), st = C.stepSpeed(s, 15, 3);
  assert(st.dir === 'up' && st.mph >= 18 && st.mph <= 20, JSON.stringify(st));
  assert.strictEqual(C.speedState(15, s), 'under');
});
t('step speed: hidden when on target', () => { assert.strictEqual(C.stepSpeed(at(1000, 54), 54, 3), null); });
t('step speed: no push while sagging a little on a climb', () => {
  const s = at(2500, 49); assert.strictEqual(C.speedState(49, s), 'hold'); assert.strictEqual(C.stepSpeed(s, 49, 3), null);
});
t('step speed: counts down into a turn', () => {
  const st = C.stepSpeed(at(6910, 30), 30, 3); assert.deepStrictEqual(st, { mph: 23, dir: 'down' });
});
t('step speed: no building speed right before a turn', () => {
  const s = { target: 55, mode: 'cruise', gNow: 0, slowAhead: [{ dist: 150, mph: 15 }], dist: null };
  assert.strictEqual(C.stepSpeed(s, 50, 3), null);           // at 50 with a turn 150 m out: don't build more
  assert.deepStrictEqual(C.stepSpeed(s, 20, 3), { mph: 30, dir: 'up' });
  const G = C.guide(s, 40, 3);
  assert.strictEqual(G.state, 'hold'); assert(/Slowing ahead in 500 ft/.test(G.msg), G.msg);
});
t('acceleration estimate', () => {
  const a = C.accelFrom([0, 1, 2, 3].map(t => ({ t, v: 10 + 3 * t })));
  assert(Math.abs(a - 3) < 1e-9, a);
  assert.strictEqual(C.accelFrom([{ t: 0, v: 1 }, { t: 1, v: 2 }]), null);
});
t('arrival', () => { assert.strictEqual(at(9980, 5).mode, 'arrived'); });
t('no hill data: still works', () => {
  const s = C.suggest({ route, profile: C.flatProfile(route.total), limits, d: 1000, speed: 50, settings: S });
  assert.strictEqual(s.target, 55); assert(/No hill data/.test(s.ahead));
});
t('no limit data: falls back to setting', () => {
  const s = C.suggest({ route, profile: prof, limits: null, d: 1000, speed: 40, settings: S });
  assert.strictEqual(s.base, 45); assert.strictEqual(s.src, 'default');
});
t('coast distance is sane', () => {
  const d = C.coastDistance(55, 25); assert(d > 350 && d < 520, d);
  assert.strictEqual(C.coastDistance(20, 25), 0);
});
// The lines on screen must never disagree, at any spot on the route and any speed.
t('hint, message and 4-second number always agree', () => {
  const bad = [];
  for (let d = 0; d <= 10000; d += 10) {
    for (const v of [0, 3, 10, 18, 25, 30, 40, 48, 52, 55, 58, 65]) {
      for (const prevMode of [null, 'climb', 'crest', 'descent', 'slowdown', 'turn']) {
        const s = at(d, v, { prevMode }), G = C.guide(s, v, 3), m = G.msg || '', h = G.hint;
        const saysUp = /Speed up|build|Build|Ease up/.test(h + ' ' + m);
        const saysDown = /Ease off|Lift|ease back|Ease back|let it drop|slow to|slow down|Off the gas/.test(h + ' ' + m);
        const saysHold = /Hold a steady|hold a steady|Hold this|Steady throttle/.test(h + ' ' + m);
        const problem =
          (/Speed up/.test(h) && /Hold a steady|let it drop|Ease back|ease back|Off the gas|no need/.test(m)) ||
          (/Ease off|Lift/.test(h) && /build|Build|Ease up/.test(m)) ||
          (G.step && G.step.dir === 'up' && (G.state !== 'under' || saysDown && !saysUp)) ||
          (G.step && G.step.dir === 'down' && G.state !== 'over') ||
          (G.state === 'on' && Math.abs(v - s.target) > 2 && !s.holdBelow) ||
          (G.state === 'under' && !G.step) ||
          (saysHold && G.step);
        if (problem) bad.push(`d=${d} v=${v} prev=${prevMode} mode=${s.mode} T=${s.target} state=${G.state} hint="${h}" msg="${m}" step=${JSON.stringify(G.step)}`);
      }
    }
  }
  assert(!bad.length, bad.length + ' conflicts, e.g.\n       ' + bad.slice(0, 4).join('\n       '));
});
// ------------------------------------------------------------ lights, logging, learning
const sigIds = new Set(fx.overpass.elements.filter(e => e.type === 'node').map(e => e.id));
const signals = C.buildSignals(route, sigIds);
t('signals found at 1500 m and 8000 m (twin nodes merged)', () => assert.deepStrictEqual(signals, [1500, 8000]));
t('light ahead cue ~150 m out, and lines agree', () => {
  const s = C.suggest({ route, profile: prof, limits, signals, d: 1400, speed: 50, settings: S });
  assert.strictEqual(s.mode, 'light', s.mode); assert(/Light in/.test(s.msg));
  const G = C.guide(s, 50, 3); assert.strictEqual(G.step, null); assert.strictEqual(G.hint, 'On target');
  const s2 = C.suggest({ route, profile: prof, limits, signals, d: 1300, speed: 50, settings: S });
  assert.notStrictEqual(s2.mode, 'light');
  const G3 = C.guide(C.suggest({ route, profile: prof, limits, signals, d: 1400, speed: 30, settings: S }), 30, 3);
  assert(G3.state === 'on' && !G3.step, JSON.stringify(G3));
});
t('via points: multi-leg route keeps node pairs, limits and only the final arrival', () => {
  const r2 = C.buildRoute(fx.multiLeg([100, 300]).routes[0]);
  assert(r2.segPairs && r2.segPairs.length === r2.pts.length - 1);
  const l2 = C.buildLimits(r2, fx.overpass.elements);
  assert(Math.abs(l2.postedShare - limits.postedShare) < 1e-9);
  assert.deepStrictEqual(r2.maneuvers.map(m => m.type), ['depart', 'turn', 'arrive']);
  assert.deepStrictEqual(C.buildSignals(r2, sigIds), [1500, 8000]);
});
t('stop tracker: queue at a light counts once; random stop does not; tapped stop does', () => {
  const T = C.stopTracker([1500, 8000]);
  let t0 = 0; const at = (s, d, v) => T.push(t0 + s * 1000, d, v);
  at(0, 1300, 30); at(1, 1400, 1);  at(20, 1400, 1); at(21, 1404, 8); at(23, 1418, 8); at(24, 1420, 1); at(38, 1420, 1); at(39, 1425, 9);
  at(100, 4000, 0.5); at(130, 4000, 9);
  at(200, 6000, 0.5); T.manual(205000, 6000); at(240, 6000, 9);
  const stops = T.finish(300000);
  assert.strictEqual(stops.length, 2, JSON.stringify(stops));
  assert.strictEqual(stops[0].light, 1500); assert(stops[0].dur >= 33 && stops[0].dur <= 38, stops[0].dur);
  assert.strictEqual(stops[1].light, 6000); assert.strictEqual(stops[1].manual, true); assert.strictEqual(stops[1].dur, 40);
});

// Two routes to the same place: A (this road) and B (same first 3 km, then a parallel road to the east).
const A = Object.assign({ id: 'A', name: 'Route A', lights: [1500, 5000] }, route);
const lonOff = 400 / (111320 * Math.cos(39.7 * Math.PI / 180));
const bPts = [];
for (let dd = 0; dd <= 3000; dd += 20) bPts.push(C.pointAt(route, dd));
const p3 = C.pointAt(route, 3000);
for (let k = 1; k <= 10; k++) bPts.push([p3[0] + k * 20 / 111194.9, p3[1] + lonOff * k / 10]);
const p32 = bPts[bPts.length - 1];
for (let dd = 3220; dd <= 9800; dd += 20) bPts.push([fx.START[0] + dd / 111194.9, p32[1]]);
const endA = C.pointAt(route, route.total);
for (let k = 1; k <= 10; k++) bPts.push([bPts[bPts.length - 1][0] + (endA[0] - bPts[bPts.length - 1][0]) / (11 - k), p32[1] - lonOff * k / 10]);
const B = Object.assign({ id: 'B', name: 'Route B', lights: [1500, 6000] }, C.routeFromPoints(bPts));
function trip(r, startMs, waits) {
  const dur = r.total / 11 * 1000 + Object.values(waits).reduce((a, b) => a + b, 0) * 1000;
  return { routeId: r.id, fromD: 0, reached: r.total, tl: [[0, startMs], [r.total, startMs + dur]],
    stops: Object.entries(waits).filter(e => e[1] > 0).map(([L, w]) => ({ light: +L, t: startMs, dur: w })) };
}
const day = k => new Date(2026, 10, 2 + k, 7, 30).getTime();     // weekdays from Mon Nov 2, 2026
const weekdays = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
const tripsBy = {
  A: weekdays.slice(0, 8).map(k => trip(A, day(k), { 1500: 20, 5000: 40 })),
  B: weekdays.slice(0, 8).map(k => trip(B, day(k), { 1500: 20, 6000: 5 }))
};
const now = new Date(2026, 10, 25, 7, 35).getTime();
t('split point found where B leaves A (~3 km)', () => {
  const sp = C.splitPoint(A, B); assert(sp && Math.abs(sp.a - 3000) < 60 && Math.abs(sp.b - 3000) < 60, JSON.stringify(sp));
});
t('recommends the route with less time at lights', () => {
  const rec = C.recommend([A, B], tripsBy, now, 'x');
  assert.strictEqual(rec.kind, 'best'); assert.strictEqual(rec.pick, 'B'); assert(rec.gain > 30 && rec.gain < 40, rec.gain);
  assert(/Use Route B — about 35 sec less at lights/.test(rec.text), rec.text);
});
t('only the same time of day counts when there is enough of it', () => {
  const evening = new Date(2026, 10, 25, 17, 30).getTime();
  const tb = { A: tripsBy.A.concat(weekdays.slice(0, 5).map(k => trip(A, day(k) + 10 * 3600e3, { 1500: 0, 5000: 0 }))), B: tripsBy.B.concat(weekdays.slice(0, 5).map(k => trip(B, day(k) + 10 * 3600e3, { 1500: 30, 6000: 30 }))) };
  assert.strictEqual(C.recommend([A, B], tb, evening, 'x').pick, 'A');
  assert.strictEqual(C.recommend([A, B], tb, now, 'x').pick, 'B');
});
t('while learning, about 1 in 4 days suggests the least-driven route', () => {
  const tb = { A: tripsBy.A.slice(0, 4), B: tripsBy.B };
  let explore = 0;
  for (let k = 0; k < 400; k++) if (C.recommend([A, B], tb, now, 'seed' + k).kind === 'learning') explore++;
  assert(explore > 70 && explore < 130, explore);
  assert(/Try Route A — still learning it \(2 of 8 trips\)/.test(C.recommend([A, B], { A: tripsBy.A.slice(0, 2), B: tripsBy.B }, now, 'x').text));
});
t('live: before the split, suggests switching; after it, nothing', () => {
  const alts = [{ route: B, split: C.splitPoint(A, B) }];
  const sug = C.liveCompare(A, alts, tripsBy, 1000, now);
  assert(sug && sug.id === 'B' && sug.gain > 30, JSON.stringify(sug));
  assert.strictEqual(C.liveCompare(A, alts, tripsBy, 2990, now), null);
  assert.strictEqual(C.liveCompare(A, alts, { A: tripsBy.A, B: tripsBy.B.slice(0, 2) }, 1000, now), null);
});
t('saved route round-trips', () => {
  const u = C.unpackRoute(JSON.parse(JSON.stringify(C.packRoute(route, prof, limits, signals))));
  assert(Math.abs(u.route.total - route.total) < 1);
  for (const dd of [500, 3000, 7000]) {
    const a = C.limitAt(u.route, u.limits, dd), b = C.limitAt(route, limits, dd);
    assert.deepStrictEqual([a.mph, a.src], [b.mph, b.src]);
    assert(Math.abs(C.elevAt(u.profile, dd) - C.elevAt(prof, dd)) < 0.2);
  }
  assert.deepStrictEqual(u.signals, signals);
  assert.deepStrictEqual(u.route.maneuvers.map(m => m.type), route.maneuvers.map(m => m.type));
  assert(u.route.segPairs && u.route.segPairs.length === route.segPairs.length);
});
t('lines agree everywhere with lights on the route too', () => {
  const bad = [];
  for (let dd = 0; dd <= 10000; dd += 10) for (const v of [0, 10, 25, 40, 55, 62]) {
    const s = C.suggest({ route, profile: prof, limits, signals, d: dd, speed: v, settings: S }), G = C.guide(s, v, 3);
    if ((G.step && G.step.dir === 'up' && G.state !== 'under') || (G.step && G.step.dir === 'down' && G.state !== 'over') || (G.state === 'under' && !G.step))
      bad.push(dd + '/' + v + ' ' + s.mode + ' ' + G.state);
  }
  assert(!bad.length, bad.slice(0, 5).join(', '));
});
console.log(pass + ' passed');

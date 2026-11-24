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
t('node ids line up with geometry', () => assert(route.segNodes && route.segNodes.length === route.pts.length));
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
  assert(s.target >= 50 && s.target <= 53, s.target); assert.strictEqual(C.speedState(45, s), 'hold');
});
t('near the top: ease off', () => {
  const s = at(2950, 52, { prevMode: 'climb' }); assert.strictEqual(s.mode, 'crest', s.msg + ' g=' + s.gNow);
  assert.strictEqual(s.target, 50);
});
t('downhill: off the gas, roll to the limit', () => {
  const s = at(3600, 48); assert.strictEqual(s.mode, 'descent', s.msg); assert.strictEqual(s.target, 55);
});
t('limit drop: coast down early, not too early', () => {
  assert.notStrictEqual(at(5450, 55).mode, 'slowdown');
  const s = at(5650, 55); assert.strictEqual(s.mode, 'slowdown', s.msg); assert.strictEqual(s.target, 25);
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
t('turn: coast down shortly before', () => {
  assert.notStrictEqual(at(6800, 25).mode, 'turn');
  const s = at(6920, 25); assert.strictEqual(s.mode, 'turn', s.msg); assert.strictEqual(s.target, 15);
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
console.log(pass + ' passed');

// End-to-end check in a phone-sized headless Chrome with the map services faked.
// Run from the repo root: node test/ui.test.mjs   (needs playwright + Chrome)
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { makeFixture, routeBPoints } = require('./fixture.js');

const fx = makeFixture();
const OUT = process.env.SHOTS || 'test/shots';
fs.mkdirSync(OUT, { recursive: true });
const server = spawn('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1'], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: fx.START[0], longitude: fx.START[1], accuracy: 5 }, permissions: ['geolocation'],
  colorScheme: 'dark'
});
const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const calls = { nominatim: 0, osrm: 0, overpass: 0, elevation: 0 };
await ctx.route(/nominatim\.openstreetmap\.org/, r => { calls.nominatim++; r.fulfill({ headers: cors, body: JSON.stringify([
  { lat: '39.79', lon: '-105.00', name: 'Test Town Hardware', display_name: 'Test Town Hardware, 100 Main St, Test Town, Colorado, 80000, United States' },
  { lat: '39.75', lon: '-105.01', name: 'Test Town Park', display_name: 'Test Town Park, Test Town, Colorado, United States' }]) }); });
// OSRM: a plain A→B request gets the fixture road; a request with via points gets it split into legs there.
function osrmMock(r) {
  calls.osrm++;
  const path = new URL(r.request().url()).pathname;
  const pts = decodeURIComponent(path.split('/driving/')[1]).split(';').map(s => s.split(',').map(Number));
  if (pts.length <= 2) return r.fulfill({ headers: cors, body: JSON.stringify(fx.osrm) });
  const near = p => { let bi = 0, bd = Infinity; fx.coords.forEach((c, i) => { const dd = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2; if (dd < bd) { bd = dd; bi = i; } }); return bi; };
  const cuts = [...new Set(pts.slice(1, -1).map(near))].filter(i => i > 0 && i < fx.coords.length - 1).sort((a, b) => a - b);
  r.fulfill({ headers: cors, body: JSON.stringify(fx.multiLeg(cuts)) });
}
await ctx.route(/project-osrm|routing\.openstreetmap/, osrmMock);
await ctx.route(/overpass/, r => { calls.overpass++; r.fulfill({ headers: cors, body: JSON.stringify(fx.overpass) }); });
await ctx.route(/open-meteo/, r => {
  calls.elevation++;
  const u = new URL(r.request().url());
  const lats = u.searchParams.get('latitude').split(',').map(Number);
  const lons = u.searchParams.get('longitude').split(',').map(Number);
  r.fulfill({ headers: cors, body: JSON.stringify({ elevation: lats.map((la, i) => Math.round(fx.elevAtPoint([la, lons[i]]) * 10) / 10) }) });
});

const errors = [];
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) { fails++; process.exitCode = 1; } };

// ---------------------------------------------------------------- plan + test drive
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.addInitScript(() => localStorage.setItem('sc.settings', JSON.stringify({ simX: 10, voice: false })));
await page.goto('http://127.0.0.1:8765/index.html');
await page.screenshot({ path: OUT + '/1-home.png' });
await page.fill('#q', 'test town hardware');
await page.click('#searchBtn');
await page.waitForSelector('#results li button');
await page.screenshot({ path: OUT + '/2-results.png' });
await page.click('#results li button');
await page.waitForSelector('#routeCard:not([hidden])', { timeout: 10000 });
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + '/3-route.png', fullPage: true });
check(/6\.2 mi/.test(await page.textContent('#stDist')), 'route card shows 6.2 mi');
{ const c = parseInt((await page.textContent('#stClimb')).replace(/,/g, ''), 10); check(c > 140 && c < 170, 'route card shows ~160 ft of climb: ' + c); }
check(/60% from posted/.test(await page.textContent('#routeNote')), 'limits note: ' + await page.textContent('#routeNote'));

await page.click('#simBtn');
const seen = {}; const modes = []; const shotFor = ['preclimb', 'climb', 'crest', 'descent', 'slowdown', 'turn', 'arrived'];
let shot = 4;
for (let i = 0; i < 700; i++) {
  const st = await page.evaluate(() => { const d = window.__speedCoach.drive; return d.last && { mode: d.last.mode, target: d.last.target, d: d.d, v: d.speed, step: d.step, hard: d.hard, stepShown: !document.getElementById('stepBox').classList.contains('off'), stepText: document.getElementById('stepVal').textContent }; });
  if (st) {
    if (st.step && st.step.dir === 'up' && st.stepShown && !seen.stepUp) { seen.stepUp = st; await page.screenshot({ path: `${OUT}/${shot++}-drive-step-up.png` }); }
    if (st.step && st.step.dir === 'down' && st.stepShown && !seen.stepDown) { seen.stepDown = st; await page.screenshot({ path: `${OUT}/${shot++}-drive-step-down.png` }); }
    if (st.hard) seen.simHard = true;
    if (modes[modes.length - 1] !== st.mode) modes.push(st.mode);
    if (!seen[st.mode]) {
      seen[st.mode] = st;
      if (shotFor.includes(st.mode)) await page.screenshot({ path: `${OUT}/${shot++}-drive-${st.mode}.png` });
    }
    if (st.mode === 'arrived') break;
  }
  await page.waitForTimeout(150);
}
console.log('  mode sequence: ' + modes.join(' → '));
for (const m of shotFor) check(!!seen[m], 'test drive reached "' + m + '"' + (seen[m] ? ` at ${Math.round(seen[m].d)} m, target ${seen[m].target}` : ''));
check(seen.turn && seen.turn.d > 6870, 'turn cue starts about 100 m out (at ' + (seen.turn && Math.round(seen.turn.d)) + ' m, turn at 7000 m)');
check(seen.slowdown && seen.slowdown.d > 5870, 'limit-drop cue starts about 100 m out (at ' + (seen.slowdown && Math.round(seen.slowdown.d)) + ' m, drop at 6000 m)');
check(seen.stepUp && +seen.stepUp.stepText > seen.stepUp.v, '4-second step shows above current speed when building: ' + (seen.stepUp && seen.stepUp.stepText + ' vs ' + Math.round(seen.stepUp.v)));
check(seen.stepDown && +seen.stepDown.stepText < seen.stepDown.v, '4-second step counts down when slowing: ' + (seen.stepDown && seen.stepDown.stepText + ' vs ' + Math.round(seen.stepDown.v)));
check(!seen.simHard, 'a driver following the step number never trips the acceleration warning');
{ const flaps = modes.filter((m, i) => m !== 'cruise' && modes[i + 2] === m); check(!flaps.length, 'no mode flapping' + (flaps.length ? ': ' + flaps.join(', ') : '')); }

await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(300);
await page.screenshot({ path: OUT + '/z-landscape.png' });
await page.click('#endBtn');
check(await page.isVisible('#routeCard'), 'End returns to the route card');

// ---------------------------------------------------------------- real GPS path (moving location)
await page.setViewportSize({ width: 390, height: 844 });
await page.click('#startBtn');
const C = require('../core.js');
const route = C.buildRoute(fx.osrm.routes[0]);
const disp = [];
for (let d = 900, k = 0; d <= 1600; d += 22, k++) {      // ~22 m per fix ≈ 49 mph at 1 fix/s
  const p = C.pointAt(route, d);
  await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 6 });
  for (let j = 0; j < 10; j++) { await page.waitForTimeout(100); if (k >= 2) disp.push(await page.evaluate(() => window.__speedCoach.drive.dispD)); }
  if (k === 4) break;
}
await page.waitForTimeout(300);
{ const distinct = new Set(disp.map(v => Math.round(v))).size; let back = 0; for (let i = 1; i < disp.length; i++) if (disp[i] < disp[i - 1] - 1) back++;
  check(distinct >= 12 && back === 0, `graph glides between fixes (${distinct} distinct positions in ${disp.length} samples, ${back} backward steps)`); }
const live = await page.evaluate(() => ({ speed: document.getElementById('speedVal').textContent, target: document.getElementById('targetVal').textContent, lim: document.getElementById('limitVal').textContent, cls: document.getElementById('targetBox').className }));
console.log('  live GPS: ' + JSON.stringify(live));
check(+live.target === 55 && +live.lim === 55, 'live GPS shows a target and the posted limit');
check(+live.speed > 35 && +live.speed < 65, 'speed derived from moving location (~49 mph): ' + live.speed);
// hard launch: +5 mph every second from a near stop
{ let d = 1700; const v0 = 8;
  for (let k = 0; k < 6; k++) { d += (v0 + 5 * k) / 2.2369; const p = C.pointAt(route, d); await ctx.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 6 }); await page.waitForTimeout(1000); }
  const hard = await page.evaluate(() => ({ cls: document.getElementById('nowBox').className, label: document.getElementById('nowLabel').textContent, a: window.__speedCoach.drive.accel }));
  check(/hard/.test(hard.cls) && /easy on the gas/.test(hard.label), 'hard acceleration turns the corner speed red (' + (hard.a && hard.a.toFixed(1)) + ' mph/s)');
  await page.screenshot({ path: OUT + '/x-hard-accel.png' });
}
await page.click('#limUp');
check((await page.textContent('#limitVal')).trim() === '60' && /manual/.test(await page.getAttribute('#sign', 'class')), '+5 sets a manual limit');
await page.screenshot({ path: OUT + '/y-live.png' });
await page.click('#endBtn');

// ---------------------------------------------------------------- record a route, then learn from trips
{
  const ctx2 = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    geolocation: { latitude: fx.START[0], longitude: fx.START[1], accuracy: 5 }, permissions: ['geolocation'], colorScheme: 'dark'
  });
  await ctx2.route(/nominatim/, r => r.fulfill({ headers: cors, body: '[]' }));
  await ctx2.route(/project-osrm|routing\.openstreetmap/, osrmMock);
  await ctx2.route(/overpass/, r => r.fulfill({ headers: cors, body: JSON.stringify(fx.overpass) }));
  await ctx2.route(/open-meteo/, r => {
    const q = new URL(r.request().url()).searchParams, la = q.get('latitude').split(',').map(Number), lo = q.get('longitude').split(',').map(Number);
    r.fulfill({ headers: cors, body: JSON.stringify({ elevation: la.map((x, i) => fx.elevAtPoint([x, lo[i]])) }) });
  });
  const pg = await ctx2.newPage();
  pg.on('pageerror', e => errors.push('pageerror(2): ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errors.push('console(2): ' + m.text()); });
  await pg.addInitScript(() => localStorage.setItem('sc.settings', JSON.stringify({ voice: false })));
  await pg.goto('http://127.0.0.1:8765/index.html');
  check(await pg.isVisible('#myRoutesEmpty'), 'My routes starts empty with an explainer');
  await pg.screenshot({ path: OUT + '/r1-home.png' });

  const A = C.buildRoute(fx.osrm.routes[0]);
  const go = async (r, d) => { const p = C.pointAt(r, d); await ctx2.setGeolocation({ latitude: p[0], longitude: p[1], accuracy: 5 }); };
  const hold = async (r, d, secs, page, tap) => {         // brake over 4 s, then sit still (tiny jitter so updates keep coming)
    for (const back of [20, 10, 4, 1]) { await go(r, d - back); await page.waitForTimeout(1000); }
    for (let k = 0; k < secs; k++) { await go(r, d + (k % 2) * 0.4); await page.waitForTimeout(1000);
      if (tap && k === 3) { await page.waitForSelector(tap + ':not([hidden])', { timeout: 4000 }); await page.click(tap); } }
  };
  // Record: drive the fixture road, wait 7 s at the light at 1500 m, and 5 s at an unmapped light at 4000 m (tapped).
  await pg.click('#recordBtn');
  await pg.waitForSelector('#rec:not([hidden])');
  for (let d = 0; d <= A.total; d += 50) {
    await go(A, Math.min(d, A.total)); await pg.waitForTimeout(110);
    if (d === 1450) await hold(A, 1450, 7, pg);
    if (d === 4000) await hold(A, 4000, 6, pg, '#recLight');
  }
  await pg.screenshot({ path: OUT + '/r2-recording.png' });
  await pg.click('#recStop');
  await pg.waitForSelector('#saveSheet:not([hidden])');
  await pg.fill('#svName', 'Via Main'); await pg.fill('#svDest', 'Work');
  await pg.screenshot({ path: OUT + '/r3-save.png' });
  await pg.click('#svSave');
  await pg.waitForFunction(() => /Saved/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  await pg.waitForTimeout(300);
  const saved = await pg.evaluate(() => { const L = window.__speedCoach.lib; return { routes: L.routes(), trips: L.trips(), status: document.getElementById('status').textContent }; });
  console.log('  ' + saved.status);
  const rA = saved.routes[0];
  check(saved.routes.length === 1 && rA.name === 'Via Main' && rA.dest === 'Work' && Math.abs(rA.total - 10000) < 50, 'recorded route saved (' + (rA && rA.total) + ' m)');
  check(JSON.stringify(rA.data.sig) === '[1500,8000]', 'saved route knows its lights: ' + JSON.stringify(rA.data.sig));
  const t1 = saved.trips[0], st1 = (t1 && t1.stops) || [];
  console.log('  first trip stops: ' + JSON.stringify(st1.map(x => ({ light: x.light, dur: x.dur, manual: x.manual }))));
  check(st1.some(x => x.light === 1500 && x.dur >= 5 && x.dur <= 9), 'the recording logged the 7 s wait at the mapped light');
  check(st1.some(x => x.manual && Math.abs(x.light - 4000) < 60), 'the tapped stop at the unmapped light was logged');
  check((rA.extra || []).length === 1, 'the tapped light is remembered for next time: ' + JSON.stringify(rA.extra));
  check(/learning · 1 trip/.test(await pg.textContent('#groups')), 'My routes shows the route as learning with 1 trip');
  await pg.screenshot({ path: OUT + '/r4-saved.png', fullPage: true });

  // Add route B ("Via East") plus 8 same-time trips on each route; A waits 40 s at its 8000 m light, B 5 s at 6000 m.
  const Bgeo = C.routeFromPoints(routeBPoints(C, A));
  const bData = C.packRoute(Bgeo, C.flatProfile(Bgeo.total), { segs: new Array(Bgeo.pts.length - 1).fill(null) }, [1500, 6000]);
  const now = Date.now();
  const mk = (id, total, waits, k) => { const n = new Date(now), t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 7 * k, n.getHours(), n.getMinutes()).getTime(), dur = total / 11 * 1000;
    return { id: id + k, routeId: id, t0, fromD: 0, reached: total, tl: [[0, t0], [Math.round(total), t0 + dur]],
      stops: Object.entries(waits).map(([L, w]) => ({ light: +L, t: t0, dur: w, manual: false, mapped: true })) }; };
  await pg.evaluate(({ rB, trips }) => {
    const L = window.__speedCoach.lib; L.saveRoutes(L.routes().concat([rB])); L.saveTrips(L.trips().concat(trips));
  }, { rB: { id: 'routeB', name: 'Via East', dest: 'work', savedAt: now, extra: [], data: bData, total: Math.round(Bgeo.total), start: Bgeo.pts[0], end: Bgeo.pts[Bgeo.pts.length - 1] },
       trips: [1, 2, 3, 4, 5, 6, 7, 8].map(k => mk(rA.id, rA.total, { 1500: 20, 8000: 40 }, k)).concat([1, 2, 3, 4, 5, 6, 7, 8].map(k => mk('routeB', Bgeo.total, { 1500: 20, 6000: 5 }, k))) });
  await pg.reload();
  await pg.waitForTimeout(300);
  const groupText = await pg.textContent('#groups');
  console.log('  ' + groupText.replace(/\s+/g, ' ').slice(0, 220));
  { const m = groupText.match(/Use Via East — about (\d+) sec less at lights/); check(m && +m[1] >= 25 && +m[1] <= 36, 'recommends the route with less time at lights now (' + (m && m[1]) + ' sec)'); }
  check(/Start Via East/.test(groupText), 'big start button is for the recommended route');
  await pg.screenshot({ path: OUT + '/r5-recommend.png', fullPage: true });

  // Drive Via Main anyway: the tip suggests switching before the split; wait at the 1500 m light; then take B.
  await pg.click('#groups .rlist li:first-child button');
  await pg.waitForSelector('#routeCard:not([hidden])');
  check(/Via Main → Work/.test(await pg.textContent('#routeName')), 'opening a saved route shows it on the route card');
  const driveStart = Date.now();
  await pg.click('#startBtn');
  await go(A, 300); await pg.waitForTimeout(900); await go(A, 340); await pg.waitForTimeout(900);
  await pg.waitForSelector('#tipBar:not([hidden])', { timeout: 12000 });
  const tip = await pg.textContent('#tipBar');
  console.log('  tip: ' + tip);
  check(/Via East: about \d+ sec less at lights right now · split in 1\.\d mi/.test(tip), 'live tip suggests switching before the split');
  for (let d = 400; d <= 1450; d += 50) { await go(A, d); await pg.waitForTimeout(110); }
  await hold(A, 1450, 5, pg);
  const pill = await pg.textContent('#lightPill');
  if (!/Logging/.test(pill)) console.log('  debug: ' + JSON.stringify(await pg.evaluate(() => { const d = window.__speedCoach.drive; return { cur: d.tracker && d.tracker.cur, lights: d.tracker && d.tracker.lights, d: d.d, speed: d.speed, trip: !!d.trip }; })));
  check(/Logging light · 0:0[3-7]/.test(pill), 'stopped near a mapped light shows it being logged: ' + pill);
  await pg.screenshot({ path: OUT + '/r6-logging.png' });
  for (let d = 1500; d <= 3000; d += 50) { await go(A, d); await pg.waitForTimeout(110); }
  for (let d = 3100; d <= 5000; d += 50) { await go(Bgeo, d); await pg.waitForTimeout(110); }
  const act = await pg.evaluate(() => window.__speedCoach.active && window.__speedCoach.active.name);
  check(act === 'Via East', 'turning onto the other saved route switches to it without rerouting: ' + act);
  await pg.click('#endBtn');
  const live = await pg.evaluate(ds => window.__speedCoach.lib.trips().filter(t => t.t0 >= ds - 1000), driveStart);
  console.log('  live trips: ' + JSON.stringify(live.map(t => ({ route: t.routeId === 'routeB' ? 'B' : 'A', fromD: t.fromD, reached: Math.round(t.reached), stops: t.stops.map(s => s.light + ':' + s.dur) }))));
  check(live.some(t => t.routeId === rA.id && t.reached > 2800 && t.stops.some(s => s.light === 1500)), 'the part on Via Main was logged, with the light stop');
  check(live.some(t => t.routeId === 'routeB' && t.fromD > 2800), 'the part on Via East was logged from the split');
  await ctx2.close();
}

console.log('  api calls: ' + JSON.stringify(calls));
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.kill();
console.log(fails ? fails + ' failed' : 'all ui checks passed');

// End-to-end check in a phone-sized headless Chrome with the map services faked.
// Run from the repo root: node test/ui.test.mjs   (needs playwright + Chrome)
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const { makeFixture } = require('./fixture.js');

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
await ctx.route(/project-osrm|routing\.openstreetmap/, r => { calls.osrm++; r.fulfill({ headers: cors, body: JSON.stringify(fx.osrm) }); });
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

console.log('  api calls: ' + JSON.stringify(calls));
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
server.kill();
console.log(fails ? fails + ' failed' : 'all ui checks passed');

/* Speed Coach — screens, data fetching, GPS and the test-drive simulator. */
(function () {
  'use strict';
  const C = window.SpeedCore;
  const $ = id => document.getElementById(id);
  const MPH = C.MPS_TO_MPH;

  // ------------------------------------------------------------ storage & settings
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  const DEFAULTS = { eco: 0, band: 5, fallback: 45, voice: true, simX: 4, accelWarn: 3 };
  const settings = Object.assign({}, DEFAULTS, store.get('sc.settings', {}));
  const saveSettings = () => store.set('sc.settings', settings);

  const API = {
    osrm: ['https://router.project-osrm.org/route/v1/driving/',
           'https://routing.openstreetmap.de/routed-car/route/v1/driving/'],
    overpass: ['https://overpass-api.de/api/interpreter',
               'https://overpass.kumi.systems/api/interpreter'],
    nominatim: 'https://nominatim.openstreetmap.org/search',
    elevation: 'https://api.open-meteo.com/v1/elevation'
  };

  // ------------------------------------------------------------ app state
  let dest = null, route = null, profile = null, limits = null, loadNote = '';
  let lastPos = null;

  // ------------------------------------------------------------ helpers
  async function fetchJSON(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 20000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function setStatus(text, isErr) {
    const s = $('status'); s.textContent = text || ''; s.classList.toggle('err', !!isErr);
  }

  function getPosition(maxAgeMs) {
    if (lastPos && Date.now() - lastPos.ts < (maxAgeMs || 60000)) return Promise.resolve(lastPos);
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no-geo'));
      navigator.geolocation.getCurrentPosition(p => {
        lastPos = { lat: p.coords.latitude, lon: p.coords.longitude, ts: Date.now() };
        resolve(lastPos);
      }, err => reject(err), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }

  function geoErrorText(e) {
    if (e && e.code === 1) return 'Location is off for this app. Allow it in Settings → Privacy & Security → Location Services → Safari Websites.';
    return 'Couldn’t get your location. Try again with a clear view of the sky.';
  }

  const fmtMi = m => (m / C.M_PER_MI).toFixed(m < 16093 ? 1 : 0) + ' mi';
  const fmtMin = s => s < 3600 ? Math.round(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.round((s % 3600) / 60) + ' m';

  // ------------------------------------------------------------ search
  async function search(q) {
    $('results').textContent = '';
    setStatus('Searching…');
    $('searchBtn').disabled = true;
    try {
      let pos = null;
      try { pos = await getPosition(); } catch (e) { /* search still works without a bias */ }
      const p = new URLSearchParams({ q, format: 'jsonv2', limit: '6', countrycodes: 'us' });
      if (pos) {
        p.set('viewbox', [pos.lon - 1, pos.lat + 1, pos.lon + 1, pos.lat - 1].map(v => v.toFixed(4)).join(','));
        p.set('bounded', '0');
      }
      const res = await fetchJSON(API.nominatim + '?' + p.toString(), null, 15000);
      if (!res.length) { setStatus('No matches. Try adding the town or state.', true); return; }
      setStatus('Pick your destination:');
      for (const r of res) {
        const parts = String(r.display_name || '').split(', ');
        const name = r.name || parts[0] || 'Destination';
        addPlaceButton($('results'), { name, detail: parts.slice(1, 5).join(', '), lat: +r.lat, lon: +r.lon });
      }
    } catch (e) {
      setStatus('Search didn’t work — check your signal and try again.', true);
    } finally { $('searchBtn').disabled = false; }
  }

  function addPlaceButton(list, place) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button';
    const t = document.createElement('b'); t.textContent = place.name;
    const s = document.createElement('span'); s.textContent = place.detail || '';
    b.append(t, s);
    b.addEventListener('click', () => planTo(place));
    li.append(b); list.append(li);
  }

  function renderRecent() {
    const recent = store.get('sc.recent', []);
    const ul = $('recent').querySelector('ul'); ul.textContent = '';
    recent.forEach(p => addPlaceButton(ul, p));
    $('recent').hidden = !recent.length;
  }
  function remember(place) {
    const recent = store.get('sc.recent', []).filter(p => !(Math.abs(p.lat - place.lat) < 1e-4 && Math.abs(p.lon - place.lon) < 1e-4));
    recent.unshift(place); store.set('sc.recent', recent.slice(0, 5)); renderRecent();
  }

  // ------------------------------------------------------------ data loading
  async function fetchRoute(from, to) {
    const coords = from.lon.toFixed(6) + ',' + from.lat.toFixed(6) + ';' + to.lon.toFixed(6) + ',' + to.lat.toFixed(6);
    const q = '?overview=full&geometries=geojson&steps=true&annotations=nodes';
    let lastErr;
    for (const base of API.osrm) {
      try {
        const j = await fetchJSON(base + coords + q, null, 20000);
        if (j.code === 'Ok' && j.routes && j.routes.length) return j.routes[0];
        lastErr = new Error(j.code || 'NoRoute');
        if (j.code === 'NoRoute') break;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('route');
  }

  async function fetchElevation(r) {
    const step = C.sampleStepFor(r.total);
    const pts = C.sampleRoute(r, step);
    const chunks = [];
    for (let i = 0; i < pts.length; i += 100) chunks.push(pts.slice(i, i + 100));
    const out = new Array(chunks.length);
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const k = next++, c = chunks[k];
        const url = API.elevation + '?latitude=' + c.map(p => p[0].toFixed(5)).join(',') +
          '&longitude=' + c.map(p => p[1].toFixed(5)).join(',');
        let j, tries = 0;
        for (;;) {
          try { j = await fetchJSON(url, null, 15000); break; }
          catch (e) { if (++tries >= 3) throw e; await new Promise(res => setTimeout(res, 800 * tries)); }
        }
        out[k] = j.elevation;
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    return C.buildProfile(r.total, step, [].concat.apply([], out));
  }

  async function fetchWays(r) {
    if (!r.segNodes) return [];
    const ids = Array.from(new Set(r.segNodes.filter(n => n > 0)));
    const byId = new Map();
    for (let i = 0; i < ids.length; i += 2000) {
      const query = '[out:json][timeout:60];node(id:' + ids.slice(i, i + 2000).join(',') + ');way(bn)[highway];out body;';
      let j = null, lastErr;
      for (const url of API.overpass) {
        try {
          j = await fetchJSON(url, {
            method: 'POST', body: 'data=' + encodeURIComponent(query),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          }, 60000);
          break;
        } catch (e) { lastErr = e; }
      }
      if (!j) throw lastErr || new Error('overpass');
      for (const el of (j.elements || [])) if (el.type === 'way') byId.set(el.id, el);
    }
    return Array.from(byId.values());
  }

  /** Route + hills + limits from `from` to `to`. Hills and limits fail soft. */
  async function loadAll(from, to, onStep) {
    onStep && onStep('Getting the route…');
    const r = C.buildRoute(await fetchRoute(from, to));
    onStep && onStep('Reading hills and speed limits…');
    const [pe, le] = await Promise.allSettled([fetchElevation(r), fetchWays(r)]);
    const notes = [];
    const prof = pe.status === 'fulfilled' ? pe.value : (notes.push('Hill data didn’t load, so hills are ignored.'), C.flatProfile(r.total));
    const lim = C.buildLimits(r, le.status === 'fulfilled' ? le.value : null);
    if (le.status !== 'fulfilled') notes.push('Speed limits didn’t load; it will use your “unknown limit” speed.');
    return { r, prof, lim, notes };
  }

  async function planTo(place) {
    dest = place;
    $('results').textContent = '';
    $('routeCard').hidden = true;
    setStatus('Finding you…');
    let from;
    try { from = await getPosition(30000); } catch (e) { setStatus(geoErrorText(e), true); return; }
    try {
      const res = await loadAll(from, place, setStatus);
      route = res.r; profile = res.prof; limits = res.lim;
      loadNote = res.notes.join(' ');
      remember(place);
      setStatus('');
      showRouteCard();
    } catch (e) {
      setStatus(e && e.message === 'NoRoute' ? 'No drivable route found to that place.' : 'Couldn’t get a route — check your signal and try again.', true);
    }
  }

  function showRouteCard() {
    $('routeName').textContent = 'To ' + dest.name;
    $('stDist').textContent = fmtMi(route.total);
    $('stTime').textContent = fmtMin(route.duration);
    $('stClimb').textContent = profile.flat ? '–' : Math.round(profile.climb * C.FT_PER_M).toLocaleString() + ' ft';
    $('stGrade').textContent = profile.flat ? '–' : profile.maxGrade.toFixed(1) + '%';
    const note = $('routeNote'); note.textContent = '';
    const posted = Math.round(limits.postedShare * 100), known = Math.round(limits.knownShare * 100);
    note.append('Speed limits: ' + posted + '% from posted signs' +
      (known > posted ? ', ' + (known - posted) + '% estimated from road type' : '') +
      (known < 100 ? ', rest uses your “unknown limit” speed' : '') + '. ');
    if (loadNote) { const w = document.createElement('span'); w.className = 'warn'; w.textContent = loadNote; note.append(w); }
    $('routeCard').hidden = false;
    drawRouteProfile();
    $('routeCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ------------------------------------------------------------ drawing
  const GRADE_COL = g => g >= 2.5 ? '#ffb020' : g <= -2.5 ? '#4fb3ff' : '#9aa6b5';

  function sizeCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /** Elevation strip from d0 to d1. `marker` = distance to mark (current position). */
  function drawProfile(cv, d0, d1, opts) {
    const { ctx, w, h } = sizeCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    if (!profile || w < 10) return;
    const padB = 18, padT = 8, ph = h - padB - padT;
    ctx.font = '12px -apple-system, system-ui, sans-serif';
    if (profile.flat) {
      ctx.fillStyle = '#8b95a3'; ctx.textAlign = 'center'; ctx.fillText('No hill data', w / 2, h / 2); return;
    }
    const N = Math.max(40, Math.min(240, Math.round(w / 3)));
    const span = Math.max(1, d1 - d0);
    const xs = [], es = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= N; i++) {
      const d = d0 + span * i / N; xs.push(d);
      const e = d <= profile.total ? C.elevAt(profile, d) : C.elevAt(profile, profile.total);
      es.push(e); lo = Math.min(lo, e); hi = Math.max(hi, e);
    }
    const minRange = opts.minRange || 15;
    if (hi - lo < minRange) { const mid = (hi + lo) / 2; lo = mid - minRange / 2; hi = mid + minRange / 2; }
    if (opts.scale) {
      // Ease the vertical scale so the graph glides instead of re-zooming every update:
      // widen quickly when terrain needs it, tighten slowly.
      const sc = opts.scale, pad = (hi - lo) * 0.08, tlo = lo - pad, thi = hi + pad;
      if (sc.lo == null || tlo < sc.lo - 40 || thi > sc.hi + 40) { sc.lo = tlo; sc.hi = thi; }
      else {
        sc.lo += (tlo - sc.lo) * (tlo < sc.lo ? 0.35 : 0.06);
        sc.hi += (thi - sc.hi) * (thi > sc.hi ? 0.35 : 0.06);
      }
      lo = sc.lo; hi = sc.hi;
    }
    const X = i => (i / N) * w, Y = e => padT + ph - (e - lo) / (hi - lo) * ph;
    // fill
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ph);
    grad.addColorStop(0, 'rgba(154,166,181,.28)'); grad.addColorStop(1, 'rgba(154,166,181,.02)');
    ctx.beginPath(); ctx.moveTo(0, padT + ph);
    for (let i = 0; i <= N; i++) ctx.lineTo(X(i), Y(es[i]));
    ctx.lineTo(w, padT + ph); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    // line coloured by grade
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 0; i < N; i++) {
      const g = C.gradeAvg(profile, xs[i] - 50, xs[i + 1] + 50);
      ctx.strokeStyle = xs[i] > profile.total ? '#39424d' : GRADE_COL(g);
      ctx.beginPath(); ctx.moveTo(X(i), Y(es[i])); ctx.lineTo(X(i + 1), Y(es[i + 1])); ctx.stroke();
    }
    // marker
    if (opts.marker != null) {
      const i = (opts.marker - d0) / span * N, mx = X(i);
      const me = C.elevAt(profile, opts.marker);
      ctx.fillStyle = '#e9edf2'; ctx.beginPath(); ctx.arc(mx, Y(me), 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0b0d10'; ctx.lineWidth = 2; ctx.stroke();
    }
    // axis labels
    ctx.fillStyle = '#8b95a3';
    (opts.labels || []).forEach(L => {
      const x = (L.d - d0) / span * w;
      ctx.textAlign = x < 20 ? 'left' : x > w - 20 ? 'right' : 'center';
      ctx.fillText(L.text, Math.max(0, Math.min(w, x)), h - 3);
    });
  }

  function drawRouteProfile() {
    if (!route || $('routeCard').hidden) return;
    const ft = v => Math.round(v * C.FT_PER_M).toLocaleString() + ' ft';
    drawProfile($('routeProfile'), 0, route.total, {
      minRange: 30,
      labels: [{ d: 0, text: 'Start' }, { d: route.total / 2, text: '↑ ' + ft(profile.climb) + '  ↓ ' + ft(profile.descent) }, { d: route.total, text: fmtMi(route.total) }]
    });
  }

  const AHEAD_M = 2000;
  function drawAhead() {
    if (!route || $('drive').hidden) return;
    const dNow = drive.dispD != null ? drive.dispD : drive.d;
    const d0 = Math.max(0, dNow - 120);
    drawProfile($('aheadProfile'), d0, d0 + AHEAD_M, {
      minRange: 15, marker: dNow, scale: drive.scale,
      labels: [{ d: dNow, text: 'You' }, { d: dNow + 804.7, text: '½ mi' }, { d: dNow + 1609.3, text: '1 mi' }]
    });
  }

  // ------------------------------------------------------------ drive
  const drive = {
    active: false, sim: null, watchId: null, idx: null, d: 0, speed: 0, lastFix: null, hasFix: false,
    prevMode: null, last: null, override: null, overrideKey: null,
    offCount: 0, rerouting: false, lastReroute: 0,
    spokenAt: {}, lastSpeak: 0, wakeLock: null,
    // smooth motion between GPS fixes
    fixAt: 0, timeScale: 1, dispD: null, lastDraw: 0, scale: {}, ticker: null,
    // acceleration warning and the 4-second step speed
    samples: [], accel: null, hard: false, hardCount: 0, step: null
  };

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && drive.active) {
        drive.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) { /* not available; the screen may dim */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  function speak(text) {
    if (!settings.voice || !('speechSynthesis' in window) || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text); u.rate = 1.05; u.lang = 'en-US';
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  function startDrive(sim) {
    if (!route) return;
    Object.assign(drive, {
      active: true, idx: null, d: 0, speed: 0, lastFix: null, hasFix: false, prevMode: null, last: null,
      override: null, overrideKey: null, offCount: 0, rerouting: false, spokenAt: {}, lastSpeak: 0,
      fixAt: 0, timeScale: sim ? (settings.simX || 1) : 1, dispD: null, lastDraw: 0, scale: {},
      samples: [], accel: null, hard: false, hardCount: 0, step: null
    });
    $('plan').hidden = true; $('drive').hidden = false;
    $('simTag').hidden = !sim;
    $('banner').hidden = true;
    setVoiceBtn();
    renderWaiting();
    keepAwake();
    if (settings.voice) speak(sim ? 'Test drive started.' : 'Speed coach on.');   // also unlocks speech on iPhone
    if (sim) startSim();
    else {
      drive.watchId = navigator.geolocation.watchPosition(p => onFix({
        lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed,
        acc: p.coords.accuracy, ts: p.timestamp || Date.now()
      }), e => showBanner(geoErrorText(e)), { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    }
    drive.ticker = setInterval(update, 500);
    requestAnimationFrame(frame);
  }

  /** Where you probably are right now: last fix plus distance driven since. */
  function predictedD() {
    if (!drive.hasFix || drive.offCount) return drive.d;
    const el = Math.min(2.5, (performance.now() - drive.fixAt) / 1000 * drive.timeScale);
    return Math.min(route.total, drive.d + drive.speed / MPH * el);
  }

  /** Graph animation, ~25 frames a second. */
  function frame(ts) {
    if (!drive.active) return;
    requestAnimationFrame(frame);
    if (ts - drive.lastDraw < 40) return;
    const dt = drive.lastDraw ? Math.min(0.2, (ts - drive.lastDraw) / 1000) : 0;
    drive.lastDraw = ts;
    if (!drive.hasFix) return;
    const pred = predictedD();
    if (drive.dispD == null || Math.abs(pred - drive.dispD) > 250) drive.dispD = pred;
    else drive.dispD += (pred - drive.dispD) * Math.min(1, dt * 6);
    drawAhead();
  }

  function endDrive() {
    drive.active = false;
    if (drive.ticker) { clearInterval(drive.ticker); drive.ticker = null; }
    if (drive.watchId != null) { navigator.geolocation.clearWatch(drive.watchId); drive.watchId = null; }
    if (drive.sim) { clearInterval(drive.sim.timer); drive.sim = null; }
    if (drive.wakeLock) { drive.wakeLock.release().catch(() => {}); drive.wakeLock = null; }
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    $('drive').hidden = true; $('plan').hidden = false;
    requestAnimationFrame(drawRouteProfile);
  }

  function showBanner(text) { const b = $('banner'); b.textContent = text; b.hidden = !text; }

  function onFix(f) {
    if (!drive.active || !route) return;
    const p = [f.lat, f.lon];
    let sn = drive.idx == null ? C.snap(route, p, null) : C.snap(route, p, drive.idx, 30, 400);
    if (sn.dist > 60 && drive.idx != null) { const g = C.snap(route, p, null); if (g.dist < sn.dist) sn = g; }

    // Speed: GPS doppler speed when available, else from movement.
    let mph = null;
    if (f.speed != null && f.speed >= 0) mph = f.speed * MPH;
    else if (drive.lastFix) {
      const dt = (f.ts - drive.lastFix.ts) / 1000;
      if (dt > 0.3) mph = C.haversine([drive.lastFix.lat, drive.lastFix.lon], p) / dt * MPH;
    }
    if (mph != null) drive.speed = drive.hasFix ? drive.speed * 0.35 + mph * 0.65 : mph;
    drive.lastFix = { lat: f.lat, lon: f.lon, ts: f.ts };
    drive.hasFix = true;
    drive.fixAt = performance.now();

    // Acceleration over the last ~4 seconds; the corner speed turns red when it's too hard.
    if (mph != null) {
      const t = f.ts / 1000;
      drive.samples.push({ t, v: mph });
      while (drive.samples.length && t - drive.samples[0].t > 4) drive.samples.shift();
    }
    const thr = settings.accelWarn || 3;
    drive.accel = C.accelFrom(drive.samples);
    if (drive.accel != null && drive.speed > 4 && drive.accel > thr) drive.hardCount++;
    else drive.hardCount = 0;
    if (drive.hardCount >= 2) drive.hard = true;
    else if (drive.accel == null || drive.accel < thr - 0.7 || drive.speed <= 4) drive.hard = false;

    const accurate = !(f.acc > 60);
    if (sn.dist > 70 && accurate) drive.offCount++;
    else { drive.offCount = 0; drive.idx = sn.idx; drive.d = sn.d; }

    if (drive.offCount >= 3) {
      showBanner(drive.rerouting ? 'Off route — finding a new route…' : 'Off route');
      if (!drive.sim) reroute(p);
    } else if (f.acc > 60) showBanner('Weak GPS signal');
    else if (!drive.rerouting) showBanner('');

    update();
  }

  /** Recompute the suggestion. Runs on every GPS fix and twice a second between fixes. */
  function update() {
    if (!drive.active || !route || !drive.hasFix) return;
    const d = predictedD();
    // A manual limit sticks until the mapped limit changes.
    const under = C.limitAt(route, limits, d);
    const key = under ? under.mph + under.src : 'none';
    if (drive.override != null && key !== drive.overrideKey) drive.override = null;

    const s = C.suggest({
      route, profile, limits, d, speed: drive.speed, prevMode: drive.prevMode,
      settings: { band: settings.band, eco: settings.eco, fallback: settings.fallback },
      override: drive.override
    });
    drive.last = s;
    drive.step = C.stepSpeed(s, drive.speed, settings.accelWarn);
    render(s, d);
    if (s.cue && s.mode !== drive.prevMode) {
      const now = Date.now();
      if (now - drive.lastSpeak > 6000 && now - (drive.spokenAt[s.mode] || 0) > 25000) {
        speak(s.cue); drive.lastSpeak = now; drive.spokenAt[s.mode] = now;
      }
    }
    drive.prevMode = s.mode;
    if (s.mode === 'arrived' && drive.sim) { clearInterval(drive.sim.timer); }
  }

  async function reroute(p) {
    if (drive.rerouting || Date.now() - drive.lastReroute < 30000) return;
    drive.rerouting = true; drive.lastReroute = Date.now();
    showBanner('Off route — finding a new route…');
    try {
      const res = await loadAll({ lat: p[0], lon: p[1] }, dest);
      route = res.r; profile = res.prof; limits = res.lim;
      Object.assign(drive, { idx: null, d: 0, offCount: 0, override: null, dispD: null, scale: {} });
      showBanner('');
    } catch (e) { showBanner('Off route — couldn’t get a new route yet'); }
    drive.rerouting = false;
  }

  function renderWaiting() {
    $('targetBox').className = 'target state-wait';
    $('targetVal').textContent = '--'; $('speedVal').textContent = '--'; $('limitVal').textContent = '--';
    $('hint').textContent = 'Waiting for GPS…'; $('msg').textContent = '\u00a0'; $('ahead').textContent = '\u00a0';
    $('limitSrc').textContent = '\u00a0'; $('sign').className = 'sign';
    $('remain').textContent = fmtMi(route.total) + ' to go';
    $('stepBox').classList.add('off');
    $('nowBox').classList.remove('hard'); $('nowLabel').textContent = 'mph now';
  }

  const HINTS = {
    on: 'On target', over: 'Ease off', under: 'Speed up gently', hold: 'Steady throttle — don’t chase it'
  };

  function render(s, d) {
    const speed = drive.speed;
    const state = C.speedState(speed, s);
    $('targetBox').className = 'target state-' + state;
    $('targetVal').textContent = s.mode === 'arrived' ? '✓' : String(Math.round(s.target));
    let hint = HINTS[state];
    if (state === 'over' && s.holdBelow) hint = 'Lift off the gas';
    if (s.mode === 'arrived') hint = 'Arrived';
    $('hint').textContent = hint;
    $('speedVal').textContent = String(Math.round(speed));
    $('limitVal').textContent = String(Math.round(s.base));
    const srcText = { posted: 'posted', est: 'est. from road type', default: 'unknown · your setting', manual: 'set by you' }[s.src] || '';
    $('limitSrc').textContent = srcText;
    $('sign').className = 'sign' + (s.src === 'est' ? ' est' : s.src === 'default' ? ' unknown' : s.src === 'manual' ? ' manual' : '');
    $('msg').textContent = s.msg || '\u00a0';
    $('ahead').textContent = s.ahead || '\u00a0';
    $('remain').textContent = fmtMi(Math.max(0, route.total - d)) + ' to go';
    const st = drive.step, sb = $('stepBox');
    if (st) {
      sb.classList.remove('off');
      $('stepVal').textContent = String(st.mph);
      $('stepArrow').textContent = st.dir === 'up' ? '↑' : '↓';
    } else sb.classList.add('off');
    $('nowBox').classList.toggle('hard', drive.hard);
    $('nowLabel').textContent = drive.hard ? 'easy on the gas' : 'mph now';
  }

  function adjustLimit(delta) {
    if (!drive.active || !drive.last) return;
    const under = C.limitAt(route, limits, drive.d);
    drive.overrideKey = under ? under.mph + under.src : 'none';
    const cur = drive.override != null ? drive.override : drive.last.base;
    drive.override = Math.max(5, Math.min(85, Math.round((cur + delta) / 5) * 5));
    update();
  }

  // ------------------------------------------------------------ test-drive simulator
  function startSim() {
    const sim = { d: 0, v: 0, t: Date.now() };
    drive.sim = sim;
    const tick = () => {
      const s = drive.last;
      const step = s ? C.stepSpeed(s, sim.v, settings.accelWarn) : null;
      const aim = s ? (s.mode === 'arrived' ? 0 : step ? step.mph : s.target) : 20;
      const g = C.gradeAvg(profile, sim.d - 30, sim.d + 30);
      // A driver who follows the 4-second number, imperfectly; hills tug on the truck.
      let a = (aim - sim.v) / 4;
      a = Math.max(-4, Math.min(2.6, a)) + (Math.random() - 0.5) * 0.9 - g * 0.12;
      sim.v = Math.max(0, sim.v + a);
      sim.d = Math.min(route.total, sim.d + sim.v / MPH);
      sim.t += 1000;                                   // one simulated second per tick
      const p = C.pointAt(route, sim.d);
      onFix({ lat: p[0], lon: p[1], speed: sim.v / MPH, acc: 5, ts: sim.t });
    };
    sim.timer = setInterval(tick, 1000 / (settings.simX || 1));
    tick();
  }

  // ------------------------------------------------------------ settings UI
  function initSettings() {
    document.querySelectorAll('.settings .row[data-key]').forEach(row => {
      const key = row.dataset.key, min = +row.dataset.min, max = +row.dataset.max, step = +row.dataset.step;
      const out = row.querySelector('output');
      const dec = +(row.dataset.dec || 0);
      const show = () => { out.textContent = Number(settings[key]).toFixed(dec); };
      row.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        settings[key] = Math.round(Math.max(min, Math.min(max, settings[key] + step * +b.dataset.d)) * 10) / 10;
        saveSettings(); show();
      }));
      show();
    });
    const vs = $('voiceSetting');
    const showVoice = () => { vs.textContent = settings.voice ? 'On' : 'Off'; vs.setAttribute('aria-pressed', String(settings.voice)); };
    vs.addEventListener('click', () => { settings.voice = !settings.voice; saveSettings(); showVoice(); });
    showVoice();
    const ss = $('simSetting');
    const showSim = () => { ss.textContent = settings.simX + '×'; };
    ss.addEventListener('click', () => { settings.simX = settings.simX === 1 ? 4 : settings.simX === 4 ? 10 : 1; saveSettings(); showSim(); });
    showSim();
  }

  function setVoiceBtn() { $('voiceBtn').textContent = settings.voice ? 'Voice on' : 'Voice off'; }

  // ------------------------------------------------------------ wiring
  $('searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('q').value.trim();
    if (q) { $('q').blur(); search(q); }
  });
  $('startBtn').addEventListener('click', () => startDrive(false));
  $('simBtn').addEventListener('click', () => startDrive(true));
  $('endBtn').addEventListener('click', endDrive);
  $('voiceBtn').addEventListener('click', () => {
    settings.voice = !settings.voice; saveSettings(); setVoiceBtn();
    if (!settings.voice) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
    $('voiceSetting').textContent = settings.voice ? 'On' : 'Off';
    $('voiceSetting').setAttribute('aria-pressed', String(settings.voice));
  });
  $('limDown').addEventListener('click', () => adjustLimit(-5));
  $('limUp').addEventListener('click', () => adjustLimit(5));

  if (window.ResizeObserver) {
    new ResizeObserver(drawRouteProfile).observe($('routeProfile'));
    new ResizeObserver(drawAhead).observe($('aheadProfile'));
  }
  window.addEventListener('orientationchange', () => setTimeout(() => { drive.scale = {}; drawAhead(); drawRouteProfile(); }, 300));

  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  $('installTip').hidden = !(iOS && !standalone);

  initSettings();
  renderRecent();

  // Hooks for automated tests only.
  window.__speedCoach = { drive, get route() { return route; }, get limits() { return limits; } };
})();

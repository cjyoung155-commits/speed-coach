/* Speed Coach — screens, data fetching, GPS and the test-drive simulator. */
(function () {
  'use strict';
  const C = window.SpeedCore;
  const $ = id => document.getElementById(id);
  const MPH = C.MPS_TO_MPH;

  // ------------------------------------------------------------ storage & settings
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
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
  let signals = [];          // traffic lights on the current route (m along it)
  let active = null;         // the saved route being shown or driven, or null for a searched route
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

  /** Road segments (for speed limits) and traffic-light nodes along the route. */
  async function fetchMapData(r) {
    const ids = C.routeNodeIds(r);
    const byId = new Map(), signalIds = new Set();
    for (let i = 0; i < ids.length; i += 2000) {
      const query = '[out:json][timeout:60];node(id:' + ids.slice(i, i + 2000).join(',') + ')->.n;' +
        'way(bn.n)[highway];out body;node.n[highway=traffic_signals];out ids;';
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
      for (const el of (j.elements || [])) {
        if (el.type === 'way') byId.set(el.id, el);
        else if (el.type === 'node') signalIds.add(el.id);
      }
    }
    return { ways: Array.from(byId.values()), signalIds };
  }

  /** Hills, speed limits and lights for a route. Each fails soft. */
  async function loadDetails(r) {
    const [pe, me] = await Promise.allSettled([fetchElevation(r), fetchMapData(r)]);
    const notes = [];
    const prof = pe.status === 'fulfilled' ? pe.value : (notes.push('Hill data didn’t load, so hills are ignored.'), C.flatProfile(r.total));
    const md = me.status === 'fulfilled' ? me.value : null;
    const lim = C.buildLimits(r, md && md.ways);
    if (!md) notes.push('Speed limits didn’t load; it will use your “unknown limit” speed.');
    return { prof, lim, signals: md ? C.buildSignals(r, md.signalIds) : [], notes };
  }

  /** Route + hills + limits + lights from `from` to `to`. */
  async function loadAll(from, to, onStep) {
    onStep && onStep('Getting the route…');
    const r = C.buildRoute(await fetchRoute(from, to));
    onStep && onStep('Reading hills, speed limits and lights…');
    const det = await loadDetails(r);
    return Object.assign({ r }, det);
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
      route = res.r; profile = res.prof; limits = res.lim; signals = res.signals; active = null;
      loadNote = res.notes.join(' ');
      remember(place);
      setStatus('');
      showRouteCard();
    } catch (e) {
      setStatus(e && e.message === 'NoRoute' ? 'No drivable route found to that place.' : 'Couldn’t get a route — check your signal and try again.', true);
    }
  }

  function showRouteCard() {
    $('routeName').textContent = active ? active.name + ' → ' + active.dest : 'To ' + dest.name;
    $('saveRouteBtn').hidden = !!active;
    $('deleteRouteBtn').hidden = !active;
    $('deleteRouteBtn').textContent = 'Delete this route';
    delete $('deleteRouteBtn').dataset.armed;
    $('stDist').textContent = fmtMi(route.total);
    $('stTime').textContent = fmtMin(route.duration);
    $('stClimb').textContent = profile.flat ? '–' : Math.round(profile.climb * C.FT_PER_M).toLocaleString() + ' ft';
    $('stGrade').textContent = profile.flat ? '–' : profile.maxGrade.toFixed(1) + '%';
    const note = $('routeNote'); note.textContent = '';
    const posted = Math.round(limits.postedShare * 100), known = Math.round(limits.knownShare * 100);
    note.append('Speed limits: ' + posted + '% from posted signs' +
      (known > posted ? ', ' + (known - posted) + '% estimated from road type' : '') +
      (known < 100 ? ', rest uses your “unknown limit” speed' : '') + '. ' +
      (signals.length ? signals.length + ' traffic light' + (signals.length > 1 ? 's' : '') + ' on the map. ' : ''));
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
    // traffic lights
    for (const L of (opts.lights || [])) {
      if (L < d0 || L > d1) continue;
      const lx = (L - d0) / span * w, ly = Y(C.elevAt(profile, Math.min(L, profile.total)));
      ctx.strokeStyle = '#e9edf2'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx, ly - 16); ctx.stroke();
      ctx.fillStyle = '#ff5a4f'; ctx.beginPath(); ctx.arc(lx, ly - 19, 3.5, 0, Math.PI * 2); ctx.fill();
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
      minRange: 30, lights: currentLights(),
      labels: [{ d: 0, text: 'Start' }, { d: route.total / 2, text: '↑ ' + ft(profile.climb) + '  ↓ ' + ft(profile.descent) }, { d: route.total, text: fmtMi(route.total) }]
    });
  }

  const AHEAD_M = 2000;
  function drawAhead() {
    if (!route || $('drive').hidden) return;
    const dNow = drive.dispD != null ? drive.dispD : drive.d;
    const d0 = Math.max(0, dNow - 120);
    drawProfile($('aheadProfile'), d0, d0 + AHEAD_M, {
      minRange: 15, marker: dNow, scale: drive.scale, lights: currentLights(),
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
    samples: [], accel: null, hard: false, hardCount: 0, step: null,
    // logging stops at lights on a saved route
    trip: null, tracker: null, alts: [], tip: null, lastTipAt: 0, tripDone: false
  };

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && (drive.active || rec.active)) {
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
      samples: [], accel: null, hard: false, hardCount: 0, step: null,
      trip: null, tracker: null, alts: [], tip: null, lastTipAt: 0, tripDone: false
    });
    // On a saved route (and not a test drive), log stops at lights for this trip.
    if (active && !sim) beginTrip(0);
    drive.alts = active ? altsFor(active) : [];
    $('tipBar').hidden = true;
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
    return Math.min(route.total, drive.d + Math.min(drive.speed, 90) / MPH * el);
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
    finishTrip(false);
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

    if (drive.trip && !drive.offCount) {
      // Progress only counts in believable steps, so a stale first fix or a GPS jump can't fake a trip.
      const tr = drive.trip, step = tr.lastD == null ? null : drive.d - tr.lastD;
      tr.lastD = drive.d;
      if (step != null && Math.abs(step) < 400) {
        drive.tracker.push(f.ts, drive.d, mph != null ? mph : drive.speed);
        tr.reached = Math.max(tr.reached, drive.d);
        if (!tr.tl.length || drive.d - tr.tl[tr.tl.length - 1][0] >= 200) tr.tl.push([Math.round(drive.d), f.ts]);
      }
    }

    if (drive.offCount >= 3) {
      if (switchToAlt(p)) { showBanner(''); update(); return; }
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
      route, profile, limits, signals: currentLights(), d, speed: drive.speed, prevMode: drive.prevMode,
      settings: { band: settings.band, eco: settings.eco, fallback: settings.fallback },
      override: drive.override
    });
    drive.last = s;
    drive.guide = C.guide(s, drive.speed, settings.accelWarn);
    drive.step = drive.guide.step;
    render(s, d);
    if (s.cue && s.mode !== drive.prevMode) {
      const now = Date.now();
      if (now - drive.lastSpeak > 6000 && now - (drive.spokenAt[s.mode] || 0) > 25000) {
        speak(s.cue); drive.lastSpeak = now; drive.spokenAt[s.mode] = now;
      }
    }
    drive.prevMode = s.mode;
    if (s.mode === 'arrived' && drive.sim) { clearInterval(drive.sim.timer); }
    if (s.mode === 'arrived' && drive.trip && !drive.tripDone && drive.trip.reached >= route.total - 80) {
      const sum = finishTrip(true);
      if (sum) $('msg').textContent = sum;
    }
    renderLightPill();
    // Every 10 s before a split: would another saved route be better from here?
    if (drive.alts.length && Date.now() - drive.lastTipAt > 10000) {
      drive.lastTipAt = Date.now();
      const meta = active && lightsMeta(active);
      drive.tip = meta ? C.liveCompare(meta, drive.alts, tripsByRoute(), d, Date.now()) : null;
      const tb = $('tipBar');
      if (drive.tip) {
        tb.textContent = drive.tip.name + ': about ' + C.fmtSec(drive.tip.gain) + ' less at lights right now · split in ' + C.fmtDist(drive.tip.splitIn);
        tb.hidden = false;
      } else tb.hidden = true;
    }
  }

  async function reroute(p) {
    if (drive.rerouting || Date.now() - drive.lastReroute < 30000) return;
    drive.rerouting = true; drive.lastReroute = Date.now();
    showBanner('Off route — finding a new route…');
    try {
      const res = await loadAll({ lat: p[0], lon: p[1] }, dest);
      finishTrip(false);                 // left the saved route: keep what was logged so far
      active = null; drive.alts = []; $('tipBar').hidden = true;
      route = res.r; profile = res.prof; limits = res.lim; signals = res.signals;
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

  function render(s, d) {
    const speed = drive.speed;
    const G = drive.guide;              // state, both text lines and the step, decided together
    $('targetBox').className = 'target state-' + G.state;
    $('targetVal').textContent = s.mode === 'arrived' ? '✓' : String(Math.round(s.target));
    $('hint').textContent = G.hint;
    $('speedVal').textContent = String(Math.round(speed));
    $('limitVal').textContent = String(Math.round(s.base));
    const srcText = { posted: 'posted', est: 'est. from road type', default: 'unknown · your setting', manual: 'set by you' }[s.src] || '';
    $('limitSrc').textContent = srcText;
    $('sign').className = 'sign' + (s.src === 'est' ? ' est' : s.src === 'default' ? ' unknown' : s.src === 'manual' ? ' manual' : '');
    $('msg').textContent = G.msg || '\u00a0';
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

  // ------------------------------------------------------------ my routes (saved routes + trips)
  const lib = {
    routes: () => store.get('sc.routes', []),
    saveRoutes: list => store.set('sc.routes', list),
    trips: () => store.get('sc.trips', []),
    saveTrips: list => store.set('sc.trips', list.slice(-1500))
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sameDest = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const lightsOf = meta => Array.from(new Set((meta.data.sig || []).concat(meta.extra || []))).sort((a, b) => a - b);
  const lightsMeta = meta => ({ id: meta.id, name: meta.name, total: meta.total, lights: lightsOf(meta) });
  function currentLights() { return active ? lightsOf(active) : signals; }
  function tripsByRoute() {
    const by = {};
    for (const t of lib.trips()) (by[t.routeId] = by[t.routeId] || []).push(t);
    return by;
  }

  function renderMyRoutes() {
    const box = $('groups'); box.textContent = '';
    const routes = lib.routes();
    $('myRoutesEmpty').hidden = routes.length > 0;
    const groups = [];
    for (const r of routes) {
      let g = groups.find(x => sameDest(x.dest, r.dest));
      if (!g) groups.push(g = { dest: r.dest, routes: [] });
      g.routes.push(r);
    }
    const by = tripsByRoute(), now = Date.now();
    const seedBase = new Date(now).toDateString() + (new Date(now).getHours() < 12 ? 'am' : 'pm');
    for (const g of groups) {
      const rec = C.recommend(g.routes.map(lightsMeta), by, now, g.dest.toLowerCase() + seedBase);
      const card = document.createElement('div'); card.className = 'card group';
      const eb = document.createElement('p'); eb.className = 'eyebrow'; eb.textContent = 'To ' + g.dest;
      card.append(eb);
      if (rec.text) { const p = document.createElement('p'); p.className = 'pick ' + rec.kind; p.textContent = rec.text; card.append(p); }
      const pick = g.routes.find(r => r.id === rec.pick) || g.routes[0];
      const go = document.createElement('button'); go.type = 'button'; go.className = 'btn primary';
      go.textContent = 'Start ' + pick.name;
      go.addEventListener('click', () => { openSaved(pick); startDrive(false); });
      card.append(go);
      const ul = document.createElement('ul'); ul.className = 'rlist';
      for (const r of g.routes) {
        const row = rec.rows.find(x => x.id === r.id) || {};
        const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
        const t = document.createElement('b'); t.textContent = r.name + (r.id === rec.pick && g.routes.length > 1 ? '  ★' : '');
        const sp = document.createElement('span');
        sp.textContent = (row.ready ? 'about ' + C.fmtSec(row.wait) + ' at lights now · ' + row.stops.toFixed(1) + ' stops · ' : 'learning · ') +
          (row.trips || 0) + ' trip' + (row.trips === 1 ? '' : 's') + ' · ' + fmtMi(r.total);
        b.append(t, sp);
        b.addEventListener('click', () => { openSaved(r); $('routeCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        li.append(b); ul.append(li);
      }
      card.append(ul);
      box.append(card);
    }
  }

  function loadSavedData(meta) {
    const u = C.unpackRoute(meta.data);
    return { route: u.route, profile: u.profile, limits: u.limits, signals: u.signals };
  }

  function openSaved(meta) {
    const u = loadSavedData(meta);
    route = u.route; profile = u.profile; limits = u.limits; signals = u.signals; active = meta;
    dest = { name: meta.dest, lat: meta.end[0], lon: meta.end[1] };
    loadNote = '';
    setStatus('');
    showRouteCard();
    if (Date.now() - (meta.savedAt || 0) > 30 * 864e5) refreshSaved(meta);
  }

  /** Re-read hills, speed limits and lights for a saved route that is over a month old. */
  async function refreshSaved(meta) {
    try {
      const r = loadSavedData(meta).route;
      if (!r.segPairs) return;
      const det = await loadDetails(r);
      if (det.notes.length) return;
      const fresh = C.packRoute(r, det.prof, det.lim, det.signals);
      const list = lib.routes(), i = list.findIndex(x => x.id === meta.id);
      if (i < 0) return;
      list[i].data = Object.assign(list[i].data, { prof: fresh.prof, lim: fresh.lim, sig: fresh.sig });
      list[i].savedAt = Date.now();
      lib.saveRoutes(list);
    } catch (e) { /* try again next time */ }
  }

  /** The other saved routes to the same place, with where each splits from this one. */
  function altsFor(meta) {
    const cur = loadSavedData(meta).route;
    return lib.routes().filter(r => r.id !== meta.id && sameDest(r.dest, meta.dest)).map(r => {
      const u = loadSavedData(r);
      return { route: Object.assign(lightsMeta(r), { geo: u.route }), split: C.splitPoint(cur, u.route), meta: r };
    }).filter(a => a.split);
  }

  function beginTrip(fromD) {
    drive.trip = { id: newId(), routeId: active.id, t0: Date.now(), fromD, reached: fromD, tl: [], stops: [] };
    drive.tracker = C.stopTracker(lightsOf(active));
    drive.tripDone = false;
  }

  /** Save the trip being logged. Returns a one-line summary, or '' if nothing was saved. */
  function finishTrip(arrived) {
    const tr = drive.trip;
    if (!tr || drive.tripDone) return '';
    drive.tripDone = true;
    tr.stops = drive.tracker.finish(Date.now());
    delete tr.lastD;
    if (arrived) tr.reached = Math.max(tr.reached, active ? active.total : tr.reached);
    drive.trip = null;
    if (tr.reached - tr.fromD < 300) return '';
    learnLights(tr);
    const all = lib.trips(); all.push(tr);
    if (!lib.saveTrips(all)) { showBanner('Phone storage is full — trip not saved'); return ''; }
    renderMyRoutes();
    const wait = tr.stops.reduce((a, st) => a + st.dur, 0);
    return 'Trip logged · ' + tr.stops.length + ' light stop' + (tr.stops.length === 1 ? '' : 's') + ' · ' + C.fmtSec(wait) + ' waiting';
  }

  /** A light you tapped that isn't on the map is remembered for next time. */
  function learnLights(tr) {
    const list = lib.routes(), meta = list.find(r => r.id === tr.routeId);
    if (!meta) return;
    let changed = false;
    for (const st of tr.stops) {
      if (st.mapped) continue;
      const known = lightsOf(meta);
      if (!known.some(L => Math.abs(L - st.light) < 150)) { (meta.extra = meta.extra || []).push(st.light + 30); changed = true; }
    }
    if (changed) { lib.saveRoutes(list); if (active && active.id === meta.id) active = meta; }
  }

  /** Off the current saved route but on another one to the same place: carry on with that one. */
  function switchToAlt(p) {
    for (const a of drive.alts) {
      const sn = C.snap(a.route.geo, p, null);
      if (sn.dist > 40) continue;
      finishTrip(false);
      const meta = a.meta, u = loadSavedData(meta);
      route = u.route; profile = u.profile; limits = u.limits; signals = u.signals; active = meta;
      Object.assign(drive, { idx: sn.idx, d: sn.d, offCount: 0, dispD: null, scale: {}, prevMode: null, tip: null });
      if (drive.watchId != null) beginTrip(sn.d);
      drive.alts = altsFor(meta);
      $('tipBar').hidden = true;
      return true;
    }
    return false;
  }

  /** While stopped on a saved route: show that a light is being logged, or offer the button. */
  function renderLightPill() {
    const pill = $('lightPill');
    const cur = drive.tracker && drive.tracker.cur;
    if (!drive.trip || !cur || drive.speed >= 3) { pill.hidden = true; return; }
    pill.hidden = false;
    if (cur.light != null || cur.manual) {
      const secs = Math.max(0, Math.round((Date.now() - cur.t0) / 1000));
      pill.textContent = 'Logging light · ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
      pill.className = 'lightpill logging';
    } else {
      pill.textContent = 'Stopped at a light? Tap to log it';
      pill.className = 'lightpill';
    }
  }

  // ------------------------------------------------------------ recording a route
  const rec = { active: false, watchId: null, pts: [], taps: [], t0: 0, timer: null, dist: 0, last: null, speed: 0 };

  function startRecording() {
    Object.assign(rec, { active: true, pts: [], taps: [], t0: Date.now(), dist: 0, last: null, speed: 0 });
    $('plan').hidden = true; $('rec').hidden = false;
    $('recSpeed').textContent = '--'; $('recDist').textContent = '0.0 mi'; $('recTime').textContent = '0:00'; $('recTaps').textContent = '0';
    $('recLight').hidden = true;
    keepAwake();
    rec.note = $('recNote').textContent;
    rec.watchId = navigator.geolocation.watchPosition(onRecFix, e => {
      $('recNote').textContent = e && e.code === 1 ? geoErrorText(e) : 'Weak GPS signal — still recording.';
    },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
    rec.timer = setInterval(() => {
      const s = Math.round((Date.now() - rec.t0) / 1000);
      $('recTime').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
  }

  function onRecFix(p) {
    const f = { lat: p.coords.latitude, lon: p.coords.longitude, t: p.timestamp || Date.now(), acc: p.coords.accuracy };
    let v = p.coords.speed != null && p.coords.speed >= 0 ? p.coords.speed * MPH : null;
    if (v == null && rec.last) {
      const dt = (f.t - rec.last.t) / 1000;
      if (dt > 0.3) v = C.haversine([rec.last.lat, rec.last.lon], [f.lat, f.lon]) / dt * MPH;
    }
    rec.speed = v == null ? rec.speed : rec.speed * 0.35 + v * 0.65;
    rec.last = f;
    if (rec.note) $('recNote').textContent = rec.note;
    $('recSpeed').textContent = String(Math.round(rec.speed));
    $('recLight').hidden = rec.speed >= 3;
    if (f.acc > 50) return;
    const prev = rec.pts[rec.pts.length - 1];
    const step = prev ? C.haversine([prev.lat, prev.lon], [f.lat, f.lon]) : 0;
    const vNow = v == null ? rec.speed : v;
    if (!prev || step >= 8 || f.t - prev.t >= 3000 || (vNow < 2) !== (prev.v < 2)) {
      rec.pts.push({ lat: f.lat, lon: f.lon, t: f.t, v: vNow });
      rec.dist += step;
      $('recDist').textContent = fmtMi(rec.dist);
    }
  }

  function stopRecording() {
    rec.active = false;
    if (rec.watchId != null) { navigator.geolocation.clearWatch(rec.watchId); rec.watchId = null; }
    clearInterval(rec.timer);
    if (drive.wakeLock) { drive.wakeLock.release().catch(() => {}); drive.wakeLock = null; }
  }

  /** Rebuild the recorded drive on the road map: via points every ~700 m, pointed the way you drove. */
  async function buildFromTrace(trace) {
    const cum = [0];
    for (let i = 1; i < trace.length; i++) cum.push(cum[i - 1] + C.haversine([trace[i - 1].lat, trace[i - 1].lon], [trace[i].lat, trace[i].lon]));
    const total = cum[cum.length - 1];
    const every = Math.max(700, total / 23);
    const picks = [0];
    for (let i = 1; i < trace.length - 1; i++) if (cum[i] - cum[picks[picks.length - 1]] >= every && total - cum[i] > every / 2) picks.push(i);
    picks.push(trace.length - 1);
    const bearingAt = i => {
      let a = i, b = i;
      while (a > 0 && cum[i] - cum[a] < 30) a--;
      while (b < trace.length - 1 && cum[b] - cum[i] < 30) b++;
      if (a === b) return null;
      const y = Math.sin((trace[b].lon - trace[a].lon) * Math.PI / 180) * Math.cos(trace[b].lat * Math.PI / 180);
      const x = Math.cos(trace[a].lat * Math.PI / 180) * Math.sin(trace[b].lat * Math.PI / 180) -
        Math.sin(trace[a].lat * Math.PI / 180) * Math.cos(trace[b].lat * Math.PI / 180) * Math.cos((trace[b].lon - trace[a].lon) * Math.PI / 180);
      return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360);
    };
    const coords = picks.map(i => trace[i].lon.toFixed(6) + ',' + trace[i].lat.toFixed(6)).join(';');
    const bearings = picks.map((i, k) => { const b = k === 0 || k === picks.length - 1 ? null : bearingAt(i); return b == null ? '' : b + ',60'; }).join(';');
    const radiuses = picks.map(() => '50').join(';');
    const base = '?overview=full&geometries=geojson&steps=true&annotations=nodes&continue_straight=true&radiuses=' + radiuses;
    let osrm = null;
    for (const q of [base + '&bearings=' + bearings, base]) {
      for (const host of API.osrm) {
        try {
          const j = await fetchJSON(host + coords + q, null, 25000);
          if (j.code === 'Ok' && j.routes && j.routes.length) { osrm = j.routes[0]; break; }
        } catch (e) { /* next */ }
      }
      if (osrm) break;
    }
    if (!osrm) throw new Error('route');
    const r = C.buildRoute(osrm);
    const det = await loadDetails(r);
    return Object.assign({ r, traceLen: total }, det);
  }

  /** Turn the recording itself into the route's first logged trip. */
  function tripFromTrace(meta, r, trace, taps) {
    const T = C.stopTracker(lightsOf(meta));
    const tl = [], tapList = taps.slice();
    let idx = null, reached = 0;
    for (const p of trace) {
      const sn = idx == null ? C.snap(r, [p.lat, p.lon], null) : C.snap(r, [p.lat, p.lon], idx, 30, 400);
      if (sn.dist > 80) continue;
      idx = sn.idx; reached = Math.max(reached, sn.d);
      while (tapList.length && tapList[0] <= p.t) T.manual(tapList.shift(), sn.d);
      T.push(p.t, sn.d, p.v);
      if (!tl.length || sn.d - tl[tl.length - 1][0] >= 200) tl.push([Math.round(sn.d), p.t]);
    }
    const end = trace[trace.length - 1].t;
    return { id: newId(), routeId: meta.id, t0: trace[0].t, fromD: 0, reached, tl, stops: T.finish(end + 1000) };
  }

  // ------------------------------------------------------------ save sheet
  let saving = null;      // {kind: 'trace'|'current'}
  function openSaveSheet(kind) {
    saving = { kind };
    $('svName').value = ''; $('svDest').value = kind === 'current' && dest ? dest.name : '';
    $('svStatus').textContent = ''; $('svStatus').classList.remove('err');
    $('svSave').disabled = false;
    $('svCancel').textContent = kind === 'trace' ? 'Discard recording' : 'Cancel';
    const chips = $('svChips'); chips.textContent = '';
    const dests = [];
    for (const r of lib.routes()) if (!dests.some(d => sameDest(d, r.dest))) dests.push(r.dest);
    for (const d of dests) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chipbtn'; b.textContent = d;
      b.addEventListener('click', () => { $('svDest').value = d; });
      chips.append(b);
    }
    $('saveSheet').hidden = false;
    setTimeout(() => $('svName').focus(), 50);
  }
  function closeSaveSheet() { $('saveSheet').hidden = true; saving = null; }

  async function doSave() {
    const name = $('svName').value.trim(), where = $('svDest').value.trim();
    const st = $('svStatus');
    if (!name || !where) { st.textContent = 'Give it a name and a destination.'; st.classList.add('err'); return; }
    st.classList.remove('err'); $('svSave').disabled = true;
    try {
      let r, prof, lim, sig, first = null, warn = '';
      const meta = { id: newId(), name, dest: where, savedAt: Date.now(), extra: [] };
      if (saving.kind === 'trace') {
        st.textContent = 'Matching your drive to the road map…';
        const b = await buildFromTrace(rec.pts);
        r = b.r; prof = b.prof; lim = b.lim; sig = b.signals;
        if (r.total > b.traceLen * 1.25) warn = ' The mapped route came out longer than your drive — check that it looks right.';
      } else { r = route; prof = profile; lim = limits; sig = signals; }
      meta.data = C.packRoute(r, prof, lim, sig);
      meta.total = Math.round(r.total);
      meta.start = r.pts[0]; meta.end = r.pts[r.pts.length - 1];
      const list = lib.routes(); list.push(meta);
      if (!lib.saveRoutes(list)) throw new Error('storage');
      if (saving.kind === 'trace') {
        first = tripFromTrace(meta, r, rec.pts, rec.taps);
        if (first.reached > 300) { const all = lib.trips(); all.push(first); lib.saveTrips(all); learnLights(first); }
      }
      closeSaveSheet();
      $('rec').hidden = true; $('plan').hidden = false;
      renderMyRoutes();
      openSaved(lib.routes().find(x => x.id === meta.id));
      setStatus('Saved “' + name + '”.' + (first ? ' Your drive counts as its first trip (' + first.stops.length + ' light stop' + (first.stops.length === 1 ? '' : 's') + ').' : '') + warn);
    } catch (e) {
      $('svSave').disabled = false;
      st.classList.add('err');
      st.textContent = e && e.message === 'storage' ? 'Phone storage is full.' : 'Couldn’t match the drive to the road map — check your signal and try Save again.';
    }
  }

  function deleteActive() {
    const b = $('deleteRouteBtn');
    if (!active) return;
    const n = lib.trips().filter(t => t.routeId === active.id).length;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Tap again to delete it and its ' + n + ' trip' + (n === 1 ? '' : 's'); return; }
    lib.saveRoutes(lib.routes().filter(r => r.id !== active.id));
    lib.saveTrips(lib.trips().filter(t => t.routeId !== active.id));
    active = null; route = null;
    $('routeCard').hidden = true;
    renderMyRoutes();
    setStatus('Route deleted.');
  }

  // ------------------------------------------------------------ backup
  async function backup() {
    const data = JSON.stringify({ app: 'speed-coach', v: 1, at: Date.now(), routes: lib.routes(), trips: lib.trips(), settings });
    const name = 'speed-coach-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      const file = new File([data], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Speed Coach backup' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = name; document.body.append(a); a.click(); a.remove();
  }
  async function restore(file) {
    const out = $('backupNote');
    try {
      const j = JSON.parse(await file.text());
      if (j.app !== 'speed-coach') throw new Error('not ours');
      const routes = lib.routes(), trips = lib.trips();
      for (const r of j.routes || []) if (!routes.some(x => x.id === r.id)) routes.push(r);
      for (const t of j.trips || []) if (!trips.some(x => x.id === t.id)) trips.push(t);
      lib.saveRoutes(routes); lib.saveTrips(trips);
      renderMyRoutes();
      out.textContent = 'Restored: ' + routes.length + ' routes, ' + trips.length + ' trips.';
    } catch (e) { out.textContent = 'That file isn’t a Speed Coach backup.'; }
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
  $('recordBtn').addEventListener('click', startRecording);
  $('recLight').addEventListener('click', () => {
    rec.taps.push(Date.now());
    $('recTaps').textContent = String(rec.taps.length);
    $('recLight').textContent = 'Logged ✓';
    setTimeout(() => { $('recLight').textContent = 'Stopped at a light — tap to log'; }, 1500);
  });
  $('recStop').addEventListener('click', () => {
    stopRecording();
    if (rec.pts.length < 10 || rec.dist < 300) {
      $('rec').hidden = true; $('plan').hidden = false; setStatus('That recording was too short to save.', true); return;
    }
    openSaveSheet('trace');
  });
  $('recCancel').addEventListener('click', () => { stopRecording(); $('rec').hidden = true; $('plan').hidden = false; });
  $('svSave').addEventListener('click', doSave);
  $('svCancel').addEventListener('click', () => {
    const wasTrace = saving && saving.kind === 'trace';
    closeSaveSheet();
    if (wasTrace) { $('rec').hidden = true; $('plan').hidden = false; }
  });
  $('saveRouteBtn').addEventListener('click', () => openSaveSheet('current'));
  $('deleteRouteBtn').addEventListener('click', deleteActive);
  $('lightPill').addEventListener('click', () => {
    if (drive.tracker && drive.trip) { drive.tracker.manual(Date.now(), drive.d); renderLightPill(); }
  });
  $('backupBtn').addEventListener('click', backup);
  $('restoreInput').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) restore(f); e.target.value = ''; });
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
  renderMyRoutes();

  // Hooks for automated tests only.
  window.__speedCoach = { drive, rec, lib, get route() { return route; }, get limits() { return limits; }, get active() { return active; }, get signals() { return signals; } };
})();

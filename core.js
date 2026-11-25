/*
 * Speed Coach — core logic (no DOM). Works in the browser (window.SpeedCore)
 * and in Node (module.exports) so it can be unit-tested.
 *
 * Coordinates are [lat, lon]. Distances are meters along the route.
 * Speeds shown to the driver are mph.
 */
(function (root) {
  'use strict';

  const R = 6371008.8;          // Earth radius, m
  const RAD = Math.PI / 180;
  const MPS_TO_MPH = 2.2369363;
  const M_PER_MI = 1609.344;
  const FT_PER_M = 3.28084;

  // Grade thresholds (%)
  const CLIMB_IN = 2.5, CLIMB_OUT = 1.5;
  const DESC_IN = -2.5, DESC_OUT = -1.5;
  const SCAN_STEP = 25;         // m
  const COAST_DECEL = 0.55;     // m/s² — rough coast-in-gear deceleration for a pickup
  const SLOW_CUE_M = 100;       // start the turn / lower-limit cue this far out
  const STEP_SECS = 4;          // the small "next 4 seconds" speed looks this far ahead
  const EASY_DECEL = 0.8;       // m/s² — coast plus light braking; caps speed-ups before a slow point

  // Estimated US limits by OpenStreetMap road class, used when no sign is mapped.
  const EST_LIMITS = {
    motorway: 65, motorway_link: 45, trunk: 55, trunk_link: 35,
    primary: 45, primary_link: 35, secondary: 40, secondary_link: 30,
    tertiary: 35, tertiary_link: 30, unclassified: 30, residential: 25,
    living_street: 15, service: 15, road: 30
  };

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function haversine(a, b) {
    const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // ---------------------------------------------------------------- route

  /** Speed (mph) a maneuver needs, or null if you can carry speed through it. */
  function slowSpeedFor(type, modifier) {
    if (type === 'depart') return null;
    if (type === 'arrive') return 10;
    if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') return 20;
    if (modifier === 'uturn') return 10;
    const turnish = type === 'turn' || type === 'end of road' ||
      type === 'continue' || type === 'new name';
    if (!turnish) return null;
    if (modifier === 'sharp left' || modifier === 'sharp right') return 12;
    if (modifier === 'left' || modifier === 'right') return 15;
    return null;
  }

  /** Build a route model from one OSRM route object (geometries=geojson). */
  function buildRoute(r) {
    const coords = (r && r.geometry && r.geometry.coordinates) || [];
    const pts = coords.map(c => [c[1], c[0]]);
    if (pts.length === 1) pts.push(pts[0].slice());
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i]);
    const leg = (r.legs && r.legs[0]) || {};
    const nodes = leg.annotation && leg.annotation.nodes;
    const route = {
      pts, cum,
      total: pts.length ? cum[pts.length - 1] : 0,
      duration: r.duration || 0,
      segNodes: nodes && nodes.length === pts.length ? nodes : null,
      maneuvers: []
    };
    let hint = 0;
    for (const st of (leg.steps || [])) {
      const m = st.maneuver;
      if (!m || !m.location) continue;
      const slow = slowSpeedFor(m.type, m.modifier);
      let d;
      if (m.type === 'arrive') d = route.total;
      else {
        const sn = snap(route, [m.location[1], m.location[0]], hint, 0, pts.length);
        hint = sn.idx; d = sn.d;
      }
      route.maneuvers.push({ d, type: m.type, modifier: m.modifier || '', name: st.name || '', slow });
    }
    return route;
  }

  /**
   * Nearest point on the route to p. Searches segments [hint-back, hint+fwd]
   * (or everything if hint is null). Returns {idx, t, d, dist}.
   */
  function snap(route, p, hint, back, fwd) {
    const pts = route.pts, n = pts.length;
    if (n < 2) return { idx: 0, t: 0, d: 0, dist: Infinity };
    let lo = 0, hi = n - 2;
    if (hint != null) { lo = Math.max(0, hint - back); hi = Math.min(n - 2, hint + fwd); }
    const cosLat = Math.cos(p[0] * RAD), k = R * RAD;
    let best = { idx: lo, t: 0, d: route.cum[lo], dist: Infinity };
    for (let i = lo; i <= hi; i++) {
      const ax = (pts[i][1] - p[1]) * cosLat * k, ay = (pts[i][0] - p[0]) * k;
      const bx = (pts[i + 1][1] - p[1]) * cosLat * k, by = (pts[i + 1][0] - p[0]) * k;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
      const dist = Math.hypot(ax + t * dx, ay + t * dy);
      if (dist < best.dist) {
        best = { idx: i, t, dist, d: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]) };
      }
    }
    return best;
  }

  /** Index of the segment containing distance d. */
  function segIndexAt(route, d) {
    const cum = route.cum, n = cum.length;
    if (n < 2 || d <= 0) return 0;
    if (d >= route.total) return n - 2;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    return lo;
  }

  function pointAt(route, d) {
    const i = segIndexAt(route, d), a = route.pts[i], b = route.pts[i + 1] || a;
    const L = route.cum[i + 1] - route.cum[i];
    const t = L > 0 ? clamp((d - route.cum[i]) / L, 0, 1) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /** Evenly spaced points along the route for elevation lookups. */
  function sampleRoute(route, step) {
    const out = [];
    for (let d = 0; d < route.total; d += step) out.push(pointAt(route, d));
    out.push(pointAt(route, route.total));
    return out;
  }

  function sampleStepFor(total) { return Math.max(40, Math.ceil(total / 2500)); }

  // ---------------------------------------------------------------- hills

  function movingAverage(a, h) {
    const n = a.length, out = new Float64Array(n);
    let sum = 0, cnt = 0, lo = 0, hi = -1;
    for (let i = 0; i < n; i++) {
      const L = Math.max(0, i - h), H = Math.min(n - 1, i + h);
      while (hi < H) { hi++; sum += a[hi]; cnt++; }
      while (lo < L) { sum -= a[lo]; lo++; cnt--; }
      out[i] = sum / cnt;
    }
    return out;
  }

  /** elevations[i] is the ground height (m) at distance i*step. */
  function buildProfile(total, step, elevations) {
    const raw = Float64Array.from(elevations.map(e => (e == null || isNaN(e) ? NaN : e)));
    // Fill gaps by carrying the nearest known value.
    let last = NaN;
    for (let i = 0; i < raw.length; i++) { if (isNaN(raw[i])) raw[i] = last; else last = raw[i]; }
    last = NaN;
    for (let i = raw.length - 1; i >= 0; i--) { if (isNaN(raw[i])) raw[i] = last; else last = raw[i]; }
    for (let i = 0; i < raw.length; i++) if (isNaN(raw[i])) raw[i] = 0;
    // The terrain model is 90 m resolution, so smooth over ~±120 m (two passes).
    const h = Math.max(1, Math.round(120 / step));
    const elev = movingAverage(movingAverage(raw, h), h);
    let climb = 0, descent = 0, maxGrade = 0;
    for (let i = 1; i < elev.length; i++) {
      const de = elev[i] - elev[i - 1];
      if (de > 0) climb += de; else descent -= de;
    }
    const prof = { total, step, elev, climb, descent, maxGrade: 0, flat: false };
    for (let d = 0; d + 200 <= total; d += 100) {
      maxGrade = Math.max(maxGrade, Math.abs(gradeAvg(prof, d, d + 200)));
    }
    prof.maxGrade = maxGrade;
    return prof;
  }

  function flatProfile(total) {
    return { total, step: Math.max(1, total), elev: Float64Array.from([0, 0]), climb: 0, descent: 0, maxGrade: 0, flat: true };
  }

  function elevAt(prof, d) {
    const e = prof.elev, x = clamp(d, 0, prof.total) / prof.step;
    const i = Math.min(e.length - 1, Math.floor(x)), j = Math.min(e.length - 1, i + 1);
    return e[i] + (e[j] - e[i]) * (x - i);
  }

  /** Average grade (%) between d0 and d1 (rise over run). */
  function gradeAvg(prof, d0, d1) {
    if (!prof || prof.flat) return 0;
    d0 = clamp(d0, 0, prof.total); d1 = clamp(d1, 0, prof.total);
    if (d1 - d0 < 30) {
      if (d1 >= prof.total) d0 = Math.max(0, d1 - 30); else d1 = Math.min(prof.total, d0 + 30);
    }
    const run = d1 - d0;
    return run > 0 ? (elevAt(prof, d1) - elevAt(prof, d0)) / run * 100 : 0;
  }

  /** Look ahead for the next climb / downhill and, if climbing now, the top. */
  function scanAhead(prof, d, climbing) {
    const res = { climb: null, descent: null, crest: null };
    if (!prof || prof.flat) return res;
    const total = prof.total, end = Math.min(total - 50, d + 1200);
    for (let x = d; x < end && !(res.climb && res.descent); x += SCAN_STEP) {
      if (!res.climb && gradeAvg(prof, x, x + 150) >= CLIMB_IN) {
        let e = x;
        while (e < Math.min(total, x + 4000) && gradeAvg(prof, e, e + 100) >= 1.0) e += SCAN_STEP;
        res.climb = { at: x - d, len: Math.max(e - x, 150), grade: gradeAvg(prof, x, Math.max(e, x + 150)) };
      }
      if (!res.descent && gradeAvg(prof, x, x + 150) <= DESC_IN) {
        let e = x;
        while (e < Math.min(total, x + 4000) && gradeAvg(prof, e, e + 100) <= -1.0) e += SCAN_STEP;
        res.descent = { at: x - d, len: Math.max(e - x, 150), grade: gradeAvg(prof, x, Math.max(e, x + 150)) };
      }
    }
    if (climbing) {
      for (let x = d; x < Math.min(total, d + 800); x += SCAN_STEP) {
        if (gradeAvg(prof, x, x + 100) < 1.0) {
          res.crest = { at: x - d, rollsOver: gradeAvg(prof, x, x + 300) <= -1.5 || gradeAvg(prof, x + 100, x + 400) <= -1.5 };
          break;
        }
      }
    }
    return res;
  }

  // ---------------------------------------------------------------- limits

  function parseMaxspeed(v) {
    if (!v) return null;
    const s = String(v).split(';')[0].trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (!(n > 0)) return null;
    if (m[2] === 'mph') return Math.round(n);
    if (m[2] === 'knots') return Math.round(n * 1.15078);
    return Math.max(5, Math.round(n * 0.621371 / 5) * 5);   // km/h → nearest 5 mph
  }

  /**
   * Per-segment speed limits from Overpass "way" elements.
   * Returns {segs:[{mph, src:'posted'|'est', hw}|null], postedShare, knownShare}.
   */
  function buildLimits(route, ways) {
    const n = route.pts.length;
    const segs = new Array(Math.max(0, n - 1)).fill(null);
    if (route.segNodes && ways && ways.length) {
      const map = new Map();
      for (const w of ways) {
        if (!w || !w.nodes || !w.tags || !w.tags.highway) continue;
        for (let k = 0; k < w.nodes.length - 1; k++) {
          const f = w.nodes[k] + '_' + w.nodes[k + 1], b = w.nodes[k + 1] + '_' + w.nodes[k];
          if (!map.has(f)) map.set(f, { w, fwd: true });
          if (!map.has(b)) map.set(b, { w, fwd: false });
        }
      }
      for (let i = 0; i < n - 1; i++) {
        const hit = map.get(route.segNodes[i] + '_' + route.segNodes[i + 1]);
        if (!hit) continue;
        const t = hit.w.tags;
        const dirTag = hit.fwd ? t['maxspeed:forward'] : t['maxspeed:backward'];
        const posted = parseMaxspeed(dirTag || t.maxspeed);
        if (posted) segs[i] = { mph: posted, src: 'posted', hw: t.highway };
        else if (EST_LIMITS[t.highway]) segs[i] = { mph: EST_LIMITS[t.highway], src: 'est', hw: t.highway };
      }
    }
    // Bridge short gaps (snapped route ends, unmatched node pairs) from neighbours.
    const GAP = 150;
    let lastIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i]) lastIdx = i;
      else if (lastIdx >= 0 && route.cum[i] - route.cum[lastIdx + 1] < GAP) segs[i] = segs[lastIdx];
    }
    lastIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i]) lastIdx = i;
      else if (lastIdx >= 0 && route.cum[lastIdx] - route.cum[i + 1] < GAP) segs[i] = segs[lastIdx];
    }
    let posted = 0, known = 0;
    for (let i = 0; i < segs.length; i++) {
      const L = route.cum[i + 1] - route.cum[i];
      if (segs[i]) { known += L; if (segs[i].src === 'posted') posted += L; }
    }
    const tot = route.total || 1;
    return { segs, postedShare: posted / tot, knownShare: known / tot };
  }

  function limitAt(route, limits, d) {
    if (!limits || !limits.segs.length) return null;
    return limits.segs[segIndexAt(route, d)] || null;
  }

  /** First stretch within `range` m where the limit drops to <= base-3 and stays down 100 m. */
  function nextLowerLimit(route, limits, d, base, range) {
    if (!limits || !limits.segs.length) return null;
    const segs = limits.segs;
    for (let i = segIndexAt(route, d) + 1; i < segs.length && route.cum[i] < d + range; i++) {
      const s = segs[i];
      if (s && s.mph <= base - 3) {
        const later = limitAt(route, limits, Math.min(route.total, route.cum[i] + 100));
        if (!later || later.mph <= base - 3) return { d: route.cum[i], mph: s.mph };
      }
    }
    return null;
  }

  function nextSlowManeuver(route, d, range) {
    for (const m of route.maneuvers) {
      if (m.d > d + 5 && m.d <= d + range && m.slow != null) return m;
      if (m.d > d + range) break;
    }
    return null;
  }

  /** Meters needed to coast from v1 to v2 (mph). */
  function coastDistance(v1, v2) {
    const a = v1 / MPS_TO_MPH, b = v2 / MPS_TO_MPH;
    if (a <= b) return 0;
    return clamp((a * a - b * b) / (2 * COAST_DECEL), 60, 700);
  }

  // ---------------------------------------------------------------- formatting

  function fmtDist(m) {
    if (m < 160) return Math.max(50, Math.round(m * FT_PER_M / 50) * 50) + ' ft';
    const mi = m / M_PER_MI;
    return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }
  function fmtGrade(g) { return Math.abs(g).toFixed(Math.abs(g) < 10 ? 1 : 0) + '%'; }

  // ---------------------------------------------------------------- suggestion

  /**
   * ctx: {route, profile, limits, d, speed (mph), settings:{band, eco, fallback},
   *       override (mph|null), prevMode}
   * Returns {target, base, src, mode, msg, ahead, cue, holdBelow, gNow}
   *   holdBelow: true when being under the target is fine (don't say "speed up").
   */
  function suggest(ctx) {
    const route = ctx.route, prof = ctx.profile, d = ctx.d;
    const speed = Math.max(0, ctx.speed || 0);
    const S = Object.assign({ band: 5, eco: 0, fallback: 45 }, ctx.settings || {});
    const lim = limitAt(route, ctx.limits, d);
    let base, src;
    if (ctx.override != null) { base = ctx.override; src = 'manual'; }
    else if (lim) { base = lim.mph; src = lim.src; }
    else { base = S.fallback; src = 'default'; }
    const cruise = Math.max(5, base - S.eco);
    const out = { target: cruise, base, src, mode: 'cruise', msg: '', ahead: '', cue: null, holdBelow: false, gNow: 0, slowAhead: [], dist: null };

    const remaining = route.total - d;
    if (remaining < 40) {
      return Object.assign(out, { mode: 'arrived', target: 0, msg: 'You have arrived', cue: 'You have arrived.', holdBelow: true });
    }

    const prev = ctx.prevMode;
    const gNow = gradeAvg(prof, d - 60, d + 90);
    out.gNow = gNow;
    const climbing = gNow >= (prev === 'climb' || prev === 'crest' ? CLIMB_OUT : CLIMB_IN);
    const descending = !climbing && gNow <= (prev === 'descent' || prev === 'momentum' ? DESC_OUT : DESC_IN);
    const scan = scanAhead(prof, d, climbing);

    // "Ahead" line: the next notable thing.
    if (scan.climb && scan.climb.at > 50) {
      out.ahead = 'Hill in ' + fmtDist(scan.climb.at) + ' · ' + fmtGrade(scan.climb.grade) + ' for ' + fmtDist(scan.climb.len);
    } else if (scan.descent && scan.descent.at > 50) {
      out.ahead = 'Downhill in ' + fmtDist(scan.descent.at) + ' · ' + fmtGrade(scan.descent.grade);
    } else if (!prof || prof.flat) {
      out.ahead = 'No hill data for this route';
    } else {
      out.ahead = 'No big hills in the next ' + fmtDist(Math.min(1200, remaining));
    }

    // 1) Things you must slow for: a turn or a lower limit, cued ~100 m out.
    //    Everything within 900 m is also listed in slowAhead so the step speed can
    //    avoid building speed you'd just have to brake away.
    const cands = [];
    out.slowAhead = [];
    const man = nextSlowManeuver(route, d, 900);
    if (man) {
      const dist = man.d - d, mph = Math.min(man.slow, base);
      out.slowAhead.push({ dist, mph });
      if (dist <= SLOW_CUE_M) {
        const what = man.type === 'arrive' ? 'Arriving' :
          (man.type === 'roundabout' || man.type === 'rotary') ? 'Roundabout ahead' : 'Turn ahead';
        cands.push({ mode: man.type === 'arrive' ? 'arriving' : 'turn', target: mph, dist, msg: what + ' — slow to ' + mph, cue: null });
      }
    }
    if (ctx.override == null) {
      const drop = nextLowerLimit(route, ctx.limits, d, base, 800);
      if (drop) {
        out.slowAhead.push({ dist: drop.d - d, mph: drop.mph });
        if (prev === 'slowdown' || drop.d - d <= SLOW_CUE_M) {
          cands.push({ mode: 'slowdown', target: drop.mph, dist: drop.d - d, msg: 'Limit ' + drop.mph + ' in ' + fmtDist(drop.d - d) + ' — slow down', cue: 'Speed limit ' + drop.mph + ' ahead.' });
        }
      }
    }
    if (cands.length) {
      cands.sort((a, b) => a.target - b.target);
      return Object.assign(out, cands[0], { holdBelow: true });
    }

    // 2) Hills.
    if (climbing) {
      const wasCrest = prev === 'crest';
      if (scan.crest && (scan.crest.rollsOver || wasCrest) && scan.crest.at <= (wasCrest ? 300 : 200)) {
        return Object.assign(out, {
          mode: 'crest', target: Math.max(5, cruise - S.band), holdBelow: true,
          msg: 'Near the top — ease off and let it roll over', cue: 'Near the top. Ease off.'
        });
      }
      const sag = clamp(Math.round(0.8 * (gNow - 1)), 1, S.band);
      const t = Math.max(5, cruise - sag);
      return Object.assign(out, {
        mode: 'climb', target: t, holdBelow: true,
        msg: 'Climbing ' + fmtGrade(gNow) + ' — steady throttle, let it drop to ' + t,
        cue: 'Climbing. Steady throttle.'
      });
    }
    if (descending) {
      if (scan.climb && scan.climb.at <= 400) {
        return Object.assign(out, {
          mode: 'momentum', target: base,
          msg: 'Carry your speed into the next climb', cue: 'Carry your speed into the next hill.'
        });
      }
      return Object.assign(out, {
        mode: 'descent', target: base,
        msg: 'Downhill ' + fmtGrade(gNow) + ' — off the gas, let it roll to ' + base,
        cue: 'Downhill. Off the gas.'
      });
    }
    if (scan.climb && scan.climb.at <= 500 && scan.climb.len >= 150) {
      return Object.assign(out, {
        mode: 'preclimb', target: base,
        msg: (scan.climb.at < 60 ? 'Hill starting' : 'Hill in ' + fmtDist(scan.climb.at)) + ' — build to ' + base + ' now',
        cue: 'Hill ahead. Build to ' + base + '.'
      });
    }
    if (scan.descent && scan.descent.at <= 300) {
      return Object.assign(out, {
        mode: 'predescent', target: Math.max(5, cruise - Math.ceil(S.band / 2)), holdBelow: true,
        msg: 'Downhill ahead — ease off early', cue: 'Downhill ahead. Ease off.'
      });
    }
    out.msg = speed < 5 ? 'Ease up gently to ' + cruise : 'Hold a steady speed';
    return out;
  }

  /** 'on' (green), 'over' (ease off), 'under' (speed up) or 'hold' (fine, don't chase it). */
  function speedState(speed, s) {
    const diff = speed - s.target;
    if (s.mode === 'arrived') return 'on';
    if (Math.abs(diff) <= 2) return 'on';
    if (diff > 2) return 'over';
    if (s.mode === 'climb' || s.mode === 'crest') return diff >= -6 ? 'hold' : 'under';
    if (s.holdBelow) return 'on';
    return 'under';
  }

  /**
   * The small "next 4 seconds" speed: where to be STEP_SECS from now.
   * Going up, it ramps gently (slower on climbs) and never builds speed you'd have to
   * brake away for a turn or lower limit ahead. Going down, it counts toward the goal,
   * faster when a turn or limit is close. Returns {mph, dir:'up'|'down'} or null at the goal.
   * accelLimit: the "too fast" threshold in mph per second.
   */
  function stepSpeed(s, speed, accelLimit) {
    if (!s || s.mode === 'arrived') return null;
    speed = Math.max(0, speed || 0);
    const goal = s.target;
    const vMs = speed / MPS_TO_MPH;
    // Highest speed worth having now, given slow points ahead.
    let cap = Infinity;
    for (const c of (s.slowAhead || [])) {
      const vt = c.mph / MPS_TO_MPH;
      cap = Math.min(cap, Math.sqrt(vt * vt + 2 * EASY_DECEL * Math.max(0, c.dist)) * MPS_TO_MPH);
    }
    const ceiling = Math.max(Math.min(goal, cap), Math.min(goal, 5));
    if (speed < ceiling - 2) {
      const hill = s.mode === 'climb' || s.mode === 'crest';
      if (hill && speed >= goal - 6) return null;          // a little sag on a climb is the plan
      if (!hill && s.holdBelow) return null;               // slowing for a turn/limit/downhill: under is fine
      const g = Math.max(0, s.gNow || 0);
      const rate = Math.max(0.75, (accelLimit || 3) * 0.8 - 0.3 * g);   // mph per second
      return { mph: Math.round(Math.min(ceiling, speed + rate * STEP_SECS)), dir: 'up' };
    }
    if (speed > ceiling + 2) {
      let rate = COAST_DECEL * MPS_TO_MPH;                               // ~1.2 mph per second
      if (s.dist != null && s.dist > 1) {
        const vt = goal / MPS_TO_MPH;
        rate = Math.max(rate, (vMs * vMs - vt * vt) / (2 * s.dist) * MPS_TO_MPH);
      }
      return { mph: Math.round(Math.max(ceiling, speed - rate * STEP_SECS)), dir: 'down' };
    }
    return null;
  }

  /** Acceleration (mph per second) from recent [{t: seconds, v: mph}] samples; null if too few. */
  function accelFrom(samples) {
    if (!samples || samples.length < 3) return null;
    const t0 = samples[0].t, span = samples[samples.length - 1].t - t0;
    if (span < 1.5) return null;
    let n = 0, st = 0, sv = 0, stt = 0, stv = 0;
    for (const p of samples) { const t = p.t - t0; n++; st += t; sv += p.v; stt += t * t; stv += t * p.v; }
    const den = n * stt - st * st;
    return den > 0 ? (n * stv - st * sv) / den : null;
  }

  const api = {
    MPS_TO_MPH, M_PER_MI, FT_PER_M, EST_LIMITS,
    haversine, buildRoute, snap, segIndexAt, pointAt, sampleRoute, sampleStepFor,
    buildProfile, flatProfile, elevAt, gradeAvg, scanAhead,
    parseMaxspeed, buildLimits, limitAt, nextLowerLimit, nextSlowManeuver, coastDistance,
    slowSpeedFor, fmtDist, fmtGrade, suggest, speedState, stepSpeed, accelFrom,
    SLOW_CUE_M, STEP_SECS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpeedCore = api;
})(typeof self !== 'undefined' ? self : this);

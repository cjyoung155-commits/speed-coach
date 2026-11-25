// Synthetic 10 km road heading north from near Denver, shaped like real API responses.
//   0–2000 m flat · 2000–3000 climb 5% · 3000–3100 top · 3100–4100 downhill 4%
//   4100–10000 flat · limit 55 mph (posted) until 6000 m, then residential (est. 25)
//   right turn at 7000 m · arrive at 10000 m
const START = [39.70, -105.00];
const M_PER_DEG_LAT = 111194.9;
const SPACING = 20;

function elevAtDist(d) {
  if (d < 2000) return 1600;
  if (d < 3000) return 1600 + (d - 2000) * 0.05;
  if (d < 3100) return 1650;
  if (d < 4100) return 1650 - (d - 3100) * 0.04;
  return 1610;
}

function makeFixture() {
  const n = 10000 / SPACING + 1;
  const coords = [], nodes = [];
  for (let i = 0; i < n; i++) {
    coords.push([START[1], START[0] + (i * SPACING) / M_PER_DEG_LAT]);   // [lon, lat]
    nodes.push(1000 + i);
  }
  const iDrop = 6000 / SPACING, iTurn = 7000 / SPACING;
  const osrm = {
    code: 'Ok',
    routes: [{
      distance: 10000, duration: 720,
      geometry: { type: 'LineString', coordinates: coords },
      legs: [{
        annotation: { nodes },
        steps: [
          { name: 'Test Hwy', maneuver: { type: 'depart', location: coords[0] } },
          { name: 'Elm St', maneuver: { type: 'turn', modifier: 'right', location: coords[iTurn] } },
          { name: '', maneuver: { type: 'arrive', location: coords[n - 1] } }
        ]
      }]
    }]
  };
  const overpass = {
    elements: [
      { type: 'way', id: 1, nodes: nodes.slice(0, iDrop + 1), tags: { highway: 'primary', maxspeed: '55 mph' } },
      { type: 'way', id: 2, nodes: nodes.slice(iDrop).reverse(), tags: { highway: 'residential' } },
      // traffic lights at 1500 m and 8000 m (the 8000 m one is mapped on both sides of the intersection)
      { type: 'node', id: 1000 + 1500 / SPACING, tags: { highway: 'traffic_signals' } },
      { type: 'node', id: 1000 + 8000 / SPACING, tags: { highway: 'traffic_signals' } },
      { type: 'node', id: 1000 + 8020 / SPACING, tags: { highway: 'traffic_signals' } }
    ]
  };
  const elevAtPoint = p => elevAtDist((p[0] - START[0]) * M_PER_DEG_LAT);

  /** The same road as OSRM returns it with via points: legs split at the given coordinate indexes. */
  function multiLeg(cuts) {
    const idx = [0].concat(cuts, [n - 1]);
    const legs = [];
    for (let k = 0; k < idx.length - 1; k++) {
      const a = idx[k], b = idx[k + 1], last = k === idx.length - 2;
      const steps = [{ name: '', maneuver: { type: 'depart', location: coords[a] } }];
      if (iTurn > a && iTurn < b) steps.push({ name: 'Elm St', maneuver: { type: 'turn', modifier: 'right', location: coords[iTurn] } });
      steps.push({ name: '', maneuver: { type: 'arrive', location: coords[b] } });
      legs.push({ annotation: { nodes: nodes.slice(a, b + 1) }, steps });
    }
    return { code: 'Ok', routes: [{ distance: 10000, duration: 720, geometry: { type: 'LineString', coordinates: coords }, legs }] };
  }
  return { osrm, overpass, multiLeg, elevAtPoint, elevAtDist, START, M_PER_DEG_LAT, coords, nodes };
}

/** Route B: same first 3 km as the fixture road, then a parallel road 400 m east, rejoining at the end. */
function routeBPoints(C, routeA) {
  const START = [39.70, -105.00];
  const lonOff = 400 / (111320 * Math.cos(39.7 * Math.PI / 180));
  const pts = [];
  for (let dd = 0; dd <= 3000; dd += 20) pts.push(C.pointAt(routeA, dd));
  const p3 = C.pointAt(routeA, 3000);
  for (let k = 1; k <= 10; k++) pts.push([p3[0] + k * 20 / 111194.9, p3[1] + lonOff * k / 10]);
  const east = pts[pts.length - 1][1];
  for (let dd = 3220; dd <= 9800; dd += 20) pts.push([START[0] + dd / 111194.9, east]);
  const endA = C.pointAt(routeA, routeA.total);
  const last = pts[pts.length - 1];
  for (let k = 1; k <= 10; k++) pts.push([last[0] + (endA[0] - last[0]) * k / 10, east - lonOff * k / 10]);
  return pts;
}

module.exports = { makeFixture, routeBPoints };

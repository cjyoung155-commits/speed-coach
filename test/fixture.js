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
      { type: 'way', id: 2, nodes: nodes.slice(iDrop).reverse(), tags: { highway: 'residential' } }
    ]
  };
  const elevAtPoint = p => elevAtDist((p[0] - START[0]) * M_PER_DEG_LAT);
  return { osrm, overpass, elevAtPoint, elevAtDist, START, M_PER_DEG_LAT };
}

module.exports = { makeFixture };

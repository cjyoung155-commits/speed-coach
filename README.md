# Speed Coach

A phone web app that reads the hills and speed limits on your route and shows the speed that saves gas. The suggested speed is shown big and turns green when you're on it.

## Using it on an iPhone

1. Open the app's GitHub Pages link in Safari.
2. Tap **Share**, then **Add to Home Screen**. From then on it opens like a normal app.
3. Type a destination, pick it, and check the route card. It shows distance, total climb, steepest grade, and how much of the route has posted speed limits.
4. Tap **Test drive (simulated)** to watch it work without moving, or **Start drive** to use it for real. Put the phone in a dash mount; the screen stays on while the drive screen is open.

## What it tells you

| Situation | Suggestion |
|---|---|
| Flat road | Hold the limit (or a few mph under, if you set that in Settings) |
| Hill coming within ~0.3 mi | Build up to the limit now, so momentum does some of the climbing |
| Climbing | Steady throttle and let the speed sag a few mph. Don't chase it |
| Near the top | Ease off early and let the truck roll over the crest |
| Downhill | Off the gas and let it roll up to the limit |
| Lower limit or a turn ahead | Coast down early instead of braking late |

The colors mean: **green** = on target, **white** = speed up gently, **amber** = ease off.

The speed-limit sign shows where the limit came from: **posted** (mapped from a real sign), **est. from road type** (a guess based on the kind of road), or **unknown** (your setting). Tap **−5 / +5** to correct it. Your correction sticks until the road changes.

## Where the data comes from

All of these are free and need no account or key:

- Destination search: [Nominatim](https://nominatim.org) (OpenStreetMap)
- Route: [OSRM](https://project-osrm.org) public server, with the OpenStreetMap routing server as a backup
- Speed limits: OpenStreetMap `maxspeed` tags via the [Overpass API](https://overpass-api.de)
- Elevation: Copernicus DEM GLO-90 via [Open-Meteo](https://open-meteo.com)

Map data © OpenStreetMap contributors.

## Limits

- Suggestions only. Always follow posted signs and traffic.
- OpenStreetMap is missing speed limits on many roads, and some mapped limits are wrong.
- The elevation data has a 90 m grid, so short dips and bridges are smoothed out.
- It needs signal to load a route. It doesn't run in the background, so keep it on screen.

## Files

- `core.js`: the logic for routes, hills, speed limits, and the suggested speed (no UI)
- `app.js`: the screens, GPS, voice cues, and the test-drive simulator
- `index.html`, `style.css`, `manifest.webmanifest`, `icons/`: the page and the home-screen install files
- `test/`: `node test/core.test.js` (logic) and `node test/ui.test.mjs` (full app in headless Chrome with the services faked)

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
| Lower limit or a turn ahead | Slow down starting about 100 m (330 ft) before it |

The colors mean: **green** = on target, **white** = speed up gently, **amber** = ease off.

**The small number under the goal** is where to be 4 seconds from now. It steps up gently toward the goal, in smaller steps on climbs, and it won't build speed you'd just brake away for a turn or lower limit ahead. When you need to slow down, it counts down instead. It hides when you're at the goal.

**Your current speed (top right) turns red** with "easy on the gas" when you accelerate harder than about 3 mph per second (0–40 in ~15 sec). You can change that in Settings → Acceleration warning.

The speed-limit sign shows where the limit came from: **posted** (mapped from a real sign), **est. from road type** (a guess based on the kind of road), or **unknown** (your setting). Tap **−5 / +5** to correct it. Your correction sticks until the road changes.

## My routes: which way has the least time at lights

1. Tap **Record a new route**, drive the way you normally go, then tap **Stop & save**. Give the route a name (like "Via Bangerter") and say where it goes (like "Work"). Routes with the same destination are compared against each other.
2. Every time you drive a saved route, Speed Coach logs your stops at lights: where, what time and day, and how long you waited. It does this automatically at lights on the map. If it doesn't know about a light, a **Stopped at a light? Tap to log it** button appears while you're stopped, and it remembers that light for next time.
3. For each destination, My routes picks the route with the **least expected time stopped at lights** for the current time of day and kind of day (weekday or weekend), like "Use Via East — about 30 sec less at lights around 7:32 AM."
4. While you drive, before your routes split, it checks again using when you'll actually reach the split. If another route looks 15+ seconds better, a green tip says so. If you take the other route, it switches to that one without rerouting.

It needs about 8 trips per route at similar times before the picks mean much. Until then, it says "still learning," and about 1 day in 4 it suggests the route it knows least about.

Your routes and trips are stored on your phone only. Use **Settings → Back up** now and then to keep a copy.

The **light ahead** cue ("Light in 400 ft — be ready to coast") comes from traffic lights on OpenStreetMap. It doesn't know what color the light is.

## Where the data comes from

All of these are free and need no account or key:

- Destination search: [Nominatim](https://nominatim.org) (OpenStreetMap)
- Route: [OSRM](https://project-osrm.org) public server, with the OpenStreetMap routing server as a backup
- Speed limits and traffic lights: OpenStreetMap `maxspeed` and `traffic_signals` tags via the [Overpass API](https://overpass-api.de)
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

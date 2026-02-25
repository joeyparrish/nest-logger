# Nest Temperature Logger

## Goal

Log historical temperature readings from all Nest room sensors and graph them
over time.  Each sensor appears as its own line on a time-series chart.
Thermostat HVAC state (heat / cool / idle) is shown as a background shading on
the same chart.

---

## Architecture

```
Chrome extension (home.nest.com tab)
  scraper.js          — content script, scrapes the DOM every 5 min
  background.js       — service worker, receives readings and POSTs to server

Express server (local network, http://127.0.0.1:51920)
  server.js           — serves the chart page and /api/readings endpoint
  db.js               — shared better-sqlite3 connection (WAL mode)
  nest.db             — SQLite database
  public/index.html   — Plotly.js chart frontend
  start.sh            — wrapper script that loads nvm and starts server.js
  nest-logger.service — template systemd user service (copy to ~/.config/systemd/user/)

Utilities
  seed.js             — one-shot dummy data seeder for development
```

---

## Key Design Decisions

### DOM scraping, not network interception

An earlier version of the extension wrapped `window.fetch` and
`XMLHttpRequest` (in the MAIN world) to intercept the Nest app's own
`app_launch` API calls.  This was abandoned because:

- The web app doesn't request the `shared`/`device` bucket types, so
  thermostat data was always absent from intercepted readings.
- Auth credential extraction was fragile (userId not in headers, only in URL).
- The DOM approach is simpler, more robust, and produces exactly the data
  visible to the user.

### Background service worker for outbound HTTP

Fetch calls from content scripts are subject to the Nest page's
`Content-Security-Policy`, which blocks requests to non-Nest origins.
The background service worker runs outside the page context and is not
bound by CSP.  The content script sends readings to the service worker via
`chrome.runtime.sendMessage`; the service worker POSTs to the local server.
`http://127.0.0.1:51920/*` must be in `host_permissions` in manifest.json.

Note: `host_permissions` for 127.0.0.1 does NOT cause the extension to inject
into or interact with pages on that host — content script injection is
controlled solely by `content_scripts[].matches`.

### Plotly.js for charting

Chosen over Grafana+InfluxDB because the HVAC background shading requirement
(semi-transparent coloured time-range bands overlaid on the temperature lines)
maps directly to Plotly's `layout.shapes` API.  Grafana's time-series panel
only supports horizontal threshold bands, not arbitrary time-range fills.
`scattergl` (WebGL) traces handle year-scale datasets without performance issues.

### Timestamp handling

DB timestamps are UTC ISO strings (e.g. `"2026-02-23T18:00:00.000Z"`).  On
the client, they are immediately converted to `Date` objects so Plotly renders
them in the user's local timezone.

`toUtcMs(s)` handles two cases:
- `Date` object (from the DB mapping) → `.getTime()`
- string (from Plotly's zoom/pan `relayout` event) → `new Date(s).getTime()`

Plotly emits range strings as local wall-clock time with no timezone suffix
(e.g. `"2026-02-20 15:58:09"`), which `new Date()` correctly interprets as
local time — matching the `Date` objects already in the `timestamps` array.

### better-sqlite3

Synchronous SQLite driver — no callback or Promise overhead, much simpler
code than the async `sqlite3` package.  WAL journal mode is set so reads
(chart page fetches) and writes (extension POSTs) can proceed concurrently.

### Schema

```sql
sensor_readings (timestamp, section, sensor, value)
  -- one row per data point
  -- section: "TEMPERATURE SENSORS", "INSIDE HUMIDITY", "OUTSIDE TEMP.", etc.
  -- PRIMARY KEY (timestamp, section, sensor)

hvac_states (timestamp, action)
  -- action: 'heat' | 'cool' | 'idle'
  -- one row per poll cycle
```

Schema is defined **only in db.js** (`db.exec` runs on first import).
Any script that imports `db.js` gets a fully initialized database, so there
is no required startup order between server.js and seed.js.

The `OUTSIDE TEMP.` section is stored as-is in the DB (with whatever sensor
name Nest uses internally), but the `/api/readings` response renames it to
`"Weather"` to distinguish it from a physical outside sensor in the
`TEMPERATURE SENSORS` section.  The rename happens in `queryReadings()` in
`server.js`, not in the scraper or the DB.

### Frontend auto-refresh

The chart page refreshes data from the server automatically without a page
reload, using `Plotly.react` to update traces and HVAC shapes while preserving
the user's current zoom state.

Refresh timing is computed from the age of the latest data point, targeting
1 second after the next expected collection cycle — so the browser stays
roughly in sync with the extension's 5-minute poll without drifting over time.

On fetch failure, exponential backoff is used: 1 s → 2 s → 4 s → … up to
`REFRESH_INTERVAL_MS` (5 min). Resets to 1 s on the next success.

A "last reading: X min ago" indicator updates every 60 seconds independently
of the data refresh, so the displayed age stays current between refreshes.

Note: Plotly's `plotly_relayout` event fires with different key shapes
depending on how the user zooms:
- Click-drag or range-selector buttons → `ev['xaxis.range[0]']` / `ev['xaxis.range[1]']`
- Rangeslider handle drag → `ev['xaxis.range']` (array)

Both cases are handled explicitly in the relayout listener.

### Seed / dummy data

`seed.js` generates 3 days of synthetic 5-minute readings (sinusoidal diurnal
cycle + mean-reverting random walk) and inserts them with `INSERT OR IGNORE`.
It is a standalone dev utility and is never called by the server.  Delete
`nest.db` and re-run `seed.js` for a fresh dataset.

---

## Running Locally

```bash
cd server
npm install        # first time only
npm start          # starts server on port 51920

node seed.js       # optional: populate DB with dummy data
```

Chart: http://localhost:51920

## Running as a systemd User Service (start on boot)

```bash
cp server/nest-logger.service ~/.config/systemd/user/
# Edit ExecStart in the copied file to the actual path of start.sh
loginctl enable-linger $USER          # start user session at boot (once ever)
systemctl --user daemon-reload
systemctl --user enable --now nest-logger
```

Useful commands:

```bash
systemctl --user status nest-logger
journalctl --user -u nest-logger -f   # live logs
systemctl --user restart nest-logger
```

---

## Extension

```
extension/
  manifest.json     — MV3, host_permissions: home.nest.com + 127.0.0.1:51920
  scraper.js        — content script (document_idle), scrapes carousel DOM
  background.js     — service worker, receives NEST_READING messages, POSTs to server
```

**To install:** `chrome://extensions` → Load unpacked → select `extension/`

The scraper navigates to a `/thermostat/DEVICE_*` URL if not already there,
then waits for `[data-test="thermozilla-aag-carousel-container"]` to appear,
scrapes section headers and sensor rows, and polls every 5 minutes.

HVAC state is read from `.cards .card.type-thermostat` — the presence of
`thermostat-heating` or `thermostat-cooling` in the class list determines the
state; otherwise it defaults to `'idle'`.

Message payload sent to background service worker:

```json
{
  "type": "NEST_READING",
  "timestamp": "2026-02-23T18:00:00.000Z",
  "hvac_action": "heat",
  "data": {
    "TEMPERATURE SENSORS": { "Basement": 80, "Kitchen": 69 },
    "INSIDE HUMIDITY":     { "Entryway": 40 },
    "OUTSIDE TEMP.":       { "Doreen": 47 }
  }
}
```

---

## Pending Work

- [ ] Consider downsampling for the `/api/readings` query as the dataset grows
      (e.g. return one reading per 30 min when the time range exceeds 2 weeks)

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

Express server (local network, http://10.0.0.2:51920)
  server.js           — serves the chart page and /api/readings endpoint
  db.js               — shared better-sqlite3 connection (WAL mode)
  nest.db             — SQLite database
  public/index.html   — Plotly.js chart frontend

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
`http://10.0.0.2/*` must be in `host_permissions` in manifest.json.

Note: `host_permissions` for 10.0.0.2 does NOT cause the extension to inject
into or interact with pages on that host — content script injection is
controlled solely by `content_scripts[].matches`.

### Plotly.js for charting

Chosen over Grafana+InfluxDB because the HVAC background shading requirement
(semi-transparent coloured time-range bands overlaid on the temperature lines)
maps directly to Plotly's `layout.shapes` API.  Grafana's time-series panel
only supports horizontal threshold bands, not arbitrary time-range fills.
`scattergl` (WebGL) traces handle year-scale datasets without performance issues.

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

node seed.js       # optional: populate DB with dummy data (run after server at least once)
```

Chart: http://localhost:51920

---

## Extension

```
extension/
  manifest.json     — MV3, host_permissions: home.nest.com + 10.0.0.2
  scraper.js        — content script (document_idle), scrapes carousel DOM
  background.js     — service worker, receives NEST_READING messages, POSTs to server
```

**To install:** `chrome://extensions` → Load unpacked → select `extension/`

The scraper navigates to a `/thermostat/DEVICE_*` URL if not already there,
then waits for `[data-test="thermozilla-aag-carousel-container"]` to appear,
scrapes section headers and sensor rows, and polls every 5 minutes.

Scraped data shape:

```json
{
  "TEMPERATURE SENSORS": { "Basement": 80, "Kitchen": 69 },
  "INSIDE HUMIDITY":     { "Entryway": 40 },
  "OUTSIDE TEMP.":       { "Doreen": 47 }
}
```

---

## Pending Work

- [ ] Add `POST /api/readings` ingest endpoint to server.js
- [ ] Update background.js to POST real scraped readings to the server
      instead of the current dummy GET to http://10.0.0.2/
- [ ] Decide on HVAC state source: scrape from DOM or derive from thermostat
      temperature thresholds in the server
- [ ] Consider downsampling for the `/api/readings` query as the dataset grows
      (e.g. return one reading per 30 min when the time range exceeds 2 weeks)

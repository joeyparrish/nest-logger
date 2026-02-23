const express = require('express');
const path    = require('path');
const db      = require('./db');

const app  = express();
const PORT = 51920;  // E = 5, S = 19, T = 20

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Ingest ────────────────────────────────────────────────────────────────────

const insertReading = db.prepare(`
  INSERT OR IGNORE INTO sensor_readings (timestamp, section, sensor, value)
  VALUES (?, ?, ?, ?)
`);

app.post('/api/readings', (req, res) => {
  const { timestamp, data } = req.body;

  if (!timestamp || typeof data !== 'object') {
    return res.status(400).json({ error: 'Body must include timestamp and data.' });
  }

  let count = 0;
  db.transaction(() => {
    for (const [section, sensors] of Object.entries(data)) {
      for (const [sensor, value] of Object.entries(sensors)) {
        insertReading.run(timestamp, section, sensor, value);
        count++;
      }
    }
  })();

  console.log(`[POST /api/readings] ${timestamp} — inserted ${count} value(s).`);
  res.json({ ok: true, inserted: count });
});

// ── Query ─────────────────────────────────────────────────────────────────────

function queryReadings() {
  // Sensors, in the order their names first appear by timestamp so the chart
  // legend is stable across page loads.
  const sensors = db.prepare(`
    SELECT sensor
    FROM sensor_readings
    WHERE section = 'TEMPERATURE SENSORS'
    GROUP BY sensor
    ORDER BY MIN(timestamp), sensor
  `).pluck().all();

  // All distinct timestamps in chronological order.
  const timestamps = db.prepare(`
    SELECT DISTINCT timestamp FROM sensor_readings ORDER BY timestamp
  `).pluck().all();

  // All temperature readings in one query, then pivot in JS.
  const rows = db.prepare(`
    SELECT timestamp, sensor, value
    FROM sensor_readings
    WHERE section = 'TEMPERATURE SENSORS'
    ORDER BY timestamp
  `).all();

  // Build a per-timestamp lookup for fast pivoting.
  const byTs = new Map(timestamps.map(ts => [ts, {}]));
  for (const row of rows) byTs.get(row.timestamp)[row.sensor] = row.value;

  // Produce the columnar format the frontend expects.
  const readings = {};
  for (const s of sensors) {
    readings[s] = timestamps.map(ts => byTs.get(ts)?.[s] ?? null);
  }

  // HVAC states aligned to the same timestamp array.
  const hvacRows  = db.prepare(
    'SELECT timestamp, action FROM hvac_states ORDER BY timestamp'
  ).all();
  const hvacByTs  = new Map(hvacRows.map(r => [r.timestamp, r.action]));
  const hvac_actions = timestamps.map(ts => hvacByTs.get(ts) ?? 'idle');

  return { sensors, timestamps, readings, hvac_actions };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/readings', (req, res) => {
  const data = queryReadings();
  console.log(
    `[/api/readings] ${data.timestamps.length} timestamps, ` +
    `${data.sensors.length} sensors: [${data.sensors.join(', ')}]`
  );
  res.json(data);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Nest Logger server running at http://localhost:${PORT}`);
});

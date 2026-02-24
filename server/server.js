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
  // Sensor names in stable first-seen order.
  const sensors = db.prepare(`
    SELECT sensor
    FROM sensor_readings
    WHERE section = 'TEMPERATURE SENSORS'
    GROUP BY sensor
    ORDER BY MIN(timestamp), sensor
  `).pluck().all();

  // All temperature readings in one pass.
  const dbRows = db.prepare(`
    SELECT timestamp, sensor, value
    FROM sensor_readings
    WHERE section = 'TEMPERATURE SENSORS'
    ORDER BY timestamp
  `).all();

  // HVAC states keyed by timestamp for O(1) lookup.
  const hvacByTs = new Map(
    db.prepare('SELECT timestamp, action FROM hvac_states').all()
      .map(r => [r.timestamp, r.action])
  );

  // Build one snapshot object per timestamp.  Each snapshot embeds its own
  // hvac_action so there is no separate parallel array that could fall out of
  // alignment with the timestamp list.
  const snapshotMap = new Map();
  for (const { timestamp, sensor, value } of dbRows) {
    if (!snapshotMap.has(timestamp)) {
      snapshotMap.set(timestamp, {
        timestamp,
        sensors:     {},
        hvac_action: hvacByTs.get(timestamp) ?? 'idle',
      });
    }
    snapshotMap.get(timestamp).sensors[sensor] = value;
  }

  // Sort snapshots chronologically, then carry the last known HVAC state
  // forward into any gap.  Only falls back to 'idle' if no prior state exists
  // (i.e. the very first reading has no hvac_states entry).
  const rows = [...snapshotMap.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  let lastKnownAction = 'idle';
  for (const row of rows) {
    if (hvacByTs.has(row.timestamp)) {
      lastKnownAction = row.hvac_action;
    } else {
      row.hvac_action = lastKnownAction;
    }
  }

  return { sensors, rows };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/readings', (req, res) => {
  const data = queryReadings();
  console.log(
    `[/api/readings] ${data.rows.length} snapshots, ` +
    `${data.sensors.length} sensors: [${data.sensors.join(', ')}]`
  );
  res.json(data);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Nest Logger server running at http://localhost:${PORT}`);
});

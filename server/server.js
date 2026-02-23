const express  = require('express');
const path     = require('path');
const Database = require('better-sqlite3');

const app  = express();
const PORT = 51920;  // E = 5, S = 19, T = 20

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'nest.db'));

// Write-ahead logging gives much better write throughput when the extension
// starts posting readings while the chart is being served simultaneously.
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    timestamp  TEXT NOT NULL,
    section    TEXT NOT NULL,
    sensor     TEXT NOT NULL,
    value      REAL NOT NULL,
    PRIMARY KEY (timestamp, section, sensor)
  );

  CREATE TABLE IF NOT EXISTS hvac_states (
    timestamp  TEXT PRIMARY KEY,
    action     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sr_timestamp ON sensor_readings(timestamp);
`);

// ── Dummy data ────────────────────────────────────────────────────────────────
//
// Used only to seed an empty database.  Once real readings are flowing in from
// the extension this function (and the seed call below) can be removed.

function generateDummyData() {
  const SENSOR_NAMES = [
    'Entryway Thermostat',
    'Master Bedroom',
    'Kitchen',
    'Basement',
    'Outside',
  ];

  // base: mid-point temperature (°F)
  // amp:  diurnal swing amplitude (°F)
  // phase: shifts the sine wave — π offsets interior rooms so they're warmest
  //        in the evening (people home, cooking) and coolest before dawn.
  //        Outside peaks around solar noon (phase = -π/2).
  // Thermostat amplitude is wide enough to cross both thresholds (69 / 73 °F)
  // within each day so heat, cool, and idle all appear in the chart.
  const CONFIG = {
    'Entryway Thermostat': { base: 71.0, amp: 3.5, phase: Math.PI * 0.9 },
    'Master Bedroom':      { base: 66.5, amp: 2.2, phase: Math.PI * 1.1 },
    'Kitchen':             { base: 69.0, amp: 2.5, phase: Math.PI * 0.8 },
    'Basement':            { base: 78.0, amp: 1.0, phase: Math.PI       },
    'Outside':             { base: 42.0, amp: 13.0, phase: -Math.PI / 2 },
  };

  const INTERVAL_MS = 5 * 60 * 1000;           // 5 minutes
  const DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  const now         = Date.now();

  const timestamps   = [];
  const readings     = {};
  const hvac_actions = [];
  const drift        = Object.fromEntries(SENSOR_NAMES.map(n => [n, 0]));

  for (const name of SENSOR_NAMES) readings[name] = [];

  for (let t = now - DURATION_MS; t <= now; t += INTERVAL_MS) {
    const dt       = new Date(t);
    const hourFrac = (dt.getUTCHours() * 60 + dt.getUTCMinutes()) / (24 * 60);

    timestamps.push(dt.toISOString());

    for (const name of SENSOR_NAMES) {
      const { base, amp, phase } = CONFIG[name];
      drift[name] += (Math.random() - 0.5) * 0.25;
      drift[name] *= 0.98;
      const val = base + amp * Math.sin(2 * Math.PI * hourFrac + phase)
                + drift[name] + (Math.random() - 0.5) * 0.2;
      readings[name].push(Math.round(val * 10) / 10);
    }

    const thermoTemp = readings['Entryway Thermostat'].at(-1);
    hvac_actions.push(thermoTemp < 69 ? 'heat' : thermoTemp > 73 ? 'cool' : 'idle');
  }

  return { sensors: SENSOR_NAMES, timestamps, readings, hvac_actions };
}

// ── Seed ──────────────────────────────────────────────────────────────────────

function seedDb(data) {
  const insertReading = db.prepare(`
    INSERT OR IGNORE INTO sensor_readings (timestamp, section, sensor, value)
    VALUES (?, ?, ?, ?)
  `);
  const insertHvac = db.prepare(`
    INSERT OR IGNORE INTO hvac_states (timestamp, action)
    VALUES (?, ?)
  `);

  // Wrap everything in a single transaction — inserting 6 000+ rows one by
  // one without a transaction would be extremely slow in SQLite.
  db.transaction(() => {
    for (let i = 0; i < data.timestamps.length; i++) {
      const ts = data.timestamps[i];
      for (const sensor of data.sensors) {
        insertReading.run(ts, 'TEMPERATURE SENSORS', sensor, data.readings[sensor][i]);
      }
      insertHvac.run(ts, data.hvac_actions[i]);
    }
  })();
}

// Seed once if the database has no readings yet.
const existingRows = db.prepare('SELECT COUNT(*) AS n FROM sensor_readings').get().n;
if (existingRows === 0) {
  console.log('[db] Empty database — seeding with dummy data...');
  const dummy = generateDummyData();
  seedDb(dummy);
  console.log(`[db] Seeded ${dummy.timestamps.length} timestamps × ${dummy.sensors.length} sensors.`);
} else {
  console.log(`[db] Database already has ${existingRows} sensor rows — skipping seed.`);
}

// ── Query ─────────────────────────────────────────────────────────────────────

function queryReadings() {
  // Sensors, in the order their names first appear by timestamp so the chart
  // legend is stable across page loads.
  const sensors = db.prepare(`
    SELECT DISTINCT sensor
    FROM sensor_readings
    WHERE section = 'TEMPERATURE SENSORS'
    ORDER BY MIN(timestamp), sensor
    -- MIN(timestamp) in ORDER BY without GROUP BY is a SQLite extension that
    -- gives the first-seen timestamp per sensor, preserving insertion order.
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

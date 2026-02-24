/**
 * seed.js — populate the database with dummy data for development/testing.
 *
 * Run once when you want a fresh set of fake readings:
 *
 *   node seed.js
 *
 * Safe to re-run: INSERT OR IGNORE means existing rows are left untouched.
 * Delete nest.db first if you want a completely clean slate.
 */

const db = require('./db');

// ── Dummy data generator ──────────────────────────────────────────────────────

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

  // 1 year before the creation of this tool, to make removal of seed data
  // easier if someone accidentally runs the seed process after beginning to
  // collect real data.
  const END_DATE = 1740422190840;

  const timestamps   = [];
  const readings     = {};
  const hvac_actions = [];
  const drift        = Object.fromEntries(SENSOR_NAMES.map(n => [n, 0]));

  for (const name of SENSOR_NAMES) readings[name] = [];

  for (let t = END_DATE - DURATION_MS; t <= END_DATE; t += INTERVAL_MS) {
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

// ── Insert ────────────────────────────────────────────────────────────────────

const insertReading = db.prepare(`
  INSERT OR IGNORE INTO sensor_readings (timestamp, section, sensor, value)
  VALUES (?, ?, ?, ?)
`);
const insertHvac = db.prepare(`
  INSERT OR IGNORE INTO hvac_states (timestamp, action)
  VALUES (?, ?)
`);

const data = generateDummyData();

db.transaction(() => {
  for (let i = 0; i < data.timestamps.length; i++) {
    const ts = data.timestamps[i];
    for (const sensor of data.sensors) {
      insertReading.run(ts, 'TEMPERATURE SENSORS', sensor, data.readings[sensor][i]);
    }
    insertHvac.run(ts, data.hvac_actions[i]);
  }
})();

const hvacCounts = data.hvac_actions.reduce((acc, a) => {
  acc[a] = (acc[a] || 0) + 1;
  return acc;
}, {});

console.log(`Seeded ${data.timestamps.length} timestamps × ${data.sensors.length} sensors.`);
console.log(`HVAC states: heat=${hvacCounts.heat ?? 0}, cool=${hvacCounts.cool ?? 0}, idle=${hvacCounts.idle ?? 0}`);
console.log(`Date range: ${data.timestamps[0]} → ${data.timestamps.at(-1)}`);

db.close();

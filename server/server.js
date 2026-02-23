const express = require('express');
const path    = require('path');

const app  = express();
const PORT = 51920;  // E = 5, S = 19, T = 20

app.use(express.static(path.join(__dirname, 'public')));

// ── Dummy data ────────────────────────────────────────────────────────────────
//
// Generates 3 days of 5-minute readings that look like real sensor data:
//   - Outside temperature follows a diurnal sinusoid (cold at night, warm at noon)
//   - Interior rooms are stable with a gentle opposing cycle
//   - A slow mean-reverting random walk adds realistic drift to each sensor
//   - HVAC state is derived from the thermostat temperature (heat below 69°F,
//     idle above — it's February, so cooling never runs)
//
// Replace this function with a SQLite query once collection is wired up.

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
  const CONFIG = {
    'Entryway Thermostat': { base: 70.5, amp: 1.5, phase: Math.PI * 0.9 },
    'Master Bedroom':      { base: 66.5, amp: 2.2, phase: Math.PI * 1.1 },
    'Kitchen':             { base: 69.0, amp: 2.5, phase: Math.PI * 0.8 },
    'Basement':            { base: 78.0, amp: 1.0, phase: Math.PI       },
    'Outside':             { base: 42.0, amp: 13.0, phase: -Math.PI / 2 },
  };

  const INTERVAL_MS  = 5 * 60 * 1000;          // 5 minutes
  const DURATION_MS  = 3 * 24 * 60 * 60 * 1000; // 3 days
  const now          = Date.now();

  const timestamps   = [];
  const readings     = {};
  const hvac_actions = [];

  // Per-sensor slow random-walk state (mean-reverting).
  const drift = Object.fromEntries(SENSOR_NAMES.map(n => [n, 0]));

  for (const name of SENSOR_NAMES) readings[name] = [];

  for (let t = now - DURATION_MS; t <= now; t += INTERVAL_MS) {
    const dt      = new Date(t);
    const hourFrac = (dt.getUTCHours() * 60 + dt.getUTCMinutes()) / (24 * 60);

    timestamps.push(dt.toISOString());

    for (const name of SENSOR_NAMES) {
      const { base, amp, phase } = CONFIG[name];

      // Slow random walk that decays back toward 0.
      drift[name] += (Math.random() - 0.5) * 0.25;
      drift[name] *= 0.98;

      const diurnal = Math.sin(2 * Math.PI * hourFrac + phase);
      const noise   = (Math.random() - 0.5) * 0.2;
      const val     = base + amp * diurnal + drift[name] + noise;

      readings[name].push(Math.round(val * 10) / 10);
    }

    // Thermostat model: heat below 69°F, idle above.
    const thermoTemp = readings['Entryway Thermostat'].at(-1);
    hvac_actions.push(thermoTemp < 69 ? 'heat' : 'idle');
  }

  return { sensors: SENSOR_NAMES, timestamps, readings, hvac_actions };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/readings', (req, res) => {
  const data = generateDummyData();
  console.log(
    `[/api/readings] Returning ${data.timestamps.length} readings` +
    ` for ${data.sensors.length} sensors.`
  );
  res.json(data);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Nest Logger server running at http://localhost:${PORT}`);
});

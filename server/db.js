/**
 * db.js — shared SQLite connection and schema.
 *
 * Imported by server.js and seed.js.  Whoever imports it first gets a fully
 * initialized database — tables are created on first open, so there is no
 * required startup order between scripts.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'nest.db'));

// WAL mode gives much better concurrent write throughput — important once the
// extension starts posting readings while the chart page is being served.
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

module.exports = db;

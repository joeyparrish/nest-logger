/**
 * nest-logger — db.js — shared SQLite connection and schema.
 * Copyright (C) 2026 Joey Parrish
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

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

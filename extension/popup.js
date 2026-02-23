/**
 * popup.js — runs in the extension popup window.
 *
 * Reads from chrome.storage.local (written by background.js) and renders:
 *   - A summary line (reading count, date range, last capture time)
 *   - The most recent thermostat and sensor readings
 *   - Export CSV and Clear buttons
 *
 * The popup is recreated from scratch every time it opens, so all state is
 * loaded fresh from storage each time.
 */

const PREFIX = "[Nest Logger / popup]";

const metaEl    = document.getElementById("meta");
const contentEl = document.getElementById("content");
const statusEl  = document.getElementById("status");

// ── Load and render ───────────────────────────────────────────────────────────

console.log(PREFIX, "Popup opened. Loading readings from storage...");

chrome.storage.local.get(["readings", "nestCreds"], ({ readings = [], nestCreds }) => {
  console.log(PREFIX, `Loaded ${readings.length} reading(s) from storage.`);

  if (nestCreds) {
    console.log(PREFIX, "Active credentials in storage for userId:", nestCreds.userId,
      "— background polling is active.");
  } else {
    console.warn(PREFIX, "No credentials in storage.",
      "Open home.nest.com to start polling.");
  }

  if (readings.length === 0) {
    metaEl.textContent = nestCreds
      ? "No readings yet — waiting for first poll."
      : "No data. Open home.nest.com to start capturing.";
    contentEl.innerHTML =
      '<div class="no-data">Open home.nest.com to capture the first reading.</div>';
    return;
  }

  const latest = readings[readings.length - 1];
  const oldest = readings[0];

  const pollStatus = nestCreds ? " · polling active" : " · polling stopped (reload Nest page)";
  metaEl.textContent =
    `${readings.length} readings  ·  ` +
    `${fmtDate(oldest.timestamp)} – ${fmtDate(latest.timestamp)}  ·  ` +
    `last: ${new Date(latest.timestamp).toLocaleTimeString()}` +
    pollStatus;

  console.log(PREFIX,
    `Date range: ${oldest.timestamp} → ${latest.timestamp}`,
    `Latest has ${latest.sensors?.length ?? 0} sensor(s), ${latest.thermostats?.length ?? 0} thermostat(s).`
  );

  let html = "";

  // ── Thermostat section ──────────────────────────────────────────────────
  if (latest.thermostats?.length) {
    html += '<div class="section">Thermostat</div>';
    html += "<table><tr><th>Room</th><th>Current</th><th>Target</th><th>HVAC</th></tr>";
    for (const t of latest.thermostats) {
      html += `<tr>
        <td>${esc(t.room)}</td>
        <td>${fmtTemp(t.current_temperature_f, t.current_temperature_c)}</td>
        <td>${t.target_temperature_f != null
              ? fmtTemp(t.target_temperature_f, t.target_temperature_c)
              : "—"}</td>
        <td>${esc(t.hvac_action)}</td>
      </tr>`;
    }
    html += "</table>";
  } else {
    console.warn(PREFIX, "Latest reading has no thermostat data.");
  }

  // ── Sensor section ──────────────────────────────────────────────────────
  if (latest.sensors?.length) {
    html += '<div class="section">Room Sensors</div>';
    html += "<table><tr><th>Room</th><th>Temp</th><th>Battery</th></tr>";
    const sorted = [...latest.sensors].sort((a, b) => a.room.localeCompare(b.room));
    for (const s of sorted) {
      const cls  = s.is_active ? ' class="active"' : "";
      const batt = s.battery_level != null ? `${Math.round(s.battery_level)}%` : "—";
      html += `<tr${cls}>
        <td>${esc(s.room)}${s.is_active ? " ★" : ""}</td>
        <td>${fmtTemp(s.temperature_f, s.temperature_c)}</td>
        <td>${batt}</td>
      </tr>`;
    }
    html += "</table>";
  } else {
    console.warn(PREFIX, "Latest reading has no sensor data.");
    html += '<div class="no-data">No room sensors found in latest reading.</div>';
  }

  contentEl.innerHTML = html;
});

// ── Export CSV ────────────────────────────────────────────────────────────────

document.getElementById("exportBtn").addEventListener("click", () => {
  console.log(PREFIX, "Export button clicked.");

  chrome.storage.local.get("readings", ({ readings = [] }) => {
    if (readings.length === 0) {
      statusEl.textContent = "No data to export.";
      console.warn(PREFIX, "Export attempted with no data in storage.");
      return;
    }

    console.log(PREFIX, `Exporting ${readings.length} reading(s)...`);

    // One CSV row per sensor or thermostat per reading.
    // All fields in a single table; type column distinguishes sensor vs thermostat.
    const rows = [
      "timestamp,type,serial,room," +
      "temperature_c,temperature_f," +
      "battery_level,is_active," +
      "hvac_action,hvac_mode,humidity",
    ];

    let sensorRows = 0, thermostatRows = 0;

    for (const r of readings) {
      for (const s of r.sensors || []) {
        rows.push([
          r.timestamp, "sensor", s.serial, csvStr(s.room),
          s.temperature_c ?? "", s.temperature_f ?? "",
          s.battery_level ?? "", s.is_active ? 1 : 0,
          "", "", "",
        ].join(","));
        sensorRows++;
      }
      for (const t of r.thermostats || []) {
        rows.push([
          r.timestamp, "thermostat", t.serial, csvStr(t.room),
          t.current_temperature_c ?? "", t.current_temperature_f ?? "",
          "", "",
          t.hvac_action ?? "", t.hvac_mode ?? "", t.humidity ?? "",
        ].join(","));
        thermostatRows++;
      }
    }

    const filename = `nest_readings_${dateSuffix()}.csv`;
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    const msg = `Exported ${readings.length} readings (${sensorRows} sensor rows, ${thermostatRows} thermostat rows) → ${filename}`;
    statusEl.textContent = msg;
    console.log(PREFIX, msg);
  });
});

// ── Clear data ────────────────────────────────────────────────────────────────

document.getElementById("clearBtn").addEventListener("click", () => {
  if (!confirm("Delete all stored readings?")) {
    console.log(PREFIX, "Clear cancelled by user.");
    return;
  }

  console.log(PREFIX, "Clearing all readings from storage.");
  chrome.storage.local.remove("readings", () => {
    statusEl.textContent = "Data cleared.";
    metaEl.textContent   = "No data.";
    contentEl.innerHTML  = '<div class="no-data">Open home.nest.com to start capturing.</div>';
    console.log(PREFIX, "Readings cleared.");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTemp(f, c) {
  if (f == null) return "—";
  return `${f}°F (${c != null ? c.toFixed(1) : "?"}°C)`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString();
}

/** Escape HTML special characters for safe innerHTML insertion. */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;");
}

/** Quote a CSV field if it contains commas, quotes, or newlines. */
function csvStr(s) {
  s = String(s ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function dateSuffix() {
  return new Date().toISOString().slice(0, 10);
}

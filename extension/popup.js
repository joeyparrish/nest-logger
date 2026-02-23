const metaEl = document.getElementById("meta");
const contentEl = document.getElementById("content");
const statusEl = document.getElementById("status");

chrome.storage.local.get("readings", ({ readings = [] }) => {
  if (readings.length === 0) {
    metaEl.textContent = "No data yet.";
    contentEl.innerHTML = '<div class="no-data">Open home.nest.com to start capturing readings.</div>';
    return;
  }

  const latest = readings[readings.length - 1];
  const oldest = readings[0];
  const ts = new Date(latest.timestamp).toLocaleString();
  metaEl.textContent =
    `${readings.length} readings  ·  ` +
    `${fmtDate(oldest.timestamp)} – ${fmtDate(latest.timestamp)}  ·  last: ${ts}`;

  let html = "";

  if (latest.thermostats?.length) {
    html += '<div class="section">Thermostat</div>';
    html += "<table><tr><th>Room</th><th>Current</th><th>Target</th><th>HVAC</th></tr>";
    for (const t of latest.thermostats) {
      html += `<tr>
        <td>${esc(t.room)}</td>
        <td>${fmtTemp(t.current_temperature_f, t.current_temperature_c)}</td>
        <td>${t.target_temperature_f != null ? fmtTemp(t.target_temperature_f, t.target_temperature_c) : "—"}</td>
        <td>${esc(t.hvac_action)}</td>
      </tr>`;
    }
    html += "</table>";
  }

  if (latest.sensors?.length) {
    html += '<div class="section">Room Sensors</div>';
    html += "<table><tr><th>Room</th><th>Temp</th><th>Battery</th></tr>";
    const sorted = [...latest.sensors].sort((a, b) => a.room.localeCompare(b.room));
    for (const s of sorted) {
      const cls = s.is_active ? ' class="active"' : "";
      const batt = s.battery_level != null ? `${Math.round(s.battery_level)}%` : "—";
      html += `<tr${cls}>
        <td>${esc(s.room)}${s.is_active ? " ★" : ""}</td>
        <td>${fmtTemp(s.temperature_f, s.temperature_c)}</td>
        <td>${batt}</td>
      </tr>`;
    }
    html += "</table>";
  }

  contentEl.innerHTML = html;
});

document.getElementById("exportBtn").addEventListener("click", () => {
  chrome.storage.local.get("readings", ({ readings = [] }) => {
    if (readings.length === 0) {
      statusEl.textContent = "No data to export.";
      return;
    }

    const rows = [
      "timestamp,type,serial,room,temperature_c,temperature_f,battery_level,is_active,hvac_action,hvac_mode,humidity",
    ];

    for (const r of readings) {
      for (const s of r.sensors || []) {
        rows.push([
          r.timestamp, "sensor", s.serial, csvStr(s.room),
          s.temperature_c ?? "", s.temperature_f ?? "",
          s.battery_level ?? "", s.is_active ? 1 : 0,
          "", "", "",
        ].join(","));
      }
      for (const t of r.thermostats || []) {
        rows.push([
          r.timestamp, "thermostat", t.serial, csvStr(t.room),
          t.current_temperature_c ?? "", t.current_temperature_f ?? "",
          "", "",
          t.hvac_action ?? "", t.hvac_mode ?? "", t.humidity ?? "",
        ].join(","));
      }
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nest_readings_${dateSuffix()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = `Exported ${readings.length} readings.`;
  });
});

document.getElementById("clearBtn").addEventListener("click", () => {
  if (!confirm("Delete all stored readings?")) return;
  chrome.storage.local.remove("readings", () => {
    statusEl.textContent = "Data cleared.";
    metaEl.textContent = "No data.";
    contentEl.innerHTML = '<div class="no-data">Open home.nest.com to start capturing readings.</div>';
  });
});

// --- helpers ---

function fmtTemp(f, c) {
  if (f == null) return "—";
  return `${f}°F (${c != null ? c.toFixed(1) : "?"}°C)`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString();
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

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

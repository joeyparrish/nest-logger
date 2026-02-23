/**
 * background.js — service worker.
 *
 * Receives the first reading + auth credentials from the page interceptor,
 * then polls app_launch on its own schedule using chrome.alarms.
 *
 * Credential lifetime: the Nest access_token lasts 30 min – a few hours.
 * When it expires (401/403 from the API), polling stops until the user reloads
 * home.nest.com, which triggers the interceptor to supply fresh credentials.
 */

const POLL_ALARM = "nest_poll";
const POLL_INTERVAL_MINUTES = 5;
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const BUCKET_TYPES = [
  "buckets", "device", "kryptonite", "link", "rcs_settings",
  "schedule", "shared", "structure", "track", "where",
];

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "NEST_READING") return;

  // Always store the intercepted reading.
  storeReading(message.reading);

  // If we got credentials, save them and (re-)arm the poll alarm.
  if (message.creds?.authorization && message.creds?.userId) {
    saveCredentials(message.creds).then(armAlarm);
  }
});

// ── Alarm handler ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll();
});

// ── Core functions ────────────────────────────────────────────────────────────

async function poll() {
  const { nestCreds } = await chrome.storage.local.get("nestCreds");
  if (!nestCreds) return;

  const url = `https://home.nest.com/api/0.1/user/${nestCreds.userId}/app_launch`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": nestCreds.authorization,
        "X-nl-user-id": nestCreds.userId,
        "X-nl-protocol-version": "1",
        "Content-Type": "text/json",
      },
      body: JSON.stringify({
        known_bucket_types: BUCKET_TYPES,
        known_bucket_versions: [],
      }),
    });
  } catch (err) {
    console.warn("[Nest Logger] Poll network error:", err);
    return;
  }

  if (resp.status === 401 || resp.status === 403) {
    console.warn("[Nest Logger] Credentials expired — stopping poll until page reload.");
    chrome.alarms.clear(POLL_ALARM);
    await chrome.storage.local.remove("nestCreds");
    return;
  }

  if (!resp.ok) {
    console.warn("[Nest Logger] Poll returned", resp.status);
    return;
  }

  const data = await resp.json();
  const reading = parseNestData(data);
  if (reading) {
    console.log(`[Nest Logger] Polled at ${reading.timestamp}`);
    storeReading(reading);
  }
}

async function armAlarm() {
  await chrome.alarms.clear(POLL_ALARM);
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
  console.log(`[Nest Logger] Poll alarm set every ${POLL_INTERVAL_MINUTES} min.`);
}

async function saveCredentials(creds) {
  await chrome.storage.local.set({
    nestCreds: {
      authorization: creds.authorization,
      userId: creds.userId,
    },
  });
}

async function storeReading(reading) {
  const { readings = [] } = await chrome.storage.local.get("readings");
  readings.push(reading);

  const cutoff = Date.now() - RETENTION_MS;
  const trimmed = readings.filter((r) => new Date(r.timestamp).getTime() >= cutoff);

  await chrome.storage.local.set({ readings: trimmed });
}

// ── Nest data parser ──────────────────────────────────────────────────────────

function cToF(c) {
  return c == null ? null : Math.round(c * 9 / 5 * 10 + 320) / 10;
}

function parseNestData(data) {
  const buckets = {};
  for (const b of data.updated_buckets || []) {
    buckets[b.object_key] = b.value;
  }

  const wheres = {};
  for (const [key, val] of Object.entries(buckets)) {
    if (key.startsWith("where.")) {
      for (const w of val.wheres || []) wheres[w.where_id] = w.name;
    }
  }

  const rcsMap = {};
  for (const [key, val] of Object.entries(buckets)) {
    if (key.startsWith("rcs_settings.")) rcsMap[key.slice("rcs_settings.".length)] = val;
  }

  const sensors = [];
  for (const [key, val] of Object.entries(buckets)) {
    if (!key.startsWith("kryptonite.")) continue;
    const serial = key.slice("kryptonite.".length);
    let thermostatSerial = null, isActive = false;
    for (const [ts, rcs] of Object.entries(rcsMap)) {
      if ((rcs.associated_rcs_sensors || []).includes(key)) {
        thermostatSerial = ts;
        isActive = (rcs.active_rcs_sensors || []).includes(key);
        break;
      }
    }
    sensors.push({
      serial,
      room: wheres[val.where_id] || "Unknown",
      temperature_c: val.current_temperature ?? null,
      temperature_f: cToF(val.current_temperature),
      battery_level: val.battery_level ?? null,
      thermostat_serial: thermostatSerial,
      is_active: isActive,
    });
  }

  const thermostats = [];
  for (const [key, val] of Object.entries(buckets)) {
    if (!key.startsWith("shared.")) continue;
    const serial = key.slice("shared.".length);
    const deviceVal = buckets[`device.${serial}`] || {};
    thermostats.push({
      serial,
      room: wheres[deviceVal.where_id] || "Thermostat",
      current_temperature_c: val.current_temperature ?? null,
      current_temperature_f: cToF(val.current_temperature),
      target_temperature_c: val.target_temperature ?? null,
      target_temperature_f: cToF(val.target_temperature),
      hvac_mode: val.target_temperature_type || "off",
      hvac_action: val.hvac_heater_state ? "heating" : val.hvac_ac_state ? "cooling" : val.hvac_fan_state ? "fan" : "idle",
      humidity: val.current_humidity ?? null,
    });
  }

  if (sensors.length === 0 && thermostats.length === 0) return null;
  return { timestamp: new Date().toISOString(), sensors, thermostats };
}

/**
 * background.js — Chrome extension service worker.
 *
 * Service workers are event-driven and may be terminated by the browser when
 * idle (typically after 30 seconds of inactivity).  They are restarted on
 * demand when an event fires (alarm, message, etc.).  This means:
 *   - Do not rely on in-memory state persisting between events.
 *   - Use chrome.storage.local for anything that must survive restarts.
 *
 * Responsibilities:
 *   1. Receive the first reading + auth credentials from relay.js.
 *   2. Persist credentials to chrome.storage.local.
 *   3. Arm a chrome.alarms timer to poll the Nest API every N minutes.
 *   4. On each alarm, call app_launch directly, parse the response, and store
 *      the reading.
 *   5. When credentials expire (API returns 401/403), clear the alarm and wait
 *      for relay.js to supply fresh credentials on the next page load.
 */

const PREFIX = "[Nest Logger / background]";

const POLL_ALARM          = "nest_poll";
const POLL_INTERVAL_MIN   = 5;       // how often to call app_launch
const RETENTION_DAYS      = 90;      // how long to keep readings in storage
const RETENTION_MS        = RETENTION_DAYS * 24 * 60 * 60 * 1000;

// All bucket types the app_launch endpoint can return.  We request all of them
// so the parser has the full picture (room names, sensor-thermostat links, etc.)
const BUCKET_TYPES = [
  "buckets", "delayed_topaz", "device", "kryptonite", "link", "rcs_settings",
  "schedule", "shared", "structure", "topaz", "track", "where",
];

console.log(PREFIX, "Service worker started.");

// ── Message handler ───────────────────────────────────────────────────────────
// Fired when relay.js calls chrome.runtime.sendMessage.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "NEST_READING") return;

  const { reading, creds } = message;
  console.log(PREFIX, `Message received: reading at ${reading.timestamp}.`);

  // Store the intercepted reading immediately.
  storeReading(reading).then(() => {
    console.log(PREFIX, "Intercepted reading stored.");
  });

  // If the message includes credentials, save them and (re-)arm the poll alarm.
  // This happens every time the Nest page loads, which refreshes the token.
  if (creds?.authorization && creds?.userId) {
    console.log(PREFIX, "Credentials received. Saving and arming poll alarm.");
    saveCredentials(creds)
      .then(armAlarm)
      .then(() => {
        console.log(PREFIX, `Poll alarm armed: every ${POLL_INTERVAL_MIN} min.`);
        // chrome.alarms fires the first tick after periodInMinutes, not immediately.
        // The intercepted web-app reading never includes shared/device buckets
        // (the web app doesn't request them), so thermostat data would be absent
        // for up to 5 minutes.  Trigger one immediate poll right now so the very
        // next reading is complete.
        console.log(PREFIX, "Triggering immediate poll for full data (incl. thermostats)...");
        poll();
      })
      .catch((err) => console.error(PREFIX, "Failed to arm alarm:", err));
  } else {
    console.warn(PREFIX, "No credentials in message — poll alarm not updated.",
      "This is normal if the page has already been seen this session.");
  }

  // Acknowledge the message so relay.js callback fires without an error.
  sendResponse({ ok: true });
  return true; // keeps the message channel open for the async sendResponse
});

// ── Alarm handler ─────────────────────────────────────────────────────────────
// chrome.alarms survive the service worker being terminated and will wake it
// back up when they fire.

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    console.log(PREFIX, `Alarm fired: ${new Date().toISOString()}. Polling Nest API...`);
    poll();
  }
});

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  // Load credentials from storage (in-memory state would be lost if the
  // service worker was terminated between alarm firings).
  const { nestCreds } = await chrome.storage.local.get("nestCreds");

  if (!nestCreds) {
    console.warn(PREFIX, "Poll triggered but no credentials in storage.",
      "Load home.nest.com to supply credentials.");
    return;
  }

  const url = `https://home.nest.com/api/0.1/user/${nestCreds.userId}/app_launch`;
  console.log(PREFIX, "Calling app_launch for user", nestCreds.userId);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization":         nestCreds.authorization,
        "X-nl-user-id":          nestCreds.userId,
        "X-nl-protocol-version": "1",
        "Content-Type":          "text/json",
      },
      body: JSON.stringify({
        known_bucket_types:     BUCKET_TYPES,
        known_bucket_versions:  [],
      }),
    });
  } catch (err) {
    // Network-level failure (offline, DNS error, etc.).
    console.warn(PREFIX, "Poll network error (will retry on next alarm):", err.message);
    return;
  }

  console.log(PREFIX, "app_launch response status:", resp.status);

  if (resp.status === 401 || resp.status === 403) {
    // The Nest access token has expired.  Clear the stale credentials and alarm
    // so we don't keep hammering the API with a dead token.  Then reload the
    // Nest tab — the page load re-runs the interceptor, which obtains a fresh
    // token from the web app's own auth flow and posts it back to us, at which
    // point armAlarm() is called again and polling resumes automatically.
    console.warn(PREFIX,
      `Credentials expired (HTTP ${resp.status}). Clearing alarm and credentials.`,
      "Reloading home.nest.com to get a fresh token...");
    await chrome.alarms.clear(POLL_ALARM);
    await chrome.storage.local.remove("nestCreds");
    await reloadNestTab();
    return;
  }

  if (!resp.ok) {
    console.warn(PREFIX, `Unexpected HTTP ${resp.status} from app_launch. Will retry next alarm.`);
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    console.error(PREFIX, "Failed to parse app_launch response as JSON:", err);
    return;
  }

  const reading = parseNestData(data);
  if (!reading) {
    console.warn(PREFIX, "app_launch response parsed but contained no sensors or thermostats.",
      "The bucket structure may have changed.");
    return;
  }

  console.log(PREFIX,
    `Parsed ${reading.sensors.length} sensor(s), ${reading.thermostats.length} thermostat(s).`,
    reading.sensors.map(s => `${s.room}: ${s.temperature_f}°F`).join(", ")
  );

  await storeReading(reading);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function saveCredentials(creds) {
  await chrome.storage.local.set({
    nestCreds: {
      authorization: creds.authorization,
      userId:        creds.userId,
    },
  });
  console.log(PREFIX, "Credentials saved to storage (userId:", creds.userId, ").");
}

async function armAlarm() {
  // Clear any existing alarm first (e.g. page was reloaded mid-cycle).
  const cleared = await chrome.alarms.clear(POLL_ALARM);
  if (cleared) console.log(PREFIX, "Previous poll alarm cleared.");

  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MIN });
}

async function reloadNestTab() {
  // Find any open tab pointing at home.nest.com and reload it.  When the page
  // finishes loading the interceptor will fire, capture fresh credentials, and
  // call armAlarm() again — resuming polling without any user interaction.
  //
  // If no Nest tab is open we log a warning and do nothing; the next time the
  // user opens home.nest.com manually the interceptor will supply credentials.
  const tabs = await chrome.tabs.query({ url: "https://home.nest.com/*" });

  if (tabs.length === 0) {
    console.warn(PREFIX,
      "No home.nest.com tab found to reload.",
      "Polling will resume automatically the next time you open home.nest.com.");
    return;
  }

  // If multiple tabs are open, reload only the most recently active one.
  const target = tabs.reduce((best, t) =>
    (t.lastAccessed ?? 0) > (best.lastAccessed ?? 0) ? t : best
  );

  console.log(PREFIX, `Reloading Nest tab (id ${target.id}, url: ${target.url}).`);
  chrome.tabs.reload(target.id);
}

async function storeReading(reading) {
  const { readings = [] } = await chrome.storage.local.get("readings");

  const before = readings.length;
  readings.push(reading);

  // Trim entries older than the retention window.
  const cutoff = Date.now() - RETENTION_MS;
  const trimmed = readings.filter((r) => new Date(r.timestamp).getTime() >= cutoff);
  const dropped = readings.length - trimmed.length;

  await chrome.storage.local.set({ readings: trimmed });

  console.log(PREFIX,
    `Reading stored. Total: ${trimmed.length} (added 1, dropped ${dropped} old).`,
    `Span: ${trimmed[0]?.timestamp ?? "—"} → ${trimmed[trimmed.length - 1]?.timestamp ?? "—"}`
  );
  console.log(PREFIX, "Reading data:", JSON.stringify(reading, null, 2));
}

// ── Nest data parser ──────────────────────────────────────────────────────────
// This duplicates the parsing in interceptor.js because the background service
// worker runs in a separate context and cannot share code with content scripts
// without explicit module imports.

function cToF(c) {
  return c == null ? null : Math.round(c * 9 / 5 * 10 + 320) / 10;
}

function parseNestData(data) {
  // Flatten the updated_buckets array into a key → value map.
  const buckets = {};
  for (const b of data.updated_buckets || []) {
    buckets[b.object_key] = b.value;
  }

  if (Object.keys(buckets).length === 0) {
    console.warn(PREFIX, "parseNestData: updated_buckets is empty.");
    return null;
  }

  // Log every bucket key so we can see exactly what the API returned.
  // Bucket types present tell us which device classes are in the response.
  // If you see kryptonite.* but no shared.* here, the thermostat data is
  // not being returned — check that BUCKET_TYPES includes "shared" and "device".
  const bucketTypes = [...new Set(Object.keys(buckets).map(k => k.split(".")[0]))];
  console.log(PREFIX, `Bucket types in response: [${bucketTypes.join(", ")}]`);
  console.log(PREFIX, `All bucket keys: ${Object.keys(buckets).join(", ")}`);

  // Room name lookup
  const wheres = {};
  for (const [key, val] of Object.entries(buckets)) {
    if (key.startsWith("where.")) {
      for (const w of val.wheres || []) wheres[w.where_id] = w.name;
    }
  }

  // Sensor → thermostat mapping and active-sensor tracking
  const rcsMap = {};
  for (const [key, val] of Object.entries(buckets)) {
    if (key.startsWith("rcs_settings.")) {
      rcsMap[key.slice("rcs_settings.".length)] = val;
    }
  }

  // Temperature sensors (kryptonite buckets)
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
      room:            wheres[val.where_id] || "Unknown",
      temperature_c:   val.current_temperature ?? null,
      temperature_f:   cToF(val.current_temperature),
      battery_level:   val.battery_level ?? null,
      thermostat_serial: thermostatSerial,
      is_active:       isActive,
    });
  }

  // Thermostats (shared buckets)
  const thermostats = [];
  for (const [key, val] of Object.entries(buckets)) {
    if (!key.startsWith("shared.")) continue;
    const serial = key.slice("shared.".length);
    const deviceVal = buckets[`device.${serial}`] || {};
    thermostats.push({
      serial,
      room:                  wheres[deviceVal.where_id] || "Thermostat",
      current_temperature_c: val.current_temperature ?? null,
      current_temperature_f: cToF(val.current_temperature),
      target_temperature_c:  val.target_temperature ?? null,
      target_temperature_f:  cToF(val.target_temperature),
      hvac_mode:             val.target_temperature_type || "off",
      hvac_action:           val.hvac_heater_state ? "heating"
                           : val.hvac_ac_state     ? "cooling"
                           : val.hvac_fan_state    ? "fan"
                           :                         "idle",
      humidity:              val.current_humidity ?? null,
    });
  }

  if (sensors.length === 0 && thermostats.length === 0) return null;

  return {
    timestamp: new Date().toISOString(),
    sensors,
    thermostats,
  };
}

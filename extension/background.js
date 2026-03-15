/**
 * nest-logger — background.js — Chrome extension service worker.
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
 * background.js — Chrome extension service worker.
 *
 * Receives scraped Nest readings from scraper.js via chrome.runtime.sendMessage
 * and forwards them to the local server.  Running here (rather than in the
 * content script) bypasses the Nest page's Content-Security-Policy, which
 * would block fetch calls to non-Nest origins.
 *
 * The server origin must be listed in host_permissions in manifest.json.
 *
 * Reliability:
 *   Watchdog alarm (every 6 min): reloads the Nest tab if no reading has been
 *   received in more than WATCHDOG_GRACE_MS.  Cold starts are detected via
 *   WORKER_START_TIME (an in-memory constant that resets on every cold start)
 *   and skipped to avoid spurious reloads.
 *
 *   Daily reload alarm (~3 am local): proactively reloads the Nest tab once
 *   per day to clear accumulated DOM/JS heap from the long-running SPA.
 */

// Set once per service worker lifetime.  Resets on cold start, which is how
// we detect that case in the watchdog handler.
const WORKER_START_TIME = Date.now();

const PREFIX          = "[Nest Scraper / background]";
const INGEST_URL      = "http://127.0.0.1:51920/api/readings";

// Must match POLL_INTERVAL_MS in scraper.js.
const POLL_INTERVAL_MS    = 5 * 60 * 1000;
// Two missed cycles plus one minute of grace.
const WATCHDOG_GRACE_MS   = POLL_INTERVAL_MS * 2 + 60_000;

// Tracks the last time a NEST_READING was received.  In-memory is fine:
// on a cold start this is 0, but WORKER_START_TIME is fresh so the watchdog
// skips the stale check until a real reading arrives.
let lastReadingTime = 0;

console.log(PREFIX, "Service worker started.");

// ── Startup ───────────────────────────────────────────────────────────────────

// Watchdog fires every 6 minutes.  Recreated on every startup; relative
// timing is fine for a sub-hourly periodic alarm.
chrome.alarms.create('watchdog', { periodInMinutes: 6 });

// Daily reload fires at ~3 am local time.  Only created if it doesn't already
// exist so the scheduled time doesn't drift on service worker restarts.
chrome.alarms.get('daily-reload', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('daily-reload', {
      when:           next3amMs(),
      periodInMinutes: 24 * 60,
    });
    console.log(PREFIX, "Scheduled daily reload at", new Date(next3amMs()).toLocaleString());
  }
});

/** Returns the Unix timestamp (ms) of the next 3:00 am in local time. */
function next3amMs() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

// ── Alarm handler ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'watchdog') {
    await handleWatchdog();
  } else if (alarm.name === 'daily-reload') {
    await reloadNestTab('Daily reload');
  }
});

async function handleWatchdog() {
  // On a cold start the service worker hasn't had time to receive a reading
  // yet, so lastReading in storage may legitimately look stale.  Skip.
  const workerUptime = Date.now() - WORKER_START_TIME;
  if (workerUptime < POLL_INTERVAL_MS) {
    console.log(PREFIX, "Watchdog: cold start — skipping stale check.");
    return;
  }

  if (!lastReadingTime) {
    console.warn(PREFIX, "Watchdog: no reading received yet — skipping.");
    return;
  }

  const ageMs  = Date.now() - lastReadingTime;
  const ageMin = Math.round(ageMs / 60_000);
  if (ageMs > WATCHDOG_GRACE_MS) {
    console.warn(PREFIX, `Watchdog: last reading was ${ageMin} min ago — reloading Nest tab.`);
    await reloadNestTab('Watchdog');
  } else {
    console.log(PREFIX, `Watchdog: last reading ${ageMin} min ago — OK.`);
  }
}

/** Finds all home.nest.com tabs and reloads them. */
async function reloadNestTab(reason) {
  const tabs = await chrome.tabs.query({ url: 'https://home.nest.com/*' });
  if (tabs.length === 0) {
    console.log(PREFIX, `${reason}: no Nest tab open, nothing to reload.`);
    return;
  }
  for (const tab of tabs) {
    console.log(PREFIX, `${reason}: reloading tab ${tab.id}.`);
    chrome.tabs.reload(tab.id);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "NEST_READING") return;

  const { timestamp, data, hvac_action } = message;

  // Record the time of this reading so the watchdog can detect silence.
  lastReadingTime = Date.now();

  // Log every received data point for verification.
  console.log(PREFIX, `Received reading at ${timestamp} (hvac: ${hvac_action}):`);
  for (const [section, sensors] of Object.entries(data)) {
    console.log(PREFIX, ` [${section}]`);
    for (const [name, value] of Object.entries(sensors)) {
      console.log(PREFIX, `   ${name}: ${value}`);
    }
  }

  // POST to the ingest endpoint.
  fetch(INGEST_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ timestamp, data, hvac_action }),
  })
    .then((resp) => {
      if (resp.ok) {
        console.log(PREFIX, `Posted reading to server — HTTP ${resp.status}`);
      } else {
        console.warn(PREFIX, `Server rejected reading — HTTP ${resp.status}`);
      }
    })
    .catch((err) => {
      console.warn(PREFIX, `Failed to post reading: ${err.message}`);
    });

  // Acknowledge immediately so the content script callback fires without error.
  sendResponse({ ok: true, received: timestamp });
  return true; // keep the message channel open for the async sendResponse
});

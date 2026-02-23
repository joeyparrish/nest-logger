/**
 * background.js — Chrome extension service worker.
 *
 * Receives scraped Nest readings from scraper.js via chrome.runtime.sendMessage
 * and forwards them to the local server.  Running here (rather than in the
 * content script) bypasses the Nest page's Content-Security-Policy, which
 * would block fetch calls to non-Nest origins.
 *
 * The server origin must be listed in host_permissions in manifest.json.
 */

const PREFIX     = "[Nest Scraper / background]";
const INGEST_URL = "http://127.0.0.1:51920/api/readings";

console.log(PREFIX, "Service worker started.");

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "NEST_READING") return;

  const { timestamp, data } = message;

  // Log every received data point for verification.
  console.log(PREFIX, `Received reading at ${timestamp}:`);
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
    body:    JSON.stringify({ timestamp, data }),
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

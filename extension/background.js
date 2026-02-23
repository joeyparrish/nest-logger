/**
 * background.js — Chrome extension service worker.
 *
 * Receives scraped Nest readings from scraper.js via chrome.runtime.sendMessage
 * and forwards them to the remote server.  Running here (rather than in the
 * content script) bypasses the Nest page's Content-Security-Policy, which
 * would block fetch calls to non-Nest origins.
 *
 * The remote server origin must be listed in host_permissions in manifest.json.
 */

const PREFIX = "[Nest Scraper / background]";

const INGEST_URL = "http://10.0.0.2/";

console.log(PREFIX, "Service worker started.");

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "NEST_READING") return;

  const { timestamp, data } = message;

  // Log every received data point so you can verify the scraper → background
  // pipeline is working before wiring up a real ingest endpoint.
  console.log(PREFIX, `Received reading at ${timestamp}:`);
  for (const [section, sensors] of Object.entries(data)) {
    console.log(PREFIX, ` [${section}]`);
    for (const [name, value] of Object.entries(sensors)) {
      console.log(PREFIX, `   ${name}: ${value}`);
    }
  }

  // Dummy request — replace with the real ingest call once the server is ready.
  console.log(PREFIX, `Sending dummy GET to ${INGEST_URL}...`);
  fetch(INGEST_URL)
    .then((resp) => {
      console.log(PREFIX, `Dummy GET succeeded — HTTP ${resp.status}`);
    })
    .catch((err) => {
      console.warn(PREFIX, `Dummy GET failed: ${err.message}`);
    });

  // Acknowledge immediately so the content script callback fires without error.
  sendResponse({ ok: true, received: timestamp });
  return true; // keep the message channel open for the async sendResponse
});

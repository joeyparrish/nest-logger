/**
 * background.js — service worker.
 *
 * Receives readings from relay.js, appends them to chrome.storage.local,
 * and trims entries older than RETENTION_DAYS.
 */

const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NEST_READING") {
    storeReading(message.reading);
  }
});

async function storeReading(reading) {
  const { readings = [] } = await chrome.storage.local.get("readings");

  readings.push(reading);

  // Trim old entries
  const cutoff = Date.now() - RETENTION_MS;
  const trimmed = readings.filter(
    (r) => new Date(r.timestamp).getTime() >= cutoff
  );

  await chrome.storage.local.set({ readings: trimmed });
  console.log(
    `[Nest Logger] Stored reading at ${reading.timestamp}. Total: ${trimmed.length}`
  );
}

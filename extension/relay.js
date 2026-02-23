/**
 * relay.js — runs in the ISOLATED world (normal content script).
 *
 * Listens for postMessage events from interceptor.js and forwards them to
 * the background service worker via chrome.runtime.sendMessage.
 */

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (!event.data?.__nestLogger) return;

  chrome.runtime.sendMessage({
    type: "NEST_READING",
    reading: {
      timestamp: event.data.timestamp,
      sensors: event.data.sensors,
      thermostats: event.data.thermostats,
    },
  });
});

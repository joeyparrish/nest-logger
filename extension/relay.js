/**
 * relay.js — executed in the ISOLATED world (standard content script context).
 *
 * "Isolated world" means this script has access to chrome.* APIs but runs in
 * a separate JS scope from the page — it cannot see or touch the page's
 * variables.  It can communicate with the MAIN world only via window.postMessage
 * / window.addEventListener("message").
 *
 * Role: bridge between interceptor.js (MAIN world) and background.js
 * (service worker).  It receives the postMessage from interceptor.js, validates
 * it, and forwards it to the background worker via chrome.runtime.sendMessage.
 *
 * Why the two-step relay?
 *   chrome.runtime is not available in MAIN world scripts, so interceptor.js
 *   cannot talk to the background directly.  This isolated-world relay bridges
 *   the gap.
 */

const PREFIX = "[Nest Logger / relay]";

console.log(PREFIX, "Installed. Listening for postMessages from interceptor.js.");

window.addEventListener("message", (event) => {
  // Ignore messages from other frames or windows.
  if (event.source !== window) return;

  // Ignore messages not from our interceptor.
  if (!event.data?.__nestLogger) return;

  const { timestamp, sensors, thermostats, creds } = event.data;

  console.log(PREFIX,
    `Received reading (${timestamp}): ` +
    `${sensors?.length ?? 0} sensor(s), ${thermostats?.length ?? 0} thermostat(s).`
  );

  if (creds?.authorization) {
    console.log(PREFIX, "Credentials present — background will arm/refresh poll alarm.");
  } else {
    console.warn(PREFIX, "No credentials in message — background cannot poll independently.");
  }

  // Forward to the background service worker.
  chrome.runtime.sendMessage(
    {
      type: "NEST_READING",
      reading: { timestamp, sensors, thermostats },
      creds,
    },
    (response) => {
      // sendMessage callback fires after the background has processed the message.
      // Check for errors (e.g. background service worker not yet awake).
      if (chrome.runtime.lastError) {
        console.error(PREFIX, "sendMessage failed:", chrome.runtime.lastError.message);
      } else {
        console.log(PREFIX, "Background acknowledged reading.");
      }
    }
  );
});

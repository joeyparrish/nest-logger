/**
 * scraper.js — Chrome extension content script.
 *
 * Runs on every home.nest.com page at document_idle (after the basic HTML is
 * parsed).  Because the Nest web app is a React SPA, the carousel UI takes a
 * few extra seconds to render even after document_idle; we use a waitFor()
 * helper to poll the DOM until the expected element appears.
 *
 * Flow:
 *   1. If the current URL is NOT a thermostat page (/thermostat/DEVICE_…),
 *      search the DOM for a thermostat link and navigate to it.
 *   2. If the URL IS a thermostat page, wait for the carousel container to
 *      appear, then scrape section headers + sensor rows.
 *   3. Log the structured reading to the console.
 *   4. Repeat step 2–3 every POLL_INTERVAL_MS (5 minutes).
 */

(function () {
  'use strict';

  const PREFIX = "[Nest Scraper]";
  const POLL_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

  // Matches URL paths like /thermostat/DEVICE_6416660000FB4E45
  const THERMOSTAT_PATH_RE = /\/thermostat\/DEVICE_/;

  // The container element that holds the sensor carousel panel.
  const CONTAINER_SELECTOR = '[data-test="thermozilla-aag-carousel-container"]';

  console.log(PREFIX, "Content script loaded. Path:", window.location.pathname);

  // ── Utilities ──────────────────────────────────────────────────────────────

  function isOnThermostatPage() {
    return THERMOSTAT_PATH_RE.test(window.location.pathname);
  }

  /**
   * Polls predicate() every intervalMs until it returns a truthy value,
   * then resolves with that value.  Rejects after timeoutMs.
   */
  function waitFor(predicate, intervalMs = 500, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      (function check() {
        const result = predicate();
        if (result) {
          resolve(result);
        } else if (Date.now() >= deadline) {
          reject(new Error("waitFor timed out after " + timeoutMs + "ms"));
        } else {
          setTimeout(check, intervalMs);
        }
      })();
    });
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /**
   * Look for a thermostat link in the DOM and navigate to it.
   * The link appears after React hydrates, so we poll with waitFor().
   */
  async function navigateToThermostat() {
    console.log(PREFIX, "Searching DOM for a /thermostat/DEVICE_… link...");
    let link;
    try {
      link = await waitFor(
        () => Array.from(document.querySelectorAll('a'))
               .map(a => a.href)
               .find(href => href.includes('/thermostat/DEVICE_')),
        500,
        15000
      );
    } catch {
      console.error(PREFIX,
        "Timed out — no thermostat link found in DOM after 15 s.",
        "Make sure you are logged in to home.nest.com and have a thermostat."
      );
      return;
    }
    console.log(PREFIX, "Navigating to thermostat page:", link);
    window.location.href = link;
  }

  // ── Scraping ───────────────────────────────────────────────────────────────

  /**
   * Walk the direct children of the carousel container.
   * <header> elements introduce a new section.
   * <div> elements are data cells containing one sensor/location row.
   *
   * Returns an object shaped like:
   *   {
   *     "TEMPERATURE SENSORS": { "Basement": 80, "Kitchen": 69, … },
   *     "INSIDE HUMIDITY":     { "Entryway": 40 },
   *     "OUTSIDE TEMP.":       { "Doreen": 47 },
   *   }
   */
  function scrapeContainer(container) {
    const result = {};
    let currentSection = null;

    for (const el of container.children) {
      // Section divider — a plain <header> element.
      if (el.tagName === "HEADER") {
        currentSection = el.innerText.trim();
        result[currentSection] = {};
        console.log(PREFIX, "  Section:", currentSection);
        continue;
      }

      // Skip anything before the first header.
      if (currentSection === null) continue;

      // The cell contains a row div whose class starts with "style--cellRow_".
      // The suffix after the underscore is a random compiler-generated hash.
      const row = el.querySelector('[class*="style--cellRow_"]');
      if (!row) continue;

      // Sensor / location name — class starts with "style--title_".
      const titleEl = row.querySelector('[class*="style--title_"]');

      // Numeric value — class starts with "style--value_".
      const valueEl = row.querySelector('[class*="style--value_"]');

      if (!titleEl || !valueEl) {
        console.warn(PREFIX, "  Row missing title or value element — skipping.");
        continue;
      }

      const name    = titleEl.innerText.trim();
      const rawText = valueEl.innerText.trim();

      // Extract a number that may be negative and may have a decimal point.
      // Strips degree symbols (°), percent signs (%), and other non-numeric
      // characters, e.g. "72°" → 72, "40%" → 40, "-5" → -5.
      const match = rawText.match(/-?\d+(?:\.\d+)?/);
      const value = match ? parseFloat(match[0]) : NaN;

      if (name && !isNaN(value)) {
        result[currentSection][name] = value;
        console.log(PREFIX, `    ${name}: ${value}  (raw: "${rawText}")`);
      } else {
        console.warn(PREFIX,
          `  Could not parse row — name: ${JSON.stringify(name)}, rawText: ${JSON.stringify(rawText)}`
        );
      }
    }

    return result;
  }

  /**
   * Wait for the carousel container to appear (React may still be rendering),
   * then scrape it.  Returns null if the container never appears.
   */
  async function scrape() {
    let container;
    try {
      container = await waitFor(
        () => document.querySelector(CONTAINER_SELECTOR),
        500,
        15000
      );
    } catch {
      console.error(PREFIX,
        "Timed out waiting for carousel container:", CONTAINER_SELECTOR,
        "— the page structure may have changed."
      );
      return null;
    }

    return scrapeContainer(container);
  }

  // ── Poll ───────────────────────────────────────────────────────────────────

  async function poll() {
    const ts = new Date().toISOString();
    console.log(PREFIX, `=== Poll at ${ts} ===`);

    const data = await scrape();
    if (!data) {
      console.warn(PREFIX, "Scrape returned null — no reading this cycle.");
      return;
    }

    const sections   = Object.keys(data);
    const totalValues = sections.reduce((n, s) => n + Object.keys(data[s]).length, 0);
    console.log(PREFIX,
      `Reading complete: ${sections.length} section(s), ${totalValues} total value(s).`
    );
    console.log(PREFIX, "Reading:", JSON.stringify(data, null, 2));
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  if (isOnThermostatPage()) {
    console.log(PREFIX, "On thermostat page. Starting poll loop (every",
      POLL_INTERVAL_MS / 1000, "s).");
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
  } else {
    console.log(PREFIX, "Not on thermostat page — will navigate there automatically.");
    navigateToThermostat();
  }

})();

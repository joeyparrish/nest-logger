/**
 * interceptor.js — executed in the page's MAIN world.
 *
 * "MAIN world" means this script runs in the same JavaScript context as the
 * Nest web app itself, so it can wrap the global fetch/XHR functions before
 * the app uses them.  It does NOT have access to chrome.* APIs — those are
 * only available in the "isolated world" (relay.js).
 *
 * Flow:
 *   1. Wrap window.fetch (and XMLHttpRequest as a fallback).
 *   2. When a call to the app_launch endpoint is detected, clone the response
 *      so we can read the body without consuming it for the app.
 *   3. Also read the Authorization and X-nl-user-id request headers — the
 *      background worker needs these to make its own periodic poll calls.
 *   4. Parse the bucket data out of the response JSON.
 *   5. Post everything to relay.js via window.postMessage.
 */

(function () {
  const PREFIX = "[Nest Logger / interceptor]";

  // Regex that matches the app_launch REST endpoint.
  // URL shape: /api/0.1/user/<userid>/app_launch
  const APP_LAUNCH_RE = /\/api\/0\.1\/user\/[^/]+\/app_launch/;

  console.log(PREFIX, "Installed. Wrapping window.fetch and XMLHttpRequest.");

  // ── fetch wrapper ───────────────────────────────────────────────────────────

  const _fetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    // Always perform the real fetch first so the app is never blocked.
    const response = await _fetch(input, init);

    const url = input instanceof Request ? input.url : String(input);

    if (APP_LAUNCH_RE.test(url)) {
      console.log(PREFIX, "Detected app_launch fetch →", url);

      // Extract the auth credentials from the request before the response is
      // consumed.  These are needed by the background worker for polling.
      const creds = extractCredsFromFetch(url, input, init);
      if (creds.authorization) {
        console.log(PREFIX, "Captured Authorization header (length:",
          creds.authorization.length, "), userId:", creds.userId);
      } else {
        console.warn(PREFIX, "Authorization header NOT found on app_launch request.",
          "Background polling will not be set up until a request with headers is seen.");
      }

      // Clone the response — reading the body of the original would break the app.
      response.clone().json()
        .then((data) => {
          console.log(PREFIX, "Parsing app_launch response body...");
          parseAndPost(data, creds);
        })
        .catch((err) => {
          console.error(PREFIX, "Failed to parse app_launch response as JSON:", err);
        });
    }

    return response;
  };

  // ── XMLHttpRequest wrapper ──────────────────────────────────────────────────
  // Some versions of the Nest web app (or embedded frames) may use XHR instead
  // of fetch.  We patch it as a fallback.

  const _open = XMLHttpRequest.prototype.open;
  const _setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._nestUrl = String(url);
    this._nestHeaders = {};  // collect headers as they are set
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Store every header in lowercase for case-insensitive lookup later.
    if (this._nestHeaders) {
      this._nestHeaders[name.toLowerCase()] = value;
    }
    return _setRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._nestUrl && APP_LAUNCH_RE.test(this._nestUrl)) {
      console.log(PREFIX, "Detected app_launch XHR →", this._nestUrl);
      const capturedUrl = this._nestUrl;
      const capturedHeaders = Object.assign({}, this._nestHeaders);

      this.addEventListener("load", function () {
        try {
          const capturedHeaderNames = Object.keys(capturedHeaders);
          console.log(PREFIX, "XHR app_launch complete (status:", this.status, ")");
          console.log(PREFIX, "XHR captured header names:", capturedHeaderNames.length
            ? capturedHeaderNames.join(", ")
            : "(none — auth may be handled by a service worker or cookies, not setRequestHeader)");

          // userId is not sent as a header — extract it from the URL instead.
          // URL shape: /api/0.1/user/<userId>/app_launch
          const userIdMatch = capturedUrl.match(/\/user\/([^/]+)\/app_launch/);
          const creds = {
            url: capturedUrl,
            authorization: capturedHeaders["authorization"] || null,
            userId: userIdMatch?.[1] || capturedHeaders["x-nl-user-id"] || null,
          };
          console.log(PREFIX, "XHR credentials:",
            `authorization=${creds.authorization ? "found" : "NOT FOUND"}`,
            `userId=${creds.userId ?? "NOT FOUND"}`);

          parseAndPost(JSON.parse(this.responseText), creds);
        } catch (err) {
          console.error(PREFIX, "Failed to parse XHR app_launch response:", err);
        }
      });
    }
    return _send.apply(this, args);
  };

  // ── Credential extraction ───────────────────────────────────────────────────

  function extractCredsFromFetch(url, input, init) {
    let authorization = null;
    let userId = null;

    // Helper that reads a header from a Headers object or a plain object.
    function getHeader(headers, name) {
      if (!headers) return null;
      if (headers instanceof Headers) return headers.get(name);
      // Plain object — try exact case and lowercase.
      return headers[name] ?? headers[name.toLowerCase()] ?? null;
    }

    // Log the raw shape of the fetch arguments so we can see exactly where
    // the headers are (or aren't) when app_launch is called.
    const inputType = input instanceof Request ? "Request object" : `string (${typeof input})`;
    const initHeaderType = init?.headers
      ? (init.headers instanceof Headers ? "Headers object" : `plain object, keys: [${Object.keys(init.headers).join(", ")}]`)
      : "none";
    console.log(PREFIX, `extractCreds: input=${inputType}, init.headers=${initHeaderType}`);

    if (input instanceof Request) {
      // fetch(new Request(url, {headers: ...}))
      const requestHeaderNames = [...input.headers.keys()];
      console.log(PREFIX, `Request header names: [${requestHeaderNames.join(", ")}]`);
      authorization = getHeader(input.headers, "Authorization");
      userId        = getHeader(input.headers, "X-nl-user-id");
    } else if (init?.headers) {
      // fetch(urlString, {headers: {...}})
      authorization = getHeader(init.headers, "Authorization");
      userId        = getHeader(init.headers, "X-nl-user-id");
    } else {
      console.warn(PREFIX, "No headers found on app_launch fetch at all.",
        "The app may be using a service worker or middleware to inject auth headers,",
        "which are not visible to the MAIN-world fetch wrapper.");
    }

    // userId may not be in headers — fall back to parsing it from the URL.
    // URL shape: /api/0.1/user/<userId>/app_launch
    if (!userId) {
      const m = url.match(/\/user\/([^/]+)\/app_launch/);
      if (m) userId = m[1];
    }

    console.log(PREFIX,
      `Extracted: authorization=${authorization ? `"${authorization.slice(0, 20)}..."` : "null"}`,
      `userId=${userId ?? "null"}`);

    return { url, authorization, userId };
  }

  // ── Nest data parser ────────────────────────────────────────────────────────

  function cToF(c) {
    return c == null ? null : Math.round(c * 9 / 5 * 10 + 320) / 10;
  }

  function parseAndPost(data, creds) {
    // The app_launch response contains an array of "buckets", each a key/value
    // pair describing one piece of Nest device state.
    const buckets = {};
    for (const b of data.updated_buckets || []) {
      buckets[b.object_key] = b.value;
    }
    const bucketTypes = [...new Set(Object.keys(buckets).map(k => k.split(".")[0]))];
    console.log(PREFIX, `Bucket types in response: [${bucketTypes.join(", ")}]`);
    // Note: the web app's app_launch call typically does NOT request "shared",
    // "device", or "rcs_settings" bucket types, so thermostats will be empty
    // in intercepted readings.  The background worker's own poll requests those
    // types and will populate thermostat data in subsequent readings.
    if (!bucketTypes.includes("shared")) {
      console.warn(PREFIX, "No 'shared' buckets in this response — thermostat fields will be empty.",
        "Thermostat data will appear in background-poll readings (every 5 min).");
    }

    // ── Room name lookup (where.* buckets) ────────────────────────────────
    // Each structure has a "where" bucket listing room names keyed by where_id.
    const wheres = {};
    for (const [key, val] of Object.entries(buckets)) {
      if (key.startsWith("where.")) {
        for (const w of val.wheres || []) {
          wheres[w.where_id] = w.name;
        }
      }
    }
    console.log(PREFIX, "Room map:", wheres);

    // ── Active sensor mapping (rcs_settings.* buckets) ────────────────────
    // rcs_settings links temperature sensors to the thermostat they serve and
    // records which one is currently "active" (being used for temperature
    // control).
    const rcsMap = {};
    for (const [key, val] of Object.entries(buckets)) {
      if (key.startsWith("rcs_settings.")) {
        rcsMap[key.slice("rcs_settings.".length)] = val;
      }
    }

    // ── Temperature sensors (kryptonite.* buckets) ────────────────────────
    // "Kryptonite" is Nest's internal codename for the remote temperature
    // sensor hardware.
    const sensors = [];
    for (const [key, val] of Object.entries(buckets)) {
      if (!key.startsWith("kryptonite.")) continue;
      const serial = key.slice("kryptonite.".length);
      let thermostatSerial = null;
      let isActive = false;
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
    console.log(PREFIX, `Parsed ${sensors.length} temperature sensor(s):`,
      sensors.map(s => `${s.room} ${s.temperature_f}°F${s.is_active ? " [active]" : ""}`));

    // ── Thermostats (shared.* buckets) ────────────────────────────────────
    // The "shared" bucket holds the live thermostat state: current and target
    // temperatures, HVAC mode, and whether heating/cooling is running.
    const thermostats = [];
    for (const [key, val] of Object.entries(buckets)) {
      if (!key.startsWith("shared.")) continue;
      const serial = key.slice("shared.".length);
      const deviceVal = buckets[`device.${serial}`] || {};
      const hvacAction = val.hvac_heater_state ? "heating"
                        : val.hvac_ac_state    ? "cooling"
                        : val.hvac_fan_state   ? "fan"
                        :                        "idle";
      thermostats.push({
        serial,
        room: wheres[deviceVal.where_id] || "Thermostat",
        current_temperature_c: val.current_temperature ?? null,
        current_temperature_f: cToF(val.current_temperature),
        target_temperature_c: val.target_temperature ?? null,
        target_temperature_f: cToF(val.target_temperature),
        hvac_mode: val.target_temperature_type || "off",
        hvac_action: hvacAction,
        humidity: val.current_humidity ?? null,
      });
    }
    console.log(PREFIX, `Parsed ${thermostats.length} thermostat(s):`,
      thermostats.map(t => `${t.room} ${t.current_temperature_f}°F → ${t.target_temperature_f}°F [${t.hvac_action}]`));

    if (sensors.length === 0 && thermostats.length === 0) {
      console.warn(PREFIX, "No sensors or thermostats found in response. " +
        "The bucket structure may have changed, or the response was empty.");
      return;
    }

    // Hand off to relay.js via postMessage.  relay.js listens in the isolated
    // world and forwards to the background service worker.
    const message = {
      __nestLogger: true,
      timestamp: new Date().toISOString(),
      sensors,
      thermostats,
      creds,
    };
    console.log(PREFIX, "Posting reading to relay.js via window.postMessage.");
    window.postMessage(message, "*");
  }

})();

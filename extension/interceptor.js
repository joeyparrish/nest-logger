/**
 * interceptor.js — runs in the page's MAIN world.
 *
 * Wraps window.fetch and XMLHttpRequest so that the first app_launch call is
 * intercepted.  Both the parsed reading AND the auth credentials (Authorization
 * header + user-id) are posted to the isolated content script so the background
 * worker can poll on its own schedule.
 */

(function () {
  const APP_LAUNCH_RE = /\/api\/0\.1\/user\/[^/]+\/app_launch/;

  // ---------- fetch wrapper ----------

  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const response = await _fetch(input, init);

    const url = input instanceof Request ? input.url : String(input);
    if (APP_LAUNCH_RE.test(url)) {
      const creds = extractCreds(url, input, init);
      response.clone().json().then((data) => parseAndPost(data, creds)).catch(() => {});
    }

    return response;
  };

  // ---------- XHR wrapper ----------

  const _open = XMLHttpRequest.prototype.open;
  const _setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._nestUrl = String(url);
    this._nestHeaders = {};
    return _open.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._nestHeaders) this._nestHeaders[name.toLowerCase()] = value;
    return _setRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._nestUrl && APP_LAUNCH_RE.test(this._nestUrl)) {
      const url = this._nestUrl;
      const headers = this._nestHeaders || {};
      this.addEventListener("load", function () {
        try {
          const creds = {
            url,
            authorization: headers["authorization"] || null,
            userId: headers["x-nl-user-id"] || null,
          };
          parseAndPost(JSON.parse(this.responseText), creds);
        } catch (_) {}
      });
    }
    return _send.apply(this, args);
  };

  // ---------- helpers ----------

  function extractCreds(url, input, init) {
    let authorization = null;
    let userId = null;

    const getHeader = (headers, name) => {
      if (!headers) return null;
      if (headers instanceof Headers) return headers.get(name);
      return headers[name] || headers[name.toLowerCase()] || null;
    };

    if (input instanceof Request) {
      authorization = getHeader(input.headers, "Authorization");
      userId = getHeader(input.headers, "X-nl-user-id");
    } else if (init?.headers) {
      authorization = getHeader(init.headers, "Authorization");
      userId = getHeader(init.headers, "X-nl-user-id");
    }

    return { url, authorization, userId };
  }

  function cToF(c) {
    return c == null ? null : Math.round(c * 9 / 5 * 10 + 320) / 10;
  }

  function parseAndPost(data, creds) {
    const buckets = {};
    for (const b of data.updated_buckets || []) {
      buckets[b.object_key] = b.value;
    }

    // Room names
    const wheres = {};
    for (const [key, val] of Object.entries(buckets)) {
      if (key.startsWith("where.")) {
        for (const w of val.wheres || []) {
          wheres[w.where_id] = w.name;
        }
      }
    }

    // rcs_settings
    const rcsMap = {};
    for (const [key, val] of Object.entries(buckets)) {
      if (key.startsWith("rcs_settings.")) {
        rcsMap[key.slice("rcs_settings.".length)] = val;
      }
    }

    // Temperature sensors
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

    // Thermostats
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

    if (sensors.length === 0 && thermostats.length === 0) return;

    window.postMessage({
      __nestLogger: true,
      timestamp: new Date().toISOString(),
      sensors,
      thermostats,
      creds,  // authorization header + userId for background polling
    }, "*");
  }
})();

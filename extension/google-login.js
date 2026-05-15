/**
 * nest-logger — google-login.js — Chrome extension content script.
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
 * google-login.js — accounts.google.com content script.
 *
 * Runs on accounts.google.com account-picker pages.  Only acts when the
 * redirect_uri parameter points back to Nest, so it does not interfere with
 * unrelated Google sign-in flows.
 */

(function () {
  'use strict';

  const PREFIX = "[Nest Scraper]";

  const redirectUri = new URLSearchParams(window.location.search).get('redirect_uri') || '';
  if (!redirectUri.includes('nest')) {
    return;
  }

  console.log(PREFIX, "Google account picker — Nest redirect detected. Waiting for account button...");

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

  waitFor(() => document.querySelector('[data-email]'))
    .then(button => {
      console.log(PREFIX, "Clicking account:", button.dataset.email);
      button.click();
    })
    .catch(() => {
      console.error(PREFIX, "Timed out waiting for account picker button.");
    });

})();

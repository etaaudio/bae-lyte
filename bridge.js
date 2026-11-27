// SPDX-License-Identifier: MPL-2.0
// BAE Lyte. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// bridge.js: runs in the extension's own world on supported pages. It hands
// the saved settings to page.js and answers the popup.
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = { unity: false, audioCodec: 'auto', videoCodec: 'auto' };
  const isTop = window === window.top;

  // Publish a setting for page.js on <html>, and in localStorage so the next
  // page load has it before this script runs.
  const publish = (name, value) => {
    const root = document.documentElement;
    if (root && root.getAttribute('data-' + name) !== value) root.setAttribute('data-' + name, value);
    try { localStorage.setItem(name, value); } catch (_) { /* storage blocked in this frame */ }
  };
  const pick = (value, allowed) => (allowed.includes(value) ? value : 'auto');
  const push = s => {
    publish('yta-unity', s.unity ? '1' : '0');
    publish('yta-audio', pick(s.audioCodec, ['aac', 'opus']));
    publish('yta-video', pick(s.videoCodec, ['h264', 'vp9', 'av1']));
    document.dispatchEvent(new Event('yta-settings'));
  };

  const load = () => api.storage.local.get(DEFAULTS).then(push, () => {});
  load();
  api.storage.onChanged.addListener((_changes, area) => { if (area === 'local') load(); });

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message.type !== 'yta-status' && message.type !== 'yta-apply')) return;
    if (message.type === 'yta-apply') push({ ...DEFAULTS, ...(message.settings || {}) });
    document.dispatchEvent(new Event('yta-query'));
    const root = document.documentElement;
    const reply = {
      pageScript: !!root && root.getAttribute('data-yta-page') === '1',
      status: (root && root.getAttribute('data-yta-status')) || ''
    };
    if (isTop) { sendResponse(reply); return; }
    // Embedded player on another site: answer late, so the page itself wins.
    if (!document.querySelector('video')) return;
    setTimeout(() => sendResponse(reply), 150);
    return true;
  });
})();

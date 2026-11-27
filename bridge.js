// SPDX-License-Identifier: MPL-2.0
// BAE. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// bridge.js: runs in the extension's own world on YouTube and Spotify pages.
(() => {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const DEFAULTS = {
    audioCodec: 'auto', videoCodec: 'auto',
    trueVolume: false, showCodec: false, showAttenuation: false, showSpeed: false, showBuffer: false,
    speed: 1, pitchCorrection: true, unity: false, crossfeed: 'off', beef: 'off', guardMode: 'limiter', audioPath: 'tap',
    outputId: '', outputLabel: ''
  };
  // setting -> attribute / localStorage name read by page.js
  const NAMES = {
    trueVolume: 'yta-truevol',
    showCodec: 'yta-showcodec',
    showAttenuation: 'yta-showatten',
    showSpeed: 'yta-showspeed',
    showBuffer: 'yta-showbuf',
    pitchCorrection: 'yta-pitch',
    unity: 'yta-unity'
  };
  const isTop = window === window.top;
  // ponytail: purist-only build. Only these three settings are honoured; everything else stays at
  // its neutral default, whatever an older full build left in storage.
  const lite = s => ({ ...DEFAULTS, unity: !!s.unity, audioCodec: s.audioCodec || 'auto', videoCodec: s.videoCodec || 'auto' });

  // Publish one value for page.js. Writing to the page and to localStorage is
  // not free, and most values are unchanged from one push to the next (a
  // dragged slider pushes dozens of times), so only real changes are written.
  const published = new Map();
  const publish = (name, value) => {
    if (published.get(name) === value) return;
    published.set(name, value);
    const root = document.documentElement;
    if (root) root.setAttribute('data-' + name, value);
    else published.delete(name); // no page yet: write it next time
    try { localStorage.setItem(name, value); } catch (_) { /* storage blocked in this frame */ }
  };
  const CHOICES = [
    ['audioCodec', 'yta-audio', ['aac', 'opus']],
    ['videoCodec', 'yta-video', ['h264', 'vp9', 'av1']],
    ['crossfeed', 'yta-xfeed', ['light', 'medium', 'strong']],
    ['beef', 'yta-beef', ['10', '20', '40']],
    ['audioPath', 'yta-path', ['capture', 'rebuild']],
    ['guardMode', 'yta-guardmode', ['off', 'cap']]
  ];
  const SWITCHES = Object.entries(NAMES);

  const push = settings => {
    for (const [key, name] of SWITCHES) publish(name, settings[key] ? '1' : '0');
    const speed = parseFloat(settings.speed);
    publish('yta-speed', String(Number.isFinite(speed) && speed >= 0.25 && speed <= 4 ? speed : 1));
    for (const [key, name, allowed] of CHOICES) {
      publish(name, allowed.includes(settings[key]) ? settings[key] : 'auto');
    }
    publish('yta-output', typeof settings.outputId === 'string' ? settings.outputId : '');
    document.dispatchEvent(new Event('yta-settings'));
  };

  // Ask page.js what is going on and read back its answer.
  const pageStatus = () => {
    document.dispatchEvent(new Event('yta-query'));
    const root = document.documentElement;
    return (root && root.getAttribute('data-yta-status')) || '';
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* --------------------------- audio output device --------------------------- */

  // Sending a media element's sound to a chosen device needs setSinkId, which
  // not every browser has. '' means "whatever the system output is".
  const canRoute = typeof HTMLMediaElement !== 'undefined' &&
    typeof HTMLMediaElement.prototype.setSinkId === 'function';
  // page.js does the actual switching, since it can reach media elements
  // that are not in the document. This side lists devices and keeps the choice.
  let current = { ...DEFAULTS };

  // What the popup needs to draw the output picker.
  async function outputs() {
    const outputId = current.outputId || '';
    const info = { supported: canRoute, devices: [], named: false, selected: outputId, current: outputId };
    const devices = navigator.mediaDevices;
    if (!canRoute || !devices || typeof devices.enumerateDevices !== 'function') return info;
    try {
      for (const device of await devices.enumerateDevices()) {
        if (device.kind !== 'audiooutput') continue;
        // Chrome's "default" and "communications" entries just mirror the system setting.
        if (!device.deviceId || device.deviceId === 'default' || device.deviceId === 'communications') continue;
        info.devices.push({ id: device.deviceId, label: device.label || '' });
      }
    } catch (_) { /* leave the list empty */ }
    info.named = info.devices.some(device => device.label);
    try {
      const status = JSON.parse(pageStatus());
      if (typeof status.sink === 'string') info.current = status.sink;
    } catch (_) { /* nothing playing yet */ }
    return info;
  }

  // Browsers only reveal output devices to a site that has been allowed to use
  // the microphone. Ask once, then switch the microphone straight off again.
  async function unlockOutputs() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
  }

  /* -------------------------------- settings -------------------------------- */

  // page.js changed the speed itself (Option + scroll or arrows). Keep the
  // published value in step and save it once the scrolling has settled.
  let saveTimer = null;
  document.addEventListener('yta-speed-request', () => {
    const root = document.documentElement;
    const speed = parseFloat(root && root.getAttribute('data-yta-speed-request'));
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return;
    if (current) current.speed = speed;
    publish('yta-speed', String(speed));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      Promise.resolve(api.storage.local.set({ speed })).catch(() => {});
    }, 300);
  });


  const load = () => api.storage.local.get(DEFAULTS).then(settings => {
    current = lite(settings);
    push(current);
  }, () => {});
  load();
  api.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') load();
  });

  /* ------------------------------ popup messages ------------------------------ */

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return;

    // Output picker: answered by the page itself, not by embedded frames.
    if (message.type === 'yta-outputs' || message.type === 'yta-output-set' || message.type === 'yta-output-unlock') {
      if (!isTop) return;
      let work = Promise.resolve();
      if (message.type === 'yta-output-set') {
        current.outputId = typeof message.id === 'string' ? message.id : '';
        current.outputLabel = String(message.label || '');
        push(current);
        work = Promise.resolve(api.storage.local.set({ outputId: current.outputId, outputLabel: current.outputLabel }))
          .catch(() => {})
          .then(() => pause(250)); // give the player a moment to switch
      } else if (message.type === 'yta-output-unlock') {
        work = unlockOutputs();
      }
      work.then(outputs, error => outputs().then(info => ({ ...info, error: (error && error.name) || 'Error' })))
        .then(sendResponse, () => sendResponse(null));
      return true;
    }

    if (message.type !== 'yta-status' && message.type !== 'yta-apply' && message.type !== 'yta-pad') return;
    if (message.type === 'yta-pad') {
      // Experimental gain above 0 dB. Deliberately not saved anywhere: it
      // lives on this page only and is gone when the page reloads.
      const db = Math.min(20, Math.max(0, Number(message.db) || 0));
      const html = document.documentElement;
      if (html) html.setAttribute('data-yta-pad', String(db));
      document.dispatchEvent(new Event('yta-settings'));
    }
    if (message.type === 'yta-apply') {
      current = lite({ ...current, ...(message.settings || {}) });
      push(current);
    }

    const status = pageStatus();
    const root = document.documentElement;
    const reply = {
      pageScript: !!root && root.getAttribute('data-yta-page') === '1',
      status
    };
    if (isTop) {
      sendResponse(reply);
      return;
    }
    // Embedded player on another site: answer late, so a YouTube page always wins.
    if (!document.querySelector('video')) return;
    setTimeout(() => sendResponse(reply), 150);
    return true;
  });
})();

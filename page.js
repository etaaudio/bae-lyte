// SPDX-License-Identifier: MPL-2.0
// BAE Lyte. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// page.js: runs in the page's own JavaScript world, before the site's code.
// It does two things and nothing else:
//   codec choice  tells the player the formats you didn't pick are unplayable
//   Purist        keeps every media element at full digital level (volume 1),
//                 so the site's loudness normalization can't turn it down
// Written from scratch for this extension. No third-party code.
(() => {
  'use strict';

  // If the browser ignored "world": "MAIN" we are in the extension's world,
  // where none of this would have any effect.
  const ext = globalThis.browser || globalThis.chrome;
  if (ext && ext.runtime && ext.runtime.id) return;
  if (window.__ytaPage) return;
  window.__ytaPage = true;

  /* -------------------------------- settings -------------------------------- */

  // bridge.js publishes each setting as data-<name> on <html>. Until it has,
  // fall back to the value remembered from the last page load.
  const root = () => document.documentElement;
  function read(name) {
    const el = root();
    let value = el ? el.getAttribute('data-' + name) : null;
    if (value === null) {
      try { value = localStorage.getItem(name); } catch (_) { value = null; }
    }
    return value || '';
  }
  const choice = (name, allowed) => (allowed.includes(read(name)) ? read(name) : 'auto');
  const settings = {};
  function load() {
    settings.unity = read('yta-unity') === '1';
    settings.audio = choice('yta-audio', ['aac', 'opus']);
    settings.video = choice('yta-video', ['h264', 'vp9', 'av1']);
  }
  load();

  const HOST = location.hostname || '';
  const SITE = /(^|\.)youtube(-nocookie)?\.com$/.test(HOST) ? 'youtube'
    : /(^|\.)spotify\.com$/.test(HOST) ? 'spotify' : 'other';

  root() && root().setAttribute('data-yta-page', '1');

  function wrap(owner, name, build) {
    if (owner && typeof owner[name] === 'function') owner[name] = build(owner[name]);
  }

  /* ------------- codec choice: report the other formats as unplayable ------------- */

  // YouTube asks the browser which formats it can play and picks from the
  // answers. Saying "no" to everything but the chosen family steers it there.
  // It can only narrow the choice, never add a format the browser lacks.
  const FAMILIES = {
    audio: { aac: /mp4a/, opus: /opus/ },
    video: { h264: /avc[13]/, vp9: /vp0?9/, av1: /av01/ }
  };
  const SAMPLES = {
    aac: ['audio/mp4; codecs="mp4a.40.2"'],
    opus: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'],
    h264: ['video/mp4; codecs="avc1.640028"'],
    vp9: ['video/webm; codecs="vp09.00.40.08"', 'video/mp4; codecs="vp09.00.40.08"'],
    av1: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"']
  };

  // The browser's own answer, taken before it is wrapped below. A family the
  // browser can't play is never forced, so a video always has something to play.
  const Source = window.MediaSource || window.ManagedMediaSource;
  const native = Source && typeof Source.isTypeSupported === 'function' ? Source.isTypeSupported.bind(Source) : null;
  const playableCache = {};
  function playable(pick) {
    if (pick === 'auto' || !native) return true;
    if (!(pick in playableCache)) {
      try { playableCache[pick] = SAMPLES[pick].some(type => native(type)); } catch (_) { playableCache[pick] = true; }
    }
    return playableCache[pick];
  }

  function refused(mime) {
    if (typeof mime !== 'string') return false;
    const low = mime.toLowerCase();
    const kind = low.startsWith('audio/') ? 'audio' : low.startsWith('video/') ? 'video' : '';
    const keep = kind && settings[kind];
    if (!keep || keep === 'auto' || !playable(keep)) return false;
    return Object.entries(FAMILIES[kind]).some(([family, pattern]) => family !== keep && pattern.test(low));
  }

  for (const S of [window.MediaSource, window.ManagedMediaSource]) {
    wrap(S, 'isTypeSupported', original => function (mime) {
      return refused(mime) ? false : original.apply(this, arguments);
    });
  }
  wrap(HTMLMediaElement.prototype, 'canPlayType', original => function (mime) {
    return refused(mime) ? '' : original.apply(this, arguments);
  });
  wrap(window.MediaCapabilities && window.MediaCapabilities.prototype, 'decodingInfo', original => function (config) {
    if (refused(config && config.audio && config.audio.contentType) || refused(config && config.video && config.video.contentType)) {
      return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
    }
    return original.apply(this, arguments);
  });

  // Remember the formats the player actually opens, for the popup.
  const opened = { audio: '', video: '' };
  for (const [Class, method] of [[window.MediaSource, 'addSourceBuffer'], [window.ManagedMediaSource, 'addSourceBuffer'],
    [window.SourceBuffer, 'changeType'], [window.ManagedSourceBuffer, 'changeType']]) {
    const proto = Class && Class.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, method)) continue;
    wrap(proto, method, original => function (mime) {
      if (typeof mime === 'string') {
        const kind = mime.slice(0, 5).toLowerCase();
        if (kind === 'audio' || kind === 'video') opened[kind] = mime;
      }
      return original.apply(this, arguments);
    });
  }

  /* ------------------- Purist: full digital level, always ------------------- */

  // The site writes (slider level x loudness factor) into the media element's
  // volume. With Purist on we let it believe that value was stored, and play
  // at 1 instead. A write of 0 (mute, or a fade to silence) is always honoured.
  const proto = HTMLMediaElement.prototype;
  const vol = Object.getOwnPropertyDescriptor(proto, 'volume');
  const patchable = !!(vol && vol.get && vol.set && vol.configurable);
  const requested = new WeakMap(); // element -> the value the site last wrote
  const getVol = el => vol.get.call(el);
  const setVol = (el, value) => vol.set.call(el, value);

  function hold(el) {
    if (!settings.unity) return;
    if (!requested.has(el)) requested.set(el, getVol(el));
    const level = requested.get(el) === 0 ? 0 : 1;
    if (getVol(el) !== level) setVol(el, level);
  }
  function release(el) {
    if (!requested.has(el)) return;
    setVol(el, Math.min(1, Math.max(0, requested.get(el))));
    requested.delete(el);
  }

  // Some players (Spotify's) keep their media element out of the document,
  // where a selector can't find it. Anything that plays is noted here.
  const known = new Set();
  const everyMedia = () => Array.from(new Set([...document.querySelectorAll('video, audio'), ...known]));

  if (patchable) {
    Object.defineProperty(proto, 'volume', {
      configurable: true,
      enumerable: vol.enumerable,
      get() { return settings.unity && requested.has(this) ? requested.get(this) : getVol(this); },
      set(value) {
        const n = Number(value);
        if (!settings.unity || !(this instanceof HTMLMediaElement) || !(n >= 0 && n <= 1)) {
          requested.delete(this);
          setVol(this, value); // also raises the browser's own errors
          return;
        }
        requested.set(this, n);
        hold(this);
      }
    });
    wrap(proto, 'play', original => function () {
      if (this instanceof HTMLMediaElement) { known.add(this); hold(this); }
      return original.apply(this, arguments);
    });
    for (const type of ['playing', 'loadeddata']) {
      document.addEventListener(type, event => {
        if (event.target instanceof HTMLMediaElement) hold(event.target);
      }, true);
    }
  }

  /* --------------------------- talking to bridge.js --------------------------- */

  document.addEventListener('yta-settings', () => {
    const was = settings.unity;
    load();
    if (patchable && settings.unity) everyMedia().forEach(hold);
    else if (patchable && was) everyMedia().forEach(release);
  });

  document.addEventListener('yta-query', () => {
    const el = root();
    if (!el) return;
    el.setAttribute('data-yta-page', '1');
    el.setAttribute('data-yta-status', JSON.stringify({
      site: SITE, unity: settings.unity, canPatch: patchable, audio: opened.audio, video: opened.video
    }));
  });
})();

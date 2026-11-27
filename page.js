// SPDX-License-Identifier: MPL-2.0
// BAE. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// page.js: runs in the page's own JavaScript world (YouTube or Spotify's web
// player), before the site's code.
// Written from scratch for this extension. No third-party code.
(() => {
  'use strict';

  // If the browser ignored "world": "MAIN" we are in the extension's world,
  // where none of this would have any effect.
  const ext = globalThis.browser || globalThis.chrome;
  if (ext && ext.runtime && ext.runtime.id) return;
  if (window.__ytaPage) return;
  window.__ytaPage = true;

  /* ------------------------------ settings ------------------------------ */

  const rootEl = () => document.documentElement;

  // bridge.js publishes each switch as data-<name>="0|1" on <html>. Until it
  // has done so, fall back to the value remembered from the last page load.
  function readSwitch(name) {
    const el = rootEl();
    let value = el ? el.getAttribute('data-' + name) : null;
    if (value !== '0' && value !== '1') {
      try { value = localStorage.getItem(name); } catch (_) { value = null; }
    }
    return value !== '0';
  }

  // A numeric setting published the same way, e.g. data-yta-speed="1.25".
  function readNumber(name, fallback) {
    const el = rootEl();
    let value = el ? el.getAttribute('data-' + name) : null;
    if (value === null || value === '') {
      try { value = localStorage.getItem(name); } catch (_) { value = null; }
    }
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= 0.25 && n <= 4 ? n : fallback;
  }

  // A text setting published the same way, e.g. data-yta-output="<device id>".
  function readText(name) {
    const el = rootEl();
    let value = el ? el.getAttribute('data-' + name) : null;
    if (value === null) {
      try { value = localStorage.getItem(name); } catch (_) { value = null; }
    }
    return typeof value === 'string' ? value : '';
  }

  // A setting that is one of a few named choices; anything else means 'auto'.
  function readChoice(name, allowed) {
    const value = readText(name);
    return allowed.includes(value) ? value : 'auto';
  }
  const AUDIO_CHOICES = ['aac', 'opus'];
  const VIDEO_CHOICES = ['h264', 'vp9', 'av1'];

  // Which player this is. The codec choice and the attenuation bypass are
  // YouTube-specific; codec readout, speed and output work on both.
  const HOST = (typeof location !== 'undefined' && location.hostname) || '';
  const SITE = /(^|\.)youtube(-nocookie)?\.com$/.test(HOST) ? 'youtube'
    : /(^|\.)spotify\.com$/.test(HOST) ? 'spotify' : 'other';

  // A switch that is off unless it has been turned on.
  function readOff(name) {
    const el = rootEl();
    let value = el ? el.getAttribute('data-' + name) : null;
    if (value !== '0' && value !== '1') {
      try { value = localStorage.getItem(name); } catch (_) { value = null; }
    }
    return value === '1';
  }

  const settings = {
    unity: readOff('yta-unity'),
    output: readText('yta-output'),
    speed: readNumber('yta-speed', 1),
    pitchCorrection: readSwitch('yta-pitch'),
    audioCodec: readChoice('yta-audio', AUDIO_CHOICES),
    videoCodec: readChoice('yta-video', VIDEO_CHOICES),
    trueVolume: readSwitch('yta-truevol'),
    showCodec: readSwitch('yta-showcodec'),
    showAttenuation: readSwitch('yta-showatten'),
    showSpeed: readSwitch('yta-showspeed'),
    showBuffer: readOff('yta-showbuf')
  };

  // Which way the sound is brought into the audio engine (see "other ways of
  // getting at the sound", further down). Read once, when the page loads.
  const PATH_CHOICES = ['capture', 'rebuild'];
  const audioPath = (() => {
    const value = readChoice('yta-path', PATH_CHOICES);
    return value === 'auto' ? 'tap' : value;
  })();
  // The rebuild path decodes the audio itself, and AAC is the format it reads.
  // So on that path YouTube is asked for AAC whatever the codec picker says;
  // otherwise it may send Opus and there would be nothing to work with.
  const audioChoice = () => (audioPath === 'rebuild' ? 'aac' : settings.audioCodec);

  function markAlive() {
    const el = rootEl();
    if (el) el.setAttribute('data-yta-page', '1');
  }
  markAlive();

  // Replace owner[name] with a wrapper built around the original function.
  function wrap(owner, name, build) {
    if (!owner || typeof owner[name] !== 'function') return;
    owner[name] = build(owner[name]);
  }

  /* ------------- codec choice: report the other formats as unplayable ------------- */

  // YouTube asks the browser which formats it can play and picks from the
  // answers. Saying "no" to everything but the chosen family steers it there.
  // This can only narrow the choice: it cannot add a format the browser lacks.
  const FAMILIES = {
    audio: { aac: /mp4a/, opus: /opus/ },
    video: { h264: /avc[13]/, vp9: /vp0?9/, av1: /av01/ }
  };
  // Real-world types per family, used to check the browser can play it at all.
  const SAMPLES = {
    aac: ['audio/mp4; codecs="mp4a.40.2"'],
    opus: ['audio/webm; codecs="opus"', 'audio/mp4; codecs="opus"'],
    h264: ['video/mp4; codecs="avc1.640028"'],
    vp9: ['video/webm; codecs="vp09.00.40.08"', 'video/mp4; codecs="vp09.00.40.08"'],
    av1: ['video/mp4; codecs="av01.0.08M.08"', 'video/webm; codecs="av01.0.08M.08"']
  };

  // The browser's own answer, taken before anything below changes it.
  const NativeSource = window.MediaSource || window.ManagedMediaSource;
  const nativeSupports = NativeSource && typeof NativeSource.isTypeSupported === 'function'
    ? NativeSource.isTypeSupported.bind(NativeSource) : null;
  const playableCache = {};

  // false when the browser itself can't play the chosen family. The choice is
  // then ignored, so a video never ends up with nothing it is allowed to play.
  function playable(choice) {
    if (choice === 'auto' || !nativeSupports || !SAMPLES[choice]) return true;
    if (!(choice in playableCache)) {
      try { playableCache[choice] = SAMPLES[choice].some(type => nativeSupports(type)); }
      catch (_) { playableCache[choice] = true; }
    }
    return playableCache[choice];
  }

  const FAMILY_LISTS = {
    audio: Object.entries(FAMILIES.audio),
    video: Object.entries(FAMILIES.video)
  };
  // The player asks about the same few dozen types over and over, so each
  // answer is worked out once and kept until the codec choice changes.
  const refusedCache = new Map();

  function refused(mime) {
    if (SITE !== 'youtube' || typeof mime !== 'string') return false;
    // With both choices on Auto (the default) nothing is ever refused.
    if (audioChoice() === 'auto' && settings.videoCodec === 'auto') return false;
    const cached = refusedCache.get(mime);
    if (cached !== undefined) return cached;
    const answer = decide(mime);
    if (refusedCache.size > 500) refusedCache.clear();
    refusedCache.set(mime, answer);
    return answer;
  }

  function decide(mime) {
    const low = mime.toLowerCase();
    const kind = low.startsWith('audio/') ? 'audio' : low.startsWith('video/') ? 'video' : '';
    if (!kind) return false;
    const keep = kind === 'audio' ? audioChoice() : settings.videoCodec;
    if (keep === 'auto' || !playable(keep)) return false;
    for (const [family, pattern] of FAMILY_LISTS[kind]) {
      if (family !== keep && pattern.test(low)) return true;
    }
    return false;
  }

  for (const Source of [window.MediaSource, window.ManagedMediaSource]) {
    wrap(Source, 'isTypeSupported', original => function (mime) {
      return refused(mime) ? false : original.apply(this, arguments);
    });
  }

  wrap(HTMLMediaElement.prototype, 'canPlayType', original => function (mime) {
    return refused(mime) ? '' : original.apply(this, arguments);
  });

  wrap(window.MediaCapabilities && window.MediaCapabilities.prototype, 'decodingInfo',
    original => function (config) {
      const audio = config && config.audio && config.audio.contentType;
      const video = config && config.video && config.video.contentType;
      if (refused(audio) || refused(video)) {
        return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
      }
      return original.apply(this, arguments);
    });

  // Remember the audio and video formats the player actually opens.
  let openedAudio = '';
  let openedVideo = '';
  function spy(Class, method) {
    const proto = Class && Class.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, method)) return;
    wrap(proto, method, original => function (mime) {
      if (typeof mime === 'string') {
        const kind = mime.slice(0, 6).toLowerCase();
        if (kind === 'audio/') openedAudio = mime;
        else if (kind === 'video/') openedVideo = mime;
      }
      return original.apply(this, arguments);
    });
  }
  spy(window.MediaSource, 'addSourceBuffer');
  spy(window.ManagedMediaSource, 'addSourceBuffer');
  spy(window.SourceBuffer, 'changeType');
  spy(window.ManagedSourceBuffer, 'changeType');

  /* ------------- true volume: the slider decides, not the loudness data ------------- */

  // YouTube writes (slider level x loudness factor) into the media element's
  // volume. We let it believe that value was stored, and store the slider
  // level instead.

  const mediaProto = HTMLMediaElement.prototype;
  const nativeVolume = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const patchable = !!(nativeVolume && nativeVolume.get && nativeVolume.set && nativeVolume.configurable);
  const nativeGet = el => nativeVolume.get.call(el);
  const nativeSet = (el, value) => nativeVolume.set.call(el, value);
  // On two of the experimental audio paths BAE plays an element's sound
  // itself. The element is then kept silent, and the level it would have had
  // is kept here and applied to BAE's own output instead. Everything below
  // reads and writes "the element's level" through rawGet and rawSet, so the
  // rest of the volume handling neither knows nor cares which is the case.
  const silenced = new WeakMap();  // element -> the level it would be playing at
  const levelNode = new WeakMap(); // element -> the gain node carrying that level
  const rawGet = el => (silenced.has(el) ? silenced.get(el) : nativeGet(el));
  function rawSet(el, value) {
    if (silenced.has(el)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0 && n <= 1) {
        silenced.set(el, n);
        carryLevel(el);
        recap(el);
        return;
      }
    }
    nativeSet(el, value); // also raises the browser's own errors
    recap(el);
  }

  const requested = new WeakMap();   // element -> value YouTube last wrote
  const listening = new WeakSet();   // players we already subscribed to
  const settling = new WeakSet();    // elements with a follow-up level check pending
  const PLAYER = '#movie_player, #shorts-player, .html5-video-player, ytmusic-player';
  const unit = n => Math.min(1, Math.max(0, n));
  const mediaIn = scope => Array.from(scope.querySelectorAll('video, audio'));

  function subscribe(player) {
    if (listening.has(player)) return;
    listening.add(player);
    try {
      player.addEventListener('onVolumeChange', () => mediaIn(player).forEach(el => apply(el)));
    } catch (_) { /* not an API player */ }
  }

  // The level the user picked, 0..1, or null if this isn't a YouTube player
  // (or it isn't ready yet).
  function sliderLevel(el) {
    const player = el && typeof el.closest === 'function' ? el.closest(PLAYER) : null;
    if (!player) return null;
    if (typeof player.getVolume === 'function') {
      try {
        const n = player.getVolume();
        if (Number.isFinite(n)) {
          subscribe(player);
          return unit(n / 100);
        }
      } catch (_) { /* fall through to the slider */ }
    }
    const slider = player.querySelector('.ytp-volume-panel[aria-valuenow]');
    const n = slider ? parseFloat(slider.getAttribute('aria-valuenow')) : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : null;
  }

  // Two ways of managing the level:
  //   bypass attenuation - play at the slider's level (YouTube only)
  //   0 dB               - play at full level, ignoring the slider too
  const managing = () => settings.trueVolume || settings.unity;

  // The level to play at, or null when this element should be left alone.
  function targetLevel(el) {
    if (settings.unity) return 1;
    return settings.trueVolume ? sliderLevel(el) : null;
  }

  // `target` is the level to play at when the caller has just worked it out.
  function apply(el, target) {
    if (!patchable || !managing() || !requested.has(el)) return;
    // Zero means mute or a fade to silence. Never override that.
    const level = requested.get(el) === 0 ? 0 : (target === undefined ? targetLevel(el) : target);
    if (level === null) {
      release(el); // nothing to enforce here: hand the volume back
      return;
    }
    if (Math.abs(rawGet(el) - level) > 0.001) rawSet(el, level);
  }

  // Start managing an element that already has a volume.
  function takeOver(el) {
    if (!requested.has(el)) {
      if (targetLevel(el) === null) return;
      requested.set(el, rawGet(el));
    }
    apply(el);
  }

  // Stop managing: put back the value YouTube wanted.
  function release(el) {
    if (!requested.has(el)) return;
    const value = requested.get(el);
    requested.delete(el);
    rawSet(el, unit(value));
  }

  if (patchable) {
    Object.defineProperty(mediaProto, 'volume', {
      configurable: true,
      enumerable: nativeVolume.enumerable,
      get() {
        return managing() && requested.has(this) ? requested.get(this) : rawGet(this);
      },
      set(value) {
        const n = Number(value);
        const level = managing() && this instanceof HTMLMediaElement &&
          Number.isFinite(n) && n >= 0 && n <= 1 ? targetLevel(this) : null;
        if (level === null) {
          requested.delete(this);
          rawSet(this, value);            // also raises the browser's own errors
          return;
        }
        requested.set(this, n);
        apply(this, level);
        // The player may update its level just after. One follow-up check per
        // element is enough, however many writes arrive in a burst (a fade).
        if (!settling.has(this)) {
          settling.add(this);
          setTimeout(() => {
            settling.delete(this);
            apply(this);
          }, 10);
        }
      }
    });

    for (const type of ['playing', 'loadeddata']) {
      document.addEventListener(type, event => {
        if (managing() && event.target instanceof HTMLMediaElement) takeOver(event.target);
      }, true);
    }
  }

  /* ----------------------- talking to bridge.js ----------------------- */

  // The element the user is actually listening to. Muted ones (hover
  // previews, looping artwork) only count when nothing else is playing.
  let lastCurrent = null;
  function currentMedia() {
    // While the element found last time is still playing aloud, it is still
    // the answer, and the page doesn't need searching again.
    const last = lastCurrent;
    if (last && !last.paused && !last.muted && (last.isConnected || known.has(last))) return last;
    const all = everyMedia();
    lastCurrent = all.find(m => !m.paused && !m.muted) || all.find(m => !m.paused) ||
      all.find(m => requested.has(m)) || all[0] || null;
    return lastCurrent;
  }

  document.addEventListener('yta-settings', () => {
    const speedBefore = effSpeed();
    settings.audioCodec = readChoice('yta-audio', AUDIO_CHOICES);
    settings.videoCodec = readChoice('yta-video', VIDEO_CHOICES);
    refusedCache.clear();
    settings.showCodec = readSwitch('yta-showcodec');
    settings.showAttenuation = readSwitch('yta-showatten');
    settings.showSpeed = readSwitch('yta-showspeed');
    settings.showBuffer = readOff('yta-showbuf');
    const wasManaging = managing();
    settings.trueVolume = readSwitch('yta-truevol');
    settings.unity = readOff('yta-unity');
    const all = everyMedia(); // one search of the page serves everything below
    if (patchable) {
      if (managing()) all.forEach(el => takeOver(el));
      else if (wasManaging) all.forEach(el => release(el));
    }
    settings.speed = readNumber('yta-speed', 1);
    const speedChanged = effSpeed() !== speedBefore;
    settings.pitchCorrection = readSwitch('yta-pitch');
    settings.output = readText('yta-output');
    settings.pad = readPad();
    settings.crossfeed = readFeed();
    settings.beef = readBeef();
    settings.guard = readGuard();
    for (const media of all) {
      applySpeed(media, speedChanged);
      route(media);
      if (!media.muted) applyPad(media);
      restPath(media);
      if (rebuilds.has(media)) pump(rebuilds.get(media));
    }
    refreshBadge();
  });

  document.addEventListener('yta-query', () => {
    const el = rootEl();
    if (!el) return;
    markAlive();
    const status = {
      site: SITE,
      audioCodec: settings.audioCodec,
      audioForced: audioChoice() !== settings.audioCodec ? audioChoice() : '',
      videoCodec: settings.videoCodec,
      audioOk: playable(settings.audioCodec),
      videoOk: playable(settings.videoCodec),
      trueVolume: settings.trueVolume,
      canPatch: patchable,
      audio: openedAudio,
      video: openedVideo
    };
    const media = currentMedia();
    if (media) {
      const now = levels(media);
      status.real = now.real;
      status.asked = now.youtube;
      status.user = now.user;
      status.muted = media.muted;
      status.unity = settings.unity;
      status.pad = settings.pad;
      status.guardMode = settings.guard;
      status.padApplied = Math.round(appliedPad(media) * 10) / 10;
      status.beefRoom = beefRoomDb();
      status.crossfeed = settings.crossfeed;
      status.beef = settings.beef;
      status.guard = effGuard() && padded.has(media) && padded.get(media).guarded;
      status.guardDb = Math.round(guardDb(media) * 10) / 10;
      status.padOn = padded.has(media);
      status.padState = engine ? engine.state : '';
      status.padCan = !!AudioEngine;
      status.path = audioPath;
      status.pathReport = pathReport(media);
      status.pathFigures = pathFigures(media);
      status.buffer = Math.round(bufferAhead(media) * 10) / 10;
      listen(media);
      status.padDeaf = deaf(media);
      status.padHeard = !!(padded.has(media) && padded.get(media).heard);
      status.padError = engineError;
      status.padMisses = glideMisses;
      status.padFade = stepped ? 'stepped' : 'scheduled';
      status.padWaiting = waiting.has(media);
      status.rate = media.playbackRate;
      status.pitch = pitchOf(media);
      status.sink = media.sinkId || '';
    }
    el.setAttribute('data-yta-status', JSON.stringify(status));
  });

  /* ----------------------- speed, with or without pitch correction ----------------------- */

  const PITCH_PROPS = ['preservesPitch', 'webkitPreservesPitch', 'mozPreservesPitch'];

  // true: pitch stays put when the speed changes. false: pitch follows the
  // speed, like tape. null: this browser has no such control.
  function pitchOf(media) {
    for (const prop of PITCH_PROPS) if (prop in media) return !!media[prop];
    return null;
  }

  // Guard against a tug-of-war with the player: at most 20 corrections a second.
  let rateWindow = 0;
  let rateWrites = 0;

  // With the speed at 1x the player's own speed menu is left alone, unless
  // `force` says we are deliberately going back to 1x.
  // The speed actually wanted. The purist setting (0 dB bypass) switches the
  // speed and pitch controls off as well: 1x, pitch handling as the browser ships it.
  const effSpeed = () => (settings.unity ? 1 : settings.speed);

  function applySpeed(media, force) {
    try {
      const keepPitch = settings.unity ? true : settings.pitchCorrection;
      for (const prop of PITCH_PROPS) {
        if (prop in media && media[prop] !== keepPitch) media[prop] = keepPitch;
      }
      if (effSpeed() === 1 && !force) return;
      if (Math.abs(media.playbackRate - effSpeed()) < 0.001) return;
      const now = Date.now();
      if (now - rateWindow > 1000) { rateWindow = now; rateWrites = 0; }
      // Only automatic corrections are rate-limited; a change the user made always applies.
      if (!force && ++rateWrites > 20) return;
      media.playbackRate = effSpeed();
    } catch (_) { /* this element can't be adjusted */ }
  }

  // While a speed is chosen here, the site's own writes to playbackRate are
  // replaced by it, so the player can't quietly reset it. At 1x they pass.
  const nativeRate = Object.getOwnPropertyDescriptor(mediaProto, 'playbackRate');
  if (nativeRate && nativeRate.get && nativeRate.set && nativeRate.configurable) {
    Object.defineProperty(mediaProto, 'playbackRate', {
      configurable: true,
      enumerable: nativeRate.enumerable,
      get: nativeRate.get, // reads go straight to the browser
      set(value) {
        const ours = effSpeed() !== 1 && this instanceof HTMLMediaElement;
        nativeRate.set.call(this, ours ? effSpeed() : value);
      }
    });
  }

  /* ----------------------------- audio output device ----------------------------- */

  // '' means the system output. Fails quietly when the device is unplugged
  // or the browser has no per-element output control.
  function route(media) {
    try {
      if (typeof media.setSinkId !== 'function') return;
      if ((media.sinkId || '') === settings.output) return;
      const done = media.setSinkId(settings.output);
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch (_) { /* stay on the current output */ }
  }

  /* --------------------- every media element, attached or not --------------------- */

  // Some players (Spotify's) keep their media element out of the document,
  // where neither a selector nor a document-level listener can reach it.
  // Anything that starts playing is noted here instead.
  const known = new Set();

  function everyMedia() {
    const all = new Set(mediaIn(document));
    for (const media of known) all.add(media);
    return Array.from(all);
  }

  function register(media) {
    if (known.has(media)) return;
    known.add(media);
    for (const type of ['playing', 'loadeddata', 'ratechange']) {
      media.addEventListener(type, () => {
        applySpeed(media, false);
        route(media);
      });
    }
    applySpeed(media, false);
    route(media);
    if (patchable && managing()) takeOver(media);
  }

  wrap(mediaProto, 'play', original => function () {
    try { register(this); } catch (_) { /* not a media element */ }
    return original.apply(this, arguments);
  });

  for (const type of ['playing', 'loadeddata', 'ratechange']) {
    document.addEventListener(type, event => {
      if (!(event.target instanceof HTMLMediaElement)) return;
      applySpeed(event.target, false);
      route(event.target);
    }, true);
  }

  /* ------------- experimental: padded bits and crossfeed (audio engine) ------------- */

  // These need the sound to pass through the browser's audio engine:
  //   padded bits - gain above 0 dB, which a media element's volume can't do
  //   crossfeed   - a little of each channel, low-passed and slightly late,
  //                 mixed into the other, the way speakers reach both ears
  //   B-Mode      - a bass shelf
  // That reroutes the audio, so nothing is set up until one of them is asked
  // for, and once set up it lasts until the page reloads. Padded bits is never
  // saved: every page load starts at 0 dB. Crossfeed is an ordinary setting.
  const PAD_MAX_DB = 20;
  const FEED_CHOICES = ['light', 'medium', 'strong'];
  // How far below the direct sound the crossfed sound sits at low frequencies.
  const FEED_DB = { light: 9.5, medium: 6, strong: 4.5 };
  const FEED_CUTOFF_HZ = 700;
  const FEED_DELAY_S = 0.00028; // roughly the extra path to the far ear

  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  let engine = null;
  const padded = new WeakMap(); // media element -> its processing chain
  const waiting = new Set();    // elements to reroute once the engine may run

  function readPad() {
    const el = rootEl();
    const db = parseFloat(el ? el.getAttribute('data-yta-pad') : '');
    return Number.isFinite(db) ? Math.min(PAD_MAX_DB, Math.max(0, db)) : 0;
  }
  settings.pad = 0;
  settings.crossfeed = readChoice('yta-xfeed', FEED_CHOICES);
  if (settings.crossfeed === 'auto') settings.crossfeed = 'off';
  const readFeed = () => {
    const value = readChoice('yta-xfeed', FEED_CHOICES);
    return value === 'auto' ? 'off' : value;
  };

  // B-Mode: a gentle bass shelf in the manner of the analogue bass
  // correction on high-end headphone amplifiers. The setting names the
  // frequency at which the lift reaches 12 dB; it keeps rising a little below
  // that and fades out above. 10 Hz is the mildest, 40 Hz the heaviest.
  const BEEF_CHOICES = ['10', '20', '40'];
  const BEEF_AT_DB = 12;   // lift at the named frequency
  const BEEF_TOP_DB = 14;  // where the shelf levels off, further down
  // An analogue circuit has headroom above full level; digital audio has
  // none. The whole signal is turned down by this much so the lift has room.
  const BEEF_ROOM_DB = 12;
  const readBeef = () => {
    const value = readChoice('yta-beef', BEEF_CHOICES);
    return value === 'auto' ? 'off' : value;
  };
  settings.beef = readBeef();

  // Clip guard: a limiter on the way out, so that whatever padded bits and
  // B-Mode add, peaks are held under full scale instead of being cut off flat.
  // It is only in the path while one of those two could push past full scale.
  const GUARD_RATIO = 20;        // the steepest the browser's compressor goes
  const GUARD_CEILING_DB = -0.3; // where the loudest possible peak should land
  // Two ways of guarding against clipping, or neither:
  //   limiter  let the gain through and hold individual peaks down as they come
  //   cap      never add more gain than there is room for, so nothing needs holding down
  const readGuard = () => {
    const value = readChoice('yta-guardmode', ['off', 'cap']);
    return value === 'auto' ? 'limiter' : value;
  };
  settings.guard = readGuard();

  // Purist supersedes all three: no gain, no crossfeed, no bass lift.
  const effPad = () => (settings.unity ? 0 : settings.pad);
  const effFeed = () => (settings.unity ? 'off' : settings.crossfeed);
  const effBeef = () => (settings.unity ? 'off' : settings.beef);
  const wantsEngine = () => effPad() > 0 || effFeed() !== 'off' || effBeef() !== 'off';
  // How far past full scale the current settings could push a full-level
  // signal, in dB. B-Mode lifts up to BEEF_TOP_DB but gives BEEF_ROOM_DB back.
  const overshootDb = () => effPad() + (effBeef() === 'off' ? 0 : BEEF_TOP_DB - BEEF_ROOM_DB);
  const effGuard = () => settings.guard === 'limiter' && overshootDb() > 0;

  // The cap works from how much room there is. A video's sound reaches the
  // engine already turned down by its volume (the slider, and YouTube's
  // normalization where that isn't bypassed), and sound can't arrive above
  // full level. So the room under full level is exactly that turn-down, and
  // gain up to that much cannot clip. Nothing is measured and nothing is
  // processed: it is arithmetic on a number already known.
  function headroomDb(media) {
    let level = 1;
    // (Mute is ignored on purpose: unmuting would otherwise bring the sound back
    // a moment before the gain had come down again.)
    try { level = patchable ? rawGet(media) : media.volume; } catch (_) { level = 1; }
    if (!(level > 0)) return Infinity; // turned right down: any gain is safe
    return Math.max(0, -20 * Math.log10(Math.min(1, level)));
  }
  // The padded-bits gain actually applied to this element, in dB.
  function appliedPad(media) {
    const asked = effPad();
    if (settings.guard !== 'cap' || !media) return asked;
    return Math.min(asked, headroomDb(media));
  }
  // B-Mode gives up some level to make room for its lift. With the limiter
  // (or no guard) it gives up 12 dB and may overshoot by 2; under the cap it
  // gives up the full 14, so the lift never passes full level either.
  const beefRoomDb = () => (settings.guard === 'cap' ? BEEF_TOP_DB : BEEF_ROOM_DB);
  // The video's level changed: under the cap, the room changed with it.
  function recap(el) {
    if (settings.guard !== 'cap' || !padded.has(el)) return;
    try { tune(padded.get(el)); } catch (_) { /* keeps its last setting */ }
  }

  // The last thing that went wrong while starting or wiring the engine, kept
  // so the popup can say what it was instead of failing silently.
  let engineError = '';
  function noteError(where, error) {
    const text = error && (error.name || error.message) ? (error.name || 'Error') + ': ' + (error.message || '') : String(error);
    engineError = (where + ' - ' + text).slice(0, 200);
  }

  // Safari reports 'interrupted' as well as 'suspended'; either way it needs
  // waking, so anything that isn't running (or closed for good) gets a resume.
  function wakeEngine() {
    try {
      if (engine && engine.state !== 'running' && engine.state !== 'closed') {
        const done = engine.resume();
        if (done && typeof done.then === 'function') done.then(attachWaiting, error => noteError('resume', error));
      }
    } catch (error) { noteError('resume', error); }
  }

  // A one-pole low-pass for the crossfed sound, as in the classic circuits.
  function lowpass() {
    if (typeof engine.createIIRFilter === 'function') {
      const a = Math.exp(-2 * Math.PI * FEED_CUTOFF_HZ / engine.sampleRate);
      return engine.createIIRFilter([1 - a], [1, -a]);
    }
    const filter = engine.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FEED_CUTOFF_HZ;
    filter.Q.value = 0.5;
    return filter;
  }

  // A first-order shelf: one zero and one pole, placed so the lift is exactly
  // BEEF_AT_DB at `hz` and levels off at BEEF_TOP_DB below it.
  function beefShelf(hz) {
    const top = Math.pow(10, BEEF_TOP_DB / 20);
    const at = Math.pow(10, BEEF_AT_DB / 10);
    const pole = hz * Math.sqrt((at - 1) / (top * top - at));
    const zero = pole * top;
    if (typeof engine.createIIRFilter === 'function') {
      const kp = Math.tan(Math.PI * pole / engine.sampleRate);
      const kz = Math.tan(Math.PI * zero / engine.sampleRate);
      return engine.createIIRFilter([1 + kz, kz - 1], [1 + kp, kp - 1]);
    }
    const filter = engine.createBiquadFilter(); // nearest stock shape
    filter.type = 'lowshelf';
    filter.frequency.value = Math.sqrt(pole * zero);
    filter.gain.value = BEEF_TOP_DB;
    return filter;
  }

  // Every change of level or route is a short fade, never a jump: a jump in
  // the waveform is a click. There are two ways to fade:
  //
  //   scheduled - ask the audio engine to ramp (pin the current value, then
  //               ramp from it). Sample-accurate. Chrome and Firefox do this.
  //   stepped   - walk the value there in small steps from here. Safari's
  //               engine has been seen to ignore scheduled ramps on these
  //               nodes, and this is what it gets instead.
  //
  // Which one to use is found out, not assumed: every scheduled fade is
  // checked shortly afterwards. If the value didn't arrive it is set outright
  // and this browser is switched to stepped fades from then on (remembered
  // for next time), so a setting is never silently ignored.
  const FADE_S = 0.03;
  const STEPS = 10;        // stepped fade: this many steps...
  const STEP_GAP_MS = 4;   // ...this far apart, about 40 ms in all
  const aimed = new WeakMap(); // param -> the value it was last asked to reach
  let glideMisses = 0;         // how often a scheduled fade had to be corrected
  let stepped = false;
  try { stepped = localStorage.getItem('yta-stepfade') === '1'; } catch (_) { /* decide again this time */ }

  function stepFade(param, value) {
    const from = Number(param.value);
    if (!Number.isFinite(from) || Math.abs(from - value) < 1e-6) {
      param.value = value;
      return;
    }
    let step = 0;
    const tick = () => {
      if (aimed.get(param) !== value) return; // superseded by a later change
      step++;
      param.value = step >= STEPS ? value : from + (value - from) * step / STEPS;
      if (step < STEPS) setTimeout(tick, STEP_GAP_MS);
    };
    tick();
  }

  function glide(param, value) {
    aimed.set(param, value);
    const sounding = engine.state === 'running';
    if (!sounding) { // nothing is playing through it: no click to avoid
      param.value = value;
      return;
    }
    if (stepped) {
      stepFade(param, value);
      return;
    }
    let scheduled = false;
    try {
      const now = engine.currentTime;
      if (Number.isFinite(now) && typeof param.linearRampToValueAtTime === 'function') {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(value, now + FADE_S);
        scheduled = true;
      }
    } catch (_) { scheduled = false; }
    if (!scheduled) {
      stepFade(param, value);
      return;
    }
    setTimeout(() => {
      if (aimed.get(param) !== value) return; // superseded by a later change
      if (Math.abs(param.value - value) <= 1e-3 * Math.max(1, Math.abs(value))) return;
      try { param.cancelScheduledValues(0); } catch (_) { /* nothing scheduled */ }
      param.value = value;
      glideMisses++;
      if (!stepped) {
        stepped = true;
        try { localStorage.setItem('yta-stepfade', '1'); } catch (_) { /* found again next time */ }
      }
    }, 150);
  }

  function cut(node) {
    try { if (node && typeof node.disconnect === 'function') node.disconnect(); } catch (_) { /* already apart */ }
  }

  // The route has two forks, each with a plain path and a processed path side
  // by side, and a pair of gains that fade between them:
  //
  //   source -> pre -+-> flat ----------+-> split L/R -> (direct + crossfed) -> merge -> gain -+-> thru -----------+-> output
  //                  +-> shelf -> out --+                                                      +-> limiter -> trim -+
  //
  // B-Mode fades from `flat` to the shelf; clip guard fades from `thru` to the
  // limiter. Nothing is ever unplugged while it is carrying sound.
  function buildChain(media) {
    const source = openSource(media);
    const split = engine.createChannelSplitter(2);
    const merge = engine.createChannelMerger(2);
    const gain = engine.createGain();
    const chain = { gain, direct: [], cross: [], split, pre: null, flat: null, shelf: null, shelfOut: null,
      beef: 'off', thru: null, limiter: null, trim: null, guarded: false, media };
    for (const side of [0, 1]) {
      const direct = engine.createGain();
      split.connect(direct, side);
      direct.connect(merge, 0, side);
      const filter = lowpass();
      const delay = engine.createDelay(0.01);
      delay.delayTime.value = FEED_DELAY_S;
      const cross = engine.createGain();
      split.connect(filter, side);
      filter.connect(delay);
      delay.connect(cross);
      cross.connect(merge, 0, 1 - side); // into the opposite channel
      chain.direct.push(direct);
      chain.cross.push(cross);
    }
    merge.connect(gain);
    chain.pre = engine.createGain();
    source.connect(chain.pre);
    chain.flat = engine.createGain();
    chain.pre.connect(chain.flat);
    chain.flat.connect(split);
    chain.thru = engine.createGain();
    gain.connect(chain.thru);
    chain.thru.connect(engine.destination);
    // An ear on the incoming sound, used only to find out whether any arrives
    // (see listen below). It leads to the output through a closed gain so the
    // engine keeps it running without it being heard.
    if (typeof engine.createAnalyser === 'function') {
      chain.ear = engine.createAnalyser();
      chain.ear.fftSize = 1024;
      const closed = engine.createGain();
      closed.gain.value = 0;
      source.connect(chain.ear);
      chain.ear.connect(closed);
      closed.connect(engine.destination);
    }
    padded.set(media, chain);
    return chain;
  }

  function tune(chain) {
    glide(chain.gain.gain, Math.pow(10, appliedPad(chain.media) / 20)); // dB -> multiplier
    const feed = effFeed();
    // Scaled so the two paths never add up to more than full level.
    const amount = feed === 'off' ? 0 : Math.pow(10, -FEED_DB[feed] / 20);
    for (const node of chain.direct) glide(node.gain, 1 / (1 + amount));
    for (const node of chain.cross) glide(node.gain, amount / (1 + amount));

    const beef = effBeef();
    if (chain.beef !== beef) {
      // Fade the old shelf out and take it apart once it is silent.
      const oldShelf = chain.shelf;
      const oldOut = chain.shelfOut;
      if (oldOut) {
        glide(oldOut.gain, 0);
        setTimeout(() => {
          try { chain.pre.disconnect(oldShelf); } catch (_) { /* already apart */ }
          cut(oldShelf);
          cut(oldOut);
        }, 250);
      }
      chain.shelf = null;
      chain.shelfOut = null;
      if (beef !== 'off') {
        chain.shelf = beefShelf(Number(beef));
        chain.shelfOut = engine.createGain();
        chain.shelfOut.gain.value = 0; // joins the route silent, then fades in
        chain.pre.connect(chain.shelf);
        chain.shelf.connect(chain.shelfOut);
        chain.shelfOut.connect(chain.split);
        glide(chain.shelfOut.gain, 1);
      }
      glide(chain.flat.gain, beef === 'off' ? 1 : 0);
      chain.beef = beef;
    }
    glide(chain.pre.gain, beef === 'off' ? 1 : Math.pow(10, -beefRoomDb() / 20));

    // The browser's compressor, set up as a limiter: nothing happens below the
    // threshold, and above it the level rises only 1 dB for every GUARD_RATIO.
    // The threshold is placed so that even the worst case the current settings
    // allow lands at GUARD_CEILING_DB. The compressor also adds a fixed "makeup"
    // gain of its own; `trim` takes exactly that back out, so quiet passages
    // pass through at the level they came in.
    const guard = effGuard() && typeof engine.createDynamicsCompressor === 'function';
    if (guard && !chain.limiter) {
      chain.limiter = engine.createDynamicsCompressor();
      chain.limiter.knee.value = 0;
      chain.limiter.ratio.value = GUARD_RATIO;
      chain.limiter.attack.value = 0.001;
      chain.limiter.release.value = 0.1;
      chain.trim = engine.createGain();
      chain.trim.gain.value = 0; // joins the route silent, then fades in
      chain.gain.connect(chain.limiter);
      chain.limiter.connect(chain.trim);
      chain.trim.connect(engine.destination);
    }
    if (chain.limiter) {
      let level = 0;
      if (guard) {
        const slope = 1 - 1 / GUARD_RATIO;
        const threshold = (GUARD_CEILING_DB - overshootDb() / GUARD_RATIO) / slope;
        glide(chain.limiter.threshold, threshold);
        const makeupDb = -0.6 * threshold * slope; // as the Web Audio specification defines it
        level = Math.pow(10, -makeupDb / 20);
      }
      glide(chain.trim.gain, level);
    }
    glide(chain.thru.gain, guard ? 0 : 1);
    chain.guarded = guard;
  }

  // Some browsers keep playing a video themselves and hand the audio engine
  // only silence (Safari does this for streamed video, which is what YouTube
  // and Spotify are). Nothing here can then have any effect, and the honest
  // thing is to say so. So each chain is listened to: once any sound at all
  // has come through it is known to work; if a video has been playing aloud
  // for a few seconds and not one sample has arrived, it is known not to.
  const DEAF_AFTER_MS = 3000;
  let earBuffer = null;

  function listen(media) {
    const chain = padded.get(media);
    if (!chain || !chain.ear || chain.heard) return;
    const aloud = !media.paused && !media.muted && !(media.readyState < 3) &&
      (patchable ? rawGet(media) : media.volume) > 0 && engine.state === 'running';
    const now = Date.now();
    if (!aloud) { chain.checked = 0; return; }
    // On the paths where BAE plays the sound itself, silence only counts
    // while BAE is the one that should be playing it, not while it is still
    // getting ready or has handed the sound back to the video.
    const rb = rebuilds.get(media);
    if (rb && (!rb.anchor || rb.failed || rb.resting)) { chain.checked = 0; return; }
    if (captureOut.has(media) && !silenced.has(media)) { chain.checked = 0; return; }
    try {
      if (!earBuffer || earBuffer.length !== chain.ear.fftSize) earBuffer = new Float32Array(chain.ear.fftSize);
      chain.ear.getFloatTimeDomainData(earBuffer);
      for (let i = 0; i < earBuffer.length; i++) {
        if (earBuffer[i] !== 0) { chain.heard = true; return; }
      }
    } catch (_) { return; }
    if (chain.checked) chain.silentMs = (chain.silentMs || 0) + Math.min(now - chain.checked, 2000);
    chain.checked = now;
  }

  // true when this element's sound is known not to reach the engine.
  function deaf(media) {
    const chain = padded.get(media);
    return !!chain && !!chain.ear && !chain.heard && (chain.silentMs || 0) >= DEAF_AFTER_MS;
  }

  // How much the clip guard is holding back right now, in dB (0 or more).
  function guardDb(media) {
    const chain = padded.get(media);
    if (!chain || !chain.guarded) return 0;
    if (media.paused) return 0; // the limiter keeps its last reading while nothing plays; that isn't "right now"
    const reduction = Number(chain.limiter.reduction);
    return Number.isFinite(reduction) && reduction < 0 ? -reduction : 0;
  }

  // The browser holds a new audio engine silent until the user has touched
  // the page. Rerouting before then would mute the video, so elements wait
  // here and play normally until the engine is actually running.
  function attachWaiting() {
    if (!engine || engine.state !== 'running') return;
    for (const media of Array.from(waiting)) {
      waiting.delete(media);
      try { if (!padded.has(media)) tune(buildChain(media)); }
      catch (error) {
        noteError('wiring', error);
        if (!padded.has(media)) unsilence(media);     // never leave an element silent with nothing playing for it
        if (error && error.retry) waiting.add(media); // not ready yet: try again on the next nudge
      }
    }
  }

  function applyPad(media) {
    if (padded.has(media)) {
      try { tune(padded.get(media)); } catch (error) { noteError('settings', error); }
      wakeEngine();
      return;
    }
    if (!wantsEngine() || !AudioEngine) return; // leave the audio path alone until asked
    try {
      if (!engine) {
        engine = new AudioEngine();
        if (typeof engine.addEventListener === 'function') engine.addEventListener('statechange', attachWaiting);
      }
      waiting.add(media);
      wakeEngine();
      attachWaiting();
    } catch (error) { noteError('start', error); }
  }

  // Browsers differ on which events count as the user touching the page, so
  // every likely one is tried; each is a no-op once the engine is running.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchend', 'keydown', 'keyup']) {
    document.addEventListener(type, () => {
      wakeEngine();
      attachWaiting();
    }, true);
  }
  document.addEventListener('playing', event => {
    if (wantsEngine() && event.target instanceof HTMLMediaElement && !event.target.muted) applyPad(event.target);
  }, true);

  /* ------------- experimental: other ways of getting at the sound ------------- */

  // Everything above needs the video's sound inside the audio engine. There
  // is more than one way to get it there, and browsers differ in which work:
  //
  //   tap      ask the browser to route the element into the engine. The
  //            standard way. Safari hands over only silence for streamed
  //            video, which is what YouTube and Spotify are.
  //   capture  ask the browser for a live stream of the element's sound.
  //   rebuild  don't ask the browser for the sound at all: read the audio
  //            stream as the player downloads it, decode it here, and play
  //            it through the engine in step with the picture.
  //
  // The choice is read once, when the page loads (near the top of this file),
  // because the first and last need setting up before the player starts.

  function silence(el) {
    if (silenced.has(el)) return;
    silenced.set(el, nativeGet(el));
    nativeSet(el, 0);
  }
  function unsilence(el) {
    if (!silenced.has(el)) return;
    const level = silenced.get(el);
    silenced.delete(el);
    levelNode.delete(el);
    nativeSet(el, unit(level));
  }
  // Put the element's level (and mute) onto the node that now carries it.
  function carryLevel(el) {
    const node = levelNode.get(el);
    if (!node || !silenced.has(el)) return;
    const level = el.muted ? 0 : silenced.get(el);
    if (engine) glide(node.gain, level); else node.gain.value = level;
  }
  // From here on `node` plays this element's sound: silence the element and
  // let the node carry its level and mute instead.
  const levelWatched = new WeakSet();
  function takeSound(media, node) {
    if (silenced.has(media)) return;
    silence(media);
    levelNode.set(media, node);
    node.gain.value = media.muted ? 0 : silenced.get(media);
    if (!levelWatched.has(media)) {
      levelWatched.add(media);
      media.addEventListener('volumechange', () => carryLevel(media));
    }
  }

  // How far ahead of the playhead the browser has the video downloaded, in
  // seconds. The same on every audio path.
  function bufferAhead(media) {
    try {
      const ranges = media.buffered;
      const now = media.currentTime;
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= now + 0.1 && ranges.end(i) > now) return ranges.end(i) - now;
      }
    } catch (_) { /* no ranges to read */ }
    return 0;
  }

  // On the rebuild path: how much sound BAE has decoded ahead of the playhead.
  // null on the other paths, which have no such stage.
  function decodedAhead(media) {
    const rb = rebuilds.get(media);
    if (!rb || rb.failed) return null;
    const now = media.currentTime;
    let end = now;
    for (const chunk of rb.ready) if (chunk.t <= end + 0.05 && chunk.t + chunk.dur > end) end = chunk.t + chunk.dur;
    return Math.max(0, end - now);
  }

  // On the capture and rebuild paths BAE plays the sound itself. When there
  // is nothing to process (Purist is on, or every effect is off) that would
  // be processing for its own sake, so the sound is handed back to the video
  // element and plays the way the browser plays it, untouched.
  const captureOut = new WeakMap(); // element -> the node playing its captured sound
  function restPath(media) {
    const node = captureOut.get(media);
    if (!node) return; // the rebuild path looks after itself, in pump
    if (wantsEngine()) {
      takeSound(media, node);
      carryLevel(media);
    } else if (silenced.has(media)) {
      unsilence(media);
      glide(node.gain, 0);
    }
  }

  function openSource(media) {
    if (audioPath === 'capture') return captureSource(media);
    if (audioPath === 'rebuild') return rebuildSource(media);
    return engine.createMediaElementSource(media);
  }

  /* capture */

  function captureSource(media) {
    const grab = media.captureStream || media.mozCaptureStream;
    if (typeof grab !== 'function') throw new Error("this browser can't capture a video's sound (no captureStream)");
    const stream = grab.call(media);
    if (!stream.getAudioTracks().length) {
      const error = new Error('the video has no sound track yet');
      error.retry = true; // try again when it starts playing
      throw error;
    }
    const tapped = engine.createMediaStreamSource(stream);
    // Chrome goes on playing the element as well; Firefox's version doesn't.
    if (media.captureStream && patchable) {
      const out = engine.createGain();
      tapped.connect(out);
      captureOut.set(media, out);
      takeSound(media, out);
      return out;
    }
    return tapped;
  }

  /* rebuild: reading the stream */

  // The player hands its downloaded audio to the browser in pieces through
  // SourceBuffer.appendBuffer. Those pieces are fragmented MP4: a header
  // (moov) describing the audio, then pairs of boxes, a moof listing the
  // compressed frames in the mdat that follows it. This reads that format,
  // as far as AAC audio needs, and nothing more.
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const boxName = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  // Call visit(name, start, end) for each box between from and to; start and
  // end bound the box's contents. Stops early if visit returns false.
  function eachBox(b, from, to, visit) {
    let o = from;
    while (o + 8 <= to) {
      let size = u32(b, o);
      let head = 8;
      if (size === 1) {
        if (o + 16 > to) return;
        size = u64(b, o + 8);
        head = 16;
      } else if (size === 0) {
        size = to - o;
      }
      if (size < head || o + size > to) return;
      if (visit(boxName(b, o + 4), o + head, o + size) === false) return;
      o += size;
    }
  }

  // One length-prefixed descriptor inside an esds box.
  function descriptor(b, o) {
    let length = 0;
    let i = o + 1;
    for (let k = 0; k < 4; k++) {
      const c = b[i++];
      length = (length << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { kind: b[o], body: i, end: i + length };
  }

  // The decoder's setup bytes (AudioSpecificConfig), from an esds box.
  function readEsds(b, from, to) {
    const es = descriptor(b, from);
    if (es.kind !== 0x03) return null;
    let o = es.body + 2;
    const flags = b[o++];
    if (flags & 0x80) o += 2;
    if (flags & 0x40) o += 1 + b[o];
    if (flags & 0x20) o += 2;
    const config = descriptor(b, o);
    if (config.kind !== 0x04) return null;
    const info = descriptor(b, config.body + 13);
    if (info.kind !== 0x05 || info.end > to) return null;
    return b.slice(info.body, info.end);
  }

  function readInit(b, from, to) {
    const config = { timescale: 0, codec: '', setup: null, rate: 0, channels: 0, frame: 0, blocked: '' };
    eachBox(b, from, to, (name, s, e) => {
      if (name === 'mvex') {
        eachBox(b, s, e, (n2, s2) => { if (n2 === 'trex') config.frame = u32(b, s2 + 12); });
      }
      if (name !== 'trak') return;
      eachBox(b, s, e, (n2, s2, e2) => {
        if (n2 !== 'mdia') return;
        eachBox(b, s2, e2, (n3, s3, e3) => {
          if (n3 === 'mdhd') config.timescale = b[s3] === 1 ? u32(b, s3 + 20) : u32(b, s3 + 12);
          if (n3 !== 'minf') return;
          eachBox(b, s3, e3, (n4, s4, e4) => {
            if (n4 !== 'stbl') return;
            eachBox(b, s4, e4, (n5, s5, e5) => {
              if (n5 !== 'stsd') return;
              eachBox(b, s5 + 8, e5, (entry, s6, e6) => {
                if (entry === 'enca') config.blocked = 'this audio is copy-protected';
                if (entry !== 'mp4a') return false;
                config.channels = (b[s6 + 16] << 8) | b[s6 + 17];
                config.rate = (b[s6 + 24] << 8) | b[s6 + 25];
                eachBox(b, s6 + 28, e6, (n7, s7, e7) => {
                  if (n7 === 'esds') config.setup = readEsds(b, s7 + 4, e7);
                });
                return false;
              });
            });
          });
        });
      });
    });
    if (config.setup && config.setup.length >= 2) config.codec = 'mp4a.40.' + (config.setup[0] >> 3);
    return config;
  }

  // The list of frames a moof describes: where each run of them starts in the
  // data, and each frame's length in time and in bytes.
  function readFragment(b, from, to) {
    const fragment = { base: 0, runs: [] };
    eachBox(b, from, to, (name, s, e) => {
      if (name !== 'traf') return;
      let frame = 0;
      let bytes = 0;
      eachBox(b, s, e, (n2, s2) => {
        if (n2 === 'tfhd') {
          const flags = u32(b, s2) & 0xffffff;
          let o = s2 + 8;
          if (flags & 0x01) o += 8;
          if (flags & 0x02) o += 4;
          if (flags & 0x08) { frame = u32(b, o); o += 4; }
          if (flags & 0x10) { bytes = u32(b, o); o += 4; }
        } else if (n2 === 'tfdt') {
          fragment.base = b[s2] === 1 ? u64(b, s2 + 4) : u32(b, s2 + 4);
        } else if (n2 === 'trun') {
          const flags = u32(b, s2) & 0xffffff;
          const count = u32(b, s2 + 4);
          let o = s2 + 8;
          const run = { offset: null, samples: [] };
          if (flags & 0x001) { run.offset = u32(b, o) | 0; o += 4; }
          if (flags & 0x004) o += 4;
          for (let i = 0; i < count; i++) {
            const sample = { time: frame, bytes };
            if (flags & 0x100) { sample.time = u32(b, o); o += 4; }
            if (flags & 0x200) { sample.bytes = u32(b, o); o += 4; }
            if (flags & 0x400) o += 4;
            if (flags & 0x800) o += 4;
            run.samples.push(sample);
          }
          fragment.runs.push(run);
        }
      });
      return false; // an audio stream has a single track
    });
    return fragment;
  }

  // Everything known about one audio stream: how to decode it and every
  // compressed frame seen so far, in time order. A minute of AAC is about a
  // megabyte, so keeping a whole video's worth is cheap.
  function makeStore() {
    const store = { config: null, frames: [], blocked: '', bytes: 0 };
    let held = new Uint8Array(0); // the tail end of a box still arriving
    let fragment = null;
    let fragmentSize = 0;

    function addFrame(frame) {
      const frames = store.frames;
      const last = frames[frames.length - 1];
      if (!last || frame.t > last.t + 1e-6) { frames.push(frame); return; }
      let lo = 0;
      let hi = frames.length;
      while (lo < hi) { // first frame at or after this time
        const mid = (lo + hi) >> 1;
        if (frames[mid].t < frame.t - 1e-6) lo = mid + 1; else hi = mid;
      }
      if (lo < frames.length && Math.abs(frames[lo].t - frame.t) <= 1e-6) frames[lo] = frame; // a re-download
      else frames.splice(lo, 0, frame);
    }

    function takeData(box, head, shift) {
      const config = store.config;
      if (!fragment || !config || !config.timescale) return;
      let time = fragment.base;
      let pos = head;
      for (const run of fragment.runs) {
        if (run.offset !== null) pos = run.offset - fragmentSize; // offsets count from the start of the moof
        for (const sample of run.samples) {
          const length = sample.time || config.frame || 1024;
          if (sample.bytes > 0 && pos >= head && pos + sample.bytes <= box.length) {
            addFrame({ t: time / config.timescale + shift, d: length / config.timescale, data: box.slice(pos, pos + sample.bytes) });
          }
          pos += sample.bytes;
          time += length;
        }
      }
      fragment = null;
    }

    store.reset = () => { held = new Uint8Array(0); fragment = null; };

    // `bytes` is the next piece of the stream, exactly as the player appended it.
    store.feed = (bytes, shift) => {
      store.bytes += bytes.length;
      const all = new Uint8Array(held.length + bytes.length);
      all.set(held, 0);
      all.set(bytes, held.length);
      let o = 0;
      while (all.length - o >= 8) {
        let size = u32(all, o);
        let head = 8;
        const name = boxName(all, o + 4);
        if (size === 1) {
          if (all.length - o < 16) break;
          size = u64(all, o + 8);
          head = 16;
        }
        // Not the start of a box (the player jumped elsewhere in the stream):
        // drop what is held and start afresh with the next piece.
        if (!/^[A-Za-z0-9 ]{4}$/.test(name) || size < head || size > 0x4000000) { o = all.length; fragment = null; break; }
        if (all.length - o < size) break; // the rest of this box is still to come
        if (name === 'moov') {
          store.config = readInit(all, o + head, o + size);
          store.blocked = store.config.blocked;
        } else if (name === 'moof') {
          fragment = readFragment(all, o + head, o + size);
          fragmentSize = size;
        } else if (name === 'mdat') {
          takeData(all.subarray(o, o + size), head, shift || 0);
        }
        o += size;
      }
      held = all.slice(o);
    };
    return store;
  }

  const storeOf = new WeakMap();   // SourceBuffer -> store
  const storesIn = new WeakMap();  // MediaSource -> its audio store
  const sourceAt = new Map();      // object URL -> MediaSource
  let newestStore = null;
  let otherAudio = '';             // an audio format seen that this can't read

  if (audioPath === 'rebuild') {
    for (const Source of [window.MediaSource, window.ManagedMediaSource]) {
      const proto = Source && Source.prototype;
      if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'addSourceBuffer')) continue;
      wrap(proto, 'addSourceBuffer', original => function (mime) {
        const buffer = original.apply(this, arguments);
        try {
          const low = String(mime).toLowerCase();
          if (low.startsWith('audio/mp4') && low.includes('mp4a')) {
            const store = makeStore();
            storeOf.set(buffer, store);
            storesIn.set(this, store);
            newestStore = store;
          } else if (low.startsWith('audio/')) {
            otherAudio = String(mime);
          }
        } catch (_) { /* the player carries on regardless */ }
        return buffer;
      });
    }
    for (const Buffer of [window.SourceBuffer, window.ManagedSourceBuffer]) {
      const proto = Buffer && Buffer.prototype;
      if (!proto) continue;
      if (Object.prototype.hasOwnProperty.call(proto, 'appendBuffer')) {
        wrap(proto, 'appendBuffer', original => function (data) {
          try {
            const store = storeOf.get(this);
            if (store && data) {
              const bytes = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
              store.feed(bytes, Number(this.timestampOffset) || 0);
            }
          } catch (error) { noteError('reading the stream', error); }
          return original.apply(this, arguments);
        });
      }
      if (Object.prototype.hasOwnProperty.call(proto, 'abort')) {
        wrap(proto, 'abort', original => function () {
          const store = storeOf.get(this);
          if (store) store.reset();
          return original.apply(this, arguments);
        });
      }
    }
    if (window.URL && typeof URL.createObjectURL === 'function') {
      wrap(URL, 'createObjectURL', original => function (thing) {
        const url = original.apply(this, arguments);
        try { if (storesIn.has(thing) || (window.MediaSource && thing instanceof window.MediaSource)) sourceAt.set(url, thing); }
        catch (_) { /* not a media source */ }
        return url;
      });
    }
  }

  // The stream this element is playing.
  function storeFor(media) {
    try {
      if (media.srcObject && storesIn.has(media.srcObject)) return storesIn.get(media.srcObject);
      const source = sourceAt.get(media.currentSrc || media.src);
      if (source && storesIn.has(source)) return storesIn.get(source);
    } catch (_) { /* fall through */ }
    return newestStore;
  }

  /* rebuild: decoding and playing in step with the picture */

  const AHEAD_S = 6;        // keep this much decoded beyond the playhead
  const CHUNK_S = 1;        // decoded sound is queued in pieces about this long
  const FIRST_CHUNK_S = 0.3; // ...but the first after a jump is short, to start sooner
  const DRIFT_S = 0.08;     // further out of step than this and it is lined up again
  const STARVED_MS = 5000;  // playing this long with nothing to play: give the sound back
  const rebuilds = new WeakMap(); // element -> its rebuilder

  function rebuildSource(media) {
    if (typeof window.AudioDecoder !== 'function' || typeof window.EncodedAudioChunk !== 'function') {
      throw new Error('this browser gives extensions no audio decoder (WebCodecs)');
    }
    if (!patchable) throw new Error("this browser won't let the video's own sound be turned off");
    const rb = {
      media, out: engine.createGain(), store: null, decoder: null, key: '', run: 0,
      fed: null, from: 0, next: null, parts: [], ready: [], anchor: null, off: 0, stretch: 1, stretcher: null,
      failed: '', starved: 0, drift: 0, lineUps: 0, timer: 0
    };
    rebuilds.set(media, rb);
    for (const type of ['seeking', 'emptied']) media.addEventListener(type, () => { restart(rb); pump(rb); });
    for (const type of ['seeked', 'play', 'playing', 'pause', 'waiting', 'ratechange', 'canplay']) {
      media.addEventListener(type, () => pump(rb));
    }
    rb.timer = setInterval(() => pump(rb), 200);
    pump(rb);
    return rb.out;
  }

  function stopNodes(rb) {
    for (const chunk of rb.ready) {
      if (!chunk.node) continue;
      try { chunk.node.stop(); } catch (_) { /* already finished */ }
      try { chunk.node.disconnect(); } catch (_) { /* already apart */ }
      chunk.node = null;
    }
    rb.anchor = null;
  }

  // Forget everything decoded and start again from wherever the playhead is.
  function restart(rb) {
    stopNodes(rb);
    rb.run++; // anything the decoder still hands back belongs to the old run
    rb.ready = [];
    rb.parts = [];
    rb.fed = null;
    rb.next = null;
    try { if (rb.decoder && rb.decoder.state === 'configured') rb.decoder.reset(); } catch (_) { /* rebuilt below */ }
    rb.key = '';
    rb.stretcher = null;
  }

  // Give up: hand the sound back to the element so nobody is left in silence.
  function abandon(rb, why) {
    if (rb.failed) return;
    rb.failed = why;
    engineError = ('rebuild - ' + why).slice(0, 200);
    stopNodes(rb);
    clearInterval(rb.timer);
    try { if (rb.decoder && rb.decoder.state !== 'closed') rb.decoder.close(); } catch (_) { /* gone already */ }
    unsilence(rb.media);
  }

  /* rebuild: changing speed without changing pitch */

  // Playing a recording faster by reading it out faster raises its pitch.
  // To keep the pitch, the sound is cut into short overlapping windows that
  // are each played at normal speed but taken from the recording at the new
  // pace: closer together to slow down, further apart to speed up. Each
  // window is nudged a few milliseconds either way to wherever it lines up
  // best with the one before, so the joins don't warble. (This is the
  // technique known as WSOLA; it is what browsers do for their own players.)
  const WINDOW = 2048;        // samples per window, about 46 ms
  const HOP = WINDOW / 2;     // windows overlap by half
  const REACH = 512;          // how far a window may be nudged, about 12 ms
  const hann = new Float32Array(WINDOW);
  for (let n = 0; n < WINDOW; n++) hann[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / WINDOW);

  // `speed` is how much faster than normal; `start` is the media time of the
  // first sample that will be pushed in.
  function makeStretcher(speed, rate, channels, start) {
    let held = []; // input not yet used up, one array per channel
    for (let c = 0; c < channels; c++) held.push(new Float32Array(0));
    let base = 0;     // position in the whole input of held[.][0]
    let count = 0;    // windows written so far
    let last = 0;     // where in the input the last window was taken from
    let written = 0;  // output samples produced so far
    const tail = [];  // second half of the last window, waiting for the next to overlap it
    for (let c = 0; c < channels; c++) tail.push(new Float32Array(HOP));

    // How well the stretch of input at `a` matches the one at `b` (both HOP long).
    function likeness(a, b) {
      const x = held[0];
      const y = channels > 1 ? held[1] : held[0];
      let dot = 0;
      let power = 1e-9;
      for (let n = 0; n < HOP; n += 4) {
        const u = x[a + n] + y[a + n];
        const v = x[b + n] + y[b + n];
        dot += u * v;
        power += u * u;
      }
      return dot / Math.sqrt(power);
    }

    return {
      rate, channels, speed,
      // Add decoded sound; returns whatever stretched sound is now complete, or null.
      push(planes) {
        for (let c = 0; c < channels; c++) {
          const joined = new Float32Array(held[c].length + planes[c].length);
          joined.set(held[c], 0);
          joined.set(planes[c], held[c].length);
          held[c] = joined;
        }
        const have = base + held[0].length;
        const pieces = [];
        const startedAt = written;
        for (;;) {
          const ideal = Math.round(count * HOP * speed);
          let from = ideal;
          if (count === 0) {
            from = 0;
          } else {
            const lowest = Math.max(base, ideal - REACH);
            const highest = ideal + REACH;
            const follow = last + HOP; // what would follow the last window if nothing had been skipped
            if (highest + WINDOW > have || follow + HOP > have) break; // wait for more sound
            if (follow >= base) {
              let best = -Infinity;
              for (let at = lowest; at <= highest; at += 2) {
                const score = likeness(at - base, follow - base);
                if (score > best) { best = score; from = at; }
              }
            }
          }
          if (from + WINDOW > have) break;
          const piece = [];
          for (let c = 0; c < channels; c++) {
            const out = new Float32Array(HOP);
            const x = held[c];
            const o = from - base;
            for (let n = 0; n < HOP; n++) {
              out[n] = tail[c][n] + x[o + n] * hann[n];
              tail[c][n] = x[o + HOP + n] * hann[HOP + n];
            }
            piece.push(out);
          }
          pieces.push(piece);
          written += HOP;
          last = from;
          count++;
          // Let go of input that can no longer be needed.
          const keep = Math.min(last + HOP, Math.round(count * HOP * speed) - REACH);
          if (keep > base) {
            for (let c = 0; c < channels; c++) held[c] = held[c].slice(keep - base);
            base = keep;
          }
        }
        if (!pieces.length) return null;
        const frames = pieces.length * HOP;
        const joined = [];
        for (let c = 0; c < channels; c++) {
          const all = new Float32Array(frames);
          pieces.forEach((piece, i) => all.set(piece[c], i * HOP));
          joined.push(all);
        }
        return { planes: joined, frames, t: start + startedAt * speed / rate };
      }
    };
  }

  function durationOf(parts) {
    let seconds = 0;
    for (const part of parts) seconds += part.frames / part.rate;
    return seconds;
  }

  // Join the decoded pieces collected so far into one buffer ready to play.
  function closeChunk(rb) {
    const parts = rb.parts;
    if (!parts.length) return;
    rb.parts = [];
    let total = 0;
    for (const part of parts) total += part.frames;
    const channels = parts[0].planes.length;
    const buffer = engine.createBuffer(channels, total, parts[0].rate);
    let at = 0;
    for (const part of parts) {
      for (let c = 0; c < channels; c++) buffer.getChannelData(c).set(part.planes[c], at);
      at += part.frames;
    }
    // `stretch` is how much the sound has been compressed in time already; its
    // length in the video's time is that much longer than its own.
    const stretch = parts[0].stretch || 1;
    rb.ready.push({ t: parts[0].t, dur: total / parts[0].rate * stretch, buffer, node: null, stretch });
  }

  function takeDecoded(rb, data) {
    const frames = data.numberOfFrames;
    const rate = data.sampleRate;
    const channels = data.numberOfChannels;
    // Within one run the pieces follow each other exactly, sample for sample;
    // only the first is placed by its timestamp.
    const t = rb.next === null ? data.timestamp / 1e6 : rb.next;
    rb.next = t + frames / rate;
    if (rb.next <= rb.from - 1e-4) return; // lead-in before the playhead: only there to warm the decoder up
    const first = rb.parts[0];
    if (first && (first.rate !== rate || first.planes.length !== channels)) closeChunk(rb);
    const planes = [];
    for (let c = 0; c < channels; c++) {
      const plane = new Float32Array(frames);
      data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      planes.push(plane);
    }
    if (rb.stretch !== 1) {
      // Pitch correction: bring the sound to the playing speed here, so it can be played at normal pitch.
      if (!rb.stretcher || rb.stretcher.rate !== rate || rb.stretcher.channels !== channels) {
        closeChunk(rb);
        rb.stretcher = makeStretcher(rb.stretch, rate, channels, t);
      }
      const done = rb.stretcher.push(planes);
      if (!done) return;
      rb.parts.push({ t: done.t, frames: done.frames, rate, planes: done.planes, stretch: rb.stretch });
    } else {
      rb.parts.push({ t, frames, rate, planes });
    }
    const enough = rb.ready.length || rb.anchor ? CHUNK_S : FIRST_CHUNK_S;
    if (durationOf(rb.parts) >= enough) {
      closeChunk(rb);
      if (!rb.anchor) setTimeout(() => pump(rb), 0); // something to play at last: don't wait for the next tick
    }
  }

  function readyDecoder(rb, config) {
    const key = config.codec + '/' + config.rate + '/' + config.channels + '/' + Array.from(config.setup).join('.');
    if (rb.decoder && rb.key === key && rb.decoder.state === 'configured') return;
    try { if (rb.decoder && rb.decoder.state !== 'closed') rb.decoder.close(); } catch (_) { /* gone already */ }
    const run = rb.run;
    rb.decoder = new window.AudioDecoder({
      output: data => {
        try { if (run === rb.run && !rb.failed) takeDecoded(rb, data); }
        catch (error) { abandon(rb, 'reading decoded sound: ' + (error && error.message)); }
        finally { try { data.close(); } catch (_) { /* nothing to free */ } }
      },
      error: error => { if (run === rb.run) abandon(rb, 'decoder: ' + (error && error.message)); }
    });
    rb.decoder.configure({
      codec: config.codec, sampleRate: config.rate || 44100,
      numberOfChannels: config.channels || 2, description: config.setup
    });
    rb.key = key;
  }

  // Index of the last frame starting at or before `time` (or 0).
  function frameAt(frames, time) {
    let lo = 0;
    let hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t <= time) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  function schedule(rb, chunk) {
    const anchor = rb.anchor;
    const rate = anchor.rate;
    let when = anchor.ctx + (chunk.t - anchor.media) / rate;
    const end = when + chunk.dur / rate;
    const now = engine.currentTime;
    if (end <= now) return; // already in the past
    let offset = 0;
    // Sound already brought to speed plays at its natural rate; the rest is
    // simply read out faster or slower, pitch and all.
    const readout = rate / chunk.stretch;
    if (when < now) {
      offset = (now - when) * readout;
      when = now;
    }
    const node = engine.createBufferSource();
    node.buffer = chunk.buffer;
    node.playbackRate.value = readout;
    node.connect(rb.out);
    node.start(when, offset);
    chunk.node = node;
  }

  // Called a few times a second and on every player event: decode a little
  // further ahead, and keep what is playing lined up with the picture.
  function pump(rb) {
    if (rb.failed) return;
    if (rb.busy) { rb.again = true; return; } // asked for while already at work: go round once more after
    rb.busy = true;
    try {
      pumpOnce(rb);
    } finally {
      rb.busy = false;
    }
    if (rb.again) {
      rb.again = false;
      pump(rb);
    }
  }

  function pumpOnce(rb) {
    try {
      const media = rb.media;
      const store = storeFor(media);
      if (store !== rb.store) {
        restart(rb);
        rb.store = store;
      }
      const now = media.currentTime;
      const playing = !media.paused && !media.seeking && !(media.readyState < 3) && engine.state === 'running';

      if (store && store.blocked) { abandon(rb, store.blocked); return; }
      // Nothing to process (Purist, or every effect off): stand by. The video
      // element gets its own sound back and nothing is decoded.
      if (!wantsEngine()) {
        if (rb.anchor || rb.ready.length || rb.fed !== null) restart(rb);
        if (levelNode.get(media) === rb.out) unsilence(media);
        rb.resting = true;
        rb.starved = 0;
        return;
      }
      rb.resting = false;
      // With pitch correction on, sound is brought to the playing speed as it
      // is decoded. A change of speed (or of that switch) means starting over.
      const pace = media.playbackRate || 1;
      const stretch = settings.pitchCorrection && Math.abs(pace - 1) > 0.001 ? pace : 1;
      if (stretch !== rb.stretch) {
        restart(rb);
        rb.stretch = stretch;
      }
      // The playhead is somewhere other than the stretch being prepared (a
      // jump that arrived without a seeking event): start again from here.
      if (rb.fed !== null && (now < rb.from - 0.5 || now > rb.fed + 0.5)) restart(rb);
      if (store && store.config && store.config.setup) {
        readyDecoder(rb, store.config);
        const frames = store.frames;
        let i;
        if (rb.fed === null) {
          rb.from = now;
          rb.next = null;
          i = Math.max(0, frameAt(frames, now) - 2); // two frames early, to warm the decoder up
        } else {
          i = frameAt(frames, rb.fed - 1e-4);
          if (frames[i] && frames[i].t < rb.fed - 1e-4) i++;
        }
        // Only ever feed frames that follow on without a hole.
        while (i < frames.length && frames[i].t < now + AHEAD_S && rb.decoder.decodeQueueSize < 40) {
          const frame = frames[i];
          if (rb.fed !== null && frame.t - rb.fed > 0.05) break; // the next stretch hasn't been downloaded yet
          if (rb.fed === null && frame.t > now + 0.05) break;    // nothing at the playhead yet
          rb.decoder.decode(new window.EncodedAudioChunk({
            type: 'key', timestamp: Math.round(frame.t * 1e6), duration: Math.round(frame.d * 1e6), data: frame.data
          }));
          rb.fed = frame.t + frame.d;
          i++;
        }
        // Nothing more to decode for now: don't sit on a part-filled chunk.
        if (rb.parts.length && rb.decoder.decodeQueueSize === 0 && (i >= frames.length || frames[i].t >= now + AHEAD_S)) closeChunk(rb);
      }

      // Drop what the playhead has passed.
      while (rb.ready.length && rb.ready[0].t + rb.ready[0].dur < now - 0.5) {
        const old = rb.ready.shift();
        if (old.node) { try { old.node.disconnect(); } catch (_) { /* already apart */ } }
      }

      if (!playing) {
        if (rb.anchor) stopNodes(rb);
        rb.starved = 0;
        return;
      }
      const rate = media.playbackRate || 1;
      if (rb.anchor) {
        const expected = rb.anchor.media + (engine.currentTime - rb.anchor.ctx) * rb.anchor.rate;
        rb.drift = now - expected;
        if (rate !== rb.anchor.rate) {
          stopNodes(rb);
        } else if (Math.abs(rb.drift) > DRIFT_S) {
          if (++rb.off >= 2) { stopNodes(rb); rb.lineUps++; }
        } else {
          rb.off = 0;
        }
      }
      if (!rb.anchor) {
        const covering = rb.ready.some(chunk => chunk.t <= now + 0.02 && chunk.t + chunk.dur > now);
        if (!covering) {
          // The picture is moving and there is nothing to play. Wait a little,
          // then give the element its sound back instead of leaving silence.
          if (!rb.starved) rb.starved = Date.now();
          else if (Date.now() - rb.starved > STARVED_MS) {
            abandon(rb, !store ? (otherAudio ? "can't read this audio format (" + otherAudio + ')' : 'never saw the audio stream: reload the tab')
              : !store.config || !store.config.setup ? 'never saw the start of the audio stream: reload the tab'
              : 'no sound decoded at the playhead');
          }
          return;
        }
        // There is sound ready for this very moment. Only now is the element
        // silenced, so there is never a stretch with neither playing.
        takeSound(media, rb.out);
        rb.anchor = { ctx: engine.currentTime, media: now, rate };
        rb.off = 0;
        rb.drift = 0;
      }
      rb.starved = 0;
      for (const chunk of rb.ready) if (!chunk.node) schedule(rb, chunk);
    } catch (error) {
      abandon(rb, (error && error.message) || String(error));
    }
  }

  // One line for the popup about how the chosen path is doing.
  function pathReport(media) {
    if (audioPath !== 'rebuild') return '';
    const rb = rebuilds.get(media);
    const store = rb ? rb.store : storeFor(media);
    const seen = store ? store.frames.length + ' frames read' : (otherAudio ? 'audio is ' + otherAudio : 'no audio stream seen yet');
    if (!rb) return seen + ', not started';
    if (rb.failed) return 'stopped: ' + rb.failed;
    if (rb.resting) return seen + ', standing by: nothing to process, so the video plays its own sound';
    const queued = rb.ready.reduce((sum, chunk) => sum + chunk.dur, 0);
    return seen + ', ' + queued.toFixed(1) + ' s ready, ' +
      (rb.anchor ? 'playing, ' + Math.round(rb.drift * 1000) + ' ms off, lined up ' + rb.lineUps + ' times' : 'not playing');
  }

  // The same facts as separate figures, so the popup can set them out in
  // fixed places instead of in a sentence that reflows as the numbers change.
  function pathFigures(media) {
    if (audioPath !== 'rebuild') return null;
    const rb = rebuilds.get(media);
    const store = rb ? rb.store : storeFor(media);
    const figures = { frames: store ? store.frames.length : 0, state: 'not started', why: '' };
    if (!rb) return figures;
    if (rb.failed) { figures.state = 'stopped'; figures.why = rb.failed; return figures; }
    if (rb.resting) { figures.state = 'standing by'; return figures; }
    const ahead = decodedAhead(media);
    figures.decoded = Math.round((ahead === null ? 0 : ahead) * 10) / 10;
    figures.state = rb.anchor ? 'playing' : 'not playing';
    figures.off = Math.round(rb.drift * 1000);
    figures.lineUps = rb.lineUps;
    return figures;
  }

  // ponytail: purist-only build has no speed shortcuts (Option + scroll / arrows).
  const speedFlashUntil = 0;

  /* ------------------- on-player readout: codec and attenuation ------------------- */

  // Short name for a MIME type such as: audio/mp4; codecs="mp4a.40.2"
  function codecName(mime) {
    if (!mime) return '';
    const match = /codecs\s*=\s*"?([^";]+)/i.exec(mime);
    const id = (match ? match[1] : mime).split(',')[0].trim();
    const low = id.toLowerCase();
    const names = [
      ['mp4a.40.29', 'HE-AAC v2'], ['mp4a.40.5', 'HE-AAC'], ['mp4a.40.2', 'AAC-LC'], ['mp4a', 'AAC'],
      ['opus', 'Opus'], ['vorbis', 'Vorbis'], ['ec-3', 'E-AC-3'], ['ac-3', 'AC-3'], ['flac', 'FLAC'],
      ['av01', 'AV1'], ['vp09', 'VP9'], ['vp9', 'VP9'], ['vp8', 'VP8'],
      ['avc1', 'H.264'], ['avc3', 'H.264'], ['hev1', 'HEVC'], ['hvc1', 'HEVC']
    ];
    for (const [prefix, name] of names) if (low.startsWith(prefix)) return name;
    return id;
  }

  // real: what the element plays at. youtube: what YouTube asked for.
  // user: the slider. All 0..1 (user may be null).
  function levels(media) {
    const real = patchable ? rawGet(media) : media.volume;
    const youtube = patchable && managing() && requested.has(media)
      ? requested.get(media) : real;
    return { real, youtube, user: sliderLevel(media) };
  }

  // How far YouTube turns this video down relative to the slider, in dB
  // (0 or negative), or null when it can't be worked out.
  function attenuationDb(now) {
    if (!(now.user > 0) || !(now.youtube > 0)) return null;
    const db = 20 * Math.log10(now.youtube / now.user);
    return Math.abs(db) < 0.05 ? 0 : db;
  }

  let badge = null;

  function badgeText(media) {
    const lines = [];
    if (settings.showCodec) {
      const found = [codecName(openedAudio), codecName(openedVideo)].filter(Boolean).join(' / ');
      lines.push('Codec  ' + (found || 'unknown (reload the page)'));
    }
    if (settings.showAttenuation && SITE === 'youtube') {
      const now = levels(media);
      const db = attenuationDb(now);
      let text;
      if (media.muted || now.user === 0) text = 'muted';
      else if (db === null) text = 'unknown';
      else if (db === 0) text = 'none';
      else text = db.toFixed(1).replace('-', '\u2212') + ' dB' + (settings.trueVolume && patchable ? ', bypassed' : '');
      lines.push('Attenuation  ' + text);
    }
    listen(media);
    const works = !deaf(media);
    if (works && settings.showAttenuation && effPad() > 0 && padded.has(media)) {
      const applied = appliedPad(media);
      lines.push('Padded  +' + (applied < settings.pad - 0.05 ? applied.toFixed(1) + ' dB of +' + settings.pad : settings.pad + ' dB'));
    }
    if (works && settings.showAttenuation && effFeed() !== 'off' && padded.has(media)) {
      lines.push('Crossfeed  ' + effFeed());
    }
    if (works && settings.showAttenuation && effBeef() !== 'off' && padded.has(media)) {
      lines.push('B-Mode  ' + effBeef() + ' Hz');
    }
    if (settings.showAttenuation && guardDb(media) >= 0.1) {
      lines.push('Clip guard  \u2212' + guardDb(media).toFixed(1) + ' dB');
    }
    if (settings.showAttenuation && settings.unity && patchable) {
      lines.push('Purist  ' + (media.muted || rawGet(media) === 0 ? 'muted' : '0 dB, nothing processed'));
    }
    if (settings.showBuffer) {
      const ahead = bufferAhead(media);
      const own = decodedAhead(media);
      lines.push('Buffer  ' + ahead.toFixed(ahead < 10 ? 1 : 0) + ' s' + (own === null ? '' : ', ' + own.toFixed(1) + ' s decoded'));
    }
    const flashing = Date.now() < speedFlashUntil;
    if (flashing || (settings.showSpeed && Math.abs(media.playbackRate - 1) > 0.001)) {
      const pitch = pitchOf(media);
      lines.push('Speed  ' + (Math.round(media.playbackRate * 100) / 100) + '\u00d7' +
        (pitch === null ? '' : pitch ? ', pitch corrected' : ', pitch follows speed'));
    }
    return lines.join('\n');
  }

  let badgeFloating = null;

  function refreshBadge() {
    try {
      if (document.hidden) return; // nobody is looking; caught up when the tab is shown again
      const wanted = settings.showCodec || settings.showAttenuation || settings.showSpeed || settings.showBuffer ||
        Date.now() < speedFlashUntil;
      const media = wanted ? currentMedia() : null;
      // On YouTube the readout sits on the video. Elsewhere there may be no
      // video to sit on, so it floats above the player bar.
      let host = null;
      let floating = false;
      if (media) {
        host = typeof media.closest === 'function' ? media.closest(PLAYER) : null;
        if (!host && SITE === 'youtube') host = media.parentElement;
        if (!host && SITE !== 'youtube' && document.body) {
          host = document.body;
          floating = true;
        }
      }
      const wantedText = host ? badgeText(media) : '';
      if (!host || !wantedText) {
        if (badge && badge.parentNode) badge.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('div');
        badge.setAttribute('data-yta-badge', '');
        badge.style.cssText = 'position:absolute;top:8px;left:8px;z-index:60;pointer-events:none;' +
          'white-space:pre;font:500 12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
          'font-variant-numeric:tabular-nums;color:#fff;background:rgba(0,0,0,.62);' +
          'padding:4px 8px;border-radius:4px;letter-spacing:.01em;';
      }
      if (badgeFloating !== floating) { // restyle only when the placement changes
        badgeFloating = floating;
        badge.style.position = floating ? 'fixed' : 'absolute';
        badge.style.top = floating ? 'auto' : '8px';
        badge.style.left = floating ? 'auto' : '8px';
        badge.style.right = floating ? '16px' : 'auto';
        badge.style.bottom = floating ? '104px' : 'auto';
      }
      if (badge.parentNode !== host) host.appendChild(badge);
      if (badge.textContent !== wantedText) badge.textContent = wantedText;
    } catch (_) { /* display only */ }
  }

  setInterval(refreshBadge, 1000);
  document.addEventListener('visibilitychange', refreshBadge);

  if (patchable && managing()) everyMedia().forEach(el => takeOver(el));
  everyMedia().forEach(media => {
    applySpeed(media, false);
    route(media);
  });
})();

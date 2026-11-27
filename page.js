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
  // A codec family id like 'flac' or 'h264'; anything else means Auto.
  const codec = name => (/^[a-z0-9.-]{1,16}$/.test(read(name)) ? read(name) : 'auto');
  const settings = {};
  function load() {
    settings.unity = read('yta-unity') === '1';
    settings.audio = codec('yta-audio');
    settings.video = codec('yta-video');
  }
  load();

  const HOST = location.hostname || '';
  const SITE = /(^|\.)youtube(-nocookie)?\.com$/.test(HOST) ? 'youtube'
    : /(^|\.)spotify\.com$/.test(HOST) ? 'spotify' : 'other';

  root() && root().setAttribute('data-yta-page', '1');

  function wrap(owner, name, build) {
    if (owner && typeof owner[name] === 'function') owner[name] = build(owner[name]);
  }

  const wanted = kind => (kind === 'audio' ? settings.audio : settings.video);

  /* ------------- codecs: what the site offers, what the browser plays, forcing one ------------- */

  // Players ask the browser which formats it can play and pick from the
  // answers. Every question is noted here (what the site offers), every codec
  // below is asked of the browser directly (what it plays), and with a codec
  // forced every other family is answered "no", so the player has to use it.
  // [family, name, pattern on the codec id, a type to ask the browser about]
  const CODECS = {
    audio: [
      ['aac', 'AAC', /^mp4a\.40|^mp4a$|^aac/, 'audio/mp4; codecs="mp4a.40.2"'],
      ['mp3', 'MP3', /^mp4a\.(69|6b)|^mp3/, 'audio/mpeg'],
      ['opus', 'Opus', /^opus/, 'audio/webm; codecs="opus"'],
      ['vorbis', 'Vorbis', /^vorbis/, 'audio/webm; codecs="vorbis"'],
      ['flac', 'FLAC', /^flac/, 'audio/mp4; codecs="flac"'],
      ['alac', 'ALAC', /^alac/, 'audio/mp4; codecs="alac"'],
      ['ac-3', 'Dolby Digital', /^ac-3|^mp4a\.a5/, 'audio/mp4; codecs="ac-3"'],
      ['ec-3', 'Dolby Digital Plus', /^ec-3|^mp4a\.a6/, 'audio/mp4; codecs="ec-3"'],
      ['ac-4', 'Dolby AC-4', /^ac-4/, 'audio/mp4; codecs="ac-4.02.01.01"'],
      ['pcm', 'PCM', /^(ipcm|fpcm|lpcm|pcm)/, 'audio/wav']
    ],
    video: [
      ['h264', 'H.264', /^avc[13]/, 'video/mp4; codecs="avc1.640028"'],
      ['hevc', 'HEVC', /^(hvc1|hev1)/, 'video/mp4; codecs="hvc1.1.6.L120.90"'],
      ['dovi', 'Dolby Vision', /^(dvh1|dvhe|dva1|dvav)/, 'video/mp4; codecs="dvh1.05.06"'],
      ['vp8', 'VP8', /^vp0?8/, 'video/webm; codecs="vp8"'],
      ['vp9', 'VP9', /^vp0?9/, 'video/webm; codecs="vp09.00.40.08"'],
      ['av1', 'AV1', /^av01/, 'video/mp4; codecs="av01.0.08M.08"']
    ]
  };
  const SUBTYPES = { 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/aac': 'aac', 'audio/wav': 'pcm', 'audio/wave': 'pcm', 'audio/x-wav': 'pcm' };
  const familyName = (kind, id) => (CODECS[kind].find(c => c[0] === id) || [id, id.toUpperCase()])[1];

  // The families a type names, e.g. 'video/mp4; codecs="avc1.64, mp4a.40.2"'
  // gives h264 (video) and aac (audio). A codec not in the table keeps its own
  // prefix as its family, so it can still be listed and forced.
  function familiesOf(mime) {
    if (typeof mime !== 'string') return [];
    const low = mime.toLowerCase().trim();
    const kind = low.startsWith('audio/') ? 'audio' : low.startsWith('video/') ? 'video' : '';
    if (!kind) return [];
    const list = /codecs\s*=\s*"?([^";]+)/.exec(low);
    if (!list) return SUBTYPES[low.split(';')[0].trim()] ? [{ kind, id: SUBTYPES[low.split(';')[0].trim()] }] : [];
    return list[1].split(',').map(s => s.trim()).filter(Boolean).map(raw => {
      for (const k of ['audio', 'video']) {
        const hit = CODECS[k].find(c => c[2].test(raw));
        if (hit) return { kind: k, id: hit[0] };
      }
      return { kind, id: raw.split('.')[0] };
    });
  }

  // The browser's own answers, taken before anything below changes them.
  const Source = window.MediaSource || window.ManagedMediaSource;
  const nativeType = Source && typeof Source.isTypeSupported === 'function' ? Source.isTypeSupported.bind(Source) : null;
  const nativeCan = HTMLMediaElement.prototype.canPlayType;
  let browserList = null;
  function browserPlays() {
    if (!browserList) {
      const probe = document.createElement('audio');
      browserList = {};
      for (const kind of ['audio', 'video']) {
        for (const [id, , , type] of CODECS[kind]) {
          try { browserList[id] = !!(nativeType && nativeType(type)) || nativeCan.call(probe, type) !== ''; }
          catch (_) { browserList[id] = false; }
        }
      }
    }
    return browserList;
  }

  // family -> whether the browser said yes to it at least once
  const offered = { audio: new Map(), video: new Map() };
  function note(mime, yes) {
    for (const f of familiesOf(mime)) offered[f.kind].set(f.id, offered[f.kind].get(f.id) === true || !!yes);
  }
  // A codec the browser can't play is never forced, or nothing would play.
  function forceable(kind, id) {
    const known = browserPlays()[id];
    return known !== undefined ? known : offered[kind].get(id) !== false;
  }
  function refused(mime) {
    return familiesOf(mime).some(f => {
      const keep = wanted(f.kind);
      return keep !== 'auto' && f.id !== keep && forceable(f.kind, keep);
    });
  }

  for (const S of [window.MediaSource, window.ManagedMediaSource]) {
    wrap(S, 'isTypeSupported', original => function (mime) {
      const yes = original.apply(this, arguments);
      note(mime, yes);
      return yes && !refused(mime);
    });
  }
  wrap(HTMLMediaElement.prototype, 'canPlayType', original => function (mime) {
    const answer = original.apply(this, arguments);
    note(mime, answer !== '');
    return refused(mime) ? '' : answer;
  });
  wrap(window.MediaCapabilities && window.MediaCapabilities.prototype, 'decodingInfo', original => function (config) {
    const audio = config && config.audio && config.audio.contentType;
    const video = config && config.video && config.video.contentType;
    return original.apply(this, arguments).then(info => {
      note(audio, info && info.supported);
      note(video, info && info.supported);
      return refused(audio) || refused(video)
        ? { supported: false, smooth: false, powerEfficient: false, configuration: info && info.configuration } : info;
    });
  });

  /* ------------- the stream actually playing: codec, sample rate, bit depth, bit rate ------------- */

  const opened = { audio: '', video: '' };
  const kinds = new WeakMap(); // SourceBuffer -> 'audio' | 'video'
  const audioStream = { rate: 0, bits: 0, bytes: 0, seconds: 0 };
  function opening(buffer, mime) {
    const kind = typeof mime === 'string' ? mime.slice(0, 5).toLowerCase() : '';
    if (kind !== 'audio' && kind !== 'video') return;
    opened[kind] = mime;
    kinds.set(buffer, kind);
    note(mime, true);
    if (kind === 'audio') Object.assign(audioStream, { rate: 0, bits: 0, bytes: 0, seconds: 0, id: '' });
  }
  for (const S of [window.MediaSource, window.ManagedMediaSource]) {
    const proto = S && S.prototype;
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, 'addSourceBuffer')) continue;
    wrap(proto, 'addSourceBuffer', original => function (mime) {
      const buffer = original.apply(this, arguments);
      opening(buffer, mime);
      return buffer;
    });
  }

  // Sample rate and bit depth come from the header segment the player hands
  // the browser (MP4 or WebM). Lossy codecs have no bit depth; FLAC, ALAC and
  // PCM carry the real one.
  const boxTag = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  const be32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const findBox = (b, name, from, to) => {
    for (let i = from; i + 4 <= to; i++) if (b[i] === name.charCodeAt(0) && boxTag(b, i) === name) return i;
    return -1;
  };
  function readFormat(data, into = audioStream) {
    const b = data instanceof ArrayBuffer ? new Uint8Array(data)
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!b || b.length < 8) return;
    const end = Math.min(b.length, 65536);
    if (boxTag(b, 0) === 'fLaC' && b.length >= 22) { // a plain FLAC file: STREAMINFO comes first
      into.rate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
      into.bits = (((b[20] & 1) << 4) | (b[21] >> 4)) + 1;
      into.id = 'flac';
      return true;
    }
    if (boxTag(b, 0) === 'RIFF' && boxTag(b, 8) === 'WAVE' && boxTag(b, 12) === 'fmt ' && b.length >= 36) { // WAV
      into.rate = b[24] | (b[25] << 8) | (b[26] << 16) | (b[27] << 24);
      into.bits = b[34] | (b[35] << 8);
      into.id = 'pcm';
      return true;
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) { // WebM
      for (let i = 0; i < end - 12; i++) {
        if (b[i] !== 0xe1) continue; // the Audio element; its settings follow
        for (let j = i + 2; j < Math.min(end - 10, i + 48); j++) {
          if (b[j] !== 0xb5 || (b[j + 1] !== 0x88 && b[j + 1] !== 0x84)) continue;
          const v = new DataView(b.buffer, b.byteOffset + j + 2, 8);
          const rate = Math.round(b[j + 1] === 0x88 ? v.getFloat64(0) : v.getFloat32(0));
          if (rate < 8000 || rate > 768000) continue;
          into.rate = rate;
          for (let k = i + 2; k < Math.min(end - 3, i + 48); k++) {
            if (b[k] === 0x62 && b[k + 1] === 0x64 && b[k + 2] === 0x81) into.bits = b[k + 3];
          }
          return true;
        }
      }
      return;
    }
    if (!/^(ftyp|moov)$/.test(boxTag(b, 4))) return; // MP4 header segments only
    const s = findBox(b, 'stsd', 0, end);
    if (s < 0 || s + 48 > end) return;
    const e = s + 12; // the first sample entry
    if (!/^(mp4a|fLaC|alac|Opus|ec-3|ac-3|ac-4|ipcm|fpcm|enca)$/.test(boxTag(b, e + 4))) return;
    const stop = Math.min(end, e + be32(b, e));
    let rate = be32(b, e + 32) >>> 16;
    let bits = /^(ipcm|fpcm)$/.test(boxTag(b, e + 4)) ? b[e + 27] : 0;
    const flac = findBox(b, 'dfLa', e + 36, stop);
    const alac = findBox(b, 'alac', e + 36, stop);
    if (flac > 0 && flac + 26 <= stop) { // STREAMINFO starts 12 bytes in
      const x = flac + 12;
      rate = (b[x + 10] << 12) | (b[x + 11] << 4) | (b[x + 12] >> 4);
      bits = (((b[x + 12] & 1) << 4) | (b[x + 13] >> 4)) + 1;
    } else if (alac > 0 && alac + 32 <= stop) {
      bits = b[alac + 13];
      rate = be32(b, alac + 28);
    }
    into.rate = rate;
    into.bits = bits;
    const frma = findBox(b, 'frma', e + 36, stop); // encrypted: the real format is named here
    const entry = boxTag(b, e + 4) === 'enca' && frma > 0 ? boxTag(b, frma + 4) : boxTag(b, e + 4);
    into.id = (familiesOf('audio/mp4; codecs="' + entry.toLowerCase() + '"')[0] || {}).id;
    return true;
  }

  // Bit rate, measured: the bytes of each audio segment over the seconds it adds.
  function bufferedSeconds(buffer) {
    let total = 0;
    try { const r = buffer.buffered; for (let i = 0; i < r.length; i++) total += r.end(i) - r.start(i); } catch (_) { /* gone */ }
    return total;
  }
  function measure(buffer, data) {
    const bytes = data && data.byteLength;
    if (!bytes) return;
    const before = bufferedSeconds(buffer);
    buffer.addEventListener('updateend', () => {
      const added = bufferedSeconds(buffer) - before;
      if (added > 0.2 && added < 600) { audioStream.bytes += bytes; audioStream.seconds += added; }
    }, { once: true });
  }
  for (const S of [window.SourceBuffer, window.ManagedSourceBuffer]) {
    const proto = S && S.prototype;
    if (!proto) continue;
    if (Object.prototype.hasOwnProperty.call(proto, 'changeType')) {
      wrap(proto, 'changeType', original => function (mime) {
        opening(this, mime);
        return original.apply(this, arguments);
      });
    }
    if (Object.prototype.hasOwnProperty.call(proto, 'appendBuffer')) {
      wrap(proto, 'appendBuffer', original => function (data) {
        const kind = kinds.get(this);
        try {
          // A header segment that turns out to be audio marks its buffer as audio.
          if (kind !== 'video' && readFormat(data)) kinds.set(this, 'audio');
          if (kinds.get(this) === 'audio') measure(this, data);
        } catch (_) { /* never get in the player's way */ }
        return original.apply(this, arguments);
      });
    }
  }

  // Fetch part of a URL the player is already using and read a header from it.
  function readUrl(url, range, info, then) {
    return fetch(url, { headers: { Range: range || 'bytes=0-65535' } }).then(r => {
      if (!r.ok) return;
      return r.arrayBuffer().then(data => then(data, r));
    }).catch(() => { /* refused: say what is known without it */ });
  }

  // HLS (a .m3u8 playlist, which Safari plays itself). The playlist lists each
  // version of the stream with its codecs and bit rate; the one playing is the
  // one nearest the measured bit rate, and its header segment (EXT-X-MAP)
  // gives the sample rate and bit depth.
  const attrs = line => Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)]
    .map(m => [m[1], m[2].replace(/"/g, '')]));
  const audioIdIn = codecs => (familiesOf('audio/mp4; codecs="' + codecs + '"').find(f => f.kind === 'audio') || {}).id || '';
  function readPlaylist(text, base, info) {
    const lines = text.split(/\r?\n/);
    const renditions = lines.filter(l => l.startsWith('#EXT-X-MEDIA:')).map(attrs).filter(a => a.TYPE === 'AUDIO' && a.URI);
    const variants = [];
    lines.forEach((line, i) => {
      if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
      const a = attrs(line);
      const rendition = renditions.find(r => r['GROUP-ID'] === a.AUDIO);
      try {
        variants.push({ id: audioIdIn(a.CODECS || ''), bps: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
          uri: new URL(rendition ? rendition.URI : lines[i + 1], base).href });
      } catch (_) { /* a line this can't read */ }
    });
    if (variants.length) {
      info.variants = variants;
      const ids = new Set(variants.map(v => v.id));
      if (ids.size === 1) info.id = variants[0].id; // every version is the same codec
      return;
    }
    const map = /#EXT-X-MAP:(.*)/.exec(text); // a media playlist: read its header segment
    if (!map) return;
    const a = attrs(map[1]);
    const range = /^(\d+)(?:@(\d+))?$/.exec(a.BYTERANGE || '');
    const from = range ? Number(range[2] || 0) : 0;
    readUrl(new URL(a.URI, base).href, range ? 'bytes=' + from + '-' + (from + Number(range[1]) - 1) : '', info,
      data => readFormat(data, info));
  }
  // Once the bit rate is measured, settle which version is playing.
  function pickVariant(info, kbps) {
    if (!info.variants || info.picked || !kbps) return;
    const v = info.variants.reduce((a, b) => (Math.abs(b.bps / 1000 - kbps) < Math.abs(a.bps / 1000 - kbps) ? b : a));
    info.picked = v;
    if (v.id) info.id = v.id;
    readUrl(v.uri, 'bytes=0-262143', info, data => readPlaylist(new TextDecoder().decode(data), v.uri, info));
  }

  // A player that plays a plain file or an HLS playlist (no MediaSource) gets
  // the start of it fetched once, the same URL it is already playing, and the
  // header read from that. If the site's server refuses, the file extension
  // names the codec and there is no rate or bit depth.
  const EXT = { flac: 'flac', mp3: 'mp3', m4a: 'aac', mp4: 'aac', aac: 'aac', opus: 'opus', ogg: 'vorbis', wav: 'pcm' };
  const files = new Map(); // src -> { id, rate, bits, total, variants, picked }
  function plainFile(media) {
    const src = media && media.currentSrc;
    if (!src || !/^https?:/.test(src)) return null;
    if (files.has(src)) return files.get(src);
    if (files.size > 50) files.clear();
    const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(src.split('?')[0]);
    const info = { id: (ext && EXT[ext[1].toLowerCase()]) || '', rate: 0, bits: 0, total: 0 };
    files.set(src, info);
    readUrl(src, '', info, (data, r) => {
      if (readFormat(data, info)) {
        info.total = Number((/\/(\d+)$/.exec(r.headers.get('content-range') || '') || [])[1]) || 0;
        return;
      }
      const text = new TextDecoder().decode(data);
      if (text.startsWith('#EXTM3U')) readPlaylist(text, src, info);
    });
    return info;
  }

  // Bit rate from the browser's own count of audio bytes decoded, for players
  // whose segments this can't see. Averaged since this first looked.
  const decoded = new WeakMap(); // media -> [bytes, playback seconds] at the first look
  function decodedKbps(media) {
    const bytes = media && media.webkitAudioDecodedByteCount;
    if (!bytes) return 0;
    const t = media.currentTime;
    const first = decoded.get(media);
    if (!first || t < first[1] || bytes < first[0]) { decoded.set(media, [bytes, t]); return 0; }
    return t - first[1] > 2 ? (bytes - first[0]) * 8 / (t - first[1]) / 1000 : 0;
  }

  // Everything the popup shows about codecs, for the media element playing now.
  function codecStatus(media) {
    const file = opened.audio ? null : plainFile(media);
    const idOf = (mime, kind) => (familiesOf(mime).find(f => f.kind === kind) || {}).id || '';
    const plays = browserPlays();
    const choices = kind => {
      const ids = new Set([...CODECS[kind].map(c => c[0]).filter(id => plays[id]), ...offered[kind].keys()]);
      return [...ids].map(id => ({
        id, name: familyName(kind, id), site: offered[kind].has(id),
        browser: plays[id] !== undefined ? plays[id] : offered[kind].get(id) === true
      })).sort((a, b) => b.site - a.site);
    };
    const seconds = media && isFinite(media.duration) ? media.duration : 0;
    const kbps = (file ? (file.total && seconds > 1 ? file.total * 8 / seconds / 1000 : 0)
      : (audioStream.seconds > 1 ? audioStream.bytes * 8 / audioStream.seconds / 1000 : 0)) || decodedKbps(media);
    if (file) pickVariant(file, kbps);
    const audioId = file ? file.id : idOf(opened.audio, 'audio');
    const videoId = idOf(opened.video, 'video');
    const from = file || audioStream;
    return {
      audio: opened.audio, video: opened.video, audioId, videoId,
      audioName: audioId ? familyName('audio', audioId) : '', videoName: videoId ? familyName('video', videoId) : '',
      audioRate: from.rate,
      audioBits: /^(flac|alac|pcm)$/.test(audioId) ? from.bits : 0, // lossy codecs have no bit depth
      audioKbps: Math.round(kbps),
      choices: { audio: choices('audio'), video: choices('video') }
    };
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
      site: SITE, unity: settings.unity, canPatch: patchable,
      ...codecStatus(everyMedia().find(m => !m.paused) || everyMedia()[0])
    }));
  });
})();

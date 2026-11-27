// SPDX-License-Identifier: MPL-2.0
// BAE Lyte. Copyright (C) 2026 ETA Audio LLC.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// BAE Lyte's popup: Off or Purist, plus the codec pickers. Nothing else.
const api = globalThis.browser || globalThis.chrome;
const DEFAULTS = { unity: false, audioCodec: 'auto', videoCodec: 'auto' };
const settings = { ...DEFAULTS };
const el = id => document.getElementById(id);
let tabId = null;
let reloadingUntil = 0;
let lastChoices = { audio: [], video: [] }; // what the page last reported

// Every codec the menus know, with a type to ask this browser about. The
// popup asks the browser itself, so the menus are full even before the page
// has reported anything.
const MENU = {
  audio: [['aac', 'AAC', 'audio/mp4; codecs="mp4a.40.2"'], ['mp3', 'MP3', 'audio/mpeg'], ['opus', 'Opus', 'audio/webm; codecs="opus"'],
    ['vorbis', 'Vorbis', 'audio/webm; codecs="vorbis"'], ['flac', 'FLAC', 'audio/mp4; codecs="flac"'], ['alac', 'ALAC', 'audio/mp4; codecs="alac"'],
    ['ac-3', 'Dolby Digital', 'audio/mp4; codecs="ac-3"'], ['ec-3', 'Dolby Digital Plus', 'audio/mp4; codecs="ec-3"'],
    ['ac-4', 'Dolby AC-4', 'audio/mp4; codecs="ac-4.02.01.01"'], ['pcm', 'PCM', 'audio/wav']],
  video: [['h264', 'H.264', 'video/mp4; codecs="avc1.640028"'], ['hevc', 'HEVC', 'video/mp4; codecs="hvc1.1.6.L120.90"'],
    ['dovi', 'Dolby Vision', 'video/mp4; codecs="dvh1.05.06"'], ['vp8', 'VP8', 'video/webm; codecs="vp8"'],
    ['vp9', 'VP9', 'video/webm; codecs="vp09.00.40.08"'], ['av1', 'AV1', 'video/mp4; codecs="av01.0.08M.08"']]
};
const probe = document.createElement('video');
function canPlay(type) {
  try { return (globalThis.MediaSource && MediaSource.isTypeSupported(type)) || probe.canPlayType(type) !== ''; } catch (_) { return false; }
}

// The codec menus: codecs the site offered first, by name; then every other
// codec this browser plays, as "(Force) name". Rebuilt only when that changes.
function fillPicker(select, kind, choices, chosen) {
  const offered = new Map((choices || []).filter(c => c.site).map(c => [c.id, c]));
  const items = MENU[kind].map(([id, name, type]) => ({ id, name, site: offered.has(id),
    ok: offered.has(id) ? offered.get(id).browser !== false : canPlay(type) })).filter(c => c.site || c.ok);
  for (const c of offered.values()) {
    if (!MENU[kind].some(m => m[0] === c.id)) items.push({ id: c.id, name: c.name, site: true, ok: c.browser !== false });
  }
  items.sort((a, b) => b.site - a.site);
  if (chosen !== 'auto' && !items.some(c => c.id === chosen)) items.push({ id: chosen, name: chosen.toUpperCase(), site: false, ok: true });
  const key = JSON.stringify([items, chosen]);
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  select.textContent = '';
  select.append(new Option('Auto', 'auto'));
  for (const c of items) {
    const option = new Option(!c.ok ? c.name + " (browser can't play)" : c.site ? c.name : '(Force) ' + c.name, c.id);
    option.disabled = !c.ok;
    select.append(option);
  }
  select.value = chosen;
}

// "FLAC · 24-bit · 96 kHz · 2116 kbps"
const audioLine = s => [s.audioName, s.audioBits ? s.audioBits + '-bit' : '',
  s.audioRate ? s.audioRate / 1000 + ' kHz' : '', s.audioKbps ? s.audioKbps + ' kbps' : ''].filter(Boolean).join(' · ');

// One sentence about a forced codec, or '' when there is nothing to say.
function forcedNote(kind, chosen, status) {
  if (chosen === 'auto') return '';
  const list = (status.choices && status.choices[kind]) || [];
  const found = list.find(c => c.id === chosen);
  const name = found ? found.name : chosen.toUpperCase();
  const now = kind === 'audio' ? status.audioId : status.videoId;
  if (found && !found.browser) return "This browser can't play " + name + ', so ' + kind + ' stays on Auto.';
  if (now === chosen) return '';
  if (!found || !found.site) return 'This site hasn\'t offered ' + name + ' yet. If nothing plays, set ' + kind + ' back to Auto.';
  return now ? 'Reload the tab to switch ' + kind + ' to ' + name + '.' : '';
}

async function ask(message) {
  if (tabId === null) return null;
  try { return (await api.tabs.sendMessage(tabId, message)) || null; } catch (_) { return null; }
}

function show() {
  el('off').setAttribute('aria-pressed', String(!settings.unity));
  el('purist').setAttribute('aria-pressed', String(!!settings.unity));
  el('modeNote').textContent = settings.unity
    ? 'Full digital level, normalization bypassed, speed 1x. Set your level on your amp or DAC.'
    : 'Playing as the site delivers it.';
  fillPicker(el('audioCodec'), 'audio', lastChoices.audio, settings.audioCodec);
  fillPicker(el('videoCodec'), 'video', lastChoices.video, settings.videoCodec);
}

async function save(reload) {
  show();
  try { await api.storage.local.set(settings); } catch (_) { /* keep going */ }
  const reply = await ask({ type: 'yta-apply', settings });
  if (reply && reload) {
    // Players pick their formats when the page loads, so load it again.
    reloadingUntil = Date.now() + 5000;
    try { await api.tabs.reload(tabId); } catch (_) { /* keep going */ }
  }
  render(reply);
}

el('off').addEventListener('click', () => { settings.unity = false; save(false); });
el('purist').addEventListener('click', () => { settings.unity = true; save(false); });
for (const key of ['audioCodec', 'videoCodec']) {
  el(key).addEventListener('change', () => { settings[key] = el(key).value; save(true); });
}

function render(reply) {
  const line = el('playing');
  let status = null;
  try { status = reply && JSON.parse(reply.status); } catch (_) { /* below */ }
  line.classList.remove('bad');
  if (!status) {
    line.textContent = Date.now() < reloadingUntil ? 'Reloading the tab...' : 'Reload this tab, then try again.';
    if (Date.now() >= reloadingUntil) line.classList.add('bad');
    return;
  }
  if (status.choices) lastChoices = status.choices;
  fillPicker(el('audioCodec'), 'audio', lastChoices.audio, settings.audioCodec);
  fillPicker(el('videoCodec'), 'video', lastChoices.video, settings.videoCodec);
  const audio = audioLine(status);
  line.textContent = audio || status.videoName
    ? [audio && 'Audio: ' + audio, status.videoName && 'Video: ' + status.videoName].filter(Boolean).join('\n')
    : 'Play something to see its codec.';
  const note = [forcedNote('audio', settings.audioCodec, status), forcedNote('video', settings.videoCodec, status)].filter(Boolean).join(' ');
  el('codecNote').textContent = note;
  el('codecNote').hidden = !note;
}

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab && typeof tab.id === 'number') tabId = tab.id;
  } catch (_) { /* no tab */ }
  try { Object.assign(settings, await api.storage.local.get(DEFAULTS)); } catch (_) { /* defaults */ }
  show();
  const check = async () => render(await ask({ type: 'yta-status' }));
  check();
  setInterval(check, 1000);
})();

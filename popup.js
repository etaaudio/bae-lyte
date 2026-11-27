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

// The codec menus list what the page found: codecs the site offered first,
// then the others this browser plays. Rebuilt only when that list changes.
function fillPicker(select, list, chosen) {
  const key = JSON.stringify([list, chosen]);
  if (select.dataset.key === key) return;
  select.dataset.key = key;
  select.textContent = '';
  select.append(new Option('Auto', 'auto'));
  const group = (label, items, disabled) => {
    if (!items.length) return;
    const box = document.createElement('optgroup');
    box.label = label;
    for (const c of items) {
      const option = new Option(c.name, c.id);
      option.disabled = !!disabled;
      box.append(option);
    }
    select.append(box);
  };
  group('Offered by this site', list.filter(c => c.site && c.browser));
  group('This browser also plays', list.filter(c => !c.site && c.browser));
  group("Offered, but this browser can't play", list.filter(c => c.site && !c.browser), true);
  if (chosen !== 'auto' && !list.some(c => c.id === chosen)) select.append(new Option(chosen.toUpperCase() + ' (not found)', chosen));
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
  fillPicker(el('audioCodec'), (status.choices && status.choices.audio) || [], settings.audioCodec);
  fillPicker(el('videoCodec'), (status.choices && status.choices.video) || [], settings.videoCodec);
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

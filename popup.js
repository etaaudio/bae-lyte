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

const NAMES = [['mp4a', 'AAC'], ['opus', 'Opus'], ['av01', 'AV1'], ['vp09', 'VP9'], ['vp9', 'VP9'], ['avc1', 'H.264'], ['avc3', 'H.264']];
function codecName(mime) {
  if (!mime) return '';
  const match = /codecs\s*=\s*"?([^";]+)/i.exec(mime);
  const id = (match ? match[1] : mime).split(',')[0].trim().toLowerCase();
  const hit = NAMES.find(([prefix]) => id.startsWith(prefix));
  return hit ? hit[1] : id;
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
  el('audioCodec').value = settings.audioCodec;
  el('videoCodec').value = settings.videoCodec;
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
  line.className = '';
  if (!status) {
    line.textContent = Date.now() < reloadingUntil ? 'Reloading the tab...' : 'Reload this tab, then try again.';
    if (Date.now() >= reloadingUntil) line.className = 'bad';
    return;
  }
  const audio = codecName(status.audio);
  const video = codecName(status.video);
  line.textContent = audio || video
    ? 'Playing: ' + [audio, video].filter(Boolean).join(' · ')
    : 'Play something to see its codec.';
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

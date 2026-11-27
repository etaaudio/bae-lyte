// Checks the codec code in page.js outside a browser.
// Run: node test/codecs.js page.js [media files to read the format of]
// Runs the shared codec block outside a browser, with just enough stubs.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const start = src.indexOf('  /* ------------- codecs: what the site offers');
const end = src.indexOf('  // A player that plays a plain file');
const block = src.slice(start, end);
const plays = t => /mp4a|opus|flac|vp09|avc1|av01|audio\/mpeg|vorbis|vp8/.test(t);
global.window = { MediaSource: { isTypeSupported: plays } };
global.HTMLMediaElement = function () {}; HTMLMediaElement.prototype.canPlayType = t => (plays(t) ? 'maybe' : '');
global.document = { createElement: () => new HTMLMediaElement() };
const settings = { audio: 'flac', video: 'auto' };
const wanted = k => settings[k];
const wrap = (o, n, b) => { if (o && typeof o[n] === 'function') o[n] = b(o[n]); };
eval(block + `
const assert = require('assert');
assert.deepStrictEqual(familiesOf('video/mp4; codecs="avc1.640028, mp4a.40.2"'), [{kind:'video',id:'h264'},{kind:'audio',id:'aac'}]);
assert.deepStrictEqual(familiesOf('audio/flac'), [{kind:'audio',id:'flac'}]);
assert.deepStrictEqual(familiesOf('audio/mp4; codecs="mp4a.a6"'), [{kind:'audio',id:'ec-3'}]);
assert.deepStrictEqual(familiesOf('audio/mp4; codecs="xyz9.1"'), [{kind:'audio',id:'xyz9'}]);
assert.strictEqual(window.MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'), false); // AAC refused, FLAC forced
assert.strictEqual(window.MediaSource.isTypeSupported('audio/mp4; codecs="flac"'), true);
assert.strictEqual(window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028"'), true); // video on Auto
settings.audio = 'ac-3'; // the browser can't play it: never forced
assert.strictEqual(window.MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'), true);
assert.strictEqual(offered.audio.get('aac'), true);
assert.strictEqual(browserPlays()['ac-3'], false);
for (const f of process.argv.slice(3)) {
  const info = { id: "", rate: 0, bits: 0 };
  readFormat(fs.readFileSync(f), info);
  console.log(f.split("/").pop(), info.id, info.rate, info.bits);
}
console.log('checks pass');
`);

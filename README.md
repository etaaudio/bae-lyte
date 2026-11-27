# BAE Lyte

The lite edition of BAE: an **Off / Purist** switch and the **codec pickers**, nothing else.
No speed control, padded bits, crossfeed, B-Mode, clip guard, output picker or on-player readout.
A lite fork of [etaaudio/bae](https://github.com/etaaudio/bae), the full extension; the notes below describe BAE.

# BAE

B-audio Enhancer. A browser extension for people who care how YouTube and Spotify's web player sound.
One folder runs in Safari, Chrome and Firefox. Version 3.2.

## What it does

| Feature | YouTube | Spotify web player |
| --- | --- | --- |
| Purist: 0 dB, nothing processed | Yes | Yes |
| Bypass YouTube's volume normalization | Yes | Not applicable |
| Choose audio codec (Auto, AAC, Opus) | Yes | Not applicable, AAC only |
| Choose video codec (Auto, H.264, VP9, AV1) | Yes | Not applicable |
| Codec readout | Yes | Yes |
| Speed 0.25x to 3x, with or without pitch correction | Yes | Yes |
| Audio output device picker | Where the browser allows | Where the browser allows |
| Padded bits: gain above 0 dB, up to +20 dB (experimental) | Yes | Untested |
| Crossfeed for headphones (experimental) | Yes | Untested |
| B-Mode: bass shelf, +12 dB at 10, 20 or 40 Hz (experimental) | Yes | Untested |
| Clip guard: a peak limiter, or a plain cap on the gain, after padded bits and B-Mode (experimental) | Yes | Untested |
| Audio path: Tap, Stream capture or Rebuild, for browsers that don't pass audio to extensions (experimental) | Yes, AAC | Untested |
| Buffer readout, and a toolbar icon that turns green for Purist and blue while an effect is on | Yes | Yes |

### Purist

One switch that supersedes everything that alters the sound: full digital level with the
player's volume slider ignored, normalization bypassed, speed at 1x, pitch untouched, no
added gain, no crossfeed and no bass lift. Set the listening volume on your amp or DAC.

### Speed without the popup

| Action | Result |
| --- | --- |
| Option (Alt) + scroll over the video | Faster or slower, 0.05x per notch |
| Option (Alt) + Up / Down | Faster / slower |
| Option (Alt) + 0 | Back to 1x |

### Warnings

- **Padded bits will clip with clip guard off.** With it on, peaks are held under full
  scale by a limiter, which is audible when it works hard. Either way, gain above 0 dB
  can damage speakers, headphones and hearing.
  It is never saved and returns to 0 dB on every page load.
- **Purist plays at full level.** Turn your amp or DAC down before switching it on.
- **B-Mode lowers the overall level by 12 dB** so the bass lift has room below full
  scale. Turn your amp up to compensate, and back down before switching it off.
- **In Safari the experimental audio features have no effect on YouTube or Spotify.**
  Safari plays streamed video itself and passes no audio to the Web Audio engine (WebKit
  bugs 266922 and 256445), so padded bits, crossfeed, B-Mode and clip guard cannot change
  the sound there on the standard audio path. BAE detects this and says so. An
  experimental alternative, Audio path: Rebuild, reads and decodes YouTube's AAC audio
  itself and plays it in step with the picture; it is untested. Everything else works in
  Safari.
- Padded bits, crossfeed and B-Mode route audio through the browser's audio engine, which may
  resample it. Reload the tab to return to the untouched path.

## Install

Allow the extension on each site you use it with.

### Safari (18.4 or later)

Temporary: Settings > Developer > Add Temporary Extension, pick this folder, then on the
site click the toolbar button, choose "Always Allow on This Website", and reload.

Permanent: `xcrun safari-web-extension-packager /path/to/this/folder`, then Run in Xcode
with your Apple ID as the signing team.

### Chrome, Edge, Brave (111 or later)

`chrome://extensions` > turn on Developer mode > Load unpacked > pick this folder.
Chrome shows a harmless warning about `browser_specific_settings`.

### Firefox (128 or later)

`about:debugging` > This Firefox > Load Temporary Add-on > pick `manifest.json`.
Removed when Firefox quits; a permanent install needs signing at addons.mozilla.org.

## How it works

| File | Runs in | Job |
| --- | --- | --- |
| `manifest.json` | n/a | Declares the scripts, the popup and the sites |
| `page.js` | The page's own JavaScript world | Steers codec choice, manages volume, speed, output and the audio engine |
| `background.js` | The extension's background | Colours the toolbar icon: green for Purist, blue while something changes the sound |
| `bridge.js` | The extension's isolated world | Passes settings to `page.js` and answers the popup |
| `popup.html`, `popup.js` | The toolbar popup | The controls and readouts |

The extension collects no data and makes no network requests. It has no dependencies.

## Status

Tested in simulation; real-browser testing is in progress. Expect rough edges,
especially on Spotify and in the experimental section.

## Credits

Created by Thomas Lucio at ETA Audio LLC.

All code in this repository was written for this project. It contains no third-party code.
The following work informed the design:

- **abec2304**, whose "No YouTube Volume Normalization" userscripts showed that YouTube
  applies loudness normalization through the media element's volume. The idea of
  undoing it there comes from that work. No code from those scripts is used.
- **Crossfeed designs** by Benjamin Bauer (stereophonic-to-binaural network), Chu Moy
  and Jan Meier, and Boris Mikhaylov's bs2b library, which documents their cutoff and
  feed levels. The Light, Medium and Strong settings follow those published levels.
- **B-Mode** is a gentle first-order bass shelf of the kind found on high-end headphone
  amplifiers: a lift reaching 12 dB at 10, 20 or 40 Hz.
- Developed with the assistance of Claude, by Anthropic.

YouTube and Spotify are trademarks of their respective owners. This project is not
affiliated with or endorsed by either.

## License

Copyright (C) 2026 ETA Audio LLC.

This project is licensed under the Mozilla Public License 2.0. You may use, modify and
distribute it, including as part of a larger work under other terms, provided that the
files covered by this license, and any changes you make to them, remain available under
the MPL. See the [LICENSE](LICENSE) file for the full text, or
https://mozilla.org/MPL/2.0/.

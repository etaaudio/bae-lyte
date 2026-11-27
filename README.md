# BAE Lyte

The lite edition of [BAE](https://github.com/etaaudio/bae) (B-audio Enhancer). Two things, nothing else:

- **Off / Purist.** Purist plays every video and track at full digital level, so the site's
  loudness normalization can't turn it down. Set your listening level on your amp or DAC.
  Off leaves the page exactly as the site delivers it.
- **Codec choice.** Pick the audio codec (AAC or Opus) and video codec (H.264, VP9 or AV1)
  where the player offers them. The popup shows what is actually playing.

About 400 lines of plain JavaScript, no dependencies, no build step, no network requests,
and only the `storage` permission.

## Install

Download the package for your browser from [Releases](https://github.com/etaaudio/bae-lyte/releases):
`lyte-chrome.zip`, `lyte-firefox.zip` or `lyte-safari.zip` (a Mac app; until it is signed,
turn on Safari's Develop > Allow Unsigned Extensions).

To run from source: Chrome `chrome://extensions` > Developer mode > Load unpacked > this folder.
Firefox `about:debugging` > Load Temporary Add-on > `manifest.json`. Safari Develop > Add
Temporary Extension > this folder.

## How it works

`page.js` runs in the page before the site's code. For codec choice it answers "unplayable"
for the formats you didn't pick when the player asks what the browser supports; it never
forces a format the browser can't play. For Purist it intercepts writes to a media element's
`volume`: the site's value is remembered and reported back, while the element plays at 1.
Mute and fades to silence are always honoured. `bridge.js` passes your saved settings to
`page.js` and answers the popup.

## Releasing

Set `"version"` in `manifest.json`, commit, then `git tag v1.1 && git push && git push origin v1.1`.
GitHub builds the three packages and attaches them to a Release.

## Credits

Created by Thomas Lucio at ETA Audio LLC. All code was written for this project.
The idea of undoing loudness normalization at the media element's volume comes from
abec2304's "No YouTube Volume Normalization" userscripts; none of their code is used.
Developed with the assistance of Claude, by Anthropic.

YouTube and Spotify are trademarks of their respective owners. This project is not
affiliated with or endorsed by either.

## License

Copyright (C) 2026 ETA Audio LLC. Mozilla Public License 2.0; see [LICENSE](LICENSE).

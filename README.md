# Stream Bridge

An Orpheon / Myspoti extension that uses an **Eclipse Music add-on** as an audio provider. It asks the configured add-on to identify a recording, resolves its stream URL, and returns that URL to Orpheon's local player.

## What it does

- Uses the Eclipse add-on's `/manifest.json`, `/search`, `/resolve`, `/resolve-isrc`, and `/stream/{id}` endpoints where available.
- Prefers exact ISRC resolution, then Eclipse's strict `/resolve` endpoint. If neither is advertised, it searches and accepts only a matching title and artist, with an 8-second duration tolerance when both durations are supplied.
- Supports a direct `streamURL` in a search/resolve item or a URL returned by `/stream/{id}`.
- Passes through known codec, container-derived MIME type, sample rate, bit depth, duration, and supported URL-expiry metadata.
- Stores the add-on URL in a secret setting. Token paths are not written to the extension log.

## Install

1. Upload the contents of this repository to the root of `frasersimpson126/Stream-Bridge`.
2. Add the GitHub topic `myspoti-extension` under the repository's **About → Topics** section if you want the extension to be discoverable by the extension store.
3. In Orpheon, use **Install from an address** and enter `https://github.com/frasersimpson126/Stream-Bridge`.
4. Review the permissions. The extension requests `audio.source` and the critical `network` permission for `*`, because the add-on selected by the user may be hosted on any public HTTPS domain. Install only if you accept this access.
5. Open Stream Bridge settings and paste the Eclipse add-on URL. Use the complete manifest URL, for example `https://addon.example/manifest.json`. If the add-on uses a token path, include it: `https://addon.example/USER_TOKEN/manifest.json`.
6. Put Stream Bridge at the top of the audio-source order if you want it to be tried before other sources.

The Eclipse add-on does **not** need to be installed in the Orpheon app. Stream Bridge calls its public add-on API directly. Configure one add-on URL at a time; changing the setting switches the provider.

## Compatibility limits

This is a bridge between two different extension APIs, not a way to execute Eclipse add-on code inside Orpheon. It works with Eclipse add-ons whose manifest and API can be reached over public HTTPS and which return a direct playable audio URL.

Orpheon's extension HTTP client does not send cookies, does not follow redirects, and refuses local/private network addresses. Therefore:

- An add-on that relies on browser cookies or a login session will not work unless it supports a token in its URL path or otherwise exposes its API without cookies.
- An add-on requiring a redirect before returning its JSON response may not work.
- Localhost/LAN-only add-ons are not reachable from this extension runtime.
- Eclipse HLS/DASH manifest responses are not passed through. Orpheon's `audio.source` URL hook accepts a direct URL; its separate manifest feature is not the same as Eclipse's general HLS/DASH response.
- The add-on's returned URL must itself be a direct, public HTTP(S) audio URL. Orpheon performs its own public-address checks.
- Stream Bridge does not bypass DRM, authentication, subscriptions, paywalls, or provider restrictions. Use add-ons and streams you are authorised to access.

## Development

No runtime dependencies are required.

```bash
node tests/smoke-test.js
python scripts/pack.py
```

The pack script writes `dist/io.github.frasersimpson126.streambridge-1.0.0.zip`, containing only the extension package files at the archive root. Before publishing a production release, validate with the official `myspoti-ext check .` and `myspoti-ext pack .` commands supported by your installed Orpheon/Myspoti extension tooling.

## API references

- [Orpheon extension API](https://github.com/kota-zo/Orpheon/blob/main/docs/extensions/API.md)
- [Eclipse Music add-on developer guide](https://eclipsemusic.app/docs)

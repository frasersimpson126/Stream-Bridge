# Stream Bridge

Orpheon audio-source extension that bridges multiple Eclipse Music add-ons into Orpheon's playback source order.

## Features

- Configure up to **five Eclipse add-ons** independently.
- Each add-on has its own secret manifest URL, enable switch, and **Test add-on** button.
- Add-ons are tried in settings order (Add-on 1 through Add-on 5).
- If a provider is unavailable, has no suitable match, or cannot resolve a direct stream, the bridge tries the next enabled provider when fallback is enabled.
- Within each provider, tries ISRC resolution, then the optional identity resolver, then search when those capabilities are advertised.
- Strict matching is enabled by default. Optional relaxed matching and configurable duration tolerance are available.
- Reports each test result through an Orpheon notification.
- Token-bearing add-on URLs are stored as secret settings and are not written to logs.

## Configure

1. Install the extension in Orpheon.
2. Open Stream Bridge's settings page.
3. Paste each Eclipse add-on's complete HTTPS `manifest.json` URL into Add-on 1–5.
4. Leave the corresponding Enable switch on for providers you want included.
5. Press the **Test add-on N** button directly below each provider's URL and enable switch. A notification reports whether its manifest and search endpoint passed.
6. Providers are tried in numerical order. Put your preferred provider in Add-on 1, the next choice in Add-on 2, and so on.
7. Keep **Try the next add-on on failure** enabled to use automatic fallback.

The test button checks the manifest and sends a sample search request (`Never Gonna Give You Up Rick Astley`). It does not guarantee that every track can be streamed; a real playback attempt is still the definitive stream test.

## Fallback behaviour

For each enabled provider, Stream Bridge:

1. Fetches and validates its manifest.
2. Attempts ISRC resolution if advertised and an ISRC is present.
3. Attempts the optional identity resolver if advertised.
4. Searches for the track and checks the returned title, artist and (when available) duration.
5. Uses a direct `streamURL` from the matched result, or calls `/stream/{id}`.
6. Moves to the next enabled provider if the previous provider cannot produce a valid direct audio URL and fallback is enabled.

Strict matching is on by default. Relaxed matching can accept partial title/artist containment, so it may increase false matches. Duration tolerance applies only when both the requested and candidate durations are available.

## Compatibility and limitations

- Add-ons must be reachable over public HTTPS from Orpheon's extension HTTP client.
- Orpheon's HTTP client does not send cookies or follow redirects. Token-in-path add-ons may work if the token is included in the manifest URL.
- The returned audio URL must be a direct HTTP(S) audio URL. HLS/DASH manifests are not passed through.
- Add-ons that only work on localhost/LAN, require browser cookies, or return redirect-only stream URLs will not work in this bridge.
- The extension does not bypass DRM, subscriptions, paywalls, or provider access controls. Use providers and streams you are authorised to access.

## Development

No runtime dependencies are required. Validate with the official extension tooling:

```bash
myspoti-ext check .
myspoti-ext pack .
```

## API references

- [Orpheon / Myspoti extension API](https://github.com/kota-zo/myspoti/blob/main/docs/extensions/API.md)
- [Eclipse Music add-on developer guide](https://eclipsemusic.app/docs)

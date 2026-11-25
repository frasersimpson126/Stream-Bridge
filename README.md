# Stream Bridge

An Orpheon extension that connects Eclipse Music add-ons for streaming and downloads.

## Features

- Configure up to three add-ons.
- Automatically try another add-on if one fails.
- Stream and download supported audio formats.
- Test connections and run diagnostics.
- Configure matching and fallback options.

## Setup

1. Install the extension in Orpheon.
2. Open its settings.
3. Paste each add-on's HTTPS `manifest.json` URL.
4. Test the connection and enable the add-ons you want to use.

Add-ons are tried in settings order. Keep fallback enabled to move to the next add-on when needed.

## Development

```bash
myspoti-ext check .
myspoti-ext pack .
```

## Documentation

- [Orpheon extension API](https://github.com/kota-zo/myspoti/blob/main/docs/extensions/API.md)
- [Eclipse Music add-on guide](https://eclipsemusic.app/docs)

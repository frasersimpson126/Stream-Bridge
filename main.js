/*
 * Stream Bridge
 * Orpheon / Myspoti extension API v1 -> Eclipse Music Addon API
 *
 * The user supplies an Eclipse add-on manifest URL in the secret setting.
 * No credentials, cookies, tokens, or full URLs are written to the extension log.
 */
(function () {
  "use strict";

  var ADDON_COUNT = 3;
  var REQUEST_TIMEOUT_MS = 9000;
  var MANIFEST_TIMEOUT_MS = 6000;
  var STREAM_TIMEOUT_MS = 10000;
  var TEST_QUERY = "Never Gonna Give You Up Rick Astley";

  function text(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function setting(key) {
    try { return myspoti.settings.get(key); } catch (ignored) { return undefined; }
  }

  function addonBase(index) {
    var raw = text(setting("addon_" + index + "_url"));
    if (!raw || !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(raw)) return null;
    var authority = raw.match(/^https:\/\/([^/]+)/i);
    if (!authority || authority[1].indexOf("@") !== -1) return null;
    return raw.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "") || null;
  }

  function addonEnabled(index) {
    return setting("addon_" + index + "_enabled") !== false;
  }

  function configuredAddons() {
    var list = [];
    for (var i = 1; i <= ADDON_COUNT; i += 1) {
      var base = addonBase(i);
      if (base && addonEnabled(i)) list.push({ index: i, base: base });
    }
    return list;
  }

  function notify(message) {
    try {
      if (myspoti.notify) myspoti.notify(text(message).slice(0, 180));
      else myspoti.log(text(message).slice(0, 180));
    } catch (ignored) {}
  }

  function hasResource(resources, name) {
    return resources && typeof resources.indexOf === "function" && resources.indexOf(name) !== -1;
  }

  function requestJson(url, timeoutMs) {
    try {
      var response = myspoti.http.get(url, { timeout: timeoutMs || REQUEST_TIMEOUT_MS });
      if (!response || !response.ok) {
        return { ok: false, status: response ? response.status : 0, data: null };
      }
      var payload = response.json();
      if (!payload || typeof payload !== "object") {
        return { ok: false, status: response.status, data: null };
      }
      return { ok: true, status: response.status, data: payload };
    } catch (error) {
      // Avoid logging exception text: some add-on URLs include user tokens.
      return { ok: false, status: 0, data: null };
    }
  }

  function getManifest(base) {
    var result = requestJson(base + "/manifest.json", MANIFEST_TIMEOUT_MS);
    if (!result.ok) return null;
    var manifest = result.data;
    if (!manifest || !Array.isArray(manifest.resources)) return null;
    if (!hasResource(manifest.resources, "search") || !hasResource(manifest.resources, "stream")) return null;
    return manifest;
  }

  function artistName(track) {
    if (text(track && track.artist)) return text(track.artist);
    var artists = track && track.artists;
    if (!Array.isArray(artists)) return "";
    var names = [];
    for (var i = 0; i < artists.length; i += 1) {
      var item = artists[i];
      var name = typeof item === "string" ? item : text(item && (item.name || item.title));
      if (name) names.push(name);
    }
    return names.join(", ");
  }

  function normalise(value) {
    return text(value)
      .toLowerCase()
      .replace(/[\u2018\u2019'".,!?;:()[\]{}]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normaliseIsrc(value) {
    return text(value).toUpperCase().replace(/[\s-]/g, "");
  }

  function durationMs(track) {
    var value = Number(track && track.durationMs);
    return isFinite(value) && value > 0 ? value : 0;
  }

  function exactSearchMatch(requested, candidate) {
    if (!candidate || !text(candidate.id)) return false;
    if (candidate.type && candidate.type !== "track") return false;

    var wantedTitle = normalise(requested.title);
    var wantedArtist = normalise(artistName(requested));
    var foundTitle = normalise(candidate.title);
    var foundArtist = normalise(candidate.artist);
    if (!wantedTitle || !wantedArtist || !foundTitle || !foundArtist) return false;

    var wantedIsrc = normaliseIsrc(requested.isrc);
    var foundIsrc = normaliseIsrc(candidate.isrc);
    if (wantedIsrc && foundIsrc && wantedIsrc !== foundIsrc) return false;
    if (wantedIsrc && foundIsrc && wantedIsrc === foundIsrc) return true;

    var strict = setting("strict_match") !== false;
    if (strict) {
      if (wantedTitle !== foundTitle || wantedArtist !== foundArtist) return false;
    } else {
      if (wantedTitle !== foundTitle && wantedTitle.indexOf(foundTitle) < 0 && foundTitle.indexOf(wantedTitle) < 0) return false;
      if (wantedArtist !== foundArtist && wantedArtist.indexOf(foundArtist) < 0 && foundArtist.indexOf(wantedArtist) < 0) return false;
    }
    var wantedDuration = durationMs(requested);
    var foundDuration = Number(candidate.duration) * 1000;
    if (wantedDuration && isFinite(foundDuration) && foundDuration > 0) {
      var tolerance = Number(setting("duration_tolerance")) || 8;
      if (Math.abs(wantedDuration - foundDuration) > tolerance * 1000) return false;
    }
    return true;
  }

  function encodePathSegment(value) {
    return encodeURIComponent(String(value));
  }

  function isWebAudioUrl(url) {
    return /^https?:\/\/[^\s]+$/i.test(text(url));
  }

  function mimeFor(format, codec, container) {
    var value = text(container || format || codec).toLowerCase();
    if (value === "mp3") return "audio/mpeg";
    if (value === "flac") return "audio/flac";
    if (value === "aac" || value === "he-aac") return "audio/aac";
    if (value === "m4a" || value === "mp4" || value === "fmp4" || value === "alac") return "audio/mp4";
    if (value === "wav") return "audio/wav";
    if (value === "ogg" || value === "opus" || value === "vorbis") return "audio/ogg";
    return "";
  }

  function featureAvailable(name) {
    return !!(myspoti.features && myspoti.features.indexOf(name) !== -1);
  }

  function audioAnswer(requested, stream, fallbackFormat) {
    if (!stream || !isWebAudioUrl(stream.url)) return null;
    if (/\.(m3u8|mpd)(?:[?#]|$)/i.test(text(stream.url))) return null;

    // Orpheon's audio-source hook accepts a URL, not Eclipse HLS/DASH manifests.
    // Its special audio.manifest response is a different DASH-FLAC format.
    if (stream.manifest && String(stream.manifest).toLowerCase() !== "none") return null;

    var answer = { url: text(stream.url) };
    var length = durationMs(requested);
    if (!length && Number(stream.duration) > 0) length = Number(stream.duration) * 1000;
    if (length > 0) answer.durationMs = Math.round(length);

    var format = text(stream.format || fallbackFormat).toLowerCase();
    var container = text(stream.container || format).toLowerCase();
    var codec = text(stream.codec).toLowerCase();
    if (!codec && (format === "mp3" || format === "flac" || format === "aac")) codec = format;
    var mimeType = mimeFor(format, codec, container);
    if (mimeType) answer.mimeType = mimeType;

    // Do not claim that an M4A container is a particular codec (AAC vs ALAC).
    if (/^(flac|aac|he-aac|alac|mp3|opus|vorbis|eac3_joc)$/.test(codec)) answer.codec = codec;
    var bitDepth = Number(stream.bitDepth);
    if (isFinite(bitDepth) && bitDepth >= 8 && bitDepth <= 32) answer.bitDepth = bitDepth;
    var sampleRate = Number(stream.sampleRate);
    if (isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 768000) answer.sampleRate = sampleRate;

    if (stream.expiresAt !== undefined && featureAvailable("audio.expires")) {
      var expiry = Number(stream.expiresAt);
      if (isFinite(expiry) && expiry > 0) {
        var expiryMs = expiry < 1000000000000 ? expiry * 1000 : expiry;
        var remaining = expiryMs - Date.now();
        if (remaining <= 0) return null;
        answer.expiresInMs = Math.round(remaining);
      }
    }

    if (!answer.codec || (!answer.bitDepth && !answer.sampleRate)) {
      var quality = text(stream.quality);
      var label = "Eclipse Music";
      if (quality) label += " · " + quality;
      else if (format) label += " · " + format.toUpperCase();
      answer.source = label.slice(0, 80);
    }
    return answer;
  }

  function resolveByIsrc(base, requested, manifest) {
    var isrc = normaliseIsrc(requested.isrc);
    if (!isrc || !hasResource(manifest.resources, "isrc")) return undefined;
    var url = base + "/resolve-isrc?" + myspoti.query({ isrc: isrc });
    var result = requestJson(url, REQUEST_TIMEOUT_MS);
    if (!result.ok) return null;
    var id = text(result.data.trackId || result.data.id);
    return id ? { id: id } : null;
  }

  function resolveByIdentity(base, requested, manifest) {
    if (!hasResource(manifest.resources, "resolve")) return undefined;
    var url = base + "/resolve?" + myspoti.query({
      isrc: normaliseIsrc(requested.isrc) || undefined,
      title: text(requested.title),
      artist: artistName(requested),
      durationMs: durationMs(requested) || undefined
    });
    var result = requestJson(url, REQUEST_TIMEOUT_MS);
    if (!result.ok || !result.data.item || !text(result.data.item.id)) return null;

    var item = result.data.item;
    if (item.type && item.type !== "track") return null;
    if (normalise(item.title) !== normalise(requested.title)) return null;
    if (normalise(item.artist) !== normalise(artistName(requested))) return null;
    var wantedIsrc = normaliseIsrc(requested.isrc);
    var returnedIsrc = normaliseIsrc(item.isrc);
    // Eclipse's /resolve contract is exact when an ISRC was supplied.
    if (wantedIsrc && wantedIsrc !== returnedIsrc) return null;
    return item;
  }

  function resolveBySearch(base, requested) {
    var query = (artistName(requested) + " " + text(requested.title)).trim();
    if (!query) return null;
    var result = requestJson(base + "/search?" + myspoti.query({ q: query }), REQUEST_TIMEOUT_MS);
    if (!result.ok || !Array.isArray(result.data.tracks)) return null;

    for (var i = 0; i < result.data.tracks.length; i += 1) {
      var candidate = result.data.tracks[i];
      if (exactSearchMatch(requested, candidate)) return candidate;
    }
    return null;
  }

  function fetchStream(base, trackId) {
    var url = base + "/stream/" + encodePathSegment(trackId);
    var result = requestJson(url, STREAM_TIMEOUT_MS);
    return result.ok ? result.data : null;
  }

  function resolveWithAddon(addon, track) {
    var base = addon.base;
    var manifest = getManifest(base);
    if (!manifest) return null;
    var resolved = null;
    if (normaliseIsrc(track.isrc) && hasResource(manifest.resources, "isrc")) {
      resolved = resolveByIsrc(base, track, manifest);
    }
    if (!resolved && hasResource(manifest.resources, "resolve")) {
      resolved = resolveByIdentity(base, track, manifest);
    }
    if (!resolved && hasResource(manifest.resources, "search")) {
      resolved = resolveBySearch(base, track);
    }
    if (!resolved) return null;
    if (text(resolved.streamURL)) {
      return audioAnswer(track, { url: resolved.streamURL, format: resolved.format }, resolved.format);
    }
    if (!text(resolved.id)) return null;
    return audioAnswer(track, fetchStream(base, resolved.id), resolved.format);
  }

  function downloadAnswer(track, stream, fallbackFormat, isrcMatched) {
    if (!stream || !isWebAudioUrl(stream.url)) return null;
    if (stream.manifest && String(stream.manifest).toLowerCase() !== "none") return null;
    if (/\\.(m3u8|mpd)(?:[?#]|$)/i.test(text(stream.url))) return null;

    var format = text(stream.format || fallbackFormat).toLowerCase();
    if (format === "mp4" || format === "aac" || format === "alac") format = "m4a";
    if (format !== "flac" && format !== "m4a" && format !== "mp3") return null;

    var file = {
      url: text(stream.url),
      format: format,
      provider: "Eclipse Music"
    };
    var bitDepth = Number(stream.bitDepth);
    if (isFinite(bitDepth) && bitDepth >= 8 && bitDepth <= 32) file.bitDepth = bitDepth;
    var sampleRate = Number(stream.sampleRate);
    if (isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 768000) file.sampleRate = sampleRate;
    var sizeHint = Number(stream.sizeHint || stream.size);
    if (isFinite(sizeHint) && sizeHint > 0) file.sizeHint = Math.round(sizeHint);
    if (isrcMatched) file.isrcMatched = true;
    return file;
  }

  function resolveDownloadWithAddon(addon, track) {
    var base = addon.base;
    var manifest = getManifest(base);
    if (!manifest) return null;

    var resolved = null;
    var matchedByIsrc = false;
    if (normaliseIsrc(track.isrc) && hasResource(manifest.resources, "isrc")) {
      resolved = resolveByIsrc(base, track, manifest);
      matchedByIsrc = !!resolved;
    }
    if (!resolved && hasResource(manifest.resources, "resolve")) {
      resolved = resolveByIdentity(base, track, manifest);
    }
    if (!resolved && hasResource(manifest.resources, "search")) {
      resolved = resolveBySearch(base, track);
    }
    if (!resolved) return null;

    var stream = null;
    if (text(resolved.streamURL)) {
      stream = { url: resolved.streamURL, format: resolved.format };
    } else if (text(resolved.id)) {
      stream = fetchStream(base, resolved.id);
    }
    var file = downloadAnswer(track, stream, resolved.format, matchedByIsrc);
    return file ? [file] : null;
  }

  function testAddon(index) {
    var base = addonBase(index);
    if (!base) {
      notify("Add-on " + index + ": enter a valid HTTPS manifest URL first.");
      return;
    }
    var manifest = getManifest(base);
    if (!manifest) {
      notify("Add-on " + index + ": manifest check failed. Check URL, token and HTTPS access.");
      return;
    }
    if (!hasResource(manifest.resources, "search") || !hasResource(manifest.resources, "stream")) {
      notify("Add-on " + index + ": manifest must advertise both search and stream.");
      return;
    }
    var result = requestJson(base + "/search?" + myspoti.query({ q: TEST_QUERY }), REQUEST_TIMEOUT_MS);
    if (!result.ok || !Array.isArray(result.data.tracks)) {
      notify("Add-on " + index + ": manifest works, but search test failed.");
      return;
    }
    notify((text(manifest.name) || ("Add-on " + index)) + ": connection and search test passed (" + result.data.tracks.length + " tracks returned).");
  }

  function diagnosticTrack() {
    var title = text(setting('diagnostic_track_title'));
    var artist = text(setting('diagnostic_track_artist'));
    if (!title || !artist) return null;
    return { title: title, artist: artist, isrc: text(setting('diagnostic_track_isrc')), durationMs: Number(setting('diagnostic_track_duration_ms')) || 0 };
  }

  function runDiagnostics() {
    var addons = configuredAddons();
    if (!addons.length) { notify('Diagnostics: no enabled add-ons with valid HTTPS URLs.'); return; }
    var track = diagnosticTrack();
    var passed = 0;
    for (var i = 0; i < addons.length; i += 1) {
      var addon = addons[i];
      var manifest = getManifest(addon.base);
      if (!manifest) { notify('Add-on ' + addon.index + ': FAIL — manifest unavailable or invalid.'); continue; }
      if (!hasResource(manifest.resources, 'search') || !hasResource(manifest.resources, 'stream')) { notify('Add-on ' + addon.index + ': FAIL — search/stream capability missing.'); continue; }
      var sample = requestJson(addon.base + '/search?' + myspoti.query({ q: TEST_QUERY }), REQUEST_TIMEOUT_MS);
      if (!sample.ok || !Array.isArray(sample.data.tracks)) { notify('Add-on ' + addon.index + ': FAIL — sample search failed.'); continue; }
      if (track && !resolveWithAddon(addon, track)) { notify('Add-on ' + addon.index + ': FAIL — diagnostic track did not produce a playable stream.'); continue; }
      passed += 1;
      notify((text(manifest.name) || ('Add-on ' + addon.index)) + ': PASS — ' + (track ? 'track resolved to a playable stream.' : 'manifest and sample search passed.'));
    }
    notify('Diagnostics complete: ' + passed + '/' + addons.length + ' providers passed.');
  }

  function testDiagnosticTrack() {
    var track = diagnosticTrack();
    if (!track) { notify('Track test: enter a diagnostic title and artist in settings.'); return; }
    var addons = configuredAddons();
    if (!addons.length) { notify('Track test: no enabled providers are configured.'); return; }
    var fallback = setting('fallback_enabled') !== false;
    for (var i = 0; i < addons.length; i += 1) {
      var answer = resolveWithAddon(addons[i], track);
      if (answer) { notify('Add-on ' + addons[i].index + ': diagnostic track passed; playable stream found.'); return; }
      notify('Add-on ' + addons[i].index + ': diagnostic track failed.');
      if (!fallback) break;
    }
    notify('Track test failed: no provider returned a playable stream.');
  }
  myspoti.provide("status", function () {
    var addons = configuredAddons();
    if (!addons.length) return { live: false, detail: "Add at least one enabled HTTPS Eclipse add-on URL in Stream Bridge settings." };
    for (var i = 0; i < addons.length; i += 1) {
      if (getManifest(addons[i].base)) return { live: true };
    }
    return { live: false, detail: "No configured Eclipse add-on is responding. Test each add-on in settings." };
  });

  myspoti.provide("download-source", function (track) {
    try {
      if (!track || !text(track.title) || !artistName(track)) return null;
      var addons = configuredAddons();
      if (!addons.length) return null;
      var fallback = setting("fallback_enabled") !== false;
      for (var i = 0; i < addons.length; i += 1) {
        var files = resolveDownloadWithAddon(addons[i], track);
        if (files && files.length) return files;
        if (!fallback) break;
      }
      return null;
    } catch (error) {
      try { myspoti.log("Stream Bridge: configured add-ons could not provide a download."); } catch (ignored) {}
      return null;
    }
  });

  myspoti.provide("audio-source", function (track) {
    try {
      if (!track || !text(track.title) || !artistName(track)) return null;
      var addons = configuredAddons();
      if (!addons.length) return null;
      var fallback = setting("fallback_enabled") !== false;
      for (var i = 0; i < addons.length; i += 1) {
        var answer = resolveWithAddon(addons[i], track);
        if (answer) return answer;
        if (!fallback) break;
      }
      return null;
    } catch (error) {
      try { myspoti.log("Stream Bridge: all configured add-ons failed to resolve this track."); } catch (ignored) {}
      return null;
    }
  });

  myspoti.on("setting", function (event) {
    if (!event || !event.pressed) return;
    var match = text(event.key).match(/^addon_([1-3])_test$/);
    if (match) testAddon(Number(match[1]));
    else if (text(event.key) === 'run_diagnostics') runDiagnostics();
    else if (text(event.key) === 'test_diagnostic_track') testDiagnosticTrack();
  });
}());

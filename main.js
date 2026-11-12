/*
 * Stream Bridge
 * Orpheon / Myspoti extension API v1 -> Eclipse Music Addon API
 *
 * The user supplies an Eclipse add-on manifest URL in the secret setting.
 * No credentials, cookies, tokens, or full URLs are written to the extension log.
 */
(function () {
  "use strict";

  var SETTING_URL = "addon_url";
  var REQUEST_TIMEOUT_MS = 9000;
  var MANIFEST_TIMEOUT_MS = 6000;
  var STREAM_TIMEOUT_MS = 10000;

  function text(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function settingBaseUrl() {
    var raw = text(myspoti.settings.get(SETTING_URL));
    if (!raw) return null;

    // Token-bearing path prefixes are supported. Query strings, fragments,
    // URL credentials, and non-HTTPS schemes are deliberately rejected.
    if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/i.test(raw)) return null;
    var authority = raw.match(/^https:\/\/([^/]+)/i);
    if (!authority || authority[1].indexOf("@") !== -1) return null;

    var base = raw.replace(/\/manifest\.json$/i, "");
    base = base.replace(/\/+$/, "");
    return base || null;
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

    if (wantedTitle !== foundTitle || wantedArtist !== foundArtist) return false;

    var wantedDuration = durationMs(requested);
    var foundDuration = Number(candidate.duration) * 1000;
    if (wantedDuration && isFinite(foundDuration) && foundDuration > 0) {
      if (Math.abs(wantedDuration - foundDuration) > 8000) return false;
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

  myspoti.provide("status", function () {
    var base = settingBaseUrl();
    if (!base) {
      return { live: false, detail: "Set an HTTPS Eclipse add-on manifest URL in Stream Bridge settings." };
    }
    var manifest = getManifest(base);
    if (!manifest) {
      return { live: false, detail: "Could not read the add-on manifest. Check the URL and any token path." };
    }
    return { live: true };
  });

  myspoti.provide("audio-source", function (track) {
    try {
      if (!track || !text(track.title) || !artistName(track)) return null;
      var base = settingBaseUrl();
      if (!base) return null;

      var manifest = getManifest(base);
      if (!manifest) return null;

      var resolved;
      if (normaliseIsrc(track.isrc) && hasResource(manifest.resources, "isrc")) {
        resolved = resolveByIsrc(base, track, manifest);
        if (!resolved) return null;
      } else if (hasResource(manifest.resources, "resolve")) {
        resolved = resolveByIdentity(base, track, manifest);
        if (!resolved) return null;
      } else {
        resolved = resolveBySearch(base, track);
        if (!resolved) return null;
      }

      if (text(resolved.streamURL)) {
        return audioAnswer(track, { url: resolved.streamURL, format: resolved.format }, resolved.format);
      }

      var stream = fetchStream(base, resolved.id);
      return audioAnswer(track, stream, resolved.format);
    } catch (error) {
      // Keep token-bearing URLs and provider-specific exception text out of logs.
      try { myspoti.log("Stream Bridge: the configured add-on could not resolve this track."); } catch (ignored) {}
      return null;
    }
  });
}());

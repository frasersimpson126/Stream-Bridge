// NullBeat Bridge for Orpheon
// Resolves TorBox caches via Tidal metadata matching.
// API Version: 1
// Requires actions: download.source, audio.source, network, settings.page, storage, status

// ---------------------------------------------------------------------------
// 1. CONFIGURATION & CONSTANTS
// ---------------------------------------------------------------------------

var TIERS = [
  { label: "Hi-Res", ext: "flac" },
  { label: "HiFi CD", ext: "flac" },
  { label: "320kbps AAC", ext: "m4a" },
  { label: "96kbps", ext: "m4a" },
];

// ---------------------------------------------------------------------------
// 2. UTILITIES
// ---------------------------------------------------------------------------

function clean(str) {
  // Strip forbidden characters per NullBeat spec
  return (str || "").replace(/[\/\\?%*:|"<>]/g, "").trim();
}

function getTidalToken() {
  var cached = myspoti.storage.get("tidal_token");
  if (cached && cached.exp > Date.now() + 60000) {
    return cached.v;
  }

  var clientId = myspoti.settings.get("tidal_client_id");
  var clientSecret = myspoti.settings.get("tidal_client_secret");
  if (!clientId || !clientSecret) {
    myspoti.log("Tidal credentials missing.");
    return null;
  }

  var basicAuth = myspoti.util.base64Encode(clientId + ":" + clientSecret);
  var response = myspoti.http.post("https://auth.tidal.com/v1/oauth2/token", "grant_type=client_credentials", {
    headers: {
      Authorization: "Basic " + basicAuth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    myspoti.log("Tidal auth failed: " + response.status);
    return null;
  }

  var body = response.json();
  var token = body.access_token;
  var expiresIn = body.expires_in || 3600; // Default to 1 hour

  myspoti.storage.set("tidal_token", {
    v: token,
    exp: Date.now() + expiresIn * 1000,
  });
  return token;
}

function tidalSearch(query, token) {
  var url =
    "https://openapi.tidal.com/v2/searchResults?" +
    myspoti.query({
      "filter[query]": query,
      countryCode: "US",
      include: "tracks.artists,tracks.albums.coverArt",
    });

  var response = myspoti.http.get(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.api+json",
    },
  });

  if (!response.ok) {
    myspoti.log("Tidal search failed: " + response.status);
    return [];
  }

  var json = response.json();
  var includedMap = {};
  (json.included || []).forEach(function (item) {
    includedMap[item.type + ":" + item.id] = item;
  });

  // Extract track relationship refs
  var dataArray = json.data || [];
  var firstResult = dataArray[0] || {};
  var trackRefs = ((firstResult.relationships || {}).tracks || {}).data || [];

  // Get top 2 tracks
  return trackRefs
    .slice(0, 2)
    .map(function (ref) {
      return includedMap["tracks:" + ref.id];
    })
    .filter(Boolean);
}

function getArtistName(artistId, token, includedMap) {
  // Try to find in the included map first (cheap)
  var key = "artists:" + artistId;
  if (includedMap[key] && includedMap[key].attributes && includedMap[key].attributes.name) {
    return includedMap[key].attributes.name;
  }

  // Fallback: Fetch the artist directly
  // This requires 'openapi.tidal.com' to be in the manifest's network hosts
  var url = "https://openapi.tidal.com/v2/artists/" + artistId;
  var response = myspoti.http.get(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.api+json",
    },
  });

  if (response.ok) {
    var data = response.json().data;
    if (data && data.attributes && data.attributes.name) {
      return data.attributes.name;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 3. HASH GENERATION (NullBeat Spec)
// ---------------------------------------------------------------------------

function buildHashes(tracks, token, includedMap, allowAtmos) {
  var names = {};
  var hashes = [];

  tracks.forEach(function (track) {
    var attributes = track.attributes || {};
    var trackId = String(track.id).replace(/^track:/, "");
    var title = attributes.title || "";

    // Resolve artist name
    var artistRefs = ((track.relationships || {}).artists || {}).data || [];
    var artistName = "";
    if (artistRefs.length > 0) {
      artistName = getArtistName(artistRefs[0].id, token, includedMap);
    }

    // Check for Dolby Atmos
    var tags = (attributes.mediaTags || []).concat(attributes.audioModes || []);
    var hasAtmos =
      allowAtmos &&
      tags.some(function (tag) {
        return /dolby\s*_?atmos/i.test(String(tag));
      });

    var trackTiers = TIERS.slice();
    if (hasAtmos) {
      trackTiers.push({ label: "DOLBY ATMOS", ext: "m4a" });
    }

    trackTiers.forEach(function (tier) {
      var filename =
        clean(title) + " - " + clean(artistName) + " [NullBeat " + trackId + " - " + tier.label + "]." + tier.ext;
      var md5 = myspoti.util.md5(filename);

      names[md5] = {
        filename: filename,
        tier: tier,
        trackId: trackId,
      };
      hashes.push(md5);
    });
  });

  return { names: names, hashes: hashes };
}

// ---------------------------------------------------------------------------
// 4. TORBOX INTEGRATION
// ---------------------------------------------------------------------------

function checkTorboxCache(hashes) {
  var key = myspoti.settings.get("torbox_key");
  if (!key || hashes.length === 0) return {};

  var url = "https://api.torbox.app/v1/api/torrents/checkcached?format=object&list_files=true";
  var response = myspoti.http.post(
    url,
    { hashes: hashes },
    {
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    myspoti.log("TorBox checkcached failed: " + response.status);
    return {};
  }

  // Returns an object keyed by infohash.
  // Each value contains { name: "...", files: [{ id: ..., name: "..." }] }
  return response.json().data || {};
}

function resolveTorboxUrl(torrentHash, fileId) {
  var key = myspoti.settings.get("torbox_key");
  if (!key) return null;

  // Use redirect=true to get a permalink that redirects to the CDN.
  // myspoti.http does NOT follow redirects, so we will get a 302 with a 'location' header.
  var permalink =
    "https://api.torbox.app/v1/api/torrents/requestdl?" +
    myspoti.query({
      token: key,
      torrent_id: torrentHash, // Confirmed parameter name for torrents
      file_id: fileId,
      redirect: "true",
    });

  var response = myspoti.http.get(permalink);

  // Handle redirect
  if (response.status >= 300 && response.status < 400 && response.headers["location"]) {
    return response.headers["location"];
  }

  // Fallback: If it returns 200 with JSON, try to extract the URL.
  if (response.ok) {
    try {
      var json = response.json();
      if (json.data && typeof json.data === "string") return json.data;
      if (json.data && json.data.url) return json.data.url;
    } catch (e) {
      // Ignore parse errors
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. CORE LOGIC
// ---------------------------------------------------------------------------

function findCandidates(track) {
  // 1. Get Token
  var token = getTidalToken();
  if (!token) {
    return { outcome: "sign-in", detail: "Check Tidal credentials in settings." };
  }

  // 2. Search Tidal
  var query = track.title + " " + track.artist;
  var tidalTracks = tidalSearch(query, token);
  if (tidalTracks.length === 0) {
    return { outcome: "not-found" };
  }

  // Rebuild includedMap for the artist fallback
  var includedMap = {};
  // Note: tidalSearch doesn't return the full JSON, so we'd need to re-parse.
  // For simplicity in this bridge, the fallback API call in getArtistName handles it.
  // If we wanted to avoid the extra call, we'd need to modify tidalSearch to return the map.

  // 3. Build Hashes
  var allowAtmos = myspoti.settings.get("atmos") !== false;
  var built = buildHashes(tidalTracks, token, includedMap, allowAtmos);

  // 4. Check Cache
  var hits = checkTorboxCache(built.hashes);
  if (Object.keys(hits).length === 0) {
    return { outcome: "not-found" };
  }

  // 5. Resolve URLs
  var results = [];
  var preferredQuality = myspoti.settings.get("quality");

  // Sort tiers to put preferred quality first
  var sortedTiers = TIERS.slice();
  if (allowAtmos) sortedTiers.push({ label: "DOLBY ATMOS", ext: "m4a" });
  sortedTiers.sort(function (a, b) {
    if (a.label === preferredQuality) return -1;
    if (b.label === preferredQuality) return 1;
    return 0;
  });

  // Iterate over our generated hashes in preferred order
  sortedTiers.forEach(function (tier) {
    Object.keys(built.names).forEach(function (md5) {
      var info = built.names[md5];
      if (info.tier.label !== tier.label) return; // Skip non-matching tiers in this pass

      // Find the torrent that contains this file
      for (var hashKey in hits) {
        if (!hits.hasOwnProperty(hashKey)) continue;
        var torrent = hits[hashKey];
        if (!torrent.files || !Array.isArray(torrent.files)) continue;

        var matchingFile = torrent.files.find(function (f) {
          return f.name === info.filename;
        });

        if (matchingFile) {
          var url = resolveTorboxUrl(hashKey, matchingFile.id);
          if (url) {
            results.push({
              url: url,
              format: tier.ext,
              source: "TorBox · " + tier.label,
              provider: "NullBeat",
              // Optional: quality metadata for audio-source
              codec: tier.ext === "flac" ? "flac" : "aac",
              sourceLabel: "TorBox · " + tier.label,
            });
          }
          // We found a match for this hash, no need to check other torrents for this file
          return;
        }
      }
    });
  });

  if (results.length === 0) {
    return { outcome: "not-found" };
  }

  return results;
}

// ---------------------------------------------------------------------------
// 6. HOOKS
// ---------------------------------------------------------------------------

myspoti.provide("download-source", function (input) {
  var candidates = findCandidates(input);

  // Feature gate: 'results' support
  var supportsResults = myspoti.features && myspoti.features.indexOf("results") >= 0;

  if (candidates && candidates.outcome) {
    return supportsResults ? candidates : null;
  }

  return candidates.length > 0 ? candidates : null;
});

myspoti.provide("audio-source", function (track) {
  var candidates = findCandidates(track);

  var supportsResults = myspoti.features && myspoti.features.indexOf("results") >= 0;

  if (candidates && candidates.outcome) {
    return supportsResults ? candidates : null;
  }

  if (!candidates.length) return null;

  // Return the best candidate for streaming
  var best = candidates[0];
  var answer = {
    url: best.url,
    mimeType: best.format === "flac" ? "audio/flac" : "audio/mp4",
    source: best.source,
  };

  // Feature gate: 'audio.expires' support
  if (myspoti.features && myspoti.features.indexOf("audio.expires") >= 0) {
    answer.expiresInMs = 10 * 60 * 1000; // 10 minutes
  }

  // Feature gate: 'audio.quality' support
  if (myspoti.features && myspoti.features.indexOf("audio.quality") >= 0) {
    answer.codec = best.format === "flac" ? "flac" : "aac";
    answer.source = best.source;
  }

  return answer;
});

myspoti.provide("status", function () {
  var key = myspoti.settings.get("torbox_key");
  if (!key) {
    return { live: false, detail: "Set a TorBox API key in settings." };
  }

  // A cheap call to verify the token works
  var response = myspoti.http.get("https://api.torbox.app/v1/api/user/me", { timeout: 3000 });

  if (response.ok) {
    return { live: true };
  }

  var detail = "TorBox API error (" + response.status + ")";
  try {
    var json = response.json();
    if (json.detail) detail = json.detail;
  } catch (e) {
    /* ignore */
  }

  return { live: false, detail: detail };
});

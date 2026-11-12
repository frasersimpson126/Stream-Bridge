const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');

function makeRuntime(settings, routes) {
  const provided = {};
  const listeners = {};
  const notifications = [];
  const logs = [];
  const context = {
    Date,
    encodeURIComponent,
    isFinite,
    myspoti: {
      settings: { get: key => settings[key] },
      features: ['audio.expires'],
      query: obj => Object.keys(obj).filter(k => obj[k] !== undefined).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&'),
      http: { get(url) {
        const value = routes[url];
        if (!value) return { ok: false, status: 404, json: () => ({}) };
        return { ok: true, status: 200, json: () => value };
      } },
      provide: (name, fn) => { provided[name] = fn; },
      on: (name, fn) => { listeners[name] = fn; },
      notify: message => notifications.push(message),
      log: message => logs.push(message)
    }
  };
  vm.runInNewContext(source, context);
  return { provided, listeners, notifications, logs };
}

const settings = {
  addon_1_url: 'https://one.example/manifest.json', addon_1_enabled: true,
  addon_2_url: 'https://two.example/manifest.json', addon_2_enabled: true,
  fallback_enabled: true, strict_match: true, duration_tolerance: '8'
};
const routes = {
  'https://two.example/manifest.json': { id: 'two', resources: ['search', 'stream'], name: 'Provider Two' },
  'https://two.example/search?q=Never%20Gonna%20Give%20You%20Up%20Rick%20Astley': { tracks: [] },
  'https://two.example/search?q=Rick%20Astley%20Never%20Gonna%20Give%20You%20Up': {
    tracks: [{ id: 'track-1', title: 'Never Gonna Give You Up', artist: 'Rick Astley', duration: 213, format: 'mp3' }]
  },
  'https://two.example/stream/track-1': { url: 'https://cdn.example/audio.mp3', format: 'mp3', quality: '320kbps' }
};
const runtime = makeRuntime(settings, routes);
const answer = runtime.provided['audio-source']({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', durationMs: 213000 });
assert(answer && answer.url === 'https://cdn.example/audio.mp3', 'should fall through from provider 1 to provider 2');
assert(answer.mimeType === 'audio/mpeg', 'should infer mp3 MIME type');
runtime.listeners.setting({ key: 'addon_2_test', pressed: true });
assert(runtime.notifications.some(n => n.includes('Provider Two') && n.includes('passed')), 'test button should report provider test result');

const noFallback = makeRuntime({ ...settings, fallback_enabled: false }, routes);
assert.strictEqual(noFallback.provided['audio-source']({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' }), null, 'disabled fallback should stop after first provider fails');
console.log('Stream Bridge smoke tests passed: multi-provider fallback, direct stream metadata, per-provider test button, fallback toggle.');

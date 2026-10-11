/**
 * Product usage on the hosted backend: how many people connect, what they
 * pick, where it breaks. In memory — a Railway redeploy clears it — and
 * deliberately empty of recitation text, audio, and credentials.
 *
 * Read via GET /api/analytics with DIAG_TOKEN. /api/status only exposes the
 * live connection count.
 */

const MAX_RECENT = 80;
const MAX_UNIQUES = 4000;
// Client `type: usage` may only add these. Connect/init/start/stop come from
// the real WebSocket lifecycle so a phone cannot inflate those counters.
const ALLOWED_EVENTS = new Set([
  'error', 'lang_pack', 'key_missing', 'key_ok',
]);

function bucket(value, fallback = '(none)') {
  const s = String(value == null ? '' : value).trim();
  return (s || fallback).slice(0, 48);
}

function scrub(text) {
  return String(text || '')
    .replace(/gsk_[A-Za-z0-9]+/g, 'gsk_…')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-…')
    .replace(/Bearer\s+\S+/gi, 'Bearer …')
    .slice(0, 160);
}

function inc(map, key) {
  const k = bucket(key);
  map[k] = (map[k] || 0) + 1;
}

function sorted(map) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

export class UsageStats {
  constructor({ now = Date.now } = {}) {
    this._now = now;
    this.startedAt = now();
    this.connectionsOpened = 0;
    this.connectionsClosed = 0;
    this.peakConcurrent = 0;
    this.inits = 0;
    this.starts = 0;
    this.stops = 0;
    this.errors = 0;
    this.langPacks = 0;
    this.byLang = {};
    this.byProvider = {};
    this.byAudio = {};
    this.byMode = {};
    this.byPipeline = {};
    this.byAppVersion = {};
    this.byError = {};
    this.uniques = new Map();
    this.recent = [];
  }

  _touchUnique(sessionId) {
    const id = bucket(sessionId, '');
    if (!id) return;
    if (!this.uniques.has(id) && this.uniques.size >= MAX_UNIQUES) {
      const oldest = this.uniques.keys().next().value;
      this.uniques.delete(oldest);
    }
    this.uniques.set(id, this._now());
  }

  _recent(event, detail) {
    this.recent.push({ ts: this._now(), event, ...detail });
    while (this.recent.length > MAX_RECENT) this.recent.shift();
  }

  connected({ concurrent = 0, sessionId = '' } = {}) {
    this.connectionsOpened += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, concurrent);
    this._touchUnique(sessionId);
    this._recent('connect', { concurrent });
  }

  disconnected() {
    this.connectionsClosed += 1;
    this._recent('disconnect', {});
  }

  init(meta = {}) {
    this.inits += 1;
    this._touchUnique(meta.sessionId);
    inc(this.byLang, meta.lang || '(english)');
    inc(this.byProvider, meta.provider || 'groq');
    inc(this.byAudio, meta.audioSource || 'g2');
    inc(this.byMode, meta.practiceMode ? 'practice' : 'taraweeh');
    inc(this.byPipeline, meta.pipeline || 'v4');
    inc(this.byAppVersion, meta.appVersion || '(unknown)');
    this._recent('init', {
      lang: bucket(meta.lang || '(english)'),
      provider: bucket(meta.provider || 'groq'),
      mode: meta.practiceMode ? 'practice' : 'taraweeh',
      pipeline: bucket(meta.pipeline || 'v4'),
      appVersion: bucket(meta.appVersion || '(unknown)'),
    });
  }

  start() {
    this.starts += 1;
    this._recent('start', {});
  }

  stop() {
    this.stops += 1;
    this._recent('stop', {});
  }

  error(message, kind = 'error') {
    this.errors += 1;
    inc(this.byError, `${kind}:${scrub(message) || 'unknown'}`);
    this._recent('error', { kind: bucket(kind), message: scrub(message) });
  }

  langPack({ lang = '', ok = true } = {}) {
    this.langPacks += 1;
    this._recent('lang_pack', { lang: bucket(lang), ok: !!ok });
    if (!ok) this.error(`pack ${bucket(lang)} failed`, 'lang_pack');
  }

  event(msg = {}) {
    const type = String(msg.event || '').slice(0, 40);
    if (!ALLOWED_EVENTS.has(type)) return false;
    if (type === 'lang_pack') this.langPack({ lang: msg.lang, ok: msg.ok !== false });
    else if (type === 'error') this.error(msg.message, msg.kind || 'client');
    else if (type === 'key_missing') this.error(msg.message || 'API key required', 'key_missing');
    else if (type === 'key_ok') this._recent('key_ok', { provider: bucket(msg.provider) });
    return true;
  }

  snapshot({ concurrent = 0 } = {}) {
    return {
      startedAt: this.startedAt,
      uptimeSec: Math.round((this._now() - this.startedAt) / 1000),
      live: {
        connections: concurrent,
        peakConnections: this.peakConcurrent,
        uniqueInstalls: this.uniques.size,
      },
      totals: {
        connectionsOpened: this.connectionsOpened,
        connectionsClosed: this.connectionsClosed,
        inits: this.inits,
        listenStarts: this.starts,
        listenStops: this.stops,
        errors: this.errors,
        languagePacks: this.langPacks,
      },
      using: {
        translation: sorted(this.byLang),
        engine: sorted(this.byProvider),
        microphone: sorted(this.byAudio),
        mode: sorted(this.byMode),
        pipeline: sorted(this.byPipeline),
        appVersion: sorted(this.byAppVersion),
      },
      errors: sorted(this.byError),
      recent: this.recent.slice().reverse(),
    };
  }
}

export function renderAnalyticsHtml(snap) {
  const row = (items) => items.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.count}</td></tr>`).join('');
  const live = snap.live || {};
  const totals = snap.totals || {};
  return `<!doctype html><meta charset="utf-8"><title>Quran Companion usage</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;max-width:880px;margin:24px auto;padding:0 16px;color:#111}
h1{font-size:20px}h2{font-size:15px;margin-top:28px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}
.k{display:inline-block;margin:0 16px 8px 0}b{font-variant-numeric:tabular-nums}
.muted{color:#666;font-size:12px}
</style>
<h1>Usage</h1>
<p class="muted">Since process start ${new Date(snap.startedAt).toISOString()} · ${snap.uptimeSec}s uptime. No recitation text or API keys.</p>
<p>
<span class="k">Live <b>${live.connections || 0}</b></span>
<span class="k">Peak <b>${live.peakConnections || 0}</b></span>
<span class="k">Installs seen <b>${live.uniqueInstalls || 0}</b></span>
<span class="k">Inits <b>${totals.inits || 0}</b></span>
<span class="k">Listen starts <b>${totals.listenStarts || 0}</b></span>
<span class="k">Errors <b>${totals.errors || 0}</b></span>
</p>
<h2>What people use</h2>
<table><thead><tr><th>Translation</th><th>n</th></tr></thead><tbody>${row((snap.using && snap.using.translation) || [])}</tbody></table>
<table><thead><tr><th>Engine</th><th>n</th></tr></thead><tbody>${row((snap.using && snap.using.engine) || [])}</tbody></table>
<table><thead><tr><th>Mic</th><th>n</th></tr></thead><tbody>${row((snap.using && snap.using.microphone) || [])}</tbody></table>
<table><thead><tr><th>Mode</th><th>n</th></tr></thead><tbody>${row((snap.using && snap.using.mode) || [])}</tbody></table>
<table><thead><tr><th>Pipeline</th><th>n</th></tr></thead><tbody>${row((snap.using && snap.using.pipeline) || [])}</tbody></table>
<table><thead><tr><th>App version</th><th>n</th></tr></thead><tbody>${row((snap.using && snap.using.appVersion) || [])}</tbody></table>
<h2>Errors</h2>
<table><thead><tr><th>Kind</th><th>n</th></tr></thead><tbody>${row(snap.errors || [])}</tbody></table>
<h2>Recent</h2>
<table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody>${(snap.recent || []).slice(0, 20).map((e) => {
    const d = Object.keys(e).filter((k) => k !== 'ts' && k !== 'event').map((k) => `${k}=${e[k]}`).join(' ');
    const t = Number.isFinite(e.ts) ? new Date(e.ts).toISOString().slice(11, 19) : '';
    return `<tr><td>${esc(t)}</td><td>${esc(e.event)}</td><td>${esc(d)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export default UsageStats;

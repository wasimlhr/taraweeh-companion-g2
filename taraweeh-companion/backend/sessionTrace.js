/**
 * Per-session decision trace.
 *
 * Console logs are the wrong tool for field bugs: they interleave every
 * connected user on a shared host, they are unstructured, and by the time
 * someone says "it counted nine rak'ah instead of eight" they are long gone.
 *
 * This records what the pipeline heard and what it decided, as structured
 * events on a bounded ring buffer scoped to one WebSocket connection. The
 * question a field report has to answer is almost always "why did it not act
 * on that takbeer", so rejections are recorded as deliberately as acceptances,
 * each with the score breakdown that produced it.
 *
 * Nothing here leaves the connection unless the client asks for it. Audio is
 * never recorded — only transcripts, and only the first 200 characters.
 */

/** Ring buffer size. ~600 events is roughly twenty minutes of a live prayer. */
const DEFAULT_MAX_EVENTS = 600;

/** Transcripts are the only free text recorded; keep them short. */
const MAX_TEXT = 200;

const SECRET_KEY_RE = /(apikey|api_key|token|secret|password|authorization)/i;

/**
 * Deep copy with anything that looks like a credential replaced. Reports carry
 * the client's settings so the reader can see which provider and model were in
 * play, and those settings hold the user's own API keys.
 */
export function redactSecrets(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      const s = typeof v === 'string' ? v : '';
      // Keep enough to tell "no key" from "wrong key" apart without carrying one.
      out[k] = s ? `[redacted ${s.length} chars, ends …${s.slice(-4)}]` : '[empty]';
    } else {
      out[k] = redactSecrets(v, depth + 1);
    }
  }
  return out;
}

function clip(s, n = MAX_TEXT) {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n - 1)}\u2026` : str;
}

export class SessionTrace {
  /**
   * @param {object}   [opts]
   * @param {number}   [opts.maxEvents]
   * @param {Function} [opts.onEvent]  called per event while streaming is on
   * @param {string}   [opts.sessionId]
   * @param {Function} [opts.now]      injectable clock for tests
   */
  constructor({ maxEvents = DEFAULT_MAX_EVENTS, onEvent = null, sessionId = '', now = Date.now } = {}) {
    this.maxEvents = Math.max(10, maxEvents);
    this.onEvent = onEvent;
    this.sessionId = sessionId;
    this._now = now;
    this.startedAt = this._now();
    this.streaming = false;
    this.events = [];
    this.seq = 0;
    /** Events dropped off the front of the ring, so a report says so. */
    this.dropped = 0;
    this.counts = {};
    this.meta = {};
  }

  setMeta(meta) { this.meta = { ...this.meta, ...redactSecrets(meta || {}) }; }

  /** Turn streaming to the client on or off. Recording happens either way. */
  setStreaming(on) { this.streaming = !!on; return this.streaming; }

  /**
   * @param {string} type  'asr' | 'cue' | 'prayer' | 'lock' | 'audio' | 'note' | 'error'
   * @param {object} [data]
   */
  record(type, data = {}) {
    const now = this._now();
    const event = { seq: ++this.seq, t: now - this.startedAt, type, ...data };
    if (typeof event.text === 'string') event.text = clip(event.text);
    this.events.push(event);
    while (this.events.length > this.maxEvents) { this.events.shift(); this.dropped++; }
    this.counts[type] = (this.counts[type] || 0) + 1;
    if (this.streaming && this.onEvent) {
      try { this.onEvent(event); } catch (_) {}
    }
    return event;
  }

  /**
   * Roll the trace up into the few numbers that usually identify the fault on
   * their own: how much audio was transcribed, how many cues were heard, and —
   * the one that matters — why the rejected ones were rejected.
   */
  summary() {
    const cues = this.events.filter((e) => e.type === 'cue');
    const byReason = {};
    const byKind = {};
    for (const c of cues) {
      byKind[c.kind] = (byKind[c.kind] || 0) + 1;
      if (!c.accepted) byReason[c.reason || 'unknown'] = (byReason[c.reason || 'unknown'] || 0) + 1;
    }
    const transitions = this.events.filter((e) => e.type === 'prayer');
    const asr = this.events.filter((e) => e.type === 'asr');
    const emptyAsr = asr.filter((e) => !e.text).length;
    return {
      durationMs: this._now() - this.startedAt,
      events: this.events.length,
      dropped: this.dropped,
      counts: { ...this.counts },
      transcripts: { total: asr.length, empty: emptyAsr },
      cues: { total: cues.length, accepted: cues.filter((c) => c.accepted).length, byKind, rejectedBecause: byReason },
      prayer: {
        transitions: transitions.length,
        rakatReached: transitions.length ? transitions[transitions.length - 1].rakat : null,
        byReason: transitions.reduce((a, t) => { a[t.reason] = (a[t.reason] || 0) + 1; return a; }, {}),
      },
      errors: this.events.filter((e) => e.type === 'error').length,
    };
  }

  /** The whole thing, ready to be written to a file or posted to the backend. */
  report(extra = {}) {
    return {
      v: 1,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      generatedAt: this._now(),
      meta: this.meta,
      summary: this.summary(),
      events: this.events,
      ...redactSecrets(extra),
    };
  }

  clear() {
    this.events = [];
    this.dropped = 0;
    this.counts = {};
    this.startedAt = this._now();
    this.seq = 0;
  }
}

export default SessionTrace;

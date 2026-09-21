/**
 * Field reports, kept in memory on the backend.
 *
 * A user who hits a bug during taraweeh is not going to open a terminal. The
 * app lets them send the session trace with one tap, and this is where it
 * lands so it can be read later.
 *
 * Deliberately in memory and deliberately small. These reports carry what
 * somebody recited in a mosque, so they should not outlive the process or
 * accumulate: a redeploy drops them, and the oldest fall off after
 * MAX_REPORTS. Reading them requires DIAG_TOKEN; without that variable set,
 * the read route is not mounted at all.
 */

const MAX_REPORTS = 40;
const MAX_BYTES = 512 * 1024;

export class TraceStore {
  constructor({ maxReports = MAX_REPORTS, now = Date.now } = {}) {
    this.maxReports = maxReports;
    this._now = now;
    this.reports = [];
    this.nextId = 1;
  }

  /**
   * @returns {{ok: true, id: string}|{ok: false, error: string}}
   */
  add(report, meta = {}) {
    if (!report || typeof report !== 'object') return { ok: false, error: 'report must be an object' };
    if (report.v !== 1) return { ok: false, error: 'unsupported report version' };
    let size;
    try { size = Buffer.byteLength(JSON.stringify(report)); }
    catch { return { ok: false, error: 'report is not serialisable' }; }
    if (size > MAX_BYTES) return { ok: false, error: `report too large (${size} bytes, max ${MAX_BYTES})` };

    const id = `r${this.nextId++}`;
    this.reports.push({
      id,
      receivedAt: this._now(),
      size,
      note: typeof meta.note === 'string' ? meta.note.slice(0, 500) : '',
      report,
    });
    while (this.reports.length > this.maxReports) this.reports.shift();
    return { ok: true, id };
  }

  /** Index view: enough to pick which report to open, without the events. */
  list() {
    return this.reports.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt,
      size: r.size,
      note: r.note,
      sessionId: r.report.sessionId || '',
      appVersion: r.report.meta?.appVersion || '',
      summary: r.report.summary || null,
    })).reverse();
  }

  get(id) {
    return this.reports.find((r) => r.id === id) || null;
  }

  clear() { this.reports = []; }
}

export default TraceStore;

// ScouterKit protocol 5 client for Even G1 arms running g1v0 (Web Bluetooth).
// Spec: scouter_kit g1_firmware/docs/VM.md §2-3 (instructions, drawing) and §6 (link).
// Draws whole-panel 1-bpp images: PackBits upload of the changed rows, BLIT into a 4-bpp frame, DRAW.

export const G1V0_SERVICE = 'f3da4d59-277a-4fc9-a1ed-41c9c22d4400';
const CMD_UUID = 'f3da4d59-277a-4fc9-a1ed-41c9c22d4401';
const CTRL_UUID = 'f3da4d59-277a-4fc9-a1ed-41c9c22d4402';
const EVT_UUID = 'f3da4d59-277a-4fc9-a1ed-41c9c22d4403';

export const PANEL_W = 640;
export const PANEL_H = 480;
const Q = 32;                         // receive window (HELLO says so; fixed in protocol 5)
const OP_SCRATCH = 0x100;             // operand words written in front of each instruction
const IMG = 0x1000;                   // 1-bpp image, 80 bytes per row, 38 400 bytes
const IMG_STRIDE = PANEL_W / 8;
const FRAME = 0x10000;                // 4-bpp frame, 320 bytes per row, 153 600 bytes
const FRAME_STRIDE = PANEL_W / 2;
const CTRL_OP = { HELLO: 1, PING: 2, STATUS: 3, RESET_SESSION: 4, LINK: 5, PROPS: 0x0a, VM_STOP: 0x11 };
const ONE_BPP = 4, COPY = 0;

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const seqLt = (a, b) => ((a - b) & 0xffff) >= 0x8000;   // a before b in 16-bit sequence space
const sleep = ms => new Promise(r => setTimeout(r, ms));

// PackBits as tokens: { raw: bytes consumed, out: encoded bytes }.
function packbitsTokens(data, start, end) {
  const tokens = [];
  let i = start;
  while (i < end) {
    let run = 1;
    while (i + run < end && run < 128 && data[i + run] === data[i]) run++;
    if (run >= 2) {
      tokens.push({ raw: run, out: Uint8Array.of(257 - run, data[i]) });
      i += run;
      continue;
    }
    let j = i;
    while (j < end && j - i < 128) {
      let r = 1;
      while (j + r < end && r < 3 && data[j + r] === data[j]) r++;
      if (r >= 2) break;
      j++;
    }
    const out = new Uint8Array(j - i + 1);
    out[0] = j - i - 1;
    out.set(data.subarray(i, j), 1);
    tokens.push({ raw: j - i, out });
    i = j;
  }
  return tokens;
}

class Code {
  constructor() { this.parts = []; this.length = 0; this.scratch = 0; }
  push(bytes) { this.parts.push(bytes); this.length += bytes.length; return this; }
  bytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
  static write(addr, data) {
    const b = new Uint8Array(5 + data.length);
    b[0] = 0x01; b[1] = addr & 0xff; b[2] = (addr >> 8) & 0xff; b[3] = (addr >> 16) & 0xff; b[4] = data.length;
    b.set(data, 5);
    return b;
  }
  static writeRle(addr, len, packed) {
    const b = new Uint8Array(7 + packed.length);
    b[0] = 0x02; b[1] = addr & 0xff; b[2] = (addr >> 8) & 0xff; b[3] = (addr >> 16) & 0xff;
    b[4] = len & 0xff; b[5] = len >> 8; b[6] = packed.length;
    b.set(packed, 7);
    return b;
  }
  // An instruction whose operands are the given values: the values go to scratch words first (one WRITE),
  // then every operand is an escape to its word. Size: 5 + 4k + 1 + ceil(k/2) + 2k.
  ins(op, values) {
    const k = values.length;
    const base = OP_SCRATCH / 4 + this.scratch;
    this.scratch += k;
    if (this.scratch > 48) throw new Error('operand scratch full: split the packet');
    const vals = new Uint8Array(4 * k);
    const dv = new DataView(vals.buffer);
    values.forEach((v, i) => dv.setUint32(4 * i, v >>> 0, true));
    this.push(Code.write(4 * base, vals));
    const b = new Uint8Array(1 + Math.ceil(k / 2) + 2 * k);
    b[0] = op;
    for (let i = 0; i < k; i += 2) b[1 + i / 2] = 0xf0 | (i + 1 < k ? 0x0f : 0);
    const e = 1 + Math.ceil(k / 2);
    for (let i = 0; i < k; i++) { b[e + 2 * i] = (base + i) & 0xff; b[e + 2 * i + 1] = (base + i) >> 8; }
    return this.push(b);
  }
}

export class G1Arm {
  constructor(device, { log = () => {}, name } = {}) {
    this.device = device;
    this.name = name || device.name || 'arm';
    this.log = log;
    this.tag = 0;
    this.replies = new Map();
    this.writeChain = Promise.resolve();
    this.unacked = new Map();     // seq -> { bytes, sent, resent }
    this.pending = [];            // packets not yet sent (window full)
    this.waiters = [];            // { seq, resolve, reject }
    this.errors = [];
    this.prevImage = null;
    this.srtt = 0; this.rttvar = 0; this.rto = 1000;
    this.connected = false;
    this.onEvent = null;
  }

  async connect() {
    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(G1V0_SERVICE);
    this.cmd = await svc.getCharacteristic(CMD_UUID);
    this.ctrlChar = await svc.getCharacteristic(CTRL_UUID);
    this.evt = await svc.getCharacteristic(EVT_UUID);
    this.evt.addEventListener('characteristicvaluechanged', e => this.onEvt(e.target.value));
    await this.evt.startNotifications();
    this.connected = true;
    this.device.addEventListener('gattserverdisconnected', () => { this.connected = false; this.log(`${this.name}: disconnected`); });
    // The arm asks for encryption at connect (L2); on a bonded host the first HELLO may race it: retry.
    let hello;
    for (let i = 0; i < 5; i++) {
      try { hello = await this.hello(); break; } catch (e) { if (i === 4) throw e; await sleep(600); }
    }
    if (hello.protocol !== 5) throw new Error(`${this.name}: protocol ${hello.protocol}, need 5`);
    if (!hello.encrypted && !hello.inCase) this.log(`${this.name}: link not encrypted out of the case: pair the phone with the arm in the case`);
    await this.resetSession(true);
    try { await this.ctrl(CTRL_OP.LINK, new Uint8Array([6, 0, 12, 0, 0, 0, 0x90, 1, 2])); } catch (_) {}
    this.timer = setInterval(() => this.tick(), 50);
    return hello;
  }

  disconnect() {
    clearInterval(this.timer);
    try { this.server && this.server.disconnect(); } catch (_) {}
  }

  gattWrite(ch, bytes, withResponse = false) {
    const p = this.writeChain.then(() => withResponse || !ch.writeValueWithoutResponse
      ? ch.writeValueWithResponse ? ch.writeValueWithResponse(bytes) : ch.writeValue(bytes)
      : ch.writeValueWithoutResponse(bytes));
    this.writeChain = p.catch(() => {});
    return p;
  }

  onEvt(dv) {
    const type = dv.getUint8(0);
    this.epoch = u32(dv, 1);
    if (type === 0x01) this.onAck(u16(dv, 9), u16(dv, 11), dv.getUint8(13), u32(dv, 14));
    else if (type === 0x02) {
      const err = { seq: u16(dv, 9), offset: dv.getUint8(11), op: dv.getUint8(12), code: dv.getUint8(13), detail: u32(dv, 14) };
      this.errors.push(err);
      this.log(`${this.name}: ERROR seq ${err.seq} op 0x${err.op.toString(16)} code ${err.code} detail ${err.detail}`);
    } else if (type >= 0x80) {
      const tag = dv.getUint8(9);
      this.replies.set(tag, { op: type - 0x80, status: dv.getUint8(10), body: new DataView(dv.buffer, dv.byteOffset + 11, dv.byteLength - 11) });
    }
    if (this.onEvent) this.onEvent(type, dv);
  }

  async ctrl(op, body = new Uint8Array(0), timeout = 3000, tries = 3) {
    for (let attempt = 0; attempt < tries; attempt++) {
      const tag = this.tag = (this.tag + 1) & 0xff;
      const req = new Uint8Array(2 + body.length);
      req[0] = op; req[1] = tag; req.set(body, 2);
      await this.gattWrite(this.ctrlChar, req, true);
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (this.replies.has(tag)) {
          const r = this.replies.get(tag);
          this.replies.delete(tag);
          if (r.status) throw new Error(`${this.name}: control 0x${op.toString(16)} status ${r.status}`);
          return r.body;
        }
        await sleep(10);
      }
    }
    throw new Error(`${this.name}: no reply to control 0x${op.toString(16)}`);
  }

  parseHello(b) {
    const flags = b.getUint8(5);
    const h = {
      protocol: b.getUint8(0),
      version: `${b.getUint8(1)}.${b.getUint8(2)}.${b.getUint8(3)}`,
      role: b.getUint8(4) ? 'L' : 'R',
      safeMode: !!(flags & 1), panelOk: !!(flags & 2), panelOn: !!(flags & 8),
      encrypted: !!(flags & 64), inCase: !!(flags & 128),
      maxPacket: u16(b, 18), rxNext: u16(b, 20), execNext: u16(b, 22), credits: b.getUint8(24),
    };
    this.maxPacket = h.maxPacket;
    this.rxNext = h.rxNext;
    this.execNext = h.execNext;
    if (this.nextSeq === undefined || this.unacked.size === 0) this.nextSeq = h.rxNext;
    this.info = h;
    return h;
  }

  async hello() { return this.parseHello(await this.ctrl(CTRL_OP.HELLO)); }

  async resetSession(clearArena = false) {
    const b = await this.ctrl(CTRL_OP.RESET_SESSION, Uint8Array.of(clearArena ? 1 : 0), 8000);
    this.unacked.clear(); this.pending = []; this.nextSeq = undefined;
    this.prevImage = null;
    return this.parseHello(new DataView(b.buffer, b.byteOffset + 2, b.byteLength - 2));
  }

  async props(ids) {
    const b = await this.ctrl(CTRL_OP.PROPS, Uint8Array.from(ids));
    return ids.map((_, i) => u32(b, 4 * i));
  }

  // ---- packets (VM.md §6.2)
  room() { return this.maxPacket - 2; }

  send(codeBytes) {
    if (codeBytes.length > this.room()) throw new Error(`packet of ${codeBytes.length} bytes > ${this.room()}`);
    const seq = this.nextSeq;
    this.nextSeq = (seq + 1) & 0xffff;
    const bytes = new Uint8Array(2 + codeBytes.length);
    bytes[0] = seq & 0xff; bytes[1] = seq >> 8;
    bytes.set(codeBytes, 2);
    this.pending.push({ seq, bytes });
    this.pump();
    return seq;
  }

  pump() {
    while (this.pending.length && seqLt(this.pending[0].seq, (this.execNext + Q) & 0xffff)) {
      const p = this.pending.shift();
      p.sent = performance.now(); p.resent = false;
      this.unacked.set(p.seq, p);
      this.gattWrite(this.cmd, p.bytes).catch(e => this.log(`${this.name}: write failed ${e.message}`));
    }
  }

  onAck(rxNext, execNext, credits, sack) {
    const now = performance.now();
    if (rxNext !== this.rxNext) this.lastProgress = now;
    for (const [seq, p] of this.unacked) {
      if (seqLt(seq, rxNext)) {
        if (!p.resent) this.rttSample(now - p.sent);
        this.unacked.delete(seq);
      }
    }
    this.rxNext = rxNext;
    this.execNext = execNext;
    if (sack) {                       // a hole at rxNext: resend it once per round trip
      const p = this.unacked.get(rxNext);
      if (p && now - p.sent > Math.max(this.srtt, 30)) this.resend(p, now);
    }
    this.waiters = this.waiters.filter(w => {
      if (seqLt(w.seq, execNext)) { w.resolve(); return false; }
      return true;
    });
    this.pump();
  }

  rttSample(r) {
    if (!this.srtt) { this.srtt = r; this.rttvar = r / 2; }
    else { this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r); this.srtt = 0.875 * this.srtt + 0.125 * r; }
    this.rto = Math.min(3000, Math.max(this.srtt + 4 * this.rttvar, 100));
  }

  resend(p, now) {
    p.sent = now; p.resent = true;
    this.gattWrite(this.cmd, p.bytes).catch(() => {});
  }

  tick() {
    if (!this.unacked.size) return;
    const now = performance.now();
    let oldest = null;
    for (const p of this.unacked.values()) if (!oldest || seqLt(p.seq, oldest.seq)) oldest = p;
    const backoff = oldest.resent ? 2 : 1;
    if (now - oldest.sent > this.rto * backoff) { this.rto = Math.min(this.rto * 2, 3000); this.resend(oldest, now); }
  }

  waitExec(seq, timeout = 15000) {
    if (seqLt(seq, this.execNext)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w = { seq, resolve, reject };
      this.waiters.push(w);
      setTimeout(() => { if (this.waiters.includes(w)) { this.waiters = this.waiters.filter(x => x !== w); reject(new Error(`${this.name}: packet ${seq} not executed in ${timeout} ms`)); } }, timeout);
    });
  }

  // ---- drawing
  // bits: 1-bpp 640 x 480 image, 80 bytes per row, bit 7 = left pixel, 1 = ink. Only rows that changed since
  // the last call are uploaded and drawn. level: ink brightness 1..15. Resolves when the arm has drawn it.
  async drawImage(bits, level = 15) {
    if (bits.length !== IMG_STRIDE * PANEL_H) throw new Error('need a 640 x 480 1-bpp image');
    let y0 = 0, y1 = PANEL_H;
    if (this.prevImage) {
      const rowSame = y => { for (let i = y * IMG_STRIDE, e = i + IMG_STRIDE; i < e; i++) if (bits[i] !== this.prevImage[i]) return false; return true; };
      while (y0 < PANEL_H && rowSame(y0)) y0++;
      if (y0 === PANEL_H) return { rows: 0, bytes: 0 };
      while (y1 > y0 && rowSame(y1 - 1)) y1--;
    }
    const start = y0 * IMG_STRIDE, end = y1 * IMG_STRIDE;
    const room = Math.min(255, this.room() - 7);
    const tokens = packbitsTokens(bits, start, end);
    let addr = IMG + start, sent = 0, last;
    for (let i = 0; i < tokens.length;) {
      let raw = 0, n = 0;
      const chunk = [];
      while (i < tokens.length && n + tokens[i].out.length <= room && raw + tokens[i].raw <= 0xffff) {
        chunk.push(tokens[i].out); n += tokens[i].out.length; raw += tokens[i].raw; i++;
      }
      const packed = new Uint8Array(n);
      let o = 0;
      for (const c of chunk) { packed.set(c, o); o += c.length; }
      last = this.send(Code.writeRle(addr, raw, packed));
      addr += raw; sent += n;
    }
    const h = y1 - y0;
    const c = new Code()
      .ins(0x51, [IMG, IMG_STRIDE, 0, y0, FRAME, FRAME_STRIDE, 0, y0, PANEL_W, h, COPY | ONE_BPP, level])
      .ins(0x53, [FRAME, FRAME_STRIDE, 0, y0, 0, y0, PANEL_W, h]);
    last = this.send(c.bytes());
    this.prevImage = bits.slice();
    const nErr = this.errors.length;
    await this.waitExec(last);
    if (this.errors.length > nErr) throw new Error(`${this.name}: arm reported error ${this.errors[nErr].code}`);
    return { rows: h, bytes: sent };
  }

  async panel(on) {             // PANEL property via SYS_WRITE: 0 off, 1 on, 2 standby
    await this.waitExec(this.send(new Code().ins(0x45, [PROP_PANEL, on]).bytes()));
  }
}

const PROP_PANEL = 0x21;    // VM.md §2.5

// Canvas helpers. Light pixels are ink (the G2 renderers draw white on black).
export function canvasToBits(canvas, { threshold = 110, x = 0, y = 0 } = {}) {
  const w = Math.min(canvas.width, PANEL_W - x), h = Math.min(canvas.height, PANEL_H - y);
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const bits = new Uint8Array(IMG_STRIDE * PANEL_H);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = 4 * (r * w + c);
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum > threshold) { const px = x + c, py = y + r; bits[py * IMG_STRIDE + (px >> 3)] |= 0x80 >> (px & 7); }
    }
  }
  return bits;
}

// Both arms. Each arm draws the same image (left eye, right eye).
export class G1Glasses {
  constructor({ log = () => {} } = {}) { this.log = log; this.arms = []; }

  static async requestArm(bluetooth = navigator.bluetooth) {
    return bluetooth.requestDevice({ filters: [{ namePrefix: 'G1v0_' }], optionalServices: [G1V0_SERVICE] });
  }

  async add(device) {
    const arm = new G1Arm(device, { log: this.log });
    const h = await arm.connect();
    this.arms = this.arms.filter(a => a.info.role !== h.role).concat(arm);
    this.log(`${arm.name}: g1v0 ${h.version} (${h.role}), encrypted ${h.encrypted}, in case ${h.inCase}, max packet ${h.maxPacket}`);
    return arm;
  }

  async drawImage(bits, level) {
    return Promise.all(this.arms.filter(a => a.connected).map(a => a.drawImage(bits, level)));
  }

  async drawCanvas(canvas, opts = {}) { return this.drawImage(canvasToBits(canvas, opts), opts.level); }

  disconnect() { this.arms.forEach(a => a.disconnect()); this.arms = []; }
}

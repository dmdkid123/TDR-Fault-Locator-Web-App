/* device.js - getting captures into the app: CSV text, USB serial (Web Serial), and a virtual device.
 * Every source ends in parseCapture(text), so all three paths share one parser. Exposes window.TDRDevice. */
(function (root) {
  'use strict';
  const T = root.TDR;
  const UNIT_S = { s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9 };
  const UNIT_V = { v: 1, mv: 1e-3, uv: 1e-6 };

  function unitIn(text, table) {
    const m = /[\(\[]\s*([a-zµ]+)\s*[\)\]]/i.exec(text) || /,\s*([a-zµ]+)\s*$/i.exec(text) || /\b(ms|us|µs|ns)\b/i.exec(text);
    if (!m) return null; const k = m[1].toLowerCase(); return table[k] != null ? k : null;
  }
  const isNum = (s) => s !== '' && isFinite(Number(s.replace(',', '.')));

  /** text -> {t (s, as in the file), v (V), n, skipped, timeUnit}. Throws Error with a readable message. */
  function parseCapture(text, o) {
    o = Object.assign({ timeUnit: 'auto', valueMode: 'volts', bits: 12, vref: 3.3, sampleInterval: 1e-6, valueCol: 1 }, o || {});
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    let delim = null, header = null, units = null, tCol = 0, vCol = o.valueCol;
    const t = [], v = []; let skipped = 0, oneCol = false;
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      if (/^(start|begin|end|done|ok|ready)\b/i.test(line)) continue;
      if (!delim) delim = line.includes('\t') ? '\t' : line.includes(';') ? ';' : line.includes(',') ? ',' : /\s/.test(line) ? /\s+/ : null;
      const tok = delim ? line.split(delim).map((s) => s.trim()) : [line];
      if (!tok.some(isNum) || tok.some((s) => s !== '' && !isNum(s))) {
        // not purely numeric: a header (first one), or a unit row right after it, otherwise skip
        if (!t.length && !header) { header = line; continue; }
        if (!t.length && header && !units) { units = line; continue; }
        skipped++; continue;
      }
      const nums = tok.map((s) => Number(s.replace(',', '.')));
      if (nums.length === 1) { oneCol = true; v.push(nums[0]); }
      else { if (vCol >= nums.length) vCol = nums.length - 1; t.push(nums[tCol]); v.push(nums[vCol]); }
    }
    if (v.length < 50) throw new Error((v.length ? 'Found only ' + v.length + ' numeric samples.' : 'No numeric samples found.') + ' The file needs at least 50 lines of "time,value" or a single value per line.');
    // units
    let tu = o.timeUnit;
    if (tu === 'auto') tu = (header && unitIn(header.split(delim || ',')[tCol] || header, UNIT_S)) || (units && unitIn(units.split(delim || ',')[tCol] || units, UNIT_S)) || 's';
    let vu = (header && unitIn(header.split(delim || ',')[vCol] || '', UNIT_V)) || (units && unitIn(units.split(delim || ',')[vCol] || '', UNIT_V)) || 'v';
    const tf = UNIT_S[tu] || 1, vf = UNIT_V[vu] || 1;
    const n = v.length, T_ = new Float64Array(n), V_ = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      T_[i] = oneCol ? i * o.sampleInterval : t[i] * tf;
      V_[i] = o.valueMode === 'counts' ? v[i] / (Math.pow(2, o.bits) - 1) * o.vref : v[i] * vf;
    }
    for (let i = 1; i < n; i++) if (!(T_[i] > T_[i - 1])) throw new Error('The time column must increase on every line (problem near line ' + (i + 1) + ' of the data). Check that the right column is the time.');
    return { t: T_, v: V_, n, skipped, timeUnit: oneCol ? 'interval' : tu, oneColumn: oneCol };
  }

  /** Collects streamed lines into one capture. START/END lines are optional; an idle gap also ends a capture. */
  class LineAssembler {
    constructor(cb, o) { this.cb = cb; this.o = Object.assign({ idleMs: 700, minLines: 100 }, o || {}); this.buf = []; this.timer = 0; this.active = false; }
    reset() { this.buf = []; clearTimeout(this.timer); }
    push(line) {
      line = line.trim(); if (!line) return;
      if (/^(start|begin)\b/i.test(line)) { this.reset(); this.active = true; return; }
      if (/^(end|done)\b/i.test(line)) { this._finish(); return; }
      if (!/^[-+.\d]/.test(line)) return;                      // log chatter from the board is ignored
      this.buf.push(line); if (this.cb.onProgress) this.cb.onProgress(this.buf.length);
      clearTimeout(this.timer); this.timer = setTimeout(() => this._finish(), this.o.idleMs);
    }
    _finish() {
      clearTimeout(this.timer); const lines = this.buf; this.buf = []; this.active = false;
      if (lines.length >= this.o.minLines) this.cb.onCapture(lines.join('\n'));
    }
  }

  const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

  /** CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF), same as serial_protocol.h on the board. */
  function crc16(bytes, start, len) {
    let crc = 0xFFFF;
    for (let i = start; i < start + len; i++) { crc ^= bytes[i]; for (let j = 0; j < 8; j++) crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1); }
    return crc & 0xFFFF;
  }

  /** Splits the board's byte stream into binary sweep packets and text status lines.
   *  Packet: 55 AA | count u16 | sweepID u32 | count x u16 | CRC16 u16   (all little-endian).
   *  Anything that is not a packet (POST_PASSED, WARN:, ERR: lines) is passed to onText. */
  class SweepParser {
    constructor(cb) { this.cb = cb; this.buf = new Uint8Array(0); this.dec = new TextDecoder(); this.good = 0; this.bad = 0; }
    reset() { this.buf = new Uint8Array(0); }
    _sync(from) { const b = this.buf; for (let i = from; i + 1 < b.length; i++) if (b[i] === 0x55 && b[i + 1] === 0xAA) return i; return -1; }
    _text(a, b) {
      const s = this.dec.decode(this.buf.subarray(a, b));
      s.split(/\r?\n/).forEach((l) => { l = l.trim(); if (l && /^[\x20-\x7e]+$/.test(l) && this.cb.onText) this.cb.onText(l); });
    }
    push(chunk) {
      const nb = new Uint8Array(this.buf.length + chunk.length); nb.set(this.buf); nb.set(chunk, this.buf.length); this.buf = nb;
      let pos = 0;
      for (;;) {
        const s = this._sync(pos);
        if (s < 0) {
          let nl = -1; for (let i = this.buf.length - 1; i >= pos; i--) if (this.buf[i] === 10) { nl = i; break; }
          if (nl >= 0) { this._text(pos, nl + 1); pos = nl + 1; }
          if (this.buf.length - pos > 1024) pos = this.buf.length - 1;       // garbage with no sync: keep only a possible half marker
          break;
        }
        if (s > pos) { this._text(pos, s); pos = s; }
        if (this.buf.length - pos < 8) break;
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + pos);
        const count = dv.getUint16(2, true), id = dv.getUint32(4, true);
        if (count < 1 || count > 4096) { this.bad++; pos += 2; continue; }
        const total = 8 + count * 2 + 2;
        if (this.buf.length - pos < total) break;                              // wait for the rest
        if (crc16(this.buf, pos + 8, count * 2) !== dv.getUint16(8 + count * 2, true)) { this.bad++; pos += 2; continue; }
        const samples = new Uint16Array(count); for (let i = 0; i < count; i++) samples[i] = dv.getUint16(8 + i * 2, true);
        this.good++; pos += total;
        if (this.cb.onSweep) this.cb.onSweep(samples, id);
      }
      this.buf = this.buf.slice(pos);
    }
  }

  /** Launch edge of one sweep (or an averaged one): the rising edge that ends the longest low stretch, found circularly
   *  because the 1 MHz pulse train repeats exactly once per sweep window. The biggest rising edge would be wrong, since
   *  the echo of an open circuit is as big as the launch edge.
   *  The low half of the real board's pulse is not flat: the signal reaching the ADC sags back toward the middle on both
   *  halves (it climbs from about 0% to 18% of the swing before the next launch, measured 19 Nov). Thresholds must stay above
   *  that, but below the launch step when an open circuit right after it doubles the level. So the low stretch is found on a lightly
   *  smoothed copy with hysteresis (in below 25%, out above 33% of the swing), and the result is then snapped to the
   *  steepest rise next to that crossing. -> {idx (first sample after the rise), lo, hi} or null for a flat sweep. */
  function sweepLaunch(v, minSwing) {
    const n = v.length, sm = new Float64Array(n);
    for (let i = 0; i < n; i++) { let t = 0; for (let k = -2; k <= 2; k++) t += v[(i + k + n) % n]; sm[i] = t / 5; }
    const srt = Float64Array.from(sm).sort(), lo = srt[Math.floor(n * 0.02)], hi = srt[Math.floor(n * 0.98)], sw = hi - lo;
    if (!(sw > (minSwing || 0))) return null;
    const enter = lo + 0.25 * sw, leave = lo + 0.33 * sw;
    // The launch is the rising edge that STARTS the longest high stretch. (Build 10 used the edge that ENDS the longest
    // low stretch, but the board puts two short pulses ~15-30 ns before the launch, which split the low stretch, so it
    // locked onto the first pulse and every later edge showed up as a fake short/open. The real pulse is high for ~500
    // samples; those glitches for ~6.)
    let start = 0; while (start < n && sm[start] > enter) start++;          // start the circular scan from a low sample
    if (start >= n) return null;
    let high = false, run = 0, cur = -1, best = 0, bestEnd = -1;
    for (let j = 1; j <= n; j++) {
      const i = (start + j) % n;
      if (!high && sm[i] > leave) { high = true; run = 0; cur = i; }
      if (high) { if (sm[i] < enter) { if (run > best) { best = run; bestEnd = cur; } high = false; } else run++; }
    }
    if (high && run > best) { best = run; bestEnd = cur; }
    if (bestEnd < 0) return null;
    let idx = bestEnd, d = -Infinity;
    for (let j = -8; j <= 3; j++) { const i = (bestEnd + j + n) % n, sl = v[i] - v[(i - 1 + n) % n]; if (sl > d) { d = sl; idx = i; } }
    return { idx, lo, hi };
  }

  /** A1: compare one raw sweep with the reference sweep of this capture and rotate it so its launch edge lands on the
   *  reference's launch index. Rejected when the launch moved more than maxShift samples, or the baseline or step size
   *  jumped by more than tol of the step. -> {ok, sweep, shift, reason, launch} */
  function alignSweep(samples, ref, o) {
    o = Object.assign({ maxShift: 2, tol: 0.15 }, o || {});
    const L = sweepLaunch(samples, 20);                    // 20 counts: ignore a sweep with no pulse in it
    if (!L) return { ok: false, reason: 'no launch edge' };
    const n = samples.length, base = median16(samples, L.idx, -Math.min(200, Math.floor(n / 4)), -10), top = median16(samples, L.idx, 10, Math.min(200, Math.floor(n / 4)));
    const launch = { idx: L.idx, base, step: top - base };
    if (!ref) return { ok: true, sweep: samples, shift: 0, launch };
    let shift = L.idx - ref.idx; if (shift > n / 2) shift -= n; if (shift < -n / 2) shift += n;
    if (Math.abs(shift) > o.maxShift) return { ok: false, shift, reason: 'launch moved ' + shift + ' samples', launch };
    const step = Math.abs(ref.step) || 1;
    if (Math.abs(base - ref.base) > o.tol * step) return { ok: false, shift, reason: 'baseline jumped ' + Math.round(base - ref.base) + ' counts', launch };
    if (Math.abs(launch.step - ref.step) > o.tol * step) return { ok: false, shift, reason: 'step size changed ' + Math.round(launch.step - ref.step) + ' counts', launch };
    if (shift === 0) return { ok: true, sweep: samples, shift, launch };
    const r = new Uint16Array(n); for (let i = 0; i < n; i++) r[i] = samples[((i + shift) % n + n) % n];
    return { ok: true, sweep: r, shift, launch };
  }
  /** Median of samples[k + a .. k + b) taken circularly. */
  function median16(s, k, a, b) {
    const n = s.length, out = []; for (let i = a; i < b; i++) out.push(s[((k + i) % n + n) % n]);
    out.sort((x, y) => x - y); return out.length ? out[out.length >> 1] : 0;
  }

  /** Averages sweeps and turns ADC counts into the "time,volts" text that parseCapture() reads.
   *  The sweep starts at the 10 Hz beat, which can fall anywhere in the pulse, but the pulse train is periodic
   *  (1 MHz = exactly one sweep window), so the sweep is rotated to put flat baseline before the launch edge.
   *  The launch edge is the rising edge that starts the longest high stretch (see sweepLaunch). (Picking the biggest rising edge is wrong:
   *  the echo of an open circuit is as big as the launch edge itself.) The sweep is then cut just before the pulse's
   *  falling edge, half a period later, because the falling edge and its echoes are not of interest. */
  function sweepsToText(sweeps, o) {
    o = Object.assign({ bits: 12, vref: 3.3, interval: 100e-6, lead: 80, duty: 0.5, tail: 40 }, o || {});   // tail: samples kept clear of the pulse's falling edge (sag moves it earlier)
    const n = sweeps[0].length, full = Math.pow(2, o.bits) - 1;
    let v = new Float64Array(n);
    for (let i = 0; i < n; i++) { let a = 0; for (const s of sweeps) a += s[i]; v[i] = a / sweeps.length / full * o.vref; }
    const L = o.rotate !== false ? sweepLaunch(v, 0.05) : null;
    if (L) {
      const bestEnd = L.idx;
      {
        const shift = ((bestEnd - o.lead) % n + n) % n, r = new Float64Array(n);
        for (let i = 0; i < n; i++) r[i] = v[(i + shift) % n];
        // Nothing physical happens before the launch, but the board puts two short pulses there (~15-30 ns early) and the
        // engine's own launch finder would take the first of them as the launch. Replace the lead-in with the baseline
        // (median of the low half, well away from the launch and those pulses).
        const lowSeg = []; for (let i = 300; i >= 60; i--) lowSeg.push(v[((bestEnd - i) % n + n) % n]);
        lowSeg.sort((a, b) => a - b); const baseV = lowSeg[lowSeg.length >> 1];
        for (let i = 0; i < Math.max(0, o.lead - 2); i++) r[i] = baseV;
        v = r.slice(0, Math.max(100, Math.min(n, o.lead + Math.round(n * o.duty) - o.tail)));
      }
    }
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = (i * o.interval).toExponential(9) + ',' + v[i].toFixed(5);
    return out.join('\n');
  }

  const openDevices = new Set();   // every SerialDevice this page has opened and not yet released

  class SerialDevice {
    constructor(cb) {
      this.cb = cb; this.port = null; this.reader = null; this.name = ''; this._stop = false; this.mode = 'sweep'; this.want = 0; this.sweeps = [];
      this._resetCounts(); this.tot = { recv: 0, used: 0, dropped: 0, overruns: 0, skippedIds: 0 }; this.lastId = null; this.lastIdx = null;
      this.asm = new LineAssembler({ onCapture: (t) => { clearTimeout(this.wait); cb.onCapture(t); }, onProgress: (n) => cb.onProgress && cb.onProgress(n) });
      this.parser = new SweepParser({ onSweep: (s, id) => this._onSweep(s, id), onText: (l) => this._onStatus(l) });
    }
    async connect(baud, mode) {
      if (!serialSupported()) throw new Error('This browser cannot open USB serial ports. Use Chrome or Edge, or open a scope CSV instead.');
      this.mode = mode === 'text' ? 'text' : 'sweep';
      const port = await navigator.serial.requestPort();
      // The browser hands back the same port object if we picked it before. If an earlier attempt in this page is still
      // holding it, release that first so a fresh Connect always starts clean.
      for (const d of Array.from(openDevices)) if (d.port === port) await d.disconnect();
      if (port.readable || port.writable) { try { await port.close(); } catch (e) { /* locked by something we lost track of */ } }
      try { await port.open({ baudRate: baud || 921600, bufferSize: 65536 }); }
      catch (e) {
        if (e && e.name === 'InvalidStateError') throw new Error('This port is still open from an earlier connection. Reload the page (F5) and connect again.');
        if (e && e.name === 'NetworkError') throw new Error('The port could not be opened. Close anything else using it (Arduino serial monitor, PuTTY, another browser tab), unplug and replug the board, then try again.');
        throw e;
      }
      this.port = port; this._stop = false; this.errors = 0; this.want = 0; this.lastId = null; this.parser.reset(); openDevices.add(this);
      const info = port.getInfo ? port.getInfo() : {};
      this.name = info.usbVendorId ? 'USB device ' + info.usbVendorId.toString(16).padStart(4, '0') + ':' + (info.usbProductId || 0).toString(16).padStart(4, '0') : 'Serial device';
      this._loopDone = this._loop();
    }
    /** Read until stopped. Non-fatal errors (framing, parity, overrun: typical of a wrong baud rate) do not end the connection. */
    async _loop() {
      const dec = new TextDecoder(); let tail = '';
      while (!this._stop && this.port && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read(); if (done) break;
            if (this.mode === 'sweep') this.parser.push(value);
            else { tail += dec.decode(value, { stream: true }); const parts = tail.split(/\r?\n/); tail = parts.pop(); parts.forEach((l) => this.asm.push(l)); }
          }
        } catch (e) {
          this.errors++; tail = ''; this.parser.reset();
          if (this.errors === 3 && this.cb.onWarning) this.cb.onWarning('The port is reporting read errors. Check that the baud rate in Setup matches the board (921600 for the current firmware).');
          if (this.errors > 200) break;
          await new Promise((r) => setTimeout(r, 25));
        } finally { try { this.reader.releaseLock(); } catch (e) { /* already released */ } this.reader = null; }
      }
      if (!this._stop) {                                    // ended on its own: unplugged, or the port gave up
        await this._release();
        if (this.cb.onClosed) this.cb.onClosed();
      }
    }
    async _release() {
      const p = this.port; this.port = null; openDevices.delete(this);
      try { if (p) await p.close(); } catch (e) { /* already closed */ }
    }
    async _send(text) {
      if (!this.port || !this.port.writable) throw new Error('The port is not open.');
      const w = this.port.writable.getWriter(); try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
    }
    _onStatus(line) {
      // overrun lines are counted in the per-capture summary (A3); logging each one would bury everything else
      if (this.cb.onLog && !/SAMPLER_OVERRUN/.test(line)) this.cb.onLog(line);
      if (/^ERR/i.test(line)) { this._endCapture(); if (this.cb.onError) this.cb.onError('The board reports: ' + line + (/SI5351/.test(line) ? '. The clock chip is not answering on I2C (SDA GPIO21, SCL GPIO22). Check its wiring and power.' : '')); }
      else if (/NO_SWEEP_SYNC/.test(line) && this.cb.onWarning) this.cb.onWarning('The board sees no sweep sync on GPIO27 (the 10 Hz beat signal). Check the sync wiring from the sampler.');
      else if (/SAMPLER_OVERRUN/.test(line)) {
        // The firmware prints this just before the damaged sweep's packet. New firmware says how many ticks it missed:
        // "WARN: SAMPLER_OVERRUN idx=<n> missed=<k>". Keep the sweep when k <= MAX_MISSED. Old firmware gives no count, so drop.
        const m = /SAMPLER_OVERRUN(?:\s+idx=(-?\d+))?(?:\s+missed=(\d+))?/.exec(line), missed = m && m[2] != null ? +m[2] : null;
        this.cnt.overruns++; this.tot.overruns++; if (m && m[1] != null) this.lastIdx = +m[1];
        if (missed !== null) this.cnt.missed += missed;
        this.skipNext = missed === null || missed > SerialDevice.MAX_MISSED;
      }
    }
    _endCapture(sendIdle) {
      const was = this.want > 0; this.want = 0; this.sweeps = []; this.live = false; clearTimeout(this.wait); clearInterval(this.kick);
      if (sendIdle && was) this._send('I').catch(() => {});
    }
    _resetCounts() { this.cnt = { recv: 0, used: 0, dropOverrun: 0, dropAlign: 0, overruns: 0, missed: 0, skippedIds: 0 }; this.refL = null; this.badRun = 0; this.lastReason = ''; }
    /** A3: one line per capture for the board log. */
    _summary() {
      const c = this.cnt; if (!c || !c.recv) return '';
      return 'Used ' + c.used + ' of ' + c.recv + ' sweeps, ' + c.overruns + ' overrun' + (c.overruns === 1 ? '' : 's') + (this.lastIdx != null ? ' (last idx ' + this.lastIdx + ')' : '') +
        (c.dropOverrun ? ', ' + c.dropOverrun + ' dropped for missed ticks' : '') + (c.dropAlign ? ', ' + c.dropAlign + ' dropped for misalignment' + (this.lastReason ? ' (' + this.lastReason + ')' : '') : '') +
        (c.skippedIds ? ', ' + c.skippedIds + ' sweep IDs never arrived' : '');
    }
    _info(m) { if (m && this.cb.onInfo) this.cb.onInfo(m); }
    _onSweep(samples, id) {
      this.lastSweep = Date.now();
      // sweep IDs count up by one; a gap means sweeps were lost between the board and the app
      if (this.lastId != null && id > this.lastId + 1 && id - this.lastId < 100000) { const k = id - this.lastId - 1; this.tot.skippedIds += k; if (this.want) this.cnt.skippedIds += k; }
      this.lastId = id;
      if (!this.want) { this.skipNext = false; return; }      // not asked for: ignore a leftover sweep
      const c = this.cnt; c.recv++; this.tot.recv++;
      if (this.skipNext) { this.skipNext = false; c.dropOverrun++; this.tot.dropped++; return this._checkGiveUp(); }
      // A1: line the sweep up on the launch edge of the first good sweep of this capture
      const A = alignSweep(samples, this.refL, { maxShift: SerialDevice.MAX_SHIFT });
      if (!A.ok) {
        c.dropAlign++; this.tot.dropped++; this.lastReason = A.reason;
        // several rejects in a row in live view: the circuit itself changed (plugged in, wire moved), so start over from this sweep
        if (this.live && ++this.badRun >= 5 && A.launch) { this.refL = A.launch; this.sweeps = [samples]; this.badRun = 0; this._info('Live view: the trace changed, restarting the average'); }
        return this._checkGiveUp();
      }
      this.badRun = 0; if (!this.refL) this.refL = A.launch;
      c.used++; this.tot.used++;
      if (this.live) {                                      // live view: rolling average of the last `want` sweeps, one result per sweep
        this.sweeps.push(A.sweep); while (this.sweeps.length > this.want) this.sweeps.shift();
        try { this.cb.onCapture(sweepsToText(this.sweeps, this.opt), { live: true }); } catch (e) { /* a bad frame must not stop the stream */ }
        if (c.recv % 100 === 0) this._info(this._summary());
        return;
      }
      this.sweeps.push(A.sweep); if (this.cb.onProgress) this.cb.onProgress(this.sweeps.length * samples.length);
      if (this.sweeps.length < this.want) return;
      this._finish();
    }
    /** Too many sweeps thrown away for one capture: use what there is, or report why. */
    _checkGiveUp() {
      if (this.live) return;
      const c = this.cnt, limit = 3 * this.want + 10;
      if (c.recv - c.used < limit) return;
      if (this.sweeps.length) { if (this.cb.onWarning) this.cb.onWarning('Only ' + this.sweeps.length + ' of ' + this.want + ' sweeps were clean, so this result averages fewer sweeps. See the board log for why.'); this._finish(); }
      else { const msg = 'Every sweep was rejected. ' + this._summary() + '. Check the GPIO27 sync line and the probe connection.'; this._info(this._summary()); this._endCapture(true); if (this.cb.onError) this.cb.onError(msg); }
    }
    _finish() {
      const sweeps = this.sweeps, o = this.opt, sum = this._summary(); this._endCapture(true); this._info(sum);
      try { this.cb.onCapture(sweepsToText(sweeps, o)); } catch (e) { if (this.cb.onError) this.cb.onError(e.message || String(e)); }
    }
    /** text mode: send cmd + newline, collect lines. sweep mode: send 'S' until a packet arrives, average o.avg sweeps, send 'I'. */
    async capture(cmd, timeoutMs, o) {
      if (!this.port || !this.port.writable) throw new Error('The port is not open.');
      const ms = timeoutMs || 15000;
      if (this.mode === 'text') {
        this.asm.reset();
        if (cmd) await this._send(cmd + '\n');
        clearTimeout(this.wait);
        this.wait = setTimeout(() => this.cb.onError && this.cb.onError('No data arrived within ' + Math.round(ms / 1000) + ' s. Check the baud rate in Setup and that the board sends lines like "time,value".'), ms);
        return;
      }
      this.opt = o || {}; this.sweeps = []; this.skipNext = false; this._resetCounts(); this.want = Math.max(1, Math.min(64, Math.round((o && o.avg) || 1)));
      clearTimeout(this.wait); clearInterval(this.kick);
      await this._send('S');
      // Opening the port usually resets an ESP32, and it ignores 'S' until it has finished booting, so keep asking once a second.
      this.kick = setInterval(() => { if (this.want) this._send('S').catch(() => {}); }, 1000);
      this.wait = setTimeout(() => {
        const bad = this.parser.bad, good = this.parser.good; this._endCapture(true);
        if (this.cb.onError) this.cb.onError('No sweep arrived within ' + Math.round(ms / 1000) + ' s.' + (bad && !good ? ' Data is arriving but fails the checksum: check that the baud rate in Setup is 921600.' : ' Check the baud rate (921600) and that the board is running the TDR firmware.'));
      }, ms);
    }
    /** Live view (binary protocol): keep the board sweeping and deliver a rolling average after every sweep. */
    async startLive(o) {
      if (!this.port || !this.port.writable) throw new Error('The port is not open.');
      if (this.mode !== 'sweep') throw new Error('Live view needs the binary sweep protocol.');
      this._endCapture(false);
      this.opt = o || {}; this.sweeps = []; this.skipNext = false; this._resetCounts(); this.want = Math.max(1, Math.min(64, Math.round((o && o.avg) || 1)));
      this.live = true; this.lastSweep = Date.now(); let warned = false;
      await this._send('S');
      this.kick = setInterval(() => {
        if (!this.live) return; const idle = Date.now() - this.lastSweep;
        if (idle > 1500) this._send('S').catch(() => {});                 // board rebooted or missed the command
        if (idle > 5000 && !warned) { warned = true; if (this.cb.onWarning) this.cb.onWarning('No sweeps are arriving. Check the baud rate (921600) and that the board is running the TDR firmware.'); }
        if (idle < 1500) warned = false;
      }, 1000);
    }
    async stopLive() { const was = this.live, sum = this._summary(); this._endCapture(false); if (was) { this._info(sum); await this._send('I').catch(() => {}); } }
    stats() { const t = this.tot; return { good: this.parser.good, bad: this.parser.bad, used: t.used, dropped: t.dropped, overruns: t.overruns, skippedIds: t.skippedIds }; }
    async disconnect() {
      this._endCapture(false); this._stop = true;
      try { if (this.port && this.port.writable) await this._send('I'); } catch (e) { /* port already gone */ }
      try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
      try { if (this._loopDone) await this._loopDone; } catch (e) { /* ignore */ }
      await this._release();
    }
  }
  SerialDevice.MAX_MISSED = 2;   // A2: keep a sweep whose overrun warning says it missed at most this many ticks
  SerialDevice.MAX_SHIFT = 2;    // A1: drop a sweep whose launch edge is more than this many samples from the first one

  /** Streams a synthetic equivalent-time capture through the same line path as real hardware. */
  class VirtualDevice {
    constructor(cb) { this.cb = cb; this.name = 'Virtual device'; this.asm = new LineAssembler({ onCapture: cb.onCapture, onProgress: cb.onProgress }, { idleMs: 400 }); }
    capture(p) {
      const cfg = Object.assign(T.defaultConfig(), { vp: p.vp }), events = [];
      if (p.connDist) events.push({ d: p.connDist, a: 0.10 });
      if (p.events) p.events.forEach((e) => events.push(e));
      else if (p.d != null) events.push({ d: p.d, a: p.a != null ? p.a : T.FAULT_STEPS[p.kind] });
      const dMax = Math.max(0.5, ...events.map((e) => e.d)), span = Math.max(70e-9, T.distanceToTime(dMax, p.vp) + 40e-9);
      const tLaunch = Math.max(8e-9, (p.rise || 1) * 6e-9 + 2e-9);   // enough flat baseline for the edge rise time set in Setup
      const c = T.synthCapture(events, cfg, { span: span + tLaunch, tLaunch, noise: p.noise, seed: (Date.now() & 0xffff) + 1, vpTrue: p.vpTrue });
      const scale = p.scale, out = ['START']; const chunk = 500, total = c.t.length; let i = 0;
      const lines = []; for (let k = 0; k < total; k++) lines.push((c.t[k] * scale).toExponential(9) + ',' + c.v[k].toFixed(5));
      lines.push('END');
      const tick = () => { for (let n = 0; n < chunk && i < lines.length; n++, i++) this.asm.push(lines[i]); if (i < lines.length) this._h = setTimeout(tick, 12); };
      this.asm.reset(); this.asm.push('START'); i = 0; tick();
    }
    stop() { clearTimeout(this._h); this.asm.reset(); }
  }

  root.TDRDevice = { parseCapture, LineAssembler, SerialDevice, SweepParser, sweepsToText, sweepLaunch, alignSweep, crc16, VirtualDevice, serialSupported };
  if (typeof module === 'object' && module.exports) module.exports = root.TDRDevice;
})(typeof window !== 'undefined' ? window : globalThis);

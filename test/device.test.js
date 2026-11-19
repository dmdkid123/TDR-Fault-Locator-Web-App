// Run: node test/device.test.js - checks the CSV / serial line parser on the formats scopes and boards actually produce.
const D = require('../js/device.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('pass', m); };
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const near = (a, b, t) => Math.abs(a - b) <= t;

let p = D.parseCapture('# comment\ntime_s,volts\n' + rows(100, (i) => (i * 1e-6).toExponential(6) + ',' + (i * 0.01).toFixed(3)));
ok(p.n === 100 && near(p.t[99], 99e-6, 1e-12) && near(p.v[99], 0.99, 1e-9), 'plain time_s,volts with comment and header');

p = D.parseCapture('Time (ms),Channel A (mV)\n' + rows(80, (i) => (i * 0.001).toFixed(4) + ',' + (i * 10)));
ok(near(p.t[79], 79e-6, 1e-12) && near(p.v[79], 0.79, 1e-9), 'header units: ms and mV are converted');

p = D.parseCapture('Time,Channel A\n(ms),(V)\n' + rows(80, (i) => (i * 0.001).toFixed(4) + ',' + (i * 0.01)));
ok(p.n === 80 && near(p.t[79], 79e-6, 1e-12), 'PicoScope style units row');

p = D.parseCapture(rows(70, (i) => i * 0.1), { sampleInterval: 2e-6 });
ok(p.oneColumn && near(p.t[69], 138e-6, 1e-12), 'one value per line uses the sample interval');

p = D.parseCapture(rows(60, (i) => i + '\t' + (i * 2048)), { valueMode: 'counts', bits: 12, vref: 3.3, timeUnit: 'us' });
ok(near(p.v[1], 2048 / 4095 * 3.3, 1e-9) && near(p.t[1], 1e-6, 1e-15), 'ADC counts become volts, tab separated, forced microseconds');

p = D.parseCapture('START\n' + rows(60, (i) => (i * 1e-6) + ';' + (i * 0.02)) + '\nEND');
ok(p.n === 60, 'START/END markers and semicolon delimiter');

let msg = ''; try { D.parseCapture('a,b\n1,2\n3,4'); } catch (e) { msg = e.message; }
ok(/at least 50/.test(msg), 'too few samples gives a readable error: ' + msg);
msg = ''; try { D.parseCapture(rows(60, (i) => (100 - i) + ',1')); } catch (e) { msg = e.message; }
ok(/must increase/.test(msg), 'decreasing time gives a readable error');

// streamed lines -> one capture, with chatter ignored and the idle timer finishing it
let got = null; // ---- binary sweep packets from the ESP32 firmware
{
  const T = require('../js/tdr.js');
  const pkt = (samples, id) => { const n = samples.length, b = Buffer.alloc(8 + n * 2 + 2); b.writeUInt16LE(0xAA55, 0); b.writeUInt16LE(n, 2); b.writeUInt32LE(id, 4); samples.forEach((v, k) => b.writeUInt16LE(v, 8 + k * 2)); b.writeUInt16LE(D.crc16(new Uint8Array(b), 8, n * 2), 8 + n * 2); return b; };
  const wave = (off, f) => Array.from({ length: 1000 }, (_, i) => f(((i - off) % 1000 + 1000) % 1000));
  const sw = [], txt = [], P = new D.SweepParser({ onSweep: (s2, id) => sw.push(id), onText: (l) => txt.push(l) });
  const bad = pkt(wave(0, () => 7), 9); bad[100] ^= 0xFF;
  const stream = Buffer.concat([Buffer.from('POST_PASSED: SYSTEM_READY\r\n'), pkt(wave(0, () => 1), 1), Buffer.from('WARN: SAMPLER_OVERRUN\r\n'), pkt(wave(0, () => 2), 2), bad, pkt(wave(0, () => 3), 3)]);
  for (let i = 0; i < stream.length; i += 137) P.push(new Uint8Array(stream.subarray(i, i + 137)));
  ok(sw.join() === '1,2,3' && txt.length === 2 && P.bad >= 1, 'sweep parser: 3 good packets, 2 status lines, corrupt packet rejected, any chunking');
  const cfg = Object.assign(T.defaultConfig(), { vp: 0.66 });
  let allOk = true;
  for (const off of [3, 250, 497, 760, 999]) {
    const s1 = wave(off, (k) => (k < 500 ? (k >= 20 ? 2900 : 1500) : 500));        // open circuit 20 ns after launch: the echo is bigger than the launch edge
    const q = D.parseCapture(D.sweepsToText([s1, s1], {}), { valueMode: 'volts' });
    const r = T.findReflections(Float64Array.from(q.t, (x) => x / 1e5), q.v, cfg).reflections;
    if (!(r.length === 1 && near(r[0].distance, 1.98, 0.06) && r[0].delta > 0.8)) allOk = false;
  }
  ok(allOk, 'sweep rotation: launch edge found wherever the sweep starts, open at 20 ns reads 1.98 m');
}
// ---- A1-A3: sweep alignment, missed= parsing, per-capture summary
{
  const pk = (samples, id) => { const n = samples.length, b = Buffer.alloc(8 + n * 2 + 2); b.writeUInt16LE(0xAA55, 0); b.writeUInt16LE(n, 2); b.writeUInt32LE(id, 4); samples.forEach((v, k) => b.writeUInt16LE(v, 8 + k * 2)); b.writeUInt16LE(D.crc16(new Uint8Array(b), 8, n * 2), 8 + n * 2); return b; };
  const sw = (L, bump) => Array.from({ length: 1000 }, (_, i) => { const k = ((i - L) % 1000 + 1000) % 1000; return (k < 500 ? (k >= 20 ? 2900 : 1500) : 500) + (bump || 0); });
  const runCap = (plan) => {
    const info = []; let out = null; const dev = new D.SerialDevice({ onCapture: (t) => { out = t; }, onInfo: (m) => info.push(m), onWarning: () => {}, onError: () => {} });
    dev.port = { writable: true }; dev._send = async () => {};
    dev.opt = {}; dev.sweeps = []; dev._resetCounts(); dev.want = 4;
    let id = 0; for (const s of plan) { id += 1 + (s.skip || 0); if (s.warn) dev.parser.push(new Uint8Array(Buffer.from(s.warn + '\r\n'))); dev.parser.push(new Uint8Array(pk(sw(s.L, s.bump), id))); if (out) break; }
    return { out, info: info.join(' / '), dev };
  };
  let r = runCap([{ L: 300 }, { L: 301 }, { L: 299 }, { L: 301 }]);
  ok(r.out && /Used 4 of 4/.test(r.info), 'A1: launch wobble of 1 sample is aligned and kept');
  r = runCap([{ L: 300 }, { L: 305 }, { L: 300 }, { L: 300 }, { L: 300 }]);
  ok(/Used 4 of 5/.test(r.info) && /launch moved 5/.test(r.info), 'A1: sweep 5 samples off is dropped');
  r = runCap([{ L: 300 }, { L: 300, bump: 400 }, { L: 300 }, { L: 300 }, { L: 300 }]);
  ok(/Used 4 of 5/.test(r.info) && /baseline jumped/.test(r.info), 'A1: baseline jump is dropped');
  r = runCap([{ L: 300 }, { L: 300, warn: 'WARN: SAMPLER_OVERRUN idx=120 missed=2' }, { L: 300 }, { L: 300 }]);
  ok(/Used 4 of 4/.test(r.info) && /1 overrun \(last idx 120\)/.test(r.info), 'A2: missed=2 is kept, idx logged');
  r = runCap([{ L: 300 }, { L: 300, warn: 'WARN: SAMPLER_OVERRUN idx=310 missed=3' }, { L: 300 }, { L: 300 }, { L: 300 }]);
  ok(/Used 4 of 5/.test(r.info) && /dropped for missed ticks/.test(r.info), 'A2: missed=3 is dropped');
  r = runCap([{ L: 300 }, { L: 300, warn: 'WARN: SAMPLER_OVERRUN' }, { L: 300 }, { L: 300 }, { L: 300 }]);
  ok(/Used 4 of 5/.test(r.info), 'A2: old warning without a count is still dropped');
  r = runCap([{ L: 300 }, { L: 300, skip: 2 }, { L: 300 }, { L: 300 }]);
  ok(/2 sweep IDs never arrived/.test(r.info), 'A3: gaps in sweep IDs are counted');
  r = runCap([{ L: 998 }, { L: 999 }, { L: 0 }, { L: 997 }]);
  ok(r.out && /Used 4 of 4/.test(r.info), 'A1: alignment works when the launch edge wraps round the window');
}
// ---- launch edge on the real board's waveform (19 Nov): both halves sag, edge right at the end of the window
{
  const T = require('../js/tdr.js');
  let sd = 9; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const board = (L, echo) => {                          // square wave through a high-pass, noise of +/-20 counts
    const n = 1000, ideal = [], out = []; let y = 0, prev = 0;
    for (let i = 0; i < n; i++) { const k = ((i - L) % n + n) % n; let x = k < 500 ? 1 : 0; if (echo && k >= echo.k && k < 500) x += echo.a; ideal.push(x); }
    for (let r = 0; r < 4; r++) for (let i = 0; i < n; i++) { const x = ideal[i]; y = (y + x - prev) * Math.exp(-1 / 1100); prev = x; if (r === 3) out.push(Math.round(1750 + 1650 * y + (rnd() - 0.5) * 40)); }
    return out;
  };
  const cfg = Object.assign(T.defaultConfig(), { vp: 0.66 });
  const launches = [999, 0, 1, 999].map((L) => D.sweepLaunch(board(L), 20).idx);
  ok(launches.every((x, k) => Math.abs(((x - [999, 0, 1, 999][k] + 1500) % 1000) - 500) <= 1), 'sagging board waveform: launch edge found within 1 sample (' + launches.join(',') + ')');
  const res = (echo) => { const q = D.parseCapture(D.sweepsToText([999, 0, 1, 999].map((L) => board(L, echo)), {}), { valueMode: 'volts' }); return T.findReflections(Float64Array.from(q.t, (x) => x / 1e5), q.v, cfg).reflections.filter((r) => Math.abs(r.delta) >= 0.25); };
  ok(res(null).length === 0, 'sagging board waveform, nothing connected: no fault reported');
  const o = res({ k: 20, a: 1 }), sh = res({ k: 30, a: -1 });
  ok(o.length === 1 && near(o[0].distance, 1.98, 0.06) && sh.length === 1 && near(sh[0].distance, 2.97, 0.06), 'sagging board waveform: open at 1.98 m and short at 2.97 m found');
}
const asm = new D.LineAssembler({ onCapture: (t) => { got = t; } }, { idleMs: 30, minLines: 50 });
asm.push('boot v1.2'); asm.push('START'); for (let i = 0; i < 120; i++) asm.push(i + ',' + i); asm.push('END');
ok(got && got.split('\n').length === 120, 'serial assembler: START ... END gives 120 lines, chatter ignored');
got = null; for (let i = 0; i < 80; i++) asm.push(i + ',' + i);
setTimeout(() => { ok(got && got.split('\n').length === 80, 'serial assembler: idle gap ends a capture without END'); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0); }, 120);

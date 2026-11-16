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
const asm = new D.LineAssembler({ onCapture: (t) => { got = t; } }, { idleMs: 30, minLines: 50 });
asm.push('boot v1.2'); asm.push('START'); for (let i = 0; i < 120; i++) asm.push(i + ',' + i); asm.push('END');
ok(got && got.split('\n').length === 120, 'serial assembler: START ... END gives 120 lines, chatter ignored');
got = null; for (let i = 0; i < 80; i++) asm.push(i + ',' + i);
setTimeout(() => { ok(got && got.split('\n').length === 80, 'serial assembler: idle gap ends a capture without END'); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0); }, 120);

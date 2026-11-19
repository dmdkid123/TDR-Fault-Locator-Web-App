// Feeds packets made by the firmware's own SerialProtocol (host_pkt.cpp) through the web app's parser (js/device.js).
const fs = require('fs'); const D = require(require('path').join(__dirname, '../../js/device.js'));
const bytes = new Uint8Array(fs.readFileSync(process.argv[2])); const got = [];
const p = new D.SweepParser({ onSweep: (samples, id) => got.push({ id, counts: samples }), onText: () => {} });
for (let i = 0; i < bytes.length; i += 64) p.push(bytes.subarray(i, i + 64));       // USB-serial style small reads
const exp = (i) => (i * 37 + (i > 500 ? 1800 : 0)) & 0x0FFF;
const ok = got.length > 0 && got.every((g) => g.counts.every((v, i) => v === exp(i))) && p.bad === 0;
console.log('sweeps decoded:', got.map((g) => 'id ' + g.id).join(', '), '| samples each:', got.length ? got[0].counts.length : 0,
  '| payload matches C++ source data:', ok, '| checksum failures:', p.bad);
if (!ok) process.exit(1);

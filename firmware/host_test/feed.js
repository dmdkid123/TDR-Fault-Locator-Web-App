const fs = require('fs'); const D = require(require('path').join(__dirname, '../../tdr-ui-extracted/tdr-ui/js/device.js'));
const bytes = new Uint8Array(fs.readFileSync(process.argv[2])); const got = [];
const s = new D.SweepStream({ onSweep: (x) => got.push(x), onCrcError: (e) => console.log('CRC ERROR', e) });
for (let i = 0; i < bytes.length; i += 64) s.feed(bytes.subarray(i, i + 64));      // USB-serial style small reads
const exp = (i) => (i * 37 + (i > 500 ? 1800 : 0)) & 0x0FFF;
console.log('sweeps decoded:', got.map((g) => 'id ' + g.sweepId).join(', '), '| samples each:', got[0].counts.length,
  '| payload matches C++ source data:', got.every((g) => g.counts.every((v, i) => v === exp(i))), '| crc errors:', s.crcErrors);

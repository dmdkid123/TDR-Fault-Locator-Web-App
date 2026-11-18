// Run: node tests/tdr.test.js   (no dependencies)
const T = require('../js/tdr.js');
const H = require('../js/harness_data.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('pass', m); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const cfg = T.defaultConfig();
const run = (events, o) => { const c = T.synthCapture(events, cfg, o || {}); return T.findReflections(c.t, c.v, cfg).reflections; };

ok(Math.round(T.etScaleFactor(1e6, 1e6 - 10)) === 100000, 'ET scale 100,000x');
ok(near(T.etStepSeconds(1e6, 1e6 - 10), 10e-12, 1e-13), 'ET step 10 ps');
ok(near(T.timingNeededFor(0.05, 0.66) * 1e9, 0.5, 0.05), '+/-5 cm needs ~0.5 ns');
ok(near(T.calibrateVp(3, T.distanceToTime(3, 0.66)), 0.66, 1e-9), 'vp calibration round trip');

// Python parity (noise-free): the Python suite reports these same distances.
for (const [d, a, kind] of [[2.0, 0.97, 'OPEN'], [2.0, -0.97, 'SHORT'], [2.0, -0.4, 'RESISTIVE'], [2.0, 0.3, 'HIGH-Z']]) {
  const r = run([{ d, a }], { noise: 0 });
  ok(r.length === 1 && r[0].kind.startsWith(kind) && near(r[0].distance, d, 0.02), `${kind} at ${d} m -> ${r[0] && r[0].distance.toFixed(3)}`);
}
ok(run([]).length === 0, 'clean line reports nothing');
ok(near(T.zFromGamma(T.gammaFromZ(60, 120), 120), 60, 1e-9), 'Z <-> gamma');

// accuracy sweep
let worst = 0;
for (let d = 0.5; d <= 5.001; d += 0.25) {
  const r = run([{ d, a: 0.97 }], { span: 80e-9, seed: Math.round(d * 100) });
  if (!r.length) { ok(false, 'missed open at ' + d); continue; }
  worst = Math.max(worst, Math.abs(r[r.length - 1].distance - d));
}
ok(worst < 0.05, `open sweep 0.5-5 m worst error ${(worst * 100).toFixed(2)} cm`);

// Monte Carlo with noise
const rng = T.mulberry32(7); let miss = 0, within = 0, N = 200; const errs = [];
for (let i = 0; i < N; i++) {
  const d = 0.6 + rng() * 4.4, a = rng() < 0.5 ? 0.97 : -0.97, noise = 0.002 + rng() * 0.018;
  const r = run([{ d, a }], { noise, seed: i + 1, span: 80e-9 });
  if (!r.length) { miss++; continue; }
  const e = Math.abs(r[r.length - 1].distance - d); errs.push(e); if (e < 0.05) within++;
}
errs.sort((x, y) => x - y);
console.log(`  MC: miss=${miss} median=${(errs[errs.length >> 1] * 100).toFixed(2)} cm p95=${(errs[Math.floor(errs.length * .95)] * 100).toFixed(2)} cm max=${(errs[errs.length - 1] * 100).toFixed(2)} cm`);
ok(miss === 0 && within / N >= 0.95, 'Monte Carlo: no misses, >=95% within 5 cm');

// two features, and resolution limit
let r2 = run([{ d: 1.5, a: 0.10 }, { d: 1.8, a: 0.95 }]);
ok(r2.length === 2 && near(r2[0].distance, 1.5, 0.05) && near(r2[1].distance, 1.8, 0.05), 'connector + break 0.3 m apart resolved');
ok(run([{ d: 2.0, a: 0.5 }, { d: 2.03, a: 0.45 }]).length === 1, '3 cm apart merges (honest limit)');

// harness mapping
const net = T.buildNet(H, 'FUEL_PUMP');
const c = T.synthCapture([{ d: 1.9, a: 0.97 }], cfg, { noise: 0.004 });
const a = T.findReflections(c.t, c.v, cfg), rows = T.localize(a.reflections, net);
ok(rows.length === 1 && rows[0].candidates.length === 1, 'FUEL_PUMP break maps to exactly one point on the net');
const sensor = T.buildNet(H, 'SENSOR_5V');
const split = sensor.locate(sensor.nodeDist['SPL1'] + 600);
ok(split.length === 2, 'branch ambiguity yields both branches');
ok(sensor.locate(99999).length === 0, 'beyond end returns nothing');
const leaf = Object.values(net.leaves)[0] / 1000;
const eol = T.localize(run([{ d: leaf, a: 0.95 }]), net);
ok(eol.length === 1 && eol[0].endOfLine, 'reflection at the pump connector is flagged expected end of line');

// reference subtraction
const g = T.synthCapture([{ d: 1.2, a: 0.15 }], cfg, { seed: 2 }), b = T.synthCapture([{ d: 1.2, a: 0.15 }, { d: 2.4, a: 0.97 }], cfg, { seed: 3 });
const rr = T.findReflections(g.t, b.v, cfg, g.v).reflections;
ok(rr.length === 1 && near(rr[0].distance, 2.4, 0.05), 'reference subtraction isolates new fault');

// velocity-factor sensitivity
const w = T.synthCapture([{ d: 3.0, a: 0.97 }], cfg, { vpTrue: 0.70 });
const wr = T.findReflections(w.t, w.v, cfg).reflections[0];
ok(near(wr.distance, 3.0 * 0.66 / 0.70, 0.03), `wrong vp (0.66 vs 0.70) reads ${wr.distance.toFixed(3)} m`);
const fixed = T.findReflections(w.t, w.v, Object.assign({}, cfg, { vp: T.calibrateVp(3.0, wr.t) })).reflections[0];
ok(near(fixed.distance, 3.0, 0.05), 'calibrated vp recovers 3.000 m');

// friendly errors
let msg = ''; try { T.findReflections(new Float64Array(10), new Float64Array(10), cfg); } catch (e) { msg = e.message; }
ok(/too short/.test(msg), 'short capture gives a readable error');


// ---- sub-sample timing: board data is 1 ns per sample (about 10 cm), the target is +/-5 cm
{
  let worst = 0, worstOff = 0;
  for (let d = 1.5; d < 2.5; d += 0.013) for (const f of [0, 0.37, 0.71]) {
    const c = T.synthCapture([{ d, a: 0.97 }], cfg, { dt: 1e-9, span: 120e-9, tLaunch: (30 + f) * 1e-9, noise: 0.004, seed: 7 });
    worst = Math.max(worst, Math.abs(T.findReflections(c.t, c.v, cfg).reflections[0].distance - d));
    worstOff = Math.max(worstOff, Math.abs(T.findReflections(c.t, c.v, Object.assign({}, cfg, { subsample: false })).reflections[0].distance - d));
  }
  ok(worst < 0.03, `1 ns sampling with sub-sample timing: worst error ${(worst * 100).toFixed(1)} cm (under 3 cm)`);
  ok(worstOff > 0.05, `1 ns sampling without it: worst error ${(worstOff * 100).toFixed(1)} cm`);
}
// ---- branched circuit: junction recognised, loss corrected, branch picked from the missing end echo
{
  const net = T.buildNet(H, 'SENSOR_5V'), leaves = Object.keys(net.leaves);
  const cap = (fault) => { const c = T.synthCapture(T.simEvents(net, fault), cfg, { span: 90e-9, noise: 0.004, seed: 3 }); return T.findReflections(c.t, c.v, cfg).reflections; };
  ok(net.junctions.length === 1 && net.junctions[0].k === 2 && near(net.pathFactor('B1'), 4 / 9, 1e-9), 'junction found, round-trip loss past it is 4/9');
  const good = cap(null), rows = T.localize(good, net, 75, cfg);
  ok(rows.length === 3 && rows[0].junction === 'SPL1' && rows[1].endOfLine && rows[2].endOfLine, 'healthy branched circuit: junction + two wire ends, no fault');
  for (const leaf of leaves) {
    const bad = cap({ kind: 'open', d: 1.7, leaf }), row = T.localize(bad, net, 75, cfg).find((r) => !r.junction && !r.endOfLine);
    const pick = T.pickBranch(row.reflection.distance * 1000, row.candidates, net, T.leafEchoes(bad, net, 75), T.leafEchoes(good, net, 75), 75);
    ok(row.reflection.kind === 'OPEN' && row.candidates.length === 2 && pick.segment === net.parent[leaf].seg, `open at 1.7 m on the branch to ${leaf}: classified open, branch ${pick.segment} picked`);
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);

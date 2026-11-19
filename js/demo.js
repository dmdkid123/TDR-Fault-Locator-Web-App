/* demo.js - guided, animated walkthrough of one measurement, run through the real analysis engine.
 * Five stages: Launch, Reflect, Reconstruct, Analyze, Locate. Exposes window.TDRDemo. */
(function (root) {
  'use strict';
  const mft = (m, d) => { d = d == null ? 2 : d; return (+m).toFixed(d) + ' m (' + (m / 0.3048).toFixed(d >= 3 ? 2 : 1) + ' ft)'; };   // every distance shown in metres AND feet

  const T = root.TDR, CH = root.TDRChart, $ = (id) => document.getElementById(id);
  const C = 0.299792458; // metres per nanosecond in free space
  const SCEN = [
    { id: 'open', name: 'Open circuit', sub: 'Broken wire at 1.90 m', net: 'FUEL_PUMP', d: 1.9, a: 0.97, conn: 0.10, noise: 0.004, seed: 11, story: 'A wire has snapped inside the loom behind a panel. The connector 1.2 m in is healthy.' },
    { id: 'short', name: 'Short to ground', sub: 'Chafed wire at 2.40 m', net: 'FUEL_PUMP', d: 2.4, a: -0.97, conn: 0.10, noise: 0.004, seed: 12, story: 'Insulation has rubbed through where the harness crosses the underbody and touches bare metal.' },
    { id: 'res', name: 'Resistive short', sub: 'Moisture leak at 1.70 m', net: 'FUEL_PUMP', d: 1.7, a: -0.45, conn: 0.10, noise: 0.004, seed: 13, story: 'Water has got into a splice and leaks to ground through about 45 Ω. A multimeter would barely notice it.' },
    { id: 'hz', name: 'Bad terminal', sub: 'High resistance at 2.20 m', net: 'FUEL_PUMP', d: 2.2, a: 0.30, conn: 0.10, noise: 0.004, seed: 14, story: 'A corroded crimp adds resistance in series. Current still flows, but the pump runs weak.' },
    { id: 'branch', name: 'Branched circuit', sub: 'Open past a splice', net: 'SENSOR_5V', d: 2.0, a: 0.90, conn: 0.12, noise: 0.004, seed: 15, story: 'A sensor feed splits in two. The break is 2.0 m from the test point, which is the same distance along both branches.' },
    { id: 'noisy', name: 'Noisy capture', sub: 'Break at 2.90 m, heavy noise', net: 'FUEL_PUMP', d: 2.9, a: 0.97, conn: 0.10, noise: 0.03, seed: 16, story: 'Ignition noise rides on the signal. The analyzer still has to find a clear echo.' }
  ];
  const STAGES = [['Launch', 'A fast edge goes in'], ['Reflect', 'Echoes come back'], ['Reconstruct', 'Slow it down'], ['Analyze', 'Find the echoes'], ['Locate', 'Place it on the car']];
  const DUR = [5, 6.5, 6.5, 6, 3];
  const S = { sc: 0, stage: 0, p: 0, playing: false, speed: 1, last: 0, m: null, first: true };
  let ctx = null, active = false, raf = 0, cvW, cvS;

  const v = (n) => CH.cssVar(n);
  const kindOf = (r, thr) => r.endOfLine ? 'eol' : Math.abs(r.reflection.delta) < thr ? 'feat' : r.reflection.kind.startsWith('OPEN') ? 'open' : r.reflection.kind.startsWith('SHORT') ? 'short' : r.reflection.kind.startsWith('RESISTIVE') ? 'res' : 'highz';
  const kcol = (k) => v({ open: '--open', short: '--short', res: '--res', highz: '--highz', feat: '--feat', eol: '--eol' }[k] || '--feat');

  /* ------------------------------------------------------------ model */
  function build(i) {
    const sc = SCEN[i], H = ctx.sample(), net = T.buildNet(H, sc.net), cfg = T.defaultConfig();   // the demo is a fixed simulation: it must not depend on the Setup values for the real board
    const conn = net.trav[0].d1 / 1000, ev = [{ d: conn, a: sc.conn }, { d: sc.d, a: sc.a }];
    const span = Math.max(70e-9, T.distanceToTime(sc.d, cfg.vp) + 40e-9);
    const cap = T.synthCapture(ev, cfg, { span, noise: sc.noise, seed: sc.seed });
    const an = T.findReflections(cap.t, cap.v, cfg), rows = T.localize(an.reflections, net, 75);
    rows.forEach((r) => { r.kind = kindOf(r, 0.25); });
    const prim = rows.filter((r) => r.kind !== 'eol' && r.kind !== 'feat').sort((a, b) => a.reflection.distance - b.reflection.distance)[0];
    const lanes = {}, kids = {}, segLane = {};
    net.trav.forEach((tv) => { (kids[tv.seg.a] = kids[tv.seg.a] || []).push(tv); });
    lanes[net.root] = 0; const q = [net.root];
    while (q.length) { const n = q.shift(), ch = kids[n] || []; ch.forEach((tv, k) => { const L = lanes[n] + (ch.length > 1 ? (k - (ch.length - 1) / 2) * 1.6 : 0); segLane[tv.seg.id] = L; lanes[tv.seg.b] = L; q.push(tv.seg.b); }); }
    S.m = { sc, net, cfg, ev, cap, an, rows, prim, conn, segLane, lanes, vpc: cfg.vp * C, tEnd: T.distanceToTime(sc.d, cfg.vp) * 1e9 + 5 };
  }

  /* ------------------------------------------------------------ canvas helpers */
  function fit(cv, h) {
    const w = cv.parentElement.clientWidth, dpr = devicePixelRatio || 1; if (!w) return null;
    if (cv.style.height !== h + 'px') cv.style.height = h + 'px';
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w, h };
  }
  function axes(g, R, x0, x1, y0, y1, xl, yl, xf) {
    const X = (x) => R.l + (x - x0) / (x1 - x0) * (R.r - R.l), Y = (y) => R.b - (y - y0) / (y1 - y0) * (R.b - R.t);
    const tx = CH.niceTicks(x0, x1, Math.max(4, (R.r - R.l) / 90)), ty = CH.niceTicks(y0, y1, Math.max(3, (R.b - R.t) / 40));
    g.lineWidth = 1; g.strokeStyle = v('--grat'); g.beginPath();
    tx.list.forEach((a) => { const p = Math.round(X(a)) + .5; g.moveTo(p, R.t); g.lineTo(p, R.b); }); ty.list.forEach((a) => { const p = Math.round(Y(a)) + .5; g.moveTo(R.l, p); g.lineTo(R.r, p); }); g.stroke();
    g.strokeStyle = v('--grat2'); g.strokeRect(R.l + .5, R.t + .5, R.r - R.l, R.b - R.t);
    g.fillStyle = v('--scope-ink'); g.font = '11.5px ' + v('--font-ui'); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    tx.list.forEach((a) => g.fillText(xf ? xf(a) : CH.fmt(a, tx.step), X(a), R.b + 15)); g.fillText(xl, (R.l + R.r) / 2, R.b + 30);
    g.textAlign = 'right'; ty.list.forEach((a) => g.fillText(CH.fmt(a, ty.step), R.l - 6, Y(a) + 4));
    g.save(); g.translate(12, (R.t + R.b) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText(yl, 0, 0); g.restore();
    return { X, Y };
  }
  function flag(g, x, y, text, color) {
    g.font = '600 12px ' + v('--font-ui'); const w = g.measureText(text).width + 14;
    CH.roundRect(g, x, y, w, 19, 4); g.fillStyle = color; g.fill(); g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(text, x + 7, y + 10); g.textBaseline = 'alphabetic'; return w;
  }

  /* ------------------------------------------------------------ wire schematic (stages 1-4) */
  function drawWire(τ, reflOn) {
    const F = fit(cvW, 190); if (!F) return; const { g, w, h } = F, m = S.m, net = m.net, sc = m.sc;
    g.fillStyle = v('--scope'); g.fillRect(0, 0, w, h);
    const L = net.lengthM, x0 = 92, x1 = w - 40, X = (d) => x0 + d / L * (x1 - x0), midY = h / 2 + 2, lane = (l) => midY + l * 30;
    const front = Math.max(0, m.vpc * τ), broken = Math.abs(sc.a) > 0.8, stopAt = broken ? sc.d : Infinity;
    g.textBaseline = 'alphabetic'; g.font = '11.5px ' + v('--font-ui'); g.textAlign = 'center';
    CH.niceTicks(0, L, 7).list.forEach((d) => { g.fillStyle = v('--grat2'); g.fillRect(Math.round(X(d)), h - 26, 1, 5); g.fillStyle = v('--scope-ink'); g.fillText(d.toFixed(d % 1 ? 1 : 0) + ' m', X(d), h - 8); });
    g.lineCap = 'round'; g.lineJoin = 'round';
    net.trav.forEach((tv) => {
      const ln = lane(m.segLane[tv.seg.id]), a = tv.d0 / 1000, b = tv.d1 / 1000, pl = lane(m.lanes[tv.seg.a]);
      g.strokeStyle = v('--grat2'); g.lineWidth = 5; g.beginPath(); g.moveTo(X(a), pl); g.lineTo(X(a), ln); g.lineTo(X(b), ln); g.stroke();
      const lim = Math.min(front, b, stopAt);
      if (lim > a) { g.strokeStyle = v('--trace'); g.shadowColor = v('--trace'); g.shadowBlur = 8; g.beginPath(); g.moveTo(X(a), pl); g.lineTo(X(a), ln); g.lineTo(X(lim), ln); g.stroke(); g.shadowBlur = 0; }
      g.fillStyle = v('--scope-ink'); g.beginPath(); g.arc(X(b), ln, 4, 0, 7); g.fill(); g.font = '12px ' + v('--font-ui'); g.textAlign = b >= L - 0.001 ? 'right' : 'center'; g.fillText(tv.seg.b, b >= L - 0.001 ? X(b) + 4 : X(b), ln + 19);
    });
    g.fillStyle = v('--feat'); g.fillRect(X(m.conn) - 4, lane(0) - 9, 8, 18);
    g.fillStyle = v('--scope-ink'); g.font = '11.5px ' + v('--font-ui'); g.textAlign = 'center'; g.fillText(sc.net === 'SENSOR_5V' ? 'splice' : 'connector', X(m.conn), lane(0) - 15);
    const cands = m.prim ? m.prim.candidates : [], lanesF = cands.length ? cands.map((c) => m.segLane[c.segment]) : [0], fc = kcol(m.prim ? m.prim.kind : 'open');
    lanesF.forEach((ln, i) => {
      const y = lane(ln); g.strokeStyle = fc; g.lineWidth = 3; g.beginPath(); g.moveTo(X(sc.d) - 7, y - 11); g.lineTo(X(sc.d) + 7, y + 11); g.moveTo(X(sc.d) + 7, y - 11); g.lineTo(X(sc.d) - 7, y + 11); g.stroke();
      if (i === 0) { g.fillStyle = fc; g.font = '600 12px ' + v('--font-ui'); g.textAlign = 'center'; g.fillText('fault', X(sc.d), y - 18); }
    });
    if (reflOn) m.ev.forEach((e, k) => {
      if (front < e.d) return; const back = Math.max(0, 2 * e.d - front), y = lane(k === 0 ? 0 : (lanesF[0] || 0));
      g.globalAlpha = Math.min(1, 0.35 + Math.abs(e.a)); g.strokeStyle = e.a >= 0 ? v('--open') : v('--highz'); g.lineWidth = 9; g.lineCap = 'butt'; g.shadowColor = g.strokeStyle; g.shadowBlur = 10;
      g.beginPath(); g.moveTo(X(back), y); g.lineTo(X(e.d), y); g.stroke(); g.shadowBlur = 0; g.globalAlpha = 1; g.lineCap = 'round';
    });
    const endX = Math.min(L, stopAt); if (front > 0 && front < endX) { g.fillStyle = '#fff'; g.globalAlpha = .9; g.fillRect(X(front) - 1.5, midY - 26, 3, 52); g.globalAlpha = 1; }
    g.fillStyle = v('--panel2'); CH.roundRect(g, 14, midY - 28, 58, 56, 7); g.fill(); g.strokeStyle = v('--grat2'); g.lineWidth = 1; g.stroke();
    g.fillStyle = v('--ink'); g.font = '700 14px ' + v('--font-display'); g.textAlign = 'center'; g.fillText('TDR', 43, midY - 4); g.font = '11px ' + v('--font-ui'); g.fillStyle = v('--mute'); g.fillText('120 Ω', 43, midY + 13);
    g.strokeStyle = v('--grat2'); g.lineWidth = 5; g.beginPath(); g.moveTo(72, midY); g.lineTo(X(0), midY); g.stroke();
    g.fillStyle = v('--scope-ink'); g.textAlign = 'right'; g.font = '12px ' + v('--font-mono'); g.fillText('t = ' + τ.toFixed(1) + ' ns   edge at ' + mft(Math.min(front, L)), w - 12, 18);
    g.textAlign = 'left'; g.font = '12px ' + v('--font-ui'); g.fillText('The wire, drawn to scale along its length', 12, 18);
  }

  /* ------------------------------------------------------------ scope (stages 1-2) */
  function scopeReveal(τ) {
    const F = fit(cvS, 300); if (!F) return; const { g, w, h } = F, m = S.m, cap = m.cap, t0 = m.an.t0 * 1e9;
    g.fillStyle = v('--scope'); g.fillRect(0, 0, w, h);
    const R = { l: 56, r: w - 16, t: 26, b: h - 40 }, xmax = Math.max(40, m.tEnd + 4), A = axes(g, R, -4, xmax, 0, 5.6, 'time since the launch edge (ns)', 'volts at the test point');
    g.save(); g.beginPath(); g.rect(R.l, R.t, R.r - R.l, R.b - R.t); g.clip(); g.strokeStyle = v('--trace'); g.lineWidth = 1.8; g.shadowColor = v('--trace'); g.shadowBlur = 6; g.beginPath(); let st = false;
    for (let i = 0; i < cap.t.length; i += 2) { const x = cap.t[i] * 1e9 - t0; if (x > τ) break; if (x < -4) continue; st ? g.lineTo(A.X(x), A.Y(cap.v[i])) : (g.moveTo(A.X(x), A.Y(cap.v[i])), st = true); }
    g.stroke(); g.restore(); g.shadowBlur = 0;
    m.ev.forEach((e, k) => {
      const arr = T.distanceToTime(e.d, m.cfg.vp) * 1e9; if (τ < arr) return; const c = e.a >= 0 ? v('--open') : v('--highz');
      g.strokeStyle = c; g.lineWidth = 1.2; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(A.X(arr), R.t); g.lineTo(A.X(arr), R.b); g.stroke(); g.setLineDash([]);
      flag(g, Math.min(A.X(arr) + 6, R.r - 190), R.t + 6 + k * 22, 'echo from ' + mft(e.d, 2) + '  (' + (e.a >= 0 ? '+' : '') + e.a.toFixed(2) + ')', c);
    });
    g.fillStyle = v('--scope-ink'); g.textAlign = 'left'; g.font = '12px ' + v('--font-ui'); g.fillText('What the board sees at its own terminal', 12, 16);
  }

  /* ------------------------------------------------------------ equivalent-time (stage 3) */
  function drawET(p) {
    const F = fit(cvS, 380); if (!F) return; const { g, w, h } = F, m = S.m, cap = m.cap, n = cap.t.length, k = Math.max(1, Math.floor(p * n)), t0 = m.an.t0 * 1e9;
    g.fillStyle = v('--scope'); g.fillRect(0, 0, w, h);
    const xmax = cap.t[n - 1] * 1e9 - t0, R1 = { l: 56, r: w - 16, t: 30, b: 150 }, R2 = { l: 56, r: w - 16, t: 222, b: h - 40 }, k2 = 1e5 / 1e6;
    const A1 = axes(g, R1, -4, xmax, 0, 5.6, 'real time (ns)', 'volts'), A2 = axes(g, R2, -4 * k2, xmax * k2, 0, 5.6, 'time on the scope (ms)', 'volts');
    g.fillStyle = v('--scope-ink'); g.textAlign = 'left'; g.font = '12px ' + v('--font-ui'); g.fillText('The real echo, with 1 ns edges: too fast for a USB scope', 12, 17); g.fillText('What the scope shows: the same shape, 100,000 times slower', 12, 209);
    g.save(); g.beginPath(); g.rect(R1.l, R1.t, R1.r - R1.l, R1.b - R1.t); g.clip(); g.strokeStyle = 'rgba(245,197,24,.28)'; g.lineWidth = 1.4; g.beginPath(); let s1 = false;
    for (let i = 0; i < n; i += 2) { const x = cap.t[i] * 1e9 - t0; if (x < -4) continue; s1 ? g.lineTo(A1.X(x), A1.Y(cap.v[i])) : (g.moveTo(A1.X(x), A1.Y(cap.v[i])), s1 = true); } g.stroke(); g.restore();
    g.fillStyle = v('--trace'); const step = Math.max(1, Math.floor(n / 90));
    for (let i = 0; i < k; i += step) { const x = cap.t[i] * 1e9 - t0; if (x < -4) continue; g.beginPath(); g.arc(A1.X(x), A1.Y(cap.v[i]), 2.4, 0, 7); g.fill(); }
    const cx = cap.t[k - 1] * 1e9 - t0; g.strokeStyle = v('--open'); g.lineWidth = 1.5; g.beginPath(); g.moveTo(A1.X(cx), R1.t); g.lineTo(A1.X(cx), R1.b); g.stroke();
    g.save(); g.beginPath(); g.rect(R2.l, R2.t, R2.r - R2.l, R2.b - R2.t); g.clip(); g.strokeStyle = v('--trace'); g.lineWidth = 1.8; g.shadowColor = v('--trace'); g.shadowBlur = 6; g.beginPath(); let s2 = false;
    for (let i = 0; i < k; i += 2) { const x = (cap.t[i] * 1e9 - t0) * k2; if (x < -4 * k2) continue; s2 ? g.lineTo(A2.X(x), A2.Y(cap.v[i])) : (g.moveTo(A2.X(x), A2.Y(cap.v[i])), s2 = true); }
    g.stroke(); g.restore(); g.shadowBlur = 0;
    g.textAlign = 'right'; g.fillStyle = v('--scope-ink'); g.font = '12px ' + v('--font-mono'); g.fillText('pulse ' + k.toLocaleString() + ' of ' + n.toLocaleString() + '   sample delay ' + (k * 10 / 1000).toFixed(2) + ' ns', w - 12, 17);
  }

  /* ------------------------------------------------------------ analysis plot (stages 4 and 5) */
  function drawRho(reveal) {
    const F = fit(cvS, 300); if (!F) return; const { g, w, h } = F, m = S.m, a = m.an, vp = m.cfg.vp;
    g.fillStyle = v('--scope'); g.fillRect(0, 0, w, h);
    const dmax = Math.max(m.net.lengthM * 1.25, m.sc.d * 1.15 + .3), R = { l: 56, r: w - 16, t: 26, b: h - 40 }, A = axes(g, R, 0, dmax, -1.2, 1.2, 'distance from test point (m)', 'reflection coefficient');
    g.save(); g.beginPath(); g.rect(R.l, R.t, R.r - R.l, R.b - R.t); g.clip(); g.strokeStyle = v('--trace'); g.lineWidth = 1.8; g.shadowColor = v('--trace'); g.shadowBlur = 6; g.beginPath(); let st = false;
    for (let i = 0; i < m.cap.t.length; i += 2) { if (m.cap.t[i] < a.t0) continue; const d = T.timeToDistance(m.cap.t[i] - a.t0, vp); if (d > dmax) break; st ? g.lineTo(A.X(d), A.Y(a.rho[i])) : (g.moveTo(A.X(d), A.Y(a.rho[i])), st = true); }
    g.stroke(); g.restore(); g.shadowBlur = 0;
    m.rows.forEach((r, i) => {
      if (i >= reveal) return; const x = A.X(r.reflection.distance), c = kcol(r.kind);
      g.strokeStyle = c; g.lineWidth = r === m.prim ? 2 : 1.2; g.setLineDash(r === m.prim ? [] : [6, 4]); g.beginPath(); g.moveTo(x, R.t); g.lineTo(x, R.b); g.stroke(); g.setLineDash([]);
      flag(g, Math.min(x + 6, R.r - 80), R.t + 6 + (i % 3) * 22, mft(r.reflection.distance, 2) + '', c);
    });
    g.fillStyle = v('--scope-ink'); g.textAlign = 'left'; g.font = '12px ' + v('--font-ui'); g.fillText('Normalized trace: reflection coefficient against distance', 12, 16);
  }

  /* ------------------------------------------------------------ top-view map (stage 5) */
  function drawMap() {
    const F = fit(cvW, 330); if (!F) return; const { g, w, h } = F, m = S.m, net = m.net;
    g.fillStyle = v('--scope'); g.fillRect(0, 0, w, h);
    const pts = []; net.segments.forEach((s) => s.pts.forEach((p) => pts.push(p)));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = 64;
    const k = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), (h - 2 * pad) / Math.max(1, y1 - y0)), ox = (w - (x1 - x0) * k) / 2, oy = (h - (y1 - y0) * k) / 2, P = (p) => [ox + (p[0] - x0) * k, oy + (y1 - p[1]) * k];
    g.lineCap = 'round'; g.lineJoin = 'round';
    net.segments.forEach((s) => { g.strokeStyle = s.color || '#4a6fa5'; g.lineWidth = 5; g.beginPath(); s.pts.forEach((p, i) => { const q = P(p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke(); });
    const seen = {}; g.font = '12px ' + v('--font-ui'); g.textAlign = 'left';
    net.segments.forEach((s) => [[s.a, s.pts[0]], [s.b, s.pts[s.pts.length - 1]]].forEach(([n, p]) => { if (seen[n]) return; seen[n] = 1; const q = P(p); g.fillStyle = '#1b2733'; g.strokeStyle = v('--scope-ink'); g.lineWidth = 2; g.beginPath(); g.arc(q[0], q[1], 5, 0, 7); g.fill(); g.stroke(); g.fillStyle = v('--scope-ink'); g.fillText(n, q[0] + 9, q[1] - 8); }));
    const pr = m.prim, c = pr ? kcol(pr.kind) : v('--open'), ph = ((performance.now() / 1000) % 1.2) / 1.2;
    if (pr) pr.candidates.forEach((cd, i) => {
      const q = P(cd.xyz), z = ctx.cfg().zone, seg = net.trav.find((tv) => tv.seg.id === cd.segment), dd = seg.d0 + cd.intoMm;
      g.strokeStyle = c; g.globalAlpha = .9; g.lineWidth = 11; g.beginPath();
      for (let j = 0; j <= 8; j++) { const dm = Math.max(seg.d0, Math.min(seg.d1, dd - z + 2 * z * j / 8)), cc = net.locate(dm).find((o) => o.segment === cd.segment), pp = P(cc.xyz); j ? g.lineTo(pp[0], pp[1]) : g.moveTo(pp[0], pp[1]); }
      g.stroke(); g.globalAlpha = 1;
      g.fillStyle = c; g.beginPath(); g.arc(q[0], q[1], 9, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
      g.strokeStyle = c; g.globalAlpha = 1 - ph; g.lineWidth = 3; g.beginPath(); g.arc(q[0], q[1], 9 + ph * 28, 0, 7); g.stroke(); g.globalAlpha = 1;
      g.fillStyle = '#fff'; g.font = '700 13px ' + v('--font-display'); g.textAlign = 'left'; g.fillText('FAULT  X ' + Math.round(cd.xyz[0]) + '  Y ' + Math.round(cd.xyz[1]) + '  Z ' + Math.round(cd.xyz[2]) + ' mm', q[0] + 16, q[1] + (q[1] > h / 2 ? -14 : 24));
    });
    g.fillStyle = v('--scope-ink'); g.font = '12px ' + v('--font-ui'); g.textAlign = 'left'; g.fillText('Top view of the circuit from the CAD. The thick band is the search zone.', 12, 18);
  }

  /* ------------------------------------------------------------ explanation panel */
  const kv = (rows) => '<dl class="kv">' + rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>';
  function explain(listCount) {
    const m = S.m, sc = m.sc, vpc = m.vpc, r0 = m.prim ? m.prim.reflection : null, el = $('explain'), stg = S.stage, rt = T.distanceToTime(sc.d, m.cfg.vp) * 1e9; let h = '';
    const story = '<p><i>' + sc.story + '</i></p>';
    if (stg === 0) h = '<h3>Send a fast edge down the wire</h3>' + story + '<p>The board fires a 5 V step with a 1 ns rise through a 120 Ω source. The source matches the harness, so 2.5 V travels down the wire and nothing bounces back from the board itself.</p><p>On this wire the edge moves at ' + (vpc * 100).toFixed(1) + ' cm per nanosecond, so each nanosecond of round-trip time is about ' + (vpc * 50).toFixed(0) + ' cm of wire.</p>' + kv([['Edge rise time', '1 ns'], ['Voltage on the wire', '2.50 V'], ['Speed on this wire', (vpc * 100).toFixed(1) + ' cm/ns'], ['Velocity factor', m.cfg.vp.toFixed(2)]]);
    else if (stg === 1) h = '<h3>Listen for the echoes</h3><p>Wherever the wire’s impedance changes, part of the edge reflects. An open sends it back with the same sign, a short sends it back upside down, and a partial change sends back a fraction.</p><p>The echo from this fault returns after 2 × ' + mft(sc.d, 2) + ' ÷ ' + (vpc * 100).toFixed(1) + ' cm/ns, which is ' + rt.toFixed(1) + ' ns.</p>' + kv([['Fault distance', mft(sc.d, 2) + ''], ['Echo arrives after', rt.toFixed(1) + ' ns'], ['Echo size', (sc.a >= 0 ? '+' : '') + sc.a.toFixed(2)], ['Meaning', sc.a > 0.8 ? 'open: full echo, same sign' : sc.a < -0.8 ? 'short: full echo, inverted' : sc.a < 0 ? 'partial leak to ground' : 'partial break, added resistance']]);
    else if (stg === 2) h = '<h3>Slow it down so a cheap scope can see it</h3><p>Nothing affordable can sample every 10 ps in real time. So the board sends the same pulse a million times a second and samples each echo 10 ps later than the one before.</p><p>After ' + m.cap.t.length.toLocaleString() + ' pulses it has rebuilt the whole ' + (m.cap.t[m.cap.t.length - 1] * 1e9).toFixed(0) + ' ns window, stretched 100,000 times. The 1 ns edge now lasts 100 µs, which a 25 MHz USB scope shows easily.</p>' + kv([['Pulse rate', '1 MHz'], ['Sample rate offset', '10 Hz'], ['Step per pulse', (T.etStepSeconds(1e6, 1e6 - 10) * 1e12).toFixed(0) + ' ps'], ['Stretch', Math.round(T.etScaleFactor(1e6, 1e6 - 10)).toLocaleString('en-US') + '×'], ['This window on the scope', (m.cap.t[m.cap.t.length - 1] * 1e8).toFixed(0) + ' ms']]);
    else if (stg === 3) {
      const a = m.an, items = ['Launch edge found at ' + (a.t0 * 1e9).toFixed(2) + ' ns. Everything before it is the baseline.', 'The incident step is ' + a.amp.toFixed(2) + ' V, so a full open would add the same again.', 'Divide by the step to get the reflection coefficient ρ, from −1 (short) to +1 (open).', 'The noise floor sets a threshold, so only steep edges count as echoes.']
        .concat(m.rows.map((r) => { const q = r.reflection; return '<b style="color:' + kcol(r.kind) + '">Echo at ' + mft(q.distance, 3) + '</b>, step ' + (q.delta >= 0 ? '+' : '') + q.delta.toFixed(2) + ': ' + (r.kind === 'feat' ? 'a minor feature, probably a connector or splice.' : r.kind === 'eol' ? 'the expected end of the line.' : T.kindLabel(q.kind)[0].toLowerCase() + '.'); }));
      h = '<h3>Turn the trace into a verdict</h3><ol style="padding-left:18px;margin:8px 0">' + items.slice(0, Math.min(items.length, listCount)).map((t) => '<li style="margin:6px 0">' + t + '</li>').join('') + '</ol>';
    } else {
      const c = m.prim ? m.prim.candidates : [];
      h = '<h3>Find it on the vehicle</h3><p>The distance is walked along the circuit’s wire route from the CAD. Where the circuit branches, every branch at that distance is marked, because the echo cannot say which one.</p>' + (r0 ? kv([['Measured distance', mft(r0.distance, 3) + ''], ['Simulated truth', mft(sc.d, 3) + ''], ['Error', (Math.abs(r0.distance - sc.d) * 100).toFixed(1) + ' cm'], ['Location', c.length ? c.map((q) => q.segment + ', ' + Math.round(q.intoMm) + ' mm in').join('; ') : 'not on this circuit'], ['Search zone', '±' + ctx.cfg().zone + ' mm']]) : '<p>No fault was found in this capture.</p>') + '<p class="hint">Use the buttons under the animation to open this result in Measure or in the 3D locator.</p>';
    }
    const key = stg + ':' + S.sc + ':' + listCount + ':' + ctx.cfg().zone + ':' + ctx.cfg().vp;
    if (el.dataset.k !== key) { el.innerHTML = h; el.dataset.k = key; }
  }

  /* ------------------------------------------------------------ chrome + loop */
  function renderChrome() {
    $('scen').innerHTML = SCEN.map((s, i) => '<button data-i="' + i + '" aria-pressed="' + (i === S.sc) + '"><b>' + s.name + '</b><span>' + s.sub + '</span></button>').join('');
    $('scen').querySelectorAll('button').forEach((b) => { b.onclick = () => { S.sc = +b.dataset.i; S.stage = 0; S.p = S.playing ? 0 : 1; build(S.sc); chrome(); frame(performance.now(), true); kick(); }; });
    chrome();
  }
  function chrome() {
    $('scen').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.i === S.sc)));
    $('pipe').innerHTML = STAGES.map((s, i) => '<button data-i="' + i + '" ' + (i === S.stage ? 'aria-current="step"' : '') + ' class="' + (i < S.stage ? 'done' : '') + '"><b>' + s[0] + '</b><span>' + s[1] + '</span></button>').join('');
    $('pipe').querySelectorAll('button').forEach((b) => { b.onclick = () => goStage(+b.dataset.i); });
    $('dPlay').textContent = S.playing ? 'Pause' : (S.stage === 4 && S.p >= 1 ? 'Replay' : 'Play');
    $('dPrev').disabled = S.stage === 0; $('dNext').disabled = S.stage === 4; $('explain').dataset.k = '';
  }
  function goStage(i) { S.stage = Math.max(0, Math.min(4, i)); S.p = S.playing ? 0 : 1; chrome(); frame(performance.now(), true); kick(); }
  function frame(now, once) {
    if (!once) raf = 0; if (!active) return;
    const dt = S.last ? Math.min(0.1, (now - S.last) / 1000) : 0; S.last = now;
    if (S.playing && !once) {
      S.p += dt * S.speed / DUR[S.stage];
      if (S.p >= 1) { if (S.stage < 4) { S.stage++; S.p = 0; chrome(); } else { S.p = 1; S.playing = false; chrome(); } }
    }
    const m = S.m, p = Math.min(1, S.p), rt = T.distanceToTime(m.sc.d, m.cfg.vp) * 1e9;
    if (S.stage === 0) { const τ = p * (rt / 2 + 3); drawWire(τ, false); scopeReveal(Math.min(5, τ)); explain(0); }
    else if (S.stage === 1) { const τ = p * m.tEnd; drawWire(τ, true); scopeReveal(τ); explain(0); }
    else if (S.stage === 2) { drawWire(m.tEnd, true); drawET(p); explain(0); }
    else if (S.stage === 3) { const total = 4 + m.rows.length, shown = Math.max(1, Math.min(total, Math.ceil(p * (total + 0.6)))); drawWire(m.tEnd, true); drawRho(Math.max(0, shown - 4)); explain(shown); }
    else { drawMap(); drawRho(m.rows.length); explain(0); }
    if ((S.playing || S.stage === 4) && !raf) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf && active) raf = requestAnimationFrame(frame); }

  root.TDRDemo = {
    init(c) {
      ctx = c; cvW = $('cvWire'); cvS = $('cvScope');
      $('dPlay').onclick = () => { if (S.playing) S.playing = false; else { if (S.stage === 4 && S.p >= 1) { S.stage = 0; S.p = 0; } S.playing = true; S.last = 0; } chrome(); kick(); };
      $('dNext').onclick = () => goStage(S.stage + 1); $('dPrev').onclick = () => goStage(S.stage - 1);
      $('dRestart').onclick = () => { S.stage = 0; S.p = 0; S.playing = true; S.last = 0; chrome(); kick(); };
      document.querySelectorAll('[data-speed]').forEach((b) => { b.onclick = () => { S.speed = +b.dataset.speed; document.querySelectorAll('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }; });
      $('dToMeasure').onclick = () => ctx.send(S.m.cap, S.m.sc.net, 'Demo: ' + S.m.sc.name, 'measure');
      $('dToCar').onclick = () => ctx.send(S.m.cap, S.m.sc.net, 'Demo: ' + S.m.sc.name, 'car');
      new ResizeObserver(() => { if (active) frame(performance.now(), true); }).observe($('tab-demo'));
      build(0); renderChrome();
    },
    onShow() {
      active = true; build(S.sc); S.last = 0;
      if (S.first) { S.first = false; if (!matchMedia('(prefers-reduced-motion:reduce)').matches) { S.playing = true; S.stage = 0; S.p = 0; } else { S.p = 1; } }
      chrome(); frame(performance.now(), true); kick();
    },
    onHide() { active = false; S.playing = false; cancelAnimationFrame(raf); raf = 0; chrome(); },
    redraw() { if (active) frame(performance.now(), true); },
    _goto(stage, p, sc) { active = true; S.first = false; if (sc != null) { S.sc = sc; } build(S.sc); S.stage = stage; S.p = p; S.playing = false; chrome(); frame(performance.now(), true); }
  };
})(window);

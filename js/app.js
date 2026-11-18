/* app.js - wires the device, analysis engine, scope chart, results, 3D locator and setup together. */
(function () {
  'use strict';
  const T = window.TDR, D = window.TDRDevice, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------------------------------------------------------- persistence (never required for the page to work) */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tdr.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tdr.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked: fine */ } }
  };
  const DEFAULTS = { vp: 0.66, z0: 120, rise: 1, minStep: 0.05, faultThr: 0.25, scale: 100000, zone: 75, proto: 'sweep', baud: 921600, avg: 4, interval: 100, cmd: 'MEASURE', valueMode: 'volts', bits: 12, vref: 3.3, dt: 1, timeUnit: 'auto', reanalyze: true };
  const saved = store.get('cfg', {}); if (saved && !saved.proto) { delete saved.baud; delete saved.cmd; delete saved.dt; }   // settings from before the binary-sweep protocol
  const S = { cfg: Object.assign({}, DEFAULTS, saved), harness: null, netName: null, net: null, raw: null, ref: null, cmp: null, label: '', result: null, dev: null, meshInfo: '', live: false, hist: [], log: [], calPending: false };
  const BUILD = '8';   // must match <meta name="tdr-build"> in index.html
  const SAMPLE = window.TDR_HARNESS;

  /* ---------------------------------------------------------------- small helpers */
  let toastT = 0;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200); }
  const engCfg = () => ({ z0: S.cfg.z0, vp: S.cfg.vp, riseTime: S.cfg.rise * 1e-9, minGamma: S.cfg.minStep });
  const save = () => store.set('cfg', S.cfg);
  const fmtZ = (z) => (z === Infinity || z == null || !isFinite(z) ? 'open' : Math.round(z) + ' Ω');
  function kindKey(row) {
    if (row.junction || row.lostEnd) return 'feat';
    if (row.endOfLine) return 'eol';
    const r = row.reflection; if (Math.abs(r.delta) < S.cfg.faultThr) return 'feat';
    const k = r.kind; return k.startsWith('OPEN') ? 'open' : k.startsWith('SHORT') ? 'short' : k.startsWith('RESISTIVE') ? 'res' : 'highz';
  }
  function titleOf(row) {
    const k = kindKey(row);
    if (row.junction) return ['Junction', 'The circuit splits in two at ' + row.junction + '. A split always reflects about a third of the pulse, so this is normal.'];
    if (row.lostEnd) return ['End echo gone', 'The normal reflection from the end of the wire at ' + row.lostEnd + ' is no longer there, because the signal is stopped by the fault before it.'];
    if (k === 'eol') return ['Expected end of line', 'The reflection from the far end of the circuit, where it should be.'];
    if (k === 'feat') return ['Minor feature', 'A small impedance change such as a connector, splice or bend. Normal in most harnesses.'];
    return T.kindLabel(row.reflection.kind);
  }
  const where = (c) => c.segment + ', ' + Math.round(c.intoMm) + ' mm along from ' + c.fromNode;

  /* ---------------------------------------------------------------- harness + circuit */
  function setHarness(h, keepNet) {
    T.validateHarness(h); S.harness = h;
    const sel = $('selNet'); sel.innerHTML = ''; Object.keys(h.nets).forEach((n) => { const o = document.createElement('option'); o.value = o.textContent = n; sel.appendChild(o); });
    const want = keepNet && h.nets[S.netName] ? S.netName : (h.nets[store.get('net', '')] ? store.get('net', '') : Object.keys(h.nets)[0]);
    selectNet(want); $('harnessText').value = JSON.stringify(h, null, 2);
  }
  function selectNet(name) {
    S.netName = name; S.net = T.buildNet(S.harness, name); $('selNet').value = name; store.set('net', name);
    $('chipNetName').textContent = name; if (viewer) viewer.setNet(S.net);
    const v = $('vDist'); v.max = Math.max(1, Math.floor(S.net.lengthM * 100) / 100).toString(); if (+v.value > +v.max) v.value = (+v.max * .6).toFixed(2); $('vDistVal').textContent = (+v.value).toFixed(2);
    refreshBranches();
    if (S.raw) analyze();
  }
  function refreshBranches() {
    const f = $('vBranchField'), sel = $('vBranch'); if (!f || !sel || !S.net) return;
    const leaves = Object.keys(S.net.leaves); sel.innerHTML = leaves.map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('');
    f.hidden = leaves.length < 2;
  }

  /* ---------------------------------------------------------------- analysis */
  function ingest(text, label, fixed) {
    if (!S.live) $('devErr').textContent = '';
    let p = null;
    try {
      p = D.parseCapture(text, { timeUnit: fixed ? 's' : S.cfg.timeUnit, valueMode: fixed ? 'volts' : S.cfg.valueMode, bits: S.cfg.bits, vref: S.cfg.vref, sampleInterval: S.cfg.dt * 1e-6 });
      S.raw = { t: p.t, v: p.v }; S.label = label; analyze(!S.live);
    } catch (e) { $('devErr').textContent = e.message; setCapturing(false); p = null; }
    // live view on a device that sends one capture per request: ask for the next one
    if (S.live && S.dev && !sweepSerial()) { clearTimeout(liveT); liveT = setTimeout(() => { if (S.live) capture(); }, 300); }
    return p;
  }
  function ingestSynthetic(c, label) {
    // A longer edge rise time in Setup needs more flat baseline before the launch edge than the simulated capture has, so add some.
    const dt = c.t[1] - c.t[0], pad = Math.max(0, Math.ceil((6 * S.cfg.rise * 1e-9) / dt) + 20 - Math.round(6e-9 / dt)), n = c.t.length;
    const t = new Float64Array(n + pad), v = new Float64Array(n + pad);
    for (let i = 0; i < n + pad; i++) { t[i] = i * dt * S.cfg.scale; v[i] = i < pad ? c.v[i % 150] : c.v[i - pad]; }
    S.raw = { t, v }; S.label = label; analyze(true);
  }

  /** Analyze one raw capture with the current settings and reference. */
  function runAnalysis(raw) {
    const cfg = engCfg(), t = Float64Array.from(raw.t, (x) => x / S.cfg.scale);
    let ref = null, tRef = null;
    if (S.ref) {
      tRef = Float64Array.from(S.ref.t, (x) => x / S.cfg.scale);
      // line the reference up on the launch edge, so a capture that starts a sample earlier or later still subtracts cleanly
      let shift = 0; try { shift = T.findLaunch(t, raw.v, cfg).t0 - T.findLaunch(tRef, S.ref.v, cfg).t0; } catch (e) { shift = 0; }
      ref = T.resample(t, Float64Array.from(tRef, (x) => x + shift), S.ref.v);
    }
    const a = T.findReflections(t, raw.v, cfg, ref);
    let echo = null;                                      // end-of-wire echoes now and in the reference, to tell branches apart
    if (S.ref && Object.keys(S.net.leaves).length > 1) {
      try { echo = { now: T.leafEchoes(T.findReflections(t, raw.v, cfg).reflections, S.net, S.cfg.zone), ref: T.leafEchoes(T.findReflections(tRef, S.ref.v, cfg).reflections, S.net, S.cfg.zone) }; } catch (e) { echo = null; }
    }
    return { a, t, v: raw.v, refV: ref, echo };
  }
  function makeRows(R) {
    const rows = T.localize(R.a.reflections, S.net, S.cfg.zone, engCfg()), tol = Math.max(S.cfg.zone, 100);
    rows.forEach((r) => {
      // with a reference subtracted, a negative step at a wire end means that end's normal echo has disappeared
      if (S.ref && r.reflection.delta < 0 && !r.junction) { const l = Object.keys(S.net.leaves).find((n) => Math.abs(r.reflection.distance * 1000 - S.net.leaves[n]) <= tol); if (l) { r.lostEnd = l; const own = r.candidates.filter((c) => c.segment === S.net.parent[l].seg); if (own.length) r.candidates = own; } }
      r.kind = kindKey(r);
      if (r.kind !== 'eol' && r.kind !== 'feat' && r.candidates.length > 1)
        r.branch = R.echo ? T.pickBranch(r.reflection.distance * 1000, r.candidates, S.net, R.echo.now, R.echo.ref, S.cfg.zone) : { reason: 'Capture a known-good reference of this circuit and the app can work out which branch it is.' };
      r.shown = r.branch && r.branch.segment ? r.candidates.filter((c) => c.segment === r.branch.segment) : r.candidates;
    });
    return rows;
  }

  function analyze(fresh) {
    if (!S.raw || !S.net) return;
    if (!S.live) $('devErr').textContent = '';
    try {
      const R = runAnalysis(S.raw); R.rows = makeRows(R); R.when = new Date(); S.result = R;
      renderAll(); setCapturing(false);
      if (fresh) { const f = R.rows.filter((r) => r.kind !== 'eol' && r.kind !== 'feat'); toast(f.length ? 'Fault found at ' + f[0].reflection.distance.toFixed(2) + ' m' : 'No fault found'); pushHistory(); }
      if (S.calPending) { S.calPending = false; doCal(); }
    } catch (e) {
      $('devErr').textContent = e.message; setCapturing(false);
      if (S.calPending) { S.calPending = false; $('calOut').textContent = 'The capture could not be analyzed: ' + e.message; }
    }
  }
  const primary = (rows) => rows.filter((r) => r.kind !== 'eol' && r.kind !== 'feat').sort((a, b) => a.reflection.distance - b.reflection.distance)[0];

  /* ---------------------------------------------------------------- rendering: scope, verdict, table, 3D */
  let chart = null;
  function renderScope() {
    const R = S.result; if (!R) return;
    const a = R.a, vp = S.cfg.vp, x = [], rho = [], volt = [], refv = []; const t = R.t;
    for (let i = 0; i < t.length; i++) { if (t[i] < a.t0) continue; x.push(T.timeToDistance(t[i] - a.t0, vp)); rho.push(a.rho[i]); volt.push(R.v[i]); if (R.refV) refv.push(R.refV[i]); }
    const xs = Float64Array.from(x); let dMax = Math.max(1, S.net.lengthM * 1.3);
    R.rows.forEach((r) => { dMax = Math.max(dMax, r.reflection.distance * 1.15 + .2); }); dMax = Math.min(dMax, xs[xs.length - 1] || dMax);
    chart.setVp(vp); chart.setBlind(T.timeToDistance(S.cfg.rise * 1e-9 * 3, vp));
    let cmpRho = null, cmpVolt = null;
    if (S.cmp) {
      try {
        const C = runAnalysis(S.cmp.raw), cx = [], cr = [], cv = [];
        for (let i = 0; i < C.t.length; i++) { if (C.t[i] < C.a.t0) continue; cx.push(T.timeToDistance(C.t[i] - C.a.t0, vp)); cr.push(C.a.rho[i]); cv.push(C.v[i]); }
        cmpRho = T.resample(xs, cx, cr); cmpVolt = T.resample(xs, cx, cv);
      } catch (e) { cmpRho = cmpVolt = null; }
    }
    chart.setData({ x: xs, rho: Float64Array.from(rho), volt: Float64Array.from(volt), refVolt: R.refV ? Float64Array.from(refv) : null, cmpRho, cmpVolt });
    chart.setDomain(0, dMax);
    chart.setEnds(Object.entries(S.net.leaves).map(([n, d]) => ({ x: d / 1000, label: n })));
    chart.setMarkers(R.rows.map((r) => ({ x: r.reflection.distance, kind: r.kind, primary: primary(R.rows) === r, label: r.reflection.distance.toFixed(2) + ' m' })));
    $('scopeEmpty').hidden = true;
  }
  function bandPoly(dMm) {
    const out = [], z = S.cfg.zone;
    for (const tv of S.net.trav) {
      const a = Math.max(tv.d0, dMm - z), b = Math.min(tv.d1, dMm + z); if (a >= b) continue;
      const pts = []; for (let k = 0; k <= 8; k++) { const c = S.net.locate(a + (b - a) * k / 8).find((q) => q.segment === tv.seg.id); if (c) pts.push(c.xyz); } if (pts.length > 1) out.push(pts);
    }
    return out;
  }
  function viewerFaults() {
    const out = [];
    (S.result ? S.result.rows : []).forEach((r, i) => (r.shown || r.candidates).forEach((c) => out.push({ xyz: c.xyz, group: i + 1, kind: r.kind, eol: r.kind === 'eol', band: r.kind === 'eol' || r.kind === 'feat' ? null : bandPoly(r.reflection.distance * 1000) })));
    return out;
  }
  function renderVerdict() {
    const R = S.result, v = $('verdict'); if (!R) return;
    const p = primary(R.rows);
    if (!p) {
      const minor = R.rows.filter((r) => r.kind === 'feat').length;
      v.className = 'verdict clean'; v.innerHTML = '<div><h3><span class="badge eol">Clear</span>No fault found on ' + esc(S.netName) + '</h3><p>' + (R.rows.some((r) => r.kind === 'eol') ? 'Only the expected reflection from the far end of the circuit was seen.' : 'No reflection above the reporting threshold.') +
        (minor ? ' ' + minor + ' minor feature' + (minor > 1 ? 's' : '') + ' (connectors or splices) listed below.' : '') + ' A fault closer than ' + T.timeToDistance(S.cfg.rise * 3e-9, S.cfg.vp).toFixed(2) + ' m to the test point is inside the blind zone and cannot be seen.</p></div>';
      return;
    }
    const r = p.reflection, [title, why] = titleOf(p), c = p.shown || p.candidates, br = p.branch;
    let loc;
    if (!c.length) loc = 'No point on ' + esc(S.netName) + ' is ' + r.distance.toFixed(2) + ' m from the test point. Check the circuit selection and the velocity factor.';
    else if (c.length === 1) loc = 'On wire segment <b>' + esc(c[0].segment) + '</b>, ' + Math.round(c[0].intoMm) + ' mm along from ' + esc(c[0].fromNode) + ' toward ' + esc(c[0].toNode) + '.<br>Vehicle position X ' + Math.round(c[0].xyz[0]) + ', Y ' + Math.round(c[0].xyz[1]) + ', Z ' + Math.round(c[0].xyz[2]) + ' mm. Search ±' + S.cfg.zone + ' mm along the wire.';
    if (br && br.segment && c.length === 1) loc = 'The circuit branches here. The fault is on the branch to <b>' + esc(br.leaves.join(', ')) + '</b>, because the echo from the end of that wire has disappeared while the other branch still shows its own.<br>' + loc + '<br><span class="ruled">Ruled out: ' + esc(br.others.join(', ')) + '.</span>';
    else if (c.length > 1) loc = 'The circuit branches here, so the fault could be on any of ' + c.length + ' wires: ' + c.map((q) => '<b>' + esc(q.segment) + '</b> (' + Math.round(q.intoMm) + ' mm past ' + esc(q.fromNode) + ')').join(', ') + '. Check each marked branch.' + (br && br.reason ? '<br><span class="ruled">' + esc(br.reason) + '</span>' : '');
    v.className = 'verdict';
    v.innerHTML = '<div class="readout">' + r.distance.toFixed(2) + '<small>m</small></div>' +
      '<div><h3><span class="badge ' + p.kind + '">' + esc(title) + '</span>from the test point</h3><p>' + esc(why) + ' Reflection step ' + (r.delta >= 0 ? '+' : '') + r.delta.toFixed(2) + ', impedance about ' + fmtZ(r.z) + '.</p><p class="where">' + loc + '</p></div>' +
      '<div class="acts"><button class="btn primary" id="vShow">Show on car</button><button class="btn" id="vCopy">Copy report</button><button class="btn" id="vSave">Save report</button><button class="btn" id="vPrint">Print report</button></div>';
    $('vShow').onclick = () => showOnCar(R.rows.indexOf(p) + 1); $('vCopy').onclick = copyReport; $('vSave').onclick = saveReport; $('vPrint').onclick = printReport;
  }
  function renderTable() {
    const R = S.result, w = $('tableWrap'); if (!R) return;
    if (!R.rows.length) { w.innerHTML = ''; return; }
    const lab = { open: 'Fault', short: 'Fault', res: 'Fault', highz: 'Fault', feat: 'Minor', eol: 'End of line' };
    w.innerHTML = '<table><thead><tr><th>#</th><th>Finding</th><th class="n">Distance</th><th class="n">Round trip</th><th class="n">Step</th><th class="n">Impedance</th><th>Location on circuit</th></tr></thead><tbody>' +
      R.rows.map((r, i) => { const q = r.reflection, [t] = titleOf(r); return '<tr class="pick" data-i="' + (i + 1) + '"><td class="num">' + (i + 1) + '</td><td><span class="badge ' + r.kind + '">' + esc(t) + '</span></td><td class="n">' + q.distance.toFixed(3) + ' m</td><td class="n">' + (q.t * 1e9).toFixed(1) + ' ns</td><td class="n">' + (q.delta >= 0 ? '+' : '') + q.delta.toFixed(2) + '</td><td class="n">' + fmtZ(q.z) + '</td><td>' + (r.candidates.length ? (r.shown || r.candidates).map((c) => esc(where(c))).join('<br>') + (r.branch && r.branch.segment ? '<br><span class="hint">ruled out: ' + esc(r.branch.others.join(', ')) + '</span>' : '') : '<span class="hint">not on this circuit</span>') + '</td></tr>'; }).join('') + '</tbody></table>';
    w.querySelectorAll('tr.pick').forEach((tr) => { tr.onclick = () => showOnCar(+tr.dataset.i); });
  }
  function renderLocList() {
    const R = S.result, el = $('locList'); if (!R || !R.rows.length) { el.innerHTML = '<p class="hint">' + (R ? 'No reflections to show.' : 'Take a measurement and the fault location is marked here.') + '</p>'; return; }
    el.innerHTML = R.rows.map((r, i) => { const q = r.reflection, [t] = titleOf(r); return '<div class="fitem ' + (r.kind === 'eol' ? 'eol' : r.kind === 'feat' ? 'feat' : '') + '" data-i="' + (i + 1) + '" style="' + (r.kind === 'eol' || r.kind === 'feat' ? '' : 'border-color:var(--' + r.kind + ')') + '"><b>#' + (i + 1) + ' ' + esc(t) + ', ' + q.distance.toFixed(2) + ' m</b><small>' + (r.candidates.length ? (r.shown || r.candidates).map((c) => esc(where(c)) + '<br>XYZ ' + c.xyz.map(Math.round).join(', ') + ' mm').join('<br>') : 'not on this circuit') + '</small></div>'; }).join('');
    el.querySelectorAll('.fitem').forEach((d) => { d.onclick = () => viewer && viewer.flyFault(+d.dataset.i); });
  }
  function renderAll() {
    renderScope(); renderVerdict(); renderTable(); renderLocList(); renderHist();
    if (viewer) viewer.setFaults(viewerFaults());
  }
  function showOnCar(group) { activate('locator'); if (viewer) setTimeout(() => viewer.flyFault(group), 60); }

  /* ---------------------------------------------------------------- report */
  function reportObj() {
    const R = S.result, p = primary(R.rows);
    return { generated: R.when.toISOString(), source: S.label, circuit: S.netName, velocityFactor: S.cfg.vp, timeStretch: S.cfg.scale, referenceUsed: !!S.ref,
      primaryFault: p ? { type: titleOf(p)[0], distanceM: +p.reflection.distance.toFixed(3), locations: (p.shown || p.candidates).map((c) => ({ segment: c.segment, mmAlong: Math.round(c.intoMm), xyzMm: c.xyz.map(Math.round) })) } : null,
      reflections: R.rows.map((r) => ({ finding: titleOf(r)[0], distanceM: +r.reflection.distance.toFixed(3), roundTripNs: +(r.reflection.t * 1e9).toFixed(2), step: +r.reflection.delta.toFixed(3), impedanceOhm: isFinite(r.reflection.z) ? Math.round(r.reflection.z) : null, locations: r.candidates.map((c) => ({ segment: c.segment, mmAlong: Math.round(c.intoMm), xyzMm: c.xyz.map(Math.round) })) })) };
  }
  function reportText() {
    const o = reportObj(), L = ['TDR fault report', 'Circuit: ' + o.circuit, 'Source: ' + (o.source || 'n/a'), 'Velocity factor: ' + o.velocityFactor, ''];
    if (o.primaryFault) { const f = o.primaryFault; L.push('Fault: ' + f.type + ' at ' + f.distanceM.toFixed(3) + ' m from the test point'); f.locations.forEach((l) => L.push('  ' + l.segment + ', ' + l.mmAlong + ' mm along, XYZ ' + l.xyzMm.join(', ') + ' mm')); } else L.push('No fault found.');
    L.push('', 'All reflections:'); o.reflections.forEach((r, i) => L.push((i + 1) + '. ' + r.finding + ', ' + r.distanceM.toFixed(3) + ' m, step ' + r.step)); return L.join('\n');
  }
  function copyReport() {
    const t = reportText();
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Report copied'), () => { const a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); toast('Report copied'); } catch (e) { toast('Could not copy. Use Save report instead.'); } a.remove(); });
  }
  function saveReport() {
    const b = new Blob([JSON.stringify(reportObj(), null, 2)], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = 'tdr-report-' + S.netName + '.json'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Report saved');
  }

  /* ---------------------------------------------------------------- history */
  let histId = 0;
  function pushHistory() {
    const R = S.result; if (!R || !S.raw) return; const p = primary(R.rows);
    S.hist.unshift({ id: ++histId, when: R.when, label: S.label || 'capture', net: S.netName, raw: { t: S.raw.t, v: S.raw.v }, kind: p ? p.kind : 'eol', text: p ? titleOf(p)[0] + ' at ' + p.reflection.distance.toFixed(2) + ' m' : 'No fault found' });
    if (S.hist.length > 12) { const gone = S.hist.pop(); if (S.cmp === gone) S.cmp = null; }
    renderHist();
  }
  function renderHist() {
    const card = $('histCard'), el = $('histList'); if (!card || !el) return;
    card.hidden = !S.hist.length;
    el.innerHTML = S.hist.map((h) => '<div class="hrow" data-id="' + h.id + '"><span class="num">' + h.when.toLocaleTimeString() + '</span><span class="badge ' + h.kind + '">' + esc(h.text) + '</span><span>' + esc(h.net) + '<small>' + esc(h.label) + '</small></span>' +
      '<span class="acts"><button class="btn" data-a="load">Show</button><button class="btn" data-a="cmp" aria-pressed="' + (S.cmp === h) + '">Compare</button><button class="btn" data-a="ref">Use as reference</button><button class="btn" data-a="del" aria-label="Remove">Remove</button></span></div>').join('');
    el.querySelectorAll('button').forEach((b) => { b.onclick = () => histAct(+b.closest('.hrow').dataset.id, b.dataset.a); });
  }
  function histAct(id, act) {
    const h = S.hist.find((x) => x.id === id); if (!h) return;
    if (act === 'load') { if (S.live) stopLive(); S.raw = h.raw; S.label = h.label; if (S.netName !== h.net && S.harness.nets[h.net]) selectNet(h.net); else analyze(); toast('Showing the capture from ' + h.when.toLocaleTimeString()); }
    else if (act === 'cmp') { S.cmp = S.cmp === h ? null : h; renderScope(); renderHist(); }
    else if (act === 'ref') { setRef(h.raw, h.label + ', ' + h.when.toLocaleTimeString()); }
    else if (act === 'del') { S.hist = S.hist.filter((x) => x !== h); if (S.cmp === h) { S.cmp = null; renderScope(); } renderHist(); }
  }

  /* ---------------------------------------------------------------- printed report (use the browser's "Save as PDF") */
  function planImage() {
    const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 620; const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    S.net.segments.forEach((sg) => sg.pts.forEach((q) => { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }));
    const pad = 90, k = Math.min((cv.width - 2 * pad) / Math.max(1, x1 - x0), (cv.height - 2 * pad) / Math.max(1, y1 - y0));
    const X = (x) => pad + (x - x0) * k + (cv.width - 2 * pad - (x1 - x0) * k) / 2, Y = (y) => cv.height - pad - (y - y0) * k - (cv.height - 2 * pad - (y1 - y0) * k) / 2;
    g.lineWidth = 5; g.lineJoin = g.lineCap = 'round'; g.strokeStyle = '#333';
    S.net.segments.forEach((sg) => { g.beginPath(); sg.pts.forEach((q, i) => (i ? g.lineTo(X(q[0]), Y(q[1])) : g.moveTo(X(q[0]), Y(q[1])))); g.stroke(); });
    g.font = '22px Arial'; g.fillStyle = '#000';
    Object.keys(S.net.nodeDist).forEach((n) => { const q = S.harness.nodes[n]; g.beginPath(); g.arc(X(q[0]), Y(q[1]), 7, 0, 7); g.fill(); g.fillText(n + (n === S.net.root ? ' (test point)' : ''), X(q[0]) + 12, Y(q[1]) - 12); });
    S.result.rows.forEach((r, i) => { if (r.kind === 'eol' || r.kind === 'feat') return; (r.shown || r.candidates).forEach((c) => {
      g.strokeStyle = '#d6342f'; g.lineWidth = 5; g.beginPath(); g.arc(X(c.xyz[0]), Y(c.xyz[1]), 18, 0, 7); g.stroke();
      g.fillStyle = '#d6342f'; g.font = 'bold 24px Arial'; g.fillText('#' + (i + 1) + '  ' + r.reflection.distance.toFixed(2) + ' m', X(c.xyz[0]) + 26, Y(c.xyz[1]) + 34); g.fillStyle = '#000'; g.font = '22px Arial'; }); });
    return cv.toDataURL('image/png');
  }
  function printReport() {
    const R = S.result; if (!R) return; const p = primary(R.rows), el = $('printReport');
    let scope = ''; try { scope = $('scope').toDataURL('image/png'); } catch (e) { scope = ''; }
    let plan = ''; try { plan = planImage(); } catch (e) { plan = ''; }
    const locs = (r) => (r.shown || r.candidates).map((c) => esc(where(c)) + ' (X ' + c.xyz.map(Math.round).join(', ') + ' mm)').join('<br>') || 'not on this circuit';
    el.innerHTML = '<h1>TDR fault report</h1><div class="meta">' + esc(R.when.toLocaleString()) + ' &middot; Circuit ' + esc(S.netName) + ' &middot; Source: ' + esc(S.label || 'n/a') + '</div>' +
      '<h2>Result</h2>' + (p ? '<div class="big">' + esc(titleOf(p)[0]) + ' at ' + p.reflection.distance.toFixed(2) + ' m from the test point</div><div>' + esc(titleOf(p)[1]) + '</div><div>' + locs(p) + '</div>' + (p.branch && p.branch.segment ? '<div>Branch identified from the missing end echo of ' + esc(p.branch.leaves.join(', ')) + '. Ruled out: ' + esc(p.branch.others.join(', ')) + '.</div>' : '') + '<div>Search &plusmn;' + S.cfg.zone + ' mm along the wire.</div>' : '<div class="big">No fault found</div>') +
      (scope ? '<h2>Reflection trace</h2><img src="' + scope + '" alt="Reflection trace">' : '') +
      (plan ? '<h2>Location on the circuit (top view)</h2><img src="' + plan + '" alt="Top view of the circuit with the fault marked">' : '') +
      '<h2>All reflections</h2><table><tr><th>#</th><th>Finding</th><th>Distance</th><th>Round trip</th><th>Step</th><th>Impedance</th><th>Location</th></tr>' +
      R.rows.map((r, i) => '<tr><td>' + (i + 1) + '</td><td>' + esc(titleOf(r)[0]) + '</td><td>' + r.reflection.distance.toFixed(3) + ' m</td><td>' + (r.reflection.t * 1e9).toFixed(1) + ' ns</td><td>' + (r.reflection.delta >= 0 ? '+' : '') + r.reflection.delta.toFixed(2) + '</td><td>' + fmtZ(r.reflection.z) + '</td><td>' + locs(r) + '</td></tr>').join('') + '</table>' +
      '<h2>Settings</h2><table><tr><th>Velocity factor</th><td>' + S.cfg.vp + '</td><th>Line impedance</th><td>' + S.cfg.z0 + ' &Omega;</td></tr><tr><th>Time stretch</th><td>' + S.cfg.scale + '</td><th>Edge rise time</th><td>' + S.cfg.rise + ' ns</td></tr><tr><th>Reference used</th><td>' + (S.ref ? esc(S.ref.name) : 'none') + '</td><th>Fault threshold</th><td>' + S.cfg.faultThr + '</td></tr></table>';
    const imgs = [...el.querySelectorAll('img')];
    Promise.all(imgs.map((im) => (im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; })))).then(() => window.print());
  }

  /* ---------------------------------------------------------------- board log */
  function log(msg, cls) { S.log.push({ t: new Date(), msg, cls: cls || '' }); if (S.log.length > 80) S.log.shift(); renderLog(); }
  function renderLog() {
    const el = $('devLog'); if (!el) return;
    if (S.log.length) el.innerHTML = S.log.slice().reverse().map((l) => '<div class="' + l.cls + '">' + l.t.toLocaleTimeString() + '  ' + esc(l.msg) + '</div>').join('');
    renderStats();
  }
  function renderStats() {
    const el = $('devStats'); if (!el) return;
    const st = S.dev && S.dev.type === 'serial' && S.dev.obj.stats ? S.dev.obj.stats() : null;
    el.textContent = st && (st.good || st.bad) ? '(' + st.used.toLocaleString() + ' of ' + st.good.toLocaleString() + ' sweeps used, ' + st.overruns + ' overruns, ' + st.dropped + ' dropped, ' + st.bad + ' checksum failures' + (st.skippedIds ? ', ' + st.skippedIds + ' lost' : '') + ')' : '';
  }

  /* ---------------------------------------------------------------- device */
  let liveT = 0;
  const sweepSerial = () => !!S.dev && S.dev.type === 'serial' && S.cfg.proto === 'sweep';
  const sweepOpts = () => ({ avg: S.cfg.avg, bits: S.cfg.bits, vref: S.cfg.vref, interval: S.cfg.interval * 1e-6 });
  function liveBtn() { const b = $('btnLive'); if (!b) return; b.textContent = S.live ? 'Stop live view' : 'Start live view'; b.classList.toggle('live', S.live); $('btnCapture').disabled = S.live; if (S.dev) $('devSub').textContent = S.live ? 'Live view is running. The trace and the result update continuously.' : (S.dev.type === 'virtual' ? 'Simulated board. Choose a fault, then capture.' : 'Ready. Press Capture to take a measurement.'); }
  async function toggleLive() {
    if (!S.dev) return; if (S.live) return stopLive();
    S.live = true; $('devErr').textContent = ''; liveBtn(); log('Live view started');
    if (sweepSerial()) { try { await S.dev.obj.startLive(sweepOpts()); } catch (e) { S.live = false; liveBtn(); $('devErr').textContent = e.message; } }
    else capture();
  }
  async function stopLive() {
    const was = S.live; S.live = false; clearTimeout(liveT); liveBtn(); setCapturing(false);
    if (S.dev && S.dev.type === 'serial' && S.dev.obj.stopLive) await S.dev.obj.stopLive();
    if (was) { log('Live view stopped'); if (S.result) pushHistory(); }
  }
  function setRef(raw, name) {
    S.ref = raw ? { t: raw.t, v: raw.v, name } : null;
    $('refState').textContent = S.ref ? 'Reference: ' + name + '. Normal reflections are subtracted.' : 'A reference trace from a healthy harness removes normal connector and splice reflections.';
    $('btnRef').textContent = S.ref ? 'Replace reference from a file' : 'Add known-good reference'; $('btnRefClear').hidden = !S.ref;
    analyze(); toast(S.ref ? 'Reference set' : 'Reference removed');
  }

  function setDevice(dev) {
    S.dev = dev; const on = !!dev;
    $('devState').classList.toggle('on', on); $('chipDev').classList.toggle('on', on);
    $('devName').textContent = on ? dev.name : 'Not connected';
    $('devSub').textContent = on ? (dev.type === 'virtual' ? 'Simulated board. Choose a fault, then capture.' : 'Ready. Press Capture to take a measurement.') : 'Connect the TDR board or load a scope file.';
    $('chipDev').lastElementChild.textContent = on ? dev.name : 'No device';
    $('btnConnect').hidden = on; $('btnVirtual').hidden = on; $('btnCapture').hidden = !on; $('btnDisconnect').hidden = !on; if ($('btnLive')) $('btnLive').hidden = !on; liveBtn(); refreshBranches(); $('virtBox').hidden = !(on && dev.type === 'virtual');
  }
  function setCapturing(b, n) { const btn = $('btnCapture'); if (S.live) { btn.disabled = true; btn.textContent = 'Capture'; return; } btn.disabled = !!b; btn.textContent = b ? 'Receiving' + (n ? ' ' + n.toLocaleString() + ' samples' : '') + '...' : 'Capture'; }
  async function connectSerial() {
    $('devErr').textContent = '';
    if (!D.serialSupported()) { $('devErr').textContent = 'This browser cannot open USB serial ports. Use Chrome or Edge, or open a scope CSV.'; return; }
    const obj = new D.SerialDevice({ onCapture: (t) => { ingest(t, obj.name, S.cfg.proto === 'sweep'); renderStats(); }, onProgress: (n) => setCapturing(true, n), onError: (m) => { $('devErr').textContent = m; setCapturing(false); log(m, 'bad'); if (S.calPending) { S.calPending = false; $('calOut').textContent = m; } }, onWarning: (m) => { $('devErr').textContent = m; log(m, 'warn'); }, onInfo: (m) => log(m), onLog: (l) => log('Board: ' + l, /^ERR/i.test(l) ? 'bad' : /^WARN/i.test(l) ? 'warn' : ''), onClosed: () => { if (S.dev && S.dev.obj === obj) { S.live = false; setDevice(null); log('The port closed (unplugged?)', 'bad'); } } });
    try { await obj.connect(S.cfg.baud, S.cfg.proto); setDevice({ type: 'serial', name: obj.name, obj }); log('Connected to ' + obj.name + ' at ' + S.cfg.baud + ' baud'); }
    catch (e) { $('devErr').textContent = e && e.name === 'NotFoundError' ? 'No device was selected.' : (e.message || String(e)); if (!(e && e.name === 'NotFoundError')) log($('devErr').textContent, 'bad'); }
  }
  function connectVirtual() { const obj = new D.VirtualDevice({ onCapture: (t) => { ingest(t, 'Virtual device'); }, onProgress: (n) => setCapturing(true, n) }); setDevice({ type: 'virtual', name: 'Virtual device', obj }); }
  async function disconnect() { const d = S.dev; if (S.live) await stopLive(); setDevice(null); setCapturing(false); if (d) log('Disconnected'); if (d) { if (d.type === 'serial') await d.obj.disconnect(); else d.obj.stop(); } }
  function capture() {
    if (!S.dev) return; if (!S.live) $('devErr').textContent = ''; setCapturing(true);
    if (S.dev.type === 'virtual') {
      const kind = $('vKind').value, leaves = Object.keys(S.net.leaves), leaf = S.net.leaves[$('vBranch').value] != null ? $('vBranch').value : leaves[0];
      const fault = kind === 'none' ? null : { kind, leaf, d: Math.min(+$('vDist').value, S.net.leaves[leaf] / 1000 - 0.05) };
      const c1 = S.net.trav[0].d1, isJ = S.net.junctions.some((j) => Math.abs(j.d - c1) < 1), isEnd = Object.values(S.net.leaves).some((d) => Math.abs(d - c1) < 1);
      S.dev.obj.capture({ vp: S.cfg.vp, scale: S.cfg.scale, rise: S.cfg.rise, noise: +$('vNoise').value || 0, events: T.simEvents(S.net, fault), connDist: $('vConn').checked && !isJ && !isEnd && (!fault || fault.d * 1000 > c1 + 150) ? c1 / 1000 : 0 });
    } else S.dev.obj.capture(S.cfg.cmd, S.cfg.proto === 'sweep' ? 20000 : 15000, sweepOpts()).catch((e) => { $('devErr').textContent = 'Could not send the capture command: ' + e.message; setCapturing(false); });
  }
  async function readFile(file) {
    try { return await file.text(); } catch (e) { $('devErr').textContent = 'Could not read ' + file.name + '.'; return null; }
  }
  async function openCsv(file) { const t = await readFile(file); if (t == null) return; const p = ingest(t, file.name); if (p) toast('Loaded ' + file.name + ' (' + p.n.toLocaleString() + ' samples)'); }
  async function openRef(file) {
    const t = await readFile(file); if (t == null) return;
    try {
      const p = D.parseCapture(t, { timeUnit: S.cfg.timeUnit, valueMode: S.cfg.valueMode, bits: S.cfg.bits, vref: S.cfg.vref, sampleInterval: S.cfg.dt * 1e-6 });
      setRef({ t: p.t, v: p.v }, file.name);
    } catch (e) { $('devErr').textContent = e.message; }
  }

  /* ---------------------------------------------------------------- tabs */
  let viewer = null;
  function activate(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    if (viewer) { name === 'locator' ? viewer.show() : viewer.hide(); }
    try { if (window.TDRDemo) { name === 'demo' ? window.TDRDemo.onShow() : window.TDRDemo.onHide(); } } catch (e) { if (window.console) console.error('TDR demo', e); }
    if (name === 'measure' && chart) chart.refresh();
    try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// may block this */ }
  }

  /* ---------------------------------------------------------------- setup bindings */
  const BIND = [['sVp', 'vp'], ['sZ0', 'z0'], ['sRise', 'rise'], ['sMin', 'minStep'], ['sFault', 'faultThr'], ['sScale', 'scale'], ['sZone', 'zone'], ['dProto', 'proto'], ['dBaud', 'baud'], ['dAvg', 'avg'], ['dInt', 'interval'], ['dCmd', 'cmd'], ['dVal', 'valueMode'], ['dBits', 'bits'], ['dVref', 'vref'], ['dDt', 'dt'], ['dUnit', 'timeUnit'], ['qVp', 'vp'], ['qScale', 'scale']];
  function syncInputs() {
    BIND.forEach(([id, k]) => { const el = $(id); if (el && document.activeElement !== el) el.value = S.cfg[k]; });
    $('sAdj').checked = !!S.cfg.reanalyze; $('oZone').value = S.cfg.zone; $('oZoneVal').textContent = S.cfg.zone;
    $('chipVpVal').textContent = (+S.cfg.vp).toFixed(3).replace(/0$/, '');
  }
  function bindSetup() {
    BIND.forEach(([id, k]) => {
      const el = $(id); if (!el) return; el.addEventListener('change', () => {
        let v = el.type === 'number' ? parseFloat(el.value) : el.value;
        if (el.type === 'number' && !isFinite(v)) { syncInputs(); return; }
        if (el.type === 'number' && el.min !== '' && v < +el.min) v = +el.min; if (el.type === 'number' && el.max !== '' && v > +el.max) v = +el.max;
        S.cfg[k] = v; save(); syncInputs(); if (S.cfg.reanalyze && S.raw) analyze(); else if (viewer) viewer.setFaults(viewerFaults());
      });
    });
    $('sAdj').addEventListener('change', (e) => { S.cfg.reanalyze = e.target.checked; save(); });
    $('oZone').addEventListener('input', (e) => { S.cfg.zone = +e.target.value; $('oZoneVal').textContent = S.cfg.zone; $('sZone').value = S.cfg.zone; if (S.result) { S.result.rows = makeRows(S.result); renderAll(); } });
    $('oZone').addEventListener('change', save);
    $('oOp').addEventListener('input', (e) => viewer && viewer.setOpacity(+e.target.value));
    $('oTh').addEventListener('input', (e) => viewer && viewer.setThickness(+e.target.value));
    $('oLb').addEventListener('change', (e) => viewer && viewer.setLabels(e.target.checked));
    $('btnCal').onclick = doCal;
    $('btnCalCap').onclick = () => {
      if (!S.dev) { $('calOut').textContent = 'Connect the board (or the virtual device) on the Measure tab first, or press "Use the last capture instead".'; return; }
      if (S.live) { doCal(); return; }
      S.calPending = true; $('calOut').textContent = 'Capturing...'; capture();
    };
    $('btnCalUndo').onclick = () => { if (S.calUndo == null) return; S.cfg.vp = S.calUndo; S.calUndo = null; save(); syncInputs(); $('calOut').textContent = 'Velocity factor put back to ' + S.cfg.vp + '.'; $('calSave').hidden = true; analyze(); };
    $('btnTypeSave').onclick = () => {
      const name = $('cName').value.trim(); if (!name) { $('cName').focus(); return; }
      const w = store.get('wires', []).filter((x) => x.name !== name); w.push({ name, vp: S.cfg.vp }); store.set('wires', w); renderWires(name); $('calSave').hidden = true; toast('Saved "' + name + '"');
    };
    $('cType').addEventListener('change', (e) => {
      const w = store.get('wires', []).find((x) => x.name === e.target.value); $('btnTypeDel').hidden = !w; if (!w) return;
      S.cfg.vp = w.vp; save(); syncInputs(); $('calOut').textContent = 'Velocity factor set to ' + w.vp + ' for ' + w.name + '.'; analyze();
    });
    $('btnTypeDel').onclick = () => { const n = $('cType').value; store.set('wires', store.get('wires', []).filter((x) => x.name !== n)); renderWires(''); };
    renderWires('');
    $('selNet').addEventListener('change', (e) => { try { selectNet(e.target.value); } catch (er) { toast(er.message); } });
    $('btnHarnessFile').onclick = () => $('fileHarness').click();
    $('fileHarness').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $('harnessText').value = await f.text(); applyHarness(); e.target.value = ''; };
    $('btnHarnessApply').onclick = applyHarness;
    $('btnHarnessReset').onclick = () => { try { setHarness(SAMPLE); store.set('harness', null); $('harnessErr').textContent = ''; toast('Example harness restored'); } catch (e) { $('harnessErr').textContent = e.message; } };
    $('btnMesh').onclick = () => $('fileMesh').click();
    $('fileMesh').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { const tri = TDRCar.parseSTL(await f.arrayBuffer()); setMesh(tri, f.name); toast('Loaded ' + f.name); } catch (er) { $('meshInfo').textContent = er.message; }
      e.target.value = '';
    };
    $('btnMeshReset').onclick = () => setMesh(TDRCar.placeholder(), null);
    $('btnMeshNone').onclick = () => { if (viewer) viewer.setMesh(null); $('meshInfo').textContent = 'Vehicle body hidden.'; $('meshNote').textContent = ''; };
  }
  function renderWires(pick) {
    const sel = $('cType'), w = store.get('wires', []);
    sel.innerHTML = '<option value="">Custom (velocity factor ' + S.cfg.vp + ')</option>' + w.map((x) => '<option value="' + esc(x.name) + '">' + esc(x.name) + ' (' + x.vp + ')</option>').join('');
    sel.value = pick || ''; $('btnTypeDel').hidden = !sel.value;
  }
  /** Work out the velocity factor from the open end of a wire of known length in the current capture. */
  function doCal() {
    const R = S.result, L = parseFloat($('cLen').value), out = $('calOut');
    if (!isFinite(L) || L <= 0) { out.textContent = 'Enter the length of the wire in metres.'; return; }
    if (!R) { out.textContent = 'Take a capture of the wire first.'; return; }
    const end = R.a.reflections.filter((r) => r.delta > 0.25).sort((a, b) => b.delta - a.delta)[0];   // strongest positive step = the open end
    if (!end) { out.textContent = 'No open-end reflection in the capture. Check that the far end of the wire is not connected to anything.'; return; }
    const old = S.cfg.vp, vp = T.calibrateVp(L, end.t);
    if (!(vp > 0.3 && vp < 1)) { out.textContent = 'That gives a velocity factor of ' + vp.toFixed(3) + ', which is not physical. Check the length and the time stretch.'; return; }
    S.calUndo = old; S.cfg.vp = +vp.toFixed(4); save(); syncInputs(); renderWires('');
    out.textContent = 'Velocity factor set to ' + S.cfg.vp + ' (was ' + old + '). The open end was seen ' + (end.t * 1e9).toFixed(2) + ' ns after the launch edge. Name it below to keep it as a wire type.';
    $('calSave').hidden = false; analyze();
  }
  function applyHarness() {
    const err = $('harnessErr'); err.textContent = '';
    try { const h = JSON.parse($('harnessText').value); setHarness(h, true); store.set('harness', h); toast('Harness applied'); }
    catch (e) { err.textContent = e instanceof SyntaxError ? 'The text is not valid JSON: ' + e.message : e.message; }
  }
  function setMesh(tri, name) {
    if (!viewer) return; viewer.setMesh(tri, TDRCar.bounds(tri));
    const n = (tri.length / 9).toLocaleString();
    $('meshInfo').textContent = name ? name + ': ' + n + ' triangles.' : 'Placeholder body (not to scale for any real vehicle).';
    $('meshNote').textContent = name ? '' : 'Showing a placeholder body. Load the vehicle STL in Setup.';
  }

  /* ---------------------------------------------------------------- demo hooks */
  const ctx = {
    T, store, toast, cfg: () => S.cfg, sample: () => SAMPLE, engCfg,
    /** Called by the demo: load a synthetic capture into Measure (or the 3D view). */
    send(capture, netName, label, to) {
      try { if (!S.harness.nets[netName]) setHarness(SAMPLE); } catch (e) { setHarness(SAMPLE); }
      if (S.netName !== netName) { S.netName = netName; S.net = T.buildNet(S.harness, netName); $('selNet').value = netName; $('chipNetName').textContent = netName; if (viewer) viewer.setNet(S.net); }
      ingestSynthetic(capture, label); activate(to === 'car' ? 'locator' : 'measure');
      if (to === 'car') { const p = S.result && primary(S.result.rows); if (viewer && p) setTimeout(() => viewer.flyFault(S.result.rows.indexOf(p) + 1), 80); }
    }
  };

  /* ---------------------------------------------------------------- start */
  /** Run one part of start-up. A failure in one part must not stop the tabs or the other parts from working. */
  const failed = [];
  function step(name, fn) { try { fn(); } catch (e) { failed.push(name + ': ' + (e && e.message ? e.message : e)); if (window.console) console.error('TDR start-up: ' + name, e); } }
  function banner(msg) { const b = document.createElement('div'); b.className = 'banner'; b.setAttribute('role', 'alert'); b.textContent = msg; document.body.insertBefore(b, document.body.firstChild); }

  function init() {
    // tabs first, so every tab opens even if something below fails
    step('tabs', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => { b.onclick = () => activate(b.dataset.tab); });
      document.querySelector('.tabs').addEventListener('keydown', (e) => { if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; const bs = [...document.querySelectorAll('.tab-btn')], i = bs.indexOf(document.activeElement); if (i < 0) return; const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]; n.focus(); activate(n.dataset.tab); });
    });
    step('theme', () => {
      $('themeBtn').onclick = () => {
        const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
        const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', nx); store.set('theme', nx); try { localStorage.setItem('tdr.theme', nx); } catch (e) { /* ignore */ }
        if (chart) chart.refresh(); if (viewer) viewer.kick(); if (window.TDRDemo) window.TDRDemo.redraw();
      };
    });
    step('trace chart', () => { chart = new TDRChart.ScopeChart($('scope')); });
    step('3D view', () => {
      try { viewer = TDRViewer.create($('gl'), $('lbls')); } catch (e) { viewer = null; }
      if (!viewer) { $('locator').insertAdjacentHTML('afterbegin', '<p class="hint" style="padding:24px">The 3D view needs WebGL2. Use a current Chrome, Edge or Firefox with hardware acceleration on.</p>'); }
    });
    step('harness', () => { const h = store.get('harness', null); try { setHarness(h || SAMPLE); } catch (e) { setHarness(SAMPLE); } if (viewer) setMesh(TDRCar.placeholder(), null); });
    step('settings', () => { syncInputs(); bindSetup(); });
    step('device controls', () => {
      $('btnConnect').onclick = connectSerial; $('btnVirtual').onclick = connectVirtual; $('btnDisconnect').onclick = disconnect; $('btnCapture').onclick = capture;
      $('btnLive').onclick = toggleLive;
      $('btnFirstRun').onclick = () => { if (!S.dev) connectVirtual(); capture(); };
      $('vDist').oninput = (e) => { $('vDistVal').textContent = (+e.target.value).toFixed(2); };
      $('btnCsv').onclick = () => $('fileCsv').click(); $('btnRef').onclick = () => $('fileRef').click();
      $('btnRefCap').onclick = () => { if (!S.raw) { toast('Take a capture first, then use it as the reference.'); return; } setRef(S.raw, (S.label || 'capture') + ', ' + new Date().toLocaleTimeString()); };
      $('btnRefClear').onclick = () => setRef(null);
      $('btnHistClear').onclick = () => { S.hist = []; if (S.cmp) { S.cmp = null; renderScope(); } renderHist(); };
      $('fileCsv').onchange = (e) => { if (e.target.files[0]) openCsv(e.target.files[0]); e.target.value = ''; };
      $('fileRef').onchange = (e) => { if (e.target.files[0]) openRef(e.target.files[0]); e.target.value = ''; };
      const drop = $('drop'); ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
      window.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) { activate('measure'); openCsv(f); } });
      $('mRho').onclick = () => { chart.setMode('rho'); $('mRho').setAttribute('aria-pressed', 'true'); $('mVolt').setAttribute('aria-pressed', 'false'); };
      $('mVolt').onclick = () => { chart.setMode('volt'); $('mVolt').setAttribute('aria-pressed', 'true'); $('mRho').setAttribute('aria-pressed', 'false'); };
      $('btnResetZoom').onclick = () => chart.resetView();
      setInterval(renderStats, 1000);
    });
    step('3D toolbar', () => {
      $('cFault').onclick = () => viewer && (viewer.flyFault() || toast('No fault to go to yet. Take a measurement first.'));
      $('cHarn').onclick = () => viewer && viewer.frame('wiring'); $('cCar').onclick = () => viewer && viewer.frame('car');
      $('cTop').onclick = () => viewer && viewer.preset('top'); $('cSide').onclick = () => viewer && viewer.preset('side');
    });
    step('demo', () => { if (window.TDRDemo) window.TDRDemo.init(ctx); });
    step('first tab', () => { const first = (location.hash || '').slice(1); activate(['measure', 'locator', 'demo', 'setup'].includes(first) ? first : 'measure'); });
    window.TDRApp = { S, ctx, activate, analyze, ingest, toggleLive, capture };
    const meta = document.querySelector('meta[name="tdr-build"]'), page = meta ? meta.content : 'older';
    if (page !== BUILD) banner('The files in this folder are from different versions (index.html is version ' + page + ', the scripts are version ' + BUILD + '). Unzip the whole tdr-ui.zip over this folder, then press Ctrl+F5.');
    else if (failed.length) banner('Part of the page did not start (' + failed.join('; ') + '). The rest of the page still works.');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

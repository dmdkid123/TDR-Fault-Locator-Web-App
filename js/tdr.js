/* tdr.js - TDR math, reflection analysis, harness geometry and a first-order simulator.
 * Plain script: exposes window.TDR in the browser and module.exports in Node (for tests).
 * A direct port of tdr_locator.py; keep the two in step. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TDR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const C0 = 299792458;

  /* ------------------------------------------------------------ math */
  const etScaleFactor = (fp, fs) => fp / (fp - fs);
  const etStepSeconds = (fp, fs) => (fp - fs) / (fp * fs);
  const timeToDistance = (t, vp) => vp * C0 * t / 2;
  const distanceToTime = (d, vp) => 2 * d / (vp * C0);
  const calibrateVp = (knownM, roundTripS) => (2 * knownM / roundTripS) / C0;
  const timingNeededFor = (resM, vp) => 2 * resM / (vp * C0);
  const minFeatureSpacing = (tr, vp) => vp * C0 * tr / 2;
  const gammaFromZ = (z, z0) => (isFinite(z) ? (z - z0) / (z + z0) : 1);
  const zFromGamma = (g, z0) => (g >= 0.999 ? Infinity : z0 * (1 + g) / (1 - g));

  function defaultConfig() {
    return { z0: 120, vp: 0.66, riseTime: 1e-9, minGamma: 0.05, deadZone: null,
             openGamma: 0.8, shortGamma: -0.8, vInc: null };
  }
  const deadZone = (cfg) => (cfg.deadZone != null ? cfg.deadZone : 3 * cfg.riseTime);

  /* ------------------------------------------------------------ numeric helpers */
  function pyRound(x) { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }
  function median(a) {
    const s = Float64Array.from(a).sort(); const n = s.length;
    if (!n) return NaN; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }
  function smooth(x, n) {
    n = Math.max(1, n | 0); if (n === 1) return Float64Array.from(x);
    const len = x.length, pad = n >> 1, p = new Float64Array(len + n - 1);
    p.fill(x[0], 0, pad); p.set(x, pad); p.fill(x[len - 1], pad + len);
    const out = new Float64Array(len); let s = 0;
    for (let i = 0; i < n; i++) s += p[i];
    out[0] = s / n;
    for (let i = 1; i < len; i++) { s += p[i + n - 1] - p[i - 1]; out[i] = s / n; }
    return out;
  }
  function gradient(y, dt) {
    const n = y.length, g = new Float64Array(n);
    g[0] = (y[1] - y[0]) / dt; g[n - 1] = (y[n - 1] - y[n - 2]) / dt;
    for (let i = 1; i < n - 1; i++) g[i] = (y[i + 1] - y[i - 1]) / (2 * dt);
    return g;
  }
  function interp(x, t, y) {              // np.interp for ascending t
    const n = t.length;
    if (x <= t[0]) return y[0]; if (x >= t[n - 1]) return y[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m; }
    return y[lo] + (y[hi] - y[lo]) * (x - t[lo]) / (t[hi] - t[lo]);
  }
  function resample(tNew, tOld, yOld) { const o = new Float64Array(tNew.length); for (let i = 0; i < o.length; i++) o[i] = interp(tNew[i], tOld, yOld); return o; }

  function findPeaks(slope, thr) {
    const out = [], n = slope.length; let i = 0;
    while (i < n) {
      if (Math.abs(slope[i]) > thr) {
        let j = i; const s = Math.sign(slope[i]);
        while (j + 1 < n && Math.abs(slope[j + 1]) > thr && Math.sign(slope[j + 1]) === s) j++;
        let best = i; for (let k = i; k <= j; k++) if (Math.abs(slope[k]) > Math.abs(slope[best])) best = k;
        out.push(best); i = j + 1;
      } else i++;
    }
    return out;
  }
  function suppress(peaks, slope, minSep) {
    const keep = [];
    peaks.slice().sort((a, b) => Math.abs(slope[b]) - Math.abs(slope[a])).forEach((k) => {
      if (keep.every((j) => Math.abs(k - j) > minSep)) keep.push(k);
    });
    return keep.sort((a, b) => a - b);
  }
  function winMean(t, y, lo, hi, floor) {
    let s = 0, c = 0;
    for (let i = 0; i < t.length; i++) { if (t[i] > hi) break; if (t[i] >= lo) { s += y[i]; c++; } }
    if (c >= 3) return s / c;
    return interp(Math.min(Math.max(0.5 * (lo + hi), floor), t[t.length - 1]), t, y);
  }

  /** Time at which y crosses `level`, nearest to sample k, by straight-line interpolation between samples.
   *  This is what gives timing finer than one sample. Falls back to t[k] when there is no crossing within w samples. */
  function crossing(t, y, k, level, w) {
    let best = null;
    for (let i = Math.max(0, k - w); i < Math.min(y.length - 1, k + w); i++) {
      const a = y[i] - level, b = y[i + 1] - level;
      if (a === 0 || a * b < 0) {
        const tc = t[i] + (a === b ? 0 : a / (a - b)) * (t[i + 1] - t[i]);
        if (best === null || Math.abs(tc - t[k]) < Math.abs(best - t[k])) best = tc;
      }
    }
    return best === null ? t[k] : best;
  }

  /** Finds the launch edge. -> {launch (sample index), t0 (s, sub-sample), base (V), amp (V), dt, vs} */
  function findLaunch(t, v, cfg) {
    cfg = Object.assign(defaultConfig(), cfg || {});
    if (!t || t.length < 50) throw new Error('The capture is too short to analyze. It needs at least 50 samples.');
    const dt = median(Float64Array.from({ length: t.length - 1 }, (_, i) => t[i + 1] - t[i]));
    if (!(dt > 0)) throw new Error('The time column must increase from sample to sample.');
    const tr = cfg.riseTime, nS = Math.max(1, pyRound(0.5 * tr / dt));
    const vs = smooth(v, nS), slope = gradient(vs, dt);
    let maxAbs = 0; for (let i = 0; i < slope.length; i++) maxAbs = Math.max(maxAbs, Math.abs(slope[i]));
    const launch = findPeaks(slope, 0.5 * maxAbs).find((k) => slope[k] > 0);
    if (launch === undefined) throw new Error('No launch edge found. Check the time stretch setting and the probe connection.');
    if (launch < 10 + Math.trunc(4 * tr / dt))
      throw new Error('The capture needs a few nanoseconds of flat baseline before the launch edge. Start the capture earlier or check the time stretch.');
    let t0 = t[launch];
    const base = median(v.slice(0, launch - Math.trunc(4 * tr / dt)));
    let amp;
    if (cfg.vInc != null) amp = cfg.vInc;
    else {
      let s = 0, c = 0;
      for (let i = 0; i < t.length; i++) if (t[i] >= t0 + 2 * tr && t[i] <= t0 + 4 * tr) { s += v[i]; c++; }
      amp = (c ? s / c : v[Math.min(v.length - 1, launch + 3)]) - base;
    }
    if (!(amp > 0)) throw new Error('Could not establish the incident step amplitude.');
    if (cfg.subsample !== false) t0 = crossing(t, vs, launch, base + amp / 2, Math.max(2, Math.ceil(1.5 * tr / dt)));
    return { launch, t0, base, amp, dt, nS };
  }

  /* ------------------------------------------------------------ classification */
  function classify(delta, cfg) {
    const z = delta < 0.999 ? zFromGamma(Math.min(Math.max(delta, -0.999), 0.999), cfg.z0) : Infinity;
    if (delta >= cfg.openGamma) return { kind: 'OPEN', z: Infinity };
    if (delta <= cfg.shortGamma) return { kind: 'SHORT', z };
    if (delta < 0) return { kind: 'RESISTIVE SHORT / LOW-Z SHUNT', z };
    return { kind: 'HIGH-Z / SERIES RESISTANCE (partial open, bad terminal)', z };
  }
  const KIND_LABELS = [
    ['OPEN', 'Open circuit', 'The wire is broken or a terminal has let go.'],
    ['SHORT', 'Short circuit', 'The wire is shorted to ground or to another wire.'],
    ['RESISTIVE', 'Resistive short', 'Partial leakage to ground, such as chafed insulation or moisture.'],
    ['HIGH-Z', 'High resistance', 'Partial open, such as a corroded or loose terminal, or a damaged splice.']
  ];
  /** -> [title, explanation] for a kind string returned by classify(). */
  function kindLabel(kind) {
    const k = KIND_LABELS.find((x) => kind.indexOf(x[0]) === 0);
    return k ? [k[1], k[2]] : [kind, ''];
  }

  /* ------------------------------------------------------------ analysis */
  /** t: real-time seconds (already un-stretched). v: volts at the launch node. refV: optional good trace on same t. */
  function findReflections(t, v, cfg, refV) {
    cfg = Object.assign(defaultConfig(), cfg || {});
    const L = findLaunch(t, v, cfg), t0 = L.t0, base = L.base, amp = L.amp, dt = L.dt, nS = L.nS, tr = cfg.riseTime;

    const rho = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) rho[i] = refV ? (v[i] - refV[i]) / amp : (v[i] - base) / amp - 1;
    const rhoS = smooth(rho, nS), sl = gradient(rhoS, dt);
    for (let i = 0; i < sl.length; i++) if (t[i] < t0 + deadZone(cfg) || t[i] > t[t.length - 1] - 2 * tr) sl[i] = 0;
    const med = median(sl);
    const noise = 1.4826 * median(sl.map((x) => Math.abs(x - med)));
    const thr = Math.max(0.5 * cfg.minGamma / tr, 6 * noise);
    const edges = suppress(findPeaks(sl, thr), sl, Math.trunc(1.5 * tr / dt));
    const times = edges.map((k) => t[k]);
    const reflections = [];
    edges.forEach((k, i) => {
      const te = times[i], prevT = i ? times[i - 1] : t0, nextT = i + 1 < times.length ? times[i + 1] : t[t.length - 1];
      const floor = t0 + 1.5 * tr;
      const before = winMean(t, rho, Math.max(te - 3 * tr, prevT + 1.5 * tr, floor), te - 1.5 * tr, floor);
      const after = winMean(t, rho, te + 1.5 * tr, Math.min(te + 3 * tr, nextT - 1.5 * tr), floor);
      const delta = after - before;
      if (Math.abs(delta) < cfg.minGamma) return;
      // sub-sample timing: where the edge crosses halfway between its 'before' and 'after' levels
      const tx = cfg.subsample !== false ? crossing(t, rhoS, k, 0.5 * (before + after), Math.max(2, Math.ceil(1.5 * tr / dt))) : te;
      const c = classify(delta, cfg), rt = tx - t0;
      reflections.push({ t: rt, distance: timeToDistance(rt, cfg.vp), delta, z: c.z, kind: c.kind });
    });
    const P = cfg.pulse === false ? { reflections, width: null } : dropPulseTails(reflections, cfg.pulse);
    return { t0, rho, reflections: P.reflections, pulseWidth: P.width, base, amp, noise, threshold: thr, dt };
  }

  /** Some launches are a NARROW PULSE (the real board's is about 6 ns) instead of a long step. The pulse's own falling
   *  edge then looks like a short right after the launch, and every echo of the pulse comes back with a trailing edge
   *  that looks like another fault. A short is recognised by what follows it: nothing comes back up. A pulse is
   *  recognised the other way round: a full-height drop within maxWidth of the launch, followed by a full-height rise.
   *  Then the first drop is the end of the launch pulse, and every edge that sits one pulse width after an opposite
   *  edge of similar size is the tail of that echo, so both are removed. Without that signature nothing is changed.
   *  o: { maxWidth (s, default 20 ns), minDelta (default 0.8), minRise (default 0.25) }. -> { reflections, width (s) or null } */
  function dropPulseTails(refl, o) {
    o = Object.assign({ maxWidth: 20e-9, minDelta: 0.8, minRise: 0.25 }, o && typeof o === 'object' ? o : {});
    const r = refl.slice().sort((a, b) => a.t - b.t);
    const f = r.find((x) => x.delta <= -o.minDelta);
    if (!f || f.t > o.maxWidth) return { reflections: refl, width: null };
    // The echo of a pulse comes back weaker on a long wire (cable loss), so the rise that proves "this was a pulse" only has to be
    // clearly there (minRise), not full height. Nothing at all comes back after a real short.
    if (!r.some((x) => x.t > f.t + 2e-9 && x.delta >= o.minRise)) return { reflections: refl, width: null };
    const w = f.t, drop = new Set([f]);
    for (const a of r) {
      if (drop.has(a) || Math.abs(a.delta) < o.minRise) continue;
      const tol = Math.max(2e-9, 0.5 * w, 0.04 * a.t);   // a long wire also stretches the echo, so allow more the later it arrives
      for (const b of r) {
        if (b === a || drop.has(b) || b.t <= a.t || Math.sign(b.delta) === Math.sign(a.delta)) continue;
        if (Math.abs(b.delta) >= 0.4 * Math.abs(a.delta) && Math.abs(b.t - a.t - w) <= tol) { drop.add(b); break; }
      }
    }
    return { reflections: r.filter((x) => !drop.has(x)), width: w };
  }

  /* ------------------------------------------------------------ harness / geometry */
  const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
  function polyLen(pts) { let s = 0; for (let i = 0; i < pts.length - 1; i++) s += vlen(vsub(pts[i + 1], pts[i])); return s; }

  class Net {
    constructor(name, root, segments) {
      this.name = name; this.root = root; this.segments = segments;
      const adj = {};
      segments.forEach((s) => { (adj[s.a] = adj[s.a] || []).push([s, true]); (adj[s.b] = adj[s.b] || []).push([s, false]); });
      this.nodeDist = { [root]: 0 }; this.trav = []; this.parent = {};
      const seen = new Set(), stack = [root];
      while (stack.length) {
        const n = stack.pop();
        for (const [seg, fwd] of adj[n] || []) {
          if (seen.has(seg.id)) continue; seen.add(seg.id);
          const m = fwd ? seg.b : seg.a;
          if (m in this.nodeDist) throw new Error('Circuit ' + name + ' has a loop at ' + m + '. A net must be a tree.');
          const d0 = this.nodeDist[n]; this.nodeDist[m] = d0 + seg.length; this.parent[m] = { node: n, seg: seg.id };
          this.trav.push({ seg, forward: fwd, d0, d1: d0 + seg.length }); stack.push(m);
        }
      }
      if (seen.size !== segments.length) throw new Error('Circuit ' + name + ': some segments are not connected to ' + root + '.');
      this.leaves = {};
      for (const n in this.nodeDist) if (n !== root && adj[n].length === 1) this.leaves[n] = this.nodeDist[n];
      // junctions: nodes where the wire splits into k >= 2 onward wires. Each one reflects (1-k)/(1+k) and passes 2/(k+1).
      this.junctions = [];
      for (const n in this.nodeDist) { const k = adj[n].length - (n === root ? 0 : 1); if (k >= 2) this.junctions.push({ node: n, d: this.nodeDist[n], k, rho: (1 - k) / (1 + k) }); }
      this.junctions.sort((a, b) => a.d - b.d);
    }
    /** Segment ids from the test point out to a node. */
    pathTo(node) { const out = []; let n = node; while (this.parent[n]) { out.unshift(this.parent[n].seg); n = this.parent[n].node; } return out; }
    /** Leaves that lie beyond a segment (the wire ends this segment feeds). */
    leavesBeyond(segId) { return Object.keys(this.leaves).filter((l) => this.pathTo(l).includes(segId)); }
    /** Round-trip amplitude factor for a reflection on a segment: every junction on the way costs (2/(k+1))^2. */
    pathFactor(segId) {
      const tv = this.trav.find((x) => x.seg.id === segId); if (!tv) return 1;
      let n = tv.forward ? tv.seg.a : tv.seg.b, f = 1;
      for (;;) { const j = this.junctions.find((q) => q.node === n); if (j) f *= Math.pow(2 / (j.k + 1), 2); if (!this.parent[n]) break; n = this.parent[n].node; }
      return f;
    }
    get lengthM() { return Math.max(0, ...Object.values(this.nodeDist)) / 1000; }
    locate(dMm) {
      const out = [];
      for (const tv of this.trav) {
        if (dMm < tv.d0 || dMm > tv.d1) continue;
        const pts = tv.forward ? tv.seg.pts : tv.seg.pts.slice().reverse();
        const cum = [0]; for (let i = 0; i < pts.length - 1; i++) cum.push(cum[i] + vlen(vsub(pts[i + 1], pts[i])));
        const f = Math.min(Math.max((dMm - tv.d0) / (tv.d1 - tv.d0), 0), 1) * cum[cum.length - 1];
        let i = 0; while (i < cum.length - 2 && cum[i + 1] < f) i++;
        const u = cum[i + 1] > cum[i] ? (f - cum[i]) / (cum[i + 1] - cum[i]) : 0;
        const xyz = [0, 1, 2].map((k) => pts[i][k] + (pts[i + 1][k] - pts[i][k]) * u);
        out.push({ segment: tv.seg.id, xyz, fromNode: tv.forward ? tv.seg.a : tv.seg.b, toNode: tv.forward ? tv.seg.b : tv.seg.a,
                   intoMm: dMm - tv.d0, color: tv.seg.color });
      }
      return out;
    }
  }

  /** harness JSON: {nodes:{name:[x,y,z]}, electrical_length_factor, nets:{NAME:{root, segments:[{id,from,to,via?,length_mm?,color?}]}}} */
  function buildNet(harness, netName) {
    const spec = harness.nets && harness.nets[netName];
    if (!spec) throw new Error('Circuit "' + netName + '" is not in the harness file.');
    const k = harness.electrical_length_factor != null ? harness.electrical_length_factor : 1;
    const segs = spec.segments.map((s) => {
      const a = harness.nodes[s.from], b = harness.nodes[s.to];
      if (!a) throw new Error('Unknown node "' + s.from + '" in segment ' + s.id + '.');
      if (!b) throw new Error('Unknown node "' + s.to + '" in segment ' + s.id + '.');
      const pts = [a].concat(s.via || [], [b]).map((p) => p.map(Number));
      return { id: s.id, a: s.from, b: s.to, pts, color: s.color, length: s.length_mm != null ? s.length_mm : polyLen(pts) * k };
    });
    return new Net(netName, spec.root, segs);
  }
  function validateHarness(h) {
    if (!h || typeof h !== 'object') throw new Error('The harness file must be a JSON object.');
    if (!h.nodes || !h.nets) throw new Error('The harness file needs "nodes" and "nets".');
    Object.keys(h.nets).forEach((n) => buildNet(h, n));
    return true;
  }
  /** Places each reflection on the circuit. Also:
   *  - recognizes the normal reflection of a junction (a split always reflects about -1/3), and
   *  - corrects the step size of anything past a junction for the signal lost there, then re-classifies it. */
  function localize(reflections, net, tolMm, cfg) {
    tolMm = tolMm == null ? 75 : tolMm; cfg = Object.assign(defaultConfig(), cfg || {});
    return reflections.map((r) => {
      const dMm = r.distance * 1000; let candidates = net.locate(dMm);
      // a reflection at (or a hair past) a wire end belongs to that end
      let leaf = null; for (const l in net.leaves) if (Math.abs(dMm - net.leaves[l]) <= tolMm && (leaf === null || Math.abs(dMm - net.leaves[l]) < Math.abs(dMm - net.leaves[leaf]))) leaf = l;
      if (leaf !== null && (r.delta > 0 || !candidates.length)) candidates = net.locate(net.leaves[leaf]).filter((c) => c.segment === net.parent[leaf].seg);
      const junction = r.delta < 0 ? (net.junctions || []).find((j) => {
        const up = net.parent[j.node] ? net.pathFactor(net.parent[j.node].seg) : 1, exp = j.rho * up;
        return Math.abs(dMm - j.d) <= Math.max(tolMm, 100) && r.delta <= 0.35 * exp && r.delta >= 1.7 * exp;
      }) : null;
      let refl = r;
      if (!junction && candidates.length) {
        // right at a junction the reflection may sit just before it, so use the loss up to the junction only
        const near = (net.junctions || []).find((j) => Math.abs(dMm - j.d) <= tolMm);
        const f = near ? (net.parent[near.node] ? net.pathFactor(net.parent[near.node].seg) : 1) : Math.min.apply(null, candidates.map((c) => net.pathFactor(c.segment)));
        if (f < 0.999) {
          const d = Math.max(-1, Math.min(1, r.delta / f)), c = classify(d, cfg);
          refl = Object.assign({}, r, { delta: d, rawDelta: r.delta, pathFactor: f, kind: c.kind, z: c.z });
        }
      }
      const eol = !junction && r.delta > 0 && Object.values(net.leaves).some((ld) => Math.abs(dMm - ld) <= tolMm);
      return { reflection: refl, endOfLine: eol, junction: junction ? junction.node : null, candidates };
    });
  }

  /** Size of the end-of-wire echo seen for each leaf: {leafName: step}. reflections are raw (no reference subtracted). */
  function leafEchoes(reflections, net, tolMm) {
    const out = {}, tol = Math.max(tolMm || 75, 100);
    for (const l in net.leaves) { out[l] = 0; reflections.forEach((r) => { if (r.delta > 0 && Math.abs(r.distance * 1000 - net.leaves[l]) <= tol) out[l] = Math.max(out[l], r.delta); }); }
    return out;
  }

  /** Which branch holds a fault at dMm? The branch whose end-of-wire echo has gone (compared with the healthy reference).
   *  -> {segment, leaves, loss, others} when one branch stands out, otherwise {reason}. */
  function pickBranch(dMm, candidates, net, echoNow, echoRef, tolMm) {
    tolMm = tolMm == null ? 75 : tolMm;
    const info = candidates.map((c) => {
      const leaves = net.leavesBeyond(c.segment).filter((l) => net.leaves[l] > dMm + tolMm && echoRef[l] >= 0.1);
      if (!leaves.length) return { c, loss: null, leaves };
      return { c, leaves, loss: leaves.reduce((s, l) => s + (1 - Math.min(1, echoNow[l] / echoRef[l])), 0) / leaves.length };
    });
    if (info.some((x) => x.loss === null)) return { reason: 'The reference shows no end-of-wire echo for one of the branches, so they cannot be told apart.' };
    const tol = Math.max(tolMm, 100), ends = info.map((x) => x.leaves.map((l) => net.leaves[l]));
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++)
      if (ends[i].some((a) => ends[j].some((b) => Math.abs(a - b) <= 2 * tol))) return { reason: 'These branches end at almost the same distance, so their end echoes overlap and cannot be told apart.' };
    const s = info.slice().sort((a, b) => b.loss - a.loss);
    if (s[0].loss >= 0.5 && s[0].loss - s[1].loss >= 0.3) return { segment: s[0].c.segment, leaves: s[0].leaves, loss: s[0].loss, others: s.slice(1).map((x) => x.c.segment) };
    return { reason: 'The end-of-wire echoes of the branches changed by a similar amount, so the branch could not be picked out.' };
  }

  /** Reflection list for the virtual device: junctions, wire ends and one optional fault, with the junction losses applied.
   *  fault: {kind, d (m), leaf} or null. Multiple bounces are not modelled. */
  function simEvents(net, fault) {
    const ev = [], path = fault ? net.pathTo(fault.leaf) : [], dF = fault ? fault.d * 1000 : Infinity;
    const a = fault ? FAULT_STEPS[fault.kind] : 0, pass = Math.abs(a) > 0.9 ? 0 : 1 - a * a;
    let fseg = null;
    if (fault) { const tv = net.trav.find((x) => path.includes(x.seg.id) && dF >= x.d0 && dF <= x.d1); fseg = tv ? tv.seg.id : path[path.length - 1]; }
    const behind = (node, d) => fault && d > dF && net.pathTo(node).includes(fseg);   // is this node past the fault?
    net.junctions.forEach((j) => { const up = net.parent[j.node] ? net.pathFactor(net.parent[j.node].seg) : 1, k = behind(j.node, j.d) ? pass : 1; if (k) ev.push({ d: j.d / 1000, a: j.rho * up * k }); });
    for (const l in net.leaves) { const k = behind(l, net.leaves[l]) ? pass : 1; if (k) ev.push({ d: net.leaves[l] / 1000, a: 0.97 * net.pathFactor(net.parent[l].seg) * k }); }
    if (fault) ev.push({ d: fault.d, a: a * net.pathFactor(fseg) });
    return ev.sort((x, y) => x.d - y.d);
  }

  /* ------------------------------------------------------------ simulator */
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gauss(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }
  function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
  const edgeStep = (t, te, tr) => 0.5 * (1 + erf((t - te) / ((tr / 2.563) * Math.SQRT2)));

  /** events: [{d: metres, a: reflection step}]. Returns {t, v} in real time. */
  function synthCapture(events, cfg, o) {
    cfg = Object.assign(defaultConfig(), cfg || {}); o = o || {};
    const vStep = o.vStep != null ? o.vStep : 5, span = o.span || 70e-9, dt = o.dt || 10e-12,
          tLaunch = o.tLaunch || 8e-9, noise = o.noise != null ? o.noise : 0.004, rng = mulberry32(o.seed || 1);
    const n = Math.ceil(span / dt), t = new Float64Array(n), v = new Float64Array(n), inc = vStep / 2;
    const ev = events.map((e) => [tLaunch + distanceToTime(e.d, o.vpTrue || cfg.vp), e.a]);
    for (let i = 0; i < n; i++) {
      t[i] = i * dt; let x = inc * edgeStep(t[i], tLaunch, cfg.riseTime);
      for (const [te, a] of ev) x += inc * a * edgeStep(t[i], te, cfg.riseTime);
      v[i] = x + (noise ? noise * gauss(rng) : 0);
    }
    return { t, v };
  }
  const FAULT_STEPS = { open: 0.97, short: -0.97, resistive: -0.5, highz: 0.3 };

  return { C0, defaultConfig, etScaleFactor, etStepSeconds, timeToDistance, distanceToTime, calibrateVp, timingNeededFor,
           minFeatureSpacing, gammaFromZ, zFromGamma, classify, kindLabel, findReflections, Net, buildNet, validateHarness,
           localize, leafEchoes, pickBranch, simEvents, findLaunch, crossing, dropPulseTails, synthCapture, FAULT_STEPS, interp, resample, median, smooth, mulberry32 };
});

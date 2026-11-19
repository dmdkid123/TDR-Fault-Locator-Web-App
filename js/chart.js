/* chart.js - scope-style trace display. Plain script, exposes window.TDRChart. */
(function (root) {
  'use strict';
  const mft = (m, d) => { d = d == null ? 2 : d; return (+m).toFixed(d) + ' m (' + (m / 0.3048).toFixed(d >= 3 ? 2 : 1) + ' ft)'; };   // every distance shown in metres AND feet

  const C0 = 299792458;

  function niceStep(span, target) {
    const raw = span / Math.max(1, target), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }
  function ticks(min, max, target) {
    const s = niceStep(max - min, target), out = [];
    for (let v = Math.ceil(min / s - 1e-9) * s; v <= max + s * 1e-9; v += s) out.push(+v.toFixed(10));
    return { step: s, list: out };
  }
  function fmt(v, step) { const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)); return v.toFixed(Math.min(d, 4)); }
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  const KIND_VAR = { open: '--open', short: '--short', res: '--res', highz: '--highz', feat: '--feat', eol: '--eol' };

  class ScopeChart {
    constructor(canvas) {
      this.cv = canvas; this.g = canvas.getContext('2d');
      this.data = null; this.markers = []; this.ends = []; this.blind = 0; this.vp = 0.66;
      this.mode = 'rho'; this.dom = [0, 5]; this.view = [0, 5]; this.hover = null; this._raf = 0; this.drag = null;
      new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
      canvas.addEventListener('pointermove', (e) => this._move(e));
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
      canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); this.drag = { x: e.clientX, v: this.view.slice() }; });
      canvas.addEventListener('pointerup', () => { this.drag = null; });
      canvas.addEventListener('wheel', (e) => { e.preventDefault(); this._zoom(e); }, { passive: false });
      canvas.addEventListener('dblclick', () => this.resetView());
    }
    setData(d) { this.data = d; this.draw(); }
    setDomain(a, b) { this.dom = [a, b]; this.view = [a, b]; this.draw(); }
    setMarkers(m) { this.markers = m || []; this.draw(); }
    setEnds(e) { this.ends = e || []; this.draw(); }
    setBlind(x) { this.blind = x || 0; this.draw(); }
    setVp(v) { this.vp = v; this.draw(); }
    setMode(m) { this.mode = m; this.draw(); }
    resetView() { this.view = this.dom.slice(); this.draw(); }
    refresh() { this.draw(); }

    _plot() { const w = this.cv.clientWidth, h = this.cv.clientHeight; return { w, h, l: 54, r: 16, t: 32, b: 36 }; }
    _xOf(x, P) { return P.l + (x - this.view[0]) / (this.view[1] - this.view[0]) * (P.w - P.l - P.r); }
    _xInv(px, P) { return this.view[0] + (px - P.l) / (P.w - P.l - P.r) * (this.view[1] - this.view[0]); }
    _move(e) {
      const P = this._plot(), r = this.cv.getBoundingClientRect(), px = e.clientX - r.left;
      if (this.drag) {
        const span = this.drag.v[1] - this.drag.v[0], dx = (e.clientX - this.drag.x) / (P.w - P.l - P.r) * span;
        this._setView(this.drag.v[0] - dx, this.drag.v[1] - dx);
      }
      this.hover = px >= P.l && px <= P.w - P.r ? this._xInv(px, P) : null; this.draw();
    }
    _setView(a, b) {
      const span = b - a, full = this.dom[1] - this.dom[0];
      if (span > full) { a = this.dom[0]; b = this.dom[1]; }
      else { if (a < this.dom[0]) { b += this.dom[0] - a; a = this.dom[0]; } if (b > this.dom[1]) { a -= b - this.dom[1]; b = this.dom[1]; } }
      this.view = [a, b];
    }
    _zoom(e) {
      const P = this._plot(), r = this.cv.getBoundingClientRect(), x = this._xInv(e.clientX - r.left, P), k = Math.exp(e.deltaY * 0.0015);
      const a = x - (x - this.view[0]) * k, b = x + (this.view[1] - x) * k;
      if (b - a < 0.03) return; this._setView(a, b); this.draw();
    }
    draw() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); }); }

    _paint() {
      const cv = this.cv, g = this.g, dpr = devicePixelRatio || 1, P = this._plot();
      if (!P.w || !P.h) return;
      if (cv.width !== P.w * dpr || cv.height !== P.h * dpr) { cv.width = P.w * dpr; cv.height = P.h * dpr; }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const col = (n) => cssVar(n), scopeInk = col('--scope-ink'), grat = col('--grat'), grat2 = col('--grat2');
      g.fillStyle = col('--scope'); g.fillRect(0, 0, P.w, P.h);
      const pw = P.w - P.l - P.r, ph = P.h - P.t - P.b, [x0, x1] = this.view;

      // y range
      let y0 = -1.2, y1 = 1.2;
      const D = this.data, ys = D ? (this.mode === 'rho' ? D.rho : D.volt) : null;
      let i0 = 0, i1 = 0;
      if (D) {
        i0 = Math.max(0, lowerBound(D.x, x0) - 1); i1 = Math.min(D.x.length, lowerBound(D.x, x1) + 1);
        if (this.mode === 'volt') {
          let mn = Infinity, mx = -Infinity; for (let i = i0; i < i1; i++) { if (ys[i] < mn) mn = ys[i]; if (ys[i] > mx) mx = ys[i]; }
          if (!isFinite(mn)) { mn = 0; mx = 5; } const pad = (mx - mn) * 0.12 || 0.5; y0 = Math.min(0, mn - pad); y1 = mx + pad;
        } else if (D.rho) {
          let mn = Infinity, mx = -Infinity; for (let i = i0; i < i1; i++) { if (ys[i] < mn) mn = ys[i]; if (ys[i] > mx) mx = ys[i]; }
          if (mx > 1.2) y1 = mx + 0.1; if (mn < -1.2) y0 = mn - 0.1;
        }
      }
      const Y = (v) => P.t + (1 - (v - y0) / (y1 - y0)) * ph, X = (x) => this._xOf(x, P);

      // graticule
      const tx = ticks(x0, x1, Math.max(4, pw / 90)), ty = ticks(y0, y1, Math.max(4, ph / 48));
      g.lineWidth = 1; g.font = '11.5px ' + cssVar('--font-ui');
      g.strokeStyle = grat; g.beginPath();
      for (const v of tx.list) { const px = Math.round(X(v)) + .5; g.moveTo(px, P.t); g.lineTo(px, P.t + ph); }
      for (const v of ty.list) { const py = Math.round(Y(v)) + .5; g.moveTo(P.l, py); g.lineTo(P.l + pw, py); }
      g.stroke();
      if (y0 < 0 && y1 > 0) { g.strokeStyle = grat2; g.beginPath(); const py = Math.round(Y(0)) + .5; g.moveTo(P.l, py); g.lineTo(P.l + pw, py); g.stroke(); }
      g.strokeStyle = grat2; g.strokeRect(P.l + .5, P.t + .5, pw, ph);

      g.save(); g.beginPath(); g.rect(P.l, P.t, pw, ph); g.clip();

      // blind zone
      if (this.blind > x0) {
        const bx = Math.min(X(this.blind), P.l + pw);
        g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(P.l, P.t, bx - P.l, ph);
        g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.beginPath();
        for (let k = -ph; k < bx - P.l; k += 10) { g.moveTo(P.l + k, P.t + ph); g.lineTo(P.l + k + ph, P.t); } g.stroke();
      }
      // expected ends
      for (const e of this.ends) {
        const px = X(e.x); if (px < P.l - 2 || px > P.l + pw + 2) continue;
        g.strokeStyle = col('--eol'); g.setLineDash([2, 4]); g.globalAlpha = .7; g.beginPath(); g.moveTo(px, P.t); g.lineTo(px, P.t + ph); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      }

      // traces
      const plot = (arr, color, w, glow) => {
        if (!arr) return; g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round';
        if (glow) { g.shadowColor = color; g.shadowBlur = 6; }
        g.beginPath();
        const n = i1 - i0;
        if (n <= pw * 2) { for (let i = i0; i < i1; i++) { const px = X(D.x[i]), py = Y(arr[i]); i === i0 ? g.moveTo(px, py) : g.lineTo(px, py); } }
        else {
          const per = n / pw; for (let c = 0; c < pw; c++) {
            const a = i0 + Math.floor(c * per), b = Math.min(i1, i0 + Math.floor((c + 1) * per) + 1); let mn = Infinity, mx = -Infinity;
            for (let i = a; i < b; i++) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i]; }
            const px = P.l + c + .5; c ? g.lineTo(px, Y(mn)) : g.moveTo(px, Y(mn)); g.lineTo(px, Y(mx));
          }
        }
        g.stroke(); g.shadowBlur = 0;
      };
      if (D) {
        const rs = this.mode === 'rho' ? D.refRho : D.refVolt; if (rs) { const keep = ys; plot(rs, col('--ref'), 1.4, false); }
        const cs = this.mode === 'rho' ? D.cmpRho : D.cmpVolt; if (cs) plot(cs, col('--cmp'), 1.4, false);
        plot(ys, col('--trace'), 1.8, true);
      }
      g.restore();

      // markers
      const flagY = [P.t + 6, P.t + 26, P.t + 46]; let slot = 0; const placed = [];
      for (const m of this.markers) {
        const px = X(m.x); if (px < P.l - 2 || px > P.l + pw + 2) continue;
        const c = col(KIND_VAR[m.kind] || '--feat');
        g.strokeStyle = c; g.lineWidth = m.primary ? 2 : 1.2; g.setLineDash(m.primary ? [] : [6, 4]);
        g.beginPath(); g.moveTo(px, P.t); g.lineTo(px, P.t + ph); g.stroke(); g.setLineDash([]);
        const text = m.label || mft(m.x, 2) + ''; g.font = '600 12px ' + cssVar('--font-ui');
        const tw = g.measureText(text).width + 14; let fx = px + 6; if (fx + tw > P.l + pw) fx = px - 6 - tw;
        let row = 0; while (placed.some((p) => p.row === row && fx < p.x1 && fx + tw > p.x0) && row < 5) row++;
        placed.push({ row, x0: fx, x1: fx + tw }); const fy = P.t + 6 + row * 22;
        g.fillStyle = c; roundRect(g, fx, fy, tw, 19, 4); g.fill();
        g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, fx + 7, fy + 10);
      }

      // axes labels
      g.fillStyle = scopeInk; g.textBaseline = 'alphabetic'; g.font = '11.5px ' + cssVar('--font-ui'); g.textAlign = 'center';
      for (const v of tx.list) g.fillText(fmt(v, tx.step), X(v), P.t + ph + 16);
      g.fillText('distance from test point (m)', P.l + pw / 2, P.h - 6);
      g.textAlign = 'right'; for (const v of ty.list) g.fillText(fmt(v, ty.step), P.l - 7, Y(v) + 4);
      g.save(); g.translate(13, P.t + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center';
      g.fillText(this.mode === 'rho' ? 'reflection coefficient' : 'volts at the test point', 0, 0); g.restore();
      // round-trip ns on the top
      const k = 2 / (this.vp * C0) * 1e9, n0 = x0 * k, n1 = x1 * k, tn = ticks(n0, n1, Math.max(3, pw / 120));
      g.textAlign = 'center'; g.fillStyle = col('--feat'); g.font = '10.5px ' + cssVar('--font-ui');
      for (const v of tn.list) { const px = X(v / k); if (px > P.l + 18 && px < P.l + pw - 18) { g.fillText(fmt(v, tn.step), px, P.t - 17); g.fillRect(Math.round(px), P.t - 12, 1, 5); } }
      g.textAlign = 'left'; g.fillText('round trip (ns)', P.l, P.t - 17 - 9 < 0 ? 10 : P.t - 17 - 9 + 4);

      // hover
      if (this.hover != null && D) {
        const px = X(this.hover), i = Math.min(D.x.length - 1, Math.max(0, lowerBound(D.x, this.hover)));
        g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(Math.round(px) + .5, P.t); g.lineTo(Math.round(px) + .5, P.t + ph); g.stroke();
        const dm = D.x[i], ns = dm * k, v = ys[i], txt = [mft(dm, 3) + '', ns.toFixed(2) + ' ns', (this.mode === 'rho' ? (v >= 0 ? '+' : '') + v.toFixed(3) : v.toFixed(3) + ' V')];
        g.font = '12px ' + cssVar('--font-mono'); const bw = Math.max(...txt.map((s) => g.measureText(s).width)) + 16, bh = 56;
        let bx = px + 12; if (bx + bw > P.l + pw) bx = px - 12 - bw; const by = P.t + ph - bh - 8;
        g.fillStyle = 'rgba(10,15,20,.92)'; g.strokeStyle = grat2; roundRect(g, bx, by, bw, bh, 5); g.fill(); g.stroke();
        g.fillStyle = scopeInk; g.textAlign = 'left'; g.textBaseline = 'middle'; txt.forEach((s, j) => g.fillText(s, bx + 8, by + 13 + j * 15));
        g.fillStyle = col('--trace'); g.beginPath(); g.arc(px, Y(v), 3.5, 0, 7); g.fill();
      }
    }
  }
  root.TDRChart = { ScopeChart, niceTicks: ticks, niceStep, fmt, cssVar, roundRect, lowerBound };
})(window);

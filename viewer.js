/* viewer.js - dependency-free WebGL2 viewer: wires as tubes, translucent vehicle body, fault markers and search zones.
 * Z is up. Exposes window.TDRViewer.create(canvas, labelEl). */
(function (root) {
  'use strict';
  const FAULT_RGB = { open: [.91, .45, .12], short: [.84, .20, .18], res: [.55, .31, .85], highz: [.11, .46, .79], feat: [.42, .47, .52], eol: [.12, .60, .33] };
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); if (!m) return [.2, .4, .7]; const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
  function mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(f, a, n, fr) { const t = 1 / Math.tan(f / 2), o = new Float32Array(16); o[0] = t / a; o[5] = t; o[10] = (fr + n) / (n - fr); o[11] = -1; o[14] = 2 * fr * n / (n - fr); return o; }
  function look(e, c, u) { const z = norm(sub(e, c)), x = norm(cross(u, z)), y = cross(z, x); return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]); }

  function sphereVerts(r, sl, st) {
    const v = [], pt = (a, b) => [r * Math.sin(b) * Math.cos(a), r * Math.sin(b) * Math.sin(a), r * Math.cos(b)];
    for (let i = 0; i < sl; i++) for (let j = 0; j < st; j++) {
      const a0 = 2 * Math.PI * i / sl, a1 = 2 * Math.PI * (i + 1) / sl, b0 = Math.PI * j / st, b1 = Math.PI * (j + 1) / st;
      v.push(...pt(a0, b0), ...pt(a1, b0), ...pt(a1, b1), ...pt(a0, b0), ...pt(a1, b1), ...pt(a0, b1));
    }
    return new Float32Array(v);
  }
  function tubeVerts(polys, rad) {
    const v = [], N = 8;
    for (const pts of polys) for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], len = Math.hypot(...sub(b, a)); if (len < 1e-6) continue;
      const d = norm(sub(b, a)), u = Math.abs(d[2]) < .9 ? [0, 0, 1] : [1, 0, 0], e1 = norm(cross(d, u)), e2 = cross(d, e1);
      const ring = (c, k) => [c[0] + rad * (Math.cos(k) * e1[0] + Math.sin(k) * e2[0]), c[1] + rad * (Math.cos(k) * e1[1] + Math.sin(k) * e2[1]), c[2] + rad * (Math.cos(k) * e1[2] + Math.sin(k) * e2[2])];
      for (let k = 0; k < N; k++) { const k0 = 2 * Math.PI * k / N, k1 = 2 * Math.PI * (k + 1) / N; v.push(...ring(a, k0), ...ring(b, k0), ...ring(b, k1), ...ring(a, k0), ...ring(b, k1), ...ring(a, k1)); }
    }
    return new Float32Array(v);
  }

  function create(canvas, labelEl) {
    const gl = canvas.getContext('webgl2', { antialias: true });
    if (!gl) return null;
    function prog(vs, fs) {
      const p = gl.createProgram();
      for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const h = gl.createShader(t); gl.shaderSource(h, s); gl.compileShader(h); if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(h)); gl.attachShader(p, h); }
      gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p); return p;
    }
    const PS = prog(`#version 300 es
in vec3 p;uniform mat4 VP,V;uniform vec3 pos;uniform float sc;out vec3 vv;
void main(){vec3 w=p*sc+pos;vv=(V*vec4(w,1.)).xyz;gl_Position=VP*vec4(w,1.);}`,
    `#version 300 es
precision highp float;in vec3 vv;uniform vec3 col;uniform float alpha;out vec4 o;
void main(){vec3 n=normalize(cross(dFdx(vv),dFdy(vv)));float l=.32+.68*abs(n.z);o=vec4(col*l,alpha);}`);
    const PL = prog(`#version 300 es
in vec3 p;uniform mat4 VP;void main(){gl_Position=VP*vec4(p,1.);}`,
    `#version 300 es
precision mediump float;uniform vec4 col;out vec4 o;void main(){o=col;}`);
    const US = {}; ['VP', 'V', 'pos', 'sc', 'col', 'alpha'].forEach((n) => US[n] = gl.getUniformLocation(PS, n));
    const UL = { VP: gl.getUniformLocation(PL, 'VP'), col: gl.getUniformLocation(PL, 'col') };
    const mk = (arr) => { const vao = gl.createVertexArray(); gl.bindVertexArray(vao); const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0); return { vao, b, n: arr.length / 3 }; };
    const free = (o) => { if (o) { gl.deleteBuffer(o.b); gl.deleteVertexArray(o.vao); } };
    const sph = mk(sphereVerts(1, 18, 12));

    const S = { net: null, wires: [], nodes: [], faults: [], bands: [], mesh: null, meshB: null, grid: null, wb: null, wireR: 6, thick: 1, opacity: .30, labels: true, visible: false };
    const cam = { t: [0, 0, 0], d: 4000, yaw: -.9, pit: .45 }; let anim = null, VPm, Vm, W = 1, H = 1, raf = 0, pool = [];

    function resize() { const r = devicePixelRatio || 1, w = canvas.clientWidth * r | 0, h = canvas.clientHeight * r | 0; if (w && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; } W = canvas.clientWidth; H = canvas.clientHeight; }
    function bounds(pts) { const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30]; for (const p of pts) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); } return { mn, mx, c: mn.map((v, i) => (v + mx[i]) / 2), e: Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1) }; }
    function go(t, d) { anim = { t0: performance.now(), f: { t: cam.t.slice(), d: cam.d }, to: { t, d } }; kick(); }

    function rebuildWires() {
      S.wires.forEach((w) => free(w.g)); S.wires = [];
      if (!S.net) return;
      for (const s of S.net.segments) S.wires.push({ g: mk(tubeVerts([s.pts], S.wireR * S.thick)), rgb: hexRgb(s.color || '#4a6fa5'), seg: s });
      rebuildBands();
    }
    function rebuildBands() {
      S.bands.forEach(free); S.bands = [];
      for (const f of S.faults) { if (f.eol || !f.band || !f.band.length) { S.bands.push(null); continue; } S.bands.push(mk(tubeVerts(f.band, S.wireR * S.thick * 2.2))); }
    }
    function rebuildGrid() {
      free(S.grid); const b = S.meshB || S.wb; if (!b) { S.grid = null; return; }
      const z = b.mn[2] - (S.meshB ? 260 : 0), step = 500, v = [], x0 = Math.floor((b.mn[0] - 400) / step) * step, x1 = Math.ceil((b.mx[0] + 400) / step) * step, y0 = Math.floor((b.mn[1] - 400) / step) * step, y1 = Math.ceil((b.mx[1] + 400) / step) * step;
      for (let x = x0; x <= x1; x += step) v.push(x, y0, z, x, y1, z); for (let y = y0; y <= y1; y += step) v.push(x0, y, z, x1, y, z);
      S.grid = mk(Float32Array.from(v));
    }
    const api = {
      available: true,
      setNet(net) {
        S.net = net; const pts = []; net.segments.forEach((s) => s.pts.forEach((p) => pts.push(p))); S.wb = bounds(pts);
        S.wireR = Math.max(3, S.wb.e * .0034); S.nodes = []; const seen = {};
        net.segments.forEach((s) => { [[s.a, s.pts[0]], [s.b, s.pts[s.pts.length - 1]]].forEach(([n, p]) => { if (!seen[n]) { seen[n] = 1; S.nodes.push({ name: n, xyz: p }); } }); });
        S.faults = []; rebuildWires(); rebuildGrid(); api.frame('wiring');
      },
      setFaults(list) { S.faults = list || []; rebuildBands(); kick(); },
      setMesh(tri, bounds_) { free(S.mesh); S.mesh = tri ? mk(tri) : null; S.meshB = tri ? bounds_ : null; rebuildGrid(); kick(); },
      setOpacity(v) { S.opacity = v; kick(); },
      setThickness(v) { S.thick = v; rebuildWires(); kick(); },
      setLabels(b) { S.labels = b; kick(); },
      frame(what) { if (what === 'car' && S.meshB) go(S.meshB.c, S.meshB.e * 1.35); else if (S.wb) go(S.wb.c, S.wb.e * (what === 'car' ? 2.2 : 1.55)); },
      preset(w) { anim = null; if (w === 'top') { cam.yaw = -Math.PI / 2; cam.pit = 1.5; } else { cam.yaw = -Math.PI / 2; cam.pit = .06; } kick(); },
      flyFault(group) {
        const fs = S.faults.filter((f) => !f.eol); if (!fs.length) return false;
        const f = group == null ? fs[0] : (fs.find((x) => x.group === group) || fs[0]); go(f.xyz, Math.max(900, S.wb.e * .5)); return true;
      },
      show() { S.visible = true; resize(); kick(); }, hide() { S.visible = false; },
      kick
    };
    function eye() { const c = Math.cos(cam.pit); return [cam.t[0] + cam.d * c * Math.cos(cam.yaw), cam.t[1] + cam.d * c * Math.sin(cam.yaw), cam.t[2] + cam.d * Math.sin(cam.pit)]; }
    function kick() { if (!raf && S.visible) raf = requestAnimationFrame(draw); }
    function toScreen(p) { const x = VPm[0] * p[0] + VPm[4] * p[1] + VPm[8] * p[2] + VPm[12], y = VPm[1] * p[0] + VPm[5] * p[1] + VPm[9] * p[2] + VPm[13], w = VPm[3] * p[0] + VPm[7] * p[1] + VPm[11] * p[2] + VPm[15]; if (w <= 0) return null; return [(x / w * .5 + .5) * W, (1 - (y / w * .5 + .5)) * H]; }

    function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
    function draw(now) {
      raf = 0; if (!S.visible) return; resize(); if (!S.net) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      const dark = matchMedia('(prefers-color-scheme:dark)').matches && document.documentElement.getAttribute('data-theme') !== 'light' || document.documentElement.getAttribute('data-theme') === 'dark';
      const bg = dark ? [.082, .102, .125] : [.925, .937, .949]; gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      let animating = false;
      if (anim) { let k = (now - anim.t0) / 650; if (k >= 1) k = 1; const e = k * k * (3 - 2 * k); for (let i = 0; i < 3; i++) cam.t[i] = anim.f.t[i] + (anim.to.t[i] - anim.f.t[i]) * e; cam.d = anim.f.d + (anim.to.d - anim.f.d) * e; if (k === 1) anim = null; else animating = true; }
      const ext = S.meshB ? S.meshB.e : S.wb.e; Vm = look(eye(), cam.t, [0, 0, 1]);
      VPm = mul(persp(.8, W / H, Math.max(cam.d * .01, 1), cam.d + ext * 4), Vm);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (S.grid) { gl.useProgram(PL); gl.uniformMatrix4fv(UL.VP, false, VPm); gl.uniform4f(UL.col, dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, dark ? .07 : .10); gl.bindVertexArray(S.grid.vao); gl.drawArrays(gl.LINES, 0, S.grid.n); }
      gl.useProgram(PS); gl.uniformMatrix4fv(US.VP, false, VPm); gl.uniformMatrix4fv(US.V, false, Vm); gl.uniform3f(US.pos, 0, 0, 0); gl.uniform1f(US.sc, 1);
      if (S.mesh && S.opacity > 0) {
        gl.bindVertexArray(S.mesh.vao);
        gl.colorMask(false, false, false, false); gl.depthMask(true); gl.drawArrays(gl.TRIANGLES, 0, S.mesh.n);   // depth pre-pass
        gl.colorMask(true, true, true, true); gl.depthMask(false);
        if (dark) gl.uniform3f(US.col, .66, .74, .86); else gl.uniform3f(US.col, .40, .47, .58);
        gl.uniform1f(US.alpha, S.opacity); gl.drawArrays(gl.TRIANGLES, 0, S.mesh.n);                                 // one blended layer
        gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);                                                           // wires draw over the body
      }
      gl.uniform1f(US.alpha, 1);
      for (const w of S.wires) { const lift = dark ? 1.15 : 1; gl.uniform3f(US.col, Math.min(1, w.rgb[0] * lift), Math.min(1, w.rgb[1] * lift), Math.min(1, w.rgb[2] * lift)); gl.bindVertexArray(w.g.vao); gl.drawArrays(gl.TRIANGLES, 0, w.g.n); }
      S.faults.forEach((f, i) => { const b = S.bands[i]; if (!b) return; const c = FAULT_RGB[f.kind] || FAULT_RGB.open; gl.uniform3f(US.col, c[0], c[1], c[2]); gl.bindVertexArray(b.vao); gl.drawArrays(gl.TRIANGLES, 0, b.n); });
      gl.bindVertexArray(sph.vao); gl.uniform3f(US.col, .12, .13, .16); gl.uniform1f(US.sc, S.wireR * S.thick * 2.1);
      for (const n of S.nodes) { gl.uniform3fv(US.pos, n.xyz); gl.drawArrays(gl.TRIANGLES, 0, sph.n); }
      gl.disable(gl.DEPTH_TEST);
      const ph = ((now / 1000) % 1.2) / 1.2, mk_ = Math.max(cam.d * .008, S.wireR * 2.6);
      for (const f of S.faults) {
        const c = FAULT_RGB[f.eol ? 'eol' : (f.kind || 'open')]; gl.uniform3fv(US.pos, f.xyz); gl.uniform3f(US.col, c[0], c[1], c[2]);
        gl.uniform1f(US.alpha, 1); gl.uniform1f(US.sc, f.eol ? mk_ * .55 : mk_); gl.drawArrays(gl.TRIANGLES, 0, sph.n);
        if (!f.eol && f.kind !== 'feat') { gl.uniform1f(US.alpha, .3 * (1 - ph)); gl.uniform1f(US.sc, mk_ * (1 + 3.2 * ph)); gl.drawArrays(gl.TRIANGLES, 0, sph.n); }
      }
      gl.uniform1f(US.alpha, 1); gl.disable(gl.BLEND);
      paintLabels(); if (animating || S.faults.some((f) => !f.eol && f.kind !== 'feat')) { raf = requestAnimationFrame(draw); }
    }
    function paintLabels() {
      const items = [];
      if (S.labels) { S.nodes.forEach((n) => items.push([n.xyz, n.name, ''])); S.net.segments.forEach((s) => { const n = s.pts.length, m = n === 2 ? [0, 1, 2].map((k) => (s.pts[0][k] + s.pts[1][k]) / 2) : s.pts[n >> 1]; items.push([m, s.id, 's']); }); }
      S.faults.forEach((f) => { if (f.kind !== 'feat') items.push([f.xyz, f.eol ? 'expected end' : 'FAULT ' + f.group, f.eol ? 'e' : 'f']); });
      while (pool.length < items.length) { const d = document.createElement('div'); labelEl.appendChild(d); pool.push(d); }
      pool.forEach((d, i) => { if (i >= items.length) { d.style.display = 'none'; return; } const s = toScreen(items[i][0]); if (!s) { d.style.display = 'none'; return; } d.style.display = 'block'; d.className = 'lb ' + items[i][2]; d.textContent = items[i][1]; d.style.left = s[0] + 'px'; d.style.top = s[1] + 'px'; });
    }
    // input
    let drag = null; canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1 }; anim = null; });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { const k = cam.d * .0016, y = cam.yaw, r = [-Math.sin(y), Math.cos(y), 0], u = [-Math.sin(cam.pit) * Math.cos(y), -Math.sin(cam.pit) * Math.sin(y), Math.cos(cam.pit)]; for (let i = 0; i < 3; i++) cam.t[i] += (-r[i] * dx + u[i] * dy) * k; }
      else { cam.yaw -= dx * .006; cam.pit = Math.max(-1.55, Math.min(1.55, cam.pit + dy * .006)); } kick();
    });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); anim = null; cam.d = Math.max(30, Math.min(cam.d * Math.exp(e.deltaY * .0015), 60000)); kick(); }, { passive: false });
    new ResizeObserver(() => kick()).observe(canvas.parentElement);
    return api;
  }
  root.TDRViewer = { create };
})(window);

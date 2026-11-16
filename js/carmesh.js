/* carmesh.js - placeholder pickup body (mm, same frame as the example harness) and an STL reader.
 * Returns flat Float32Array triangle lists (x,y,z per vertex, 9 floats per triangle). Exposes window.TDRCar. */
(function (root) {
  'use strict';
  function quad(out, a, b, c, d) { out.push(...a, ...b, ...c, ...a, ...c, ...d); }
  /** 8 corners: 0-3 bottom loop, 4-7 top loop above them. */
  function hex(out, p) {
    quad(out, p[0], p[3], p[2], p[1]); quad(out, p[4], p[5], p[6], p[7]);
    quad(out, p[0], p[1], p[5], p[4]); quad(out, p[1], p[2], p[6], p[5]);
    quad(out, p[2], p[3], p[7], p[6]); quad(out, p[3], p[0], p[4], p[7]);
  }
  function box(out, x0, x1, y0, y1, z0, z1) {
    hex(out, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  }
  function wheel(out, cx, cz, r, y0, y1) {
    const N = 20;
    for (let i = 0; i < N; i++) {
      const a0 = 2 * Math.PI * i / N, a1 = 2 * Math.PI * (i + 1) / N;
      const p = (a, y) => [cx + r * Math.cos(a), y, cz + r * Math.sin(a)];
      quad(out, p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1));
      out.push(...[cx, y0, cz], ...p(a1, y0), ...p(a0, y0));
      out.push(...[cx, y1, cz], ...p(a0, y1), ...p(a1, y1));
    }
  }
  function placeholder() {
    const o = [];
    box(o, -700, 4500, -880, 880, -420, 120);                                                     // chassis / lower body
    hex(o, [[-700, -860, 120], [700, -860, 120], [700, 860, 120], [-700, 860, 120],
            [-700, -860, 250], [700, -860, 330], [700, 860, 330], [-700, 860, 250]]);              // hood
    hex(o, [[700, -840, 330], [2300, -840, 330], [2300, 840, 330], [700, 840, 330],
            [1250, -730, 900], [2080, -730, 900], [2080, 730, 900], [1250, 730, 900]]);            // cabin
    box(o, 2300, 4500, -880, -790, 120, 440); box(o, 2300, 4500, 790, 880, 120, 440);             // bed walls
    box(o, 2300, 2400, -790, 790, 120, 440); box(o, 4400, 4500, -790, 790, 120, 440);             // bed front, tailgate
    for (const x of [500, 3500]) for (const s of [-1, 1]) wheel(o, x, -240, 380, s > 0 ? 700 : -940, s > 0 ? 940 : -700);
    return Float32Array.from(o);
  }
  /** STL (binary or ASCII) -> Float32Array of triangles. */
  function parseSTL(ab) {
    const dv = new DataView(ab);
    if (ab.byteLength > 84) {
      const n = dv.getUint32(80, true);
      if (84 + 50 * n === ab.byteLength) {
        const out = new Float32Array(n * 9); let o = 84, q = 0;
        for (let i = 0; i < n; i++) { o += 12; for (let k = 0; k < 9; k++) { out[q++] = dv.getFloat32(o, true); o += 4; } o += 2; }
        return out;
      }
    }
    const txt = new TextDecoder().decode(ab), re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g, a = []; let m;
    while ((m = re.exec(txt))) a.push(+m[1], +m[2], +m[3]);
    if (a.length < 9 || a.length % 9) throw new Error('This file is not a valid STL (no triangles found).');
    return Float32Array.from(a);
  }
  function bounds(tri) {
    const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30], step = Math.max(3, Math.floor(tri.length / 3 / 40000) * 3);
    for (let i = 0; i < tri.length; i += step) for (let k = 0; k < 3; k++) { const v = tri[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    return { mn, mx, c: mn.map((v, i) => (v + mx[i]) / 2), e: Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2], 1) };
  }
  root.TDRCar = { placeholder, parseSTL, bounds };
  if (typeof module === 'object' && module.exports) module.exports = root.TDRCar;
})(typeof window !== 'undefined' ? window : globalThis);

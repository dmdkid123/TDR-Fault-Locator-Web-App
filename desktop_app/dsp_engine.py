import numpy as np
from scipy.signal import savgol_filter

class TDRSignalProcessor:
    def __init__(self, velocity_factor=0.65, time_expansion=100000.0, dt_adc=100e-6):
        self.c = 299792458.0
        self.v_prop = velocity_factor * self.c  # ~1.95e8 m/s
        self.dt_equivalent = dt_adc / time_expansion  # 1.0 ns per sample
        self.baseline_trace = None

    def set_baseline(self, baseline_sweep):
        self.baseline_trace = np.array(baseline_sweep, dtype=float)

    def _parabolic_interpolation(self, array, peak_idx):
        """Calculates sub-sample peak location using quadratic interpolation."""
        if 0 < peak_idx < len(array) - 1:
            alpha = array[peak_idx - 1]
            beta = array[peak_idx]
            gamma = array[peak_idx + 1]
            
            denom = (alpha - 2 * beta + gamma)
            if abs(denom) > 1e-12:
                p = 0.5 * (alpha - gamma) / denom
                exact_idx = peak_idx + p
                exact_val = beta - 0.25 * (alpha - gamma) * p
                return exact_idx, exact_val
                
        return float(peak_idx), array[peak_idx]

    def process_sweep(self, current_sweep, launch_sample_index=50, noise_gate=0.015):
        raw_signal = np.array(current_sweep, dtype=float)
        launch_exact = float(launch_sample_index)             # may be fractional (see align_sweep()["launch"])
        launch_sample_index = int(round(launch_exact))        # integer index used for slicing
        
        # Zero-point baseline subtraction
        if self.baseline_trace is not None:
            clean_signal = raw_signal - self.baseline_trace
        else:
            clean_signal = raw_signal - np.mean(raw_signal[:launch_sample_index])

        # Smooth signal to prevent derivative noise amplification
        smooth_signal = savgol_filter(clean_signal, window_length=11, polyorder=3)

        # Discrete derivative dV/dt
        dv_dt = np.gradient(smooth_signal, self.dt_equivalent)

        # Peak detection past launch offset
        search_region = dv_dt[launch_sample_index + 10:]
        if len(search_region) == 0:
            return clean_signal, dv_dt, []

        max_idx_relative = np.argmax(search_region)
        min_idx_relative = np.argmin(search_region)
        
        max_val = search_region[max_idx_relative]
        min_val = search_region[min_idx_relative]

        results = []

        if max_val > noise_gate and max_val > abs(min_val):
            peak_idx = launch_sample_index + 10 + max_idx_relative
            exact_idx, peak_val = self._parabolic_interpolation(dv_dt, peak_idx)
            fault_type = "Open Circuit / High Impedance"
        elif abs(min_val) > noise_gate:
            peak_idx = launch_sample_index + 10 + min_idx_relative
            exact_idx, peak_val = self._parabolic_interpolation(dv_dt, peak_idx)
            fault_type = "Short Circuit / Low Impedance"
        else:
            return clean_signal, dv_dt, []

        # Calculate precise distance using fractional sub-sample index
        sample_delay = exact_idx - launch_exact
        round_trip_time = sample_delay * self.dt_equivalent
        distance_m = (self.v_prop * round_trip_time) / 2.0

        results.append({
            "distance_m": distance_m,
            "round_trip_time_ns": round_trip_time * 1e9,
            "fault_type": fault_type,
            "dv_dt_peak": peak_val
        })

        return clean_signal, dv_dt, results


def align_sweep(counts, lead=100, span=450, smooth=5, min_swing=40, guard=25, fall_tol=0.05):
    """The hardware sweep is ONE period of the 1 MHz CLK0 square wave (1000 samples, circular): a rising launch edge and,
    about 500 samples later, a falling edge that is not a fault. Rotate the rising edge to index `lead` and crop before
    the falling edge. Returns (aligned_counts, info); info['launch'] is the sub-sample launch index to pass to
    process_sweep(launch_sample_index=...). info['ok'] is False (counts unchanged) if no square wave is found.
    Mirrors alignSweep() in tdr-ui/js/device.js."""
    x = np.asarray(counts, dtype=float)
    n = len(x)
    if n < lead + 60:
        return x, {"ok": False, "note": "sweep too short to align"}
    w = smooth | 1
    h = (w - 1) // 2
    sm = sum(np.roll(x, -k) for k in range(-h, h + 1)) / w          # circular moving average
    d = np.roll(sm, -1) - np.roll(sm, 1)                              # circular central difference
    swing = float(sm.max() - sm.min())
    if swing < min_swing:
        return x, {"ok": False, "swing": swing,
                   "note": "no square wave found (swing %.0f counts); is WAVE connected?" % swing}
    # Strong slope peaks (>= half the steepest). An open-circuit reflection is almost as steep as the launch, so "steepest"
    # is ambiguous; the launch is the rising peak that follows the LONGEST quiet gap (a reflection follows another edge closely).
    ad = np.abs(d)
    cand = [i for i in range(n) if ad[i] >= 0.5 * ad.max() and ad[i] >= ad[i - 1] and ad[i] > ad[(i + 1) % n]]
    merged = []
    for i in cand:
        if merged and i - merged[-1] <= 8:
            if ad[i] > ad[merged[-1]]:
                merged[-1] = i
        else:
            merged.append(i)
    if len(merged) > 1 and merged[0] + n - merged[-1] <= 8:
        first, last = merged[0], merged.pop()
        merged[0] = last if ad[last] > ad[first] else first
    rise = fall = -1
    gr = gf = -1
    for k, i in enumerate(merged):
        g = n if len(merged) < 2 else (i - merged[k - 1]) % n
        if d[i] > 0 and g > gr:
            gr, rise = g, i
    if rise >= 0 and gr < 0.35 * n:
        # No clear quiet gap: on a cable longer than about 24 m the open-circuit echo sits closer to the previous edge than
        # the launch does, so the gap rule would pick the echo. The launch is the rising edge that starts from the LOWEST level.
        bp = np.inf
        for i in merged:
            if d[i] > 0:
                p = float(np.mean([sm[(i - k) % n] for k in range(8, 15)]))
                if p < bp:
                    bp, rise = p, i
    if rise < 0:
        return x, {"ok": False, "swing": swing, "note": "no rising edge found in the sweep"}
    # The CLK0 falling edge is half a period after the launch. A falling edge anywhere else is an ECHO from a short or
    # resistive short and must not be cropped away. If the clock's own falling edge is too small to see, assume it is there.
    for k, i in enumerate(merged):
        if d[i] < 0 and abs(((i - rise) % n) - n / 2) <= fall_tol * n:
            g = n if len(merged) < 2 else (i - merged[k - 1]) % n
            if g > gf:
                gf, fall = g, i
    if fall < 0:
        fall = (rise + n // 2) % n
    sep = (fall - rise) % n
    span = max(50, min(span, sep - guard))                            # stop before the falling edge
    start = (rise - lead) % n
    out = np.take(x, np.arange(start, start + lead + span), mode="wrap")
    # sub-sample launch: centroid of the (positive) edge slope around the peak. A flat-topped ramp defeats a parabola fit.
    k = np.arange(-12, 13)
    wgt = np.clip(d[(rise + k) % n], 0, None)
    frac = float((k * wgt).sum() / wgt.sum()) if wgt.sum() > 0 else 0.0
    note = "" if abs(sep - n / 2) <= 0.15 * n else "falling edge is %d samples after the rising edge, expected about %d" % (sep, n // 2)
    return out, {"ok": True, "rise": rise, "fall": fall, "swing": swing, "shift": start, "launch": lead + frac, "note": note}


def average_sweeps(sweeps, max_shift=3, reject_k=4.0):
    """Average several ALREADY ALIGNED sweeps (the arrays align_sweep() returns). Each sweep is slid by up to +/-max_shift
    samples onto the first one, sweeps that differ from the rest (a glitch, a bumped cable) are dropped, and the rest are
    averaged. Random noise falls by about sqrt(N). Returns (mean, info) with info = {used, rejected, total, noise,
    noise_avg}: noise is the per-sweep sample spread in counts, noise_avg the spread left in the average.
    Mirrors SweepAverager in tdr-ui/js/device.js."""
    if len(sweeps) == 0:
        raise ValueError("no sweeps to average")
    ref = np.asarray(sweeps[0], dtype=float)
    aligned = [ref]
    for sw in sweeps[1:]:
        x = np.asarray(sw, dtype=float)
        n = min(len(x), len(ref))
        best, best_e = 0, np.inf
        for s in range(-max_shift, max_shift + 1):
            seg = x[max_shift + s:n - max_shift + s]
            e = float(((seg - ref[max_shift:n - max_shift]) ** 2).sum())
            if e < best_e:
                best_e, best = e, s
        idx = np.clip(np.arange(len(x)) + best, 0, len(x) - 1)
        aligned.append(x[idx])
    n = min(len(a) for a in aligned)
    stack = np.vstack([a[:n] for a in aligned])
    k = len(stack)
    keep = np.ones(k, dtype=bool)
    if k >= 3:
        med = np.median(stack, axis=0)
        dev = np.sqrt(((stack - med) ** 2).mean(axis=1))
        dm = np.median(dev)
        mad = np.median(np.abs(dev - dm))
        keep = dev <= dm + max(reject_k * 1.4826 * mad, 1.0)
        if keep.sum() < int(np.ceil(k / 2)):
            keep = np.ones(k, dtype=bool)
    used = int(keep.sum())
    mean = stack[keep].mean(axis=0)
    noise = float(np.sqrt(((stack[keep] - mean) ** 2).sum() / (n * (used - 1)))) if used > 1 else 0.0
    return mean, {"used": used, "rejected": k - used, "total": k, "noise": noise,
                  "noise_avg": noise / np.sqrt(used)}


def align_and_average(raw_sweeps, **align_kw):
    """Raw 1000-sample sweeps from the board -> (averaged aligned counts, info). info['launch'] is the sub-sample launch
    index of the average (pass it to process_sweep(launch_sample_index=...)); info['skipped'] counts sweeps with no
    square wave (e.g. WAVE not connected), which are left out."""
    good, skipped, lead = [], 0, align_kw.get("lead", 100)
    for raw in raw_sweeps:
        out, a = align_sweep(raw, **align_kw)
        if a["ok"]:
            good.append(out)
        else:
            skipped += 1
    if not good:
        raise ValueError("No usable sweeps: no square wave found in any of them. Is WAVE connected?")
    mean, info = average_sweeps(good)
    # sub-sample launch of the AVERAGE: the rising edge is near index `lead`; centroid of the positive slope around it
    d = np.gradient(mean)
    peak = int(np.argmax(np.convolve(d, np.ones(5) / 5, mode="same")[:lead * 2]))
    kk = np.arange(-12, 13)
    ww = np.clip(d[np.clip(peak + kk, 0, len(mean) - 1)], 0, None)
    info["launch"] = float(peak + (kk * ww).sum() / ww.sum()) if ww.sum() > 0 else float(peak)
    info["skipped"] = skipped
    return mean, info

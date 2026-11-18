"""Bench check for the ESP32 sampler firmware: run it at the bench with the board and the harness connected.

    python3 bench_check.py /dev/cu.usbserial-0001 -t 120          # record 2 minutes of live sweeps and print a report
    python3 bench_check.py /dev/cu.usbserial-0001 -t 120 --save run1.npz
    python3 bench_check.py --selftest                              # no board: runs against a simulated one

Needs pyserial (pip install pyserial), numpy and scipy. Opening the port resets the ESP32, so the script waits a few
seconds for the boot lines ("INFO: ADC_US=...", "POST_PASSED"), then sends 'S' (again every second until sweeps arrive,
like the web app) and records for -t seconds. At the end it sends 'I' so the board is not left sweeping.

What it measures (these are the checks for the firmware changes F1-F6):
  * boot: the time of one analogRead (ADC_US, must be well under the 100 us sample slot), POST_PASSED, any ERR line
  * sweeps per second and any sweep ids that never arrived (F6: about 5/s before, up to 10/s after)
  * CRC errors
  * "WARN: SAMPLER_OVERRUN idx=<n> missed=<n>" lines: how many sweeps, how many late slots, where (F1, F2, F4)
  * where the launch edge sits in each raw sweep, and how far it moves: steady within about 1 sample is good, and
    sweeps that HAD an overrun should not move more than the clean ones (F3 fills the missed slots instead of shifting)
  * reboots or watchdog messages during the run (F2, F5 stability)
Run it on the old firmware and the new firmware with the same harness and compare the two reports."""
import argparse
import re
import sys
import time

import numpy as np

from live_capture import BAUD, PacketDecoder, build_packet
from dsp_engine import align_sweep

OVERRUN = re.compile(r"SAMPLER_OVERRUN idx=(-?\d+) missed=(\d+)")
ADC_US = re.compile(r"INFO: ADC_US=([0-9.]+)")
CRASH_WORDS = ("Guru Meditation", "Task watchdog", "Backtrace", "abort()", "rst:0x")
N = 1000


def run_bench(port, seconds=60.0, boot_wait=3.0, clock=time.monotonic, first_sweep_timeout=20.0):
    """Drives `port` (read(n) -> bytes, write(bytes)). Returns (decoder, sweeps, arrival_times)."""
    dec = PacketDecoder()
    sweeps, times = [], []
    t0 = clock()
    while clock() - t0 < boot_wait:                                      # catch the boot lines; the ESP32 resets when the port opens
        dec.feed(port.read(4096))
    started, last_s = clock(), -1e9
    while True:
        now = clock()
        if not sweeps and now - last_s >= 1.0:                           # a repeated 'S' while sweeping is ignored by the firmware
            port.write(b"S\n")
            last_s = now
        for s in dec.feed(port.read(4096)):
            sweeps.append(s)
            times.append(clock())
        if sweeps and clock() - times[0] >= seconds:
            break
        if not sweeps and clock() - started > first_sweep_timeout:
            break
    port.write(b"I")
    return dec, sweeps, times


def _circ(values, n=N):
    """Positions on a circle of n samples -> offsets from their median, in samples (handles the wrap at 0 / n)."""
    v = np.asarray(values, dtype=float)
    d0 = ((v - v[0] + n / 2) % n) - n / 2
    return d0 - np.median(d0)


def analyze(dec, sweeps, times):
    r = {"adc_us": None, "post_passed": 0, "reboots": 0, "errors": [], "crash_lines": [], "no_sync": 0}
    pending, per_sweep, ids = None, [], []
    seen_sweep, last_id = False, None
    for ev in dec.events:
        if ev[0] == "text":
            line = ev[1]
            m = ADC_US.search(line)
            if m and r["adc_us"] is None:
                r["adc_us"] = float(m.group(1))
            o = OVERRUN.search(line)
            if o:
                pending = (int(o.group(1)), int(o.group(2)))
            elif "SAMPLER_OVERRUN" in line:
                pending = (-1, None)                                      # old firmware text: no numbers
            if "POST_PASSED" in line:
                r["post_passed"] += 1
                r["reboots"] += 1 if seen_sweep else 0
            if "NO_SWEEP_SYNC" in line:
                r["no_sync"] += 1
            if line.startswith("ERR"):
                r["errors"].append(line)
            if any(w in line for w in CRASH_WORDS):
                r["crash_lines"].append(line)
        elif ev[0] == "sweep":
            seen_sweep = True
            if last_id is not None and ev[1] < last_id:                   # the id counter restarts when the board reboots
                r["reboots"] += 1
            last_id = ev[1]
            ids.append(ev[1])
            per_sweep.append(pending)
            pending = None
    r.update(sweeps=len(sweeps), crc_errors=dec.crc_errors, missing_ids=dec.missed)
    r["rate"] = (len(times) - 1) / (times[-1] - times[0]) if len(times) >= 2 and times[-1] > times[0] else None
    r["duration"] = times[-1] - times[0] if len(times) >= 2 else 0.0

    # overruns
    over = [(i, p) for i, p in enumerate(per_sweep) if p is not None]
    missed = [p[1] for _, p in over if p[1] is not None]
    r["overrun_sweeps"] = len(over)
    r["overrun_frac"] = len(over) / len(sweeps) if sweeps else 0.0
    r["late_slots"] = int(sum(missed))
    r["missed_hist"] = {"1": sum(m == 1 for m in missed), "2": sum(m == 2 for m in missed),
                        "3-4": sum(3 <= m <= 4 for m in missed), "5+": sum(m >= 5 for m in missed)}
    idxs = [p[0] for _, p in over if p[0] >= 0]
    r["first_idx"] = (int(min(idxs)), int(np.median(idxs)), int(max(idxs))) if idxs else None

    # launch edge position in each raw sweep, and the low level before it
    raw, base, ok_i = [], [], []
    for i, s in enumerate(sweeps):
        out, info = align_sweep(s)
        if info.get("ok"):
            raw.append((info["shift"] + info["launch"]) % N)
            base.append(float(np.mean(out[10:90])))
            ok_i.append(i)
    r["unaligned"] = len(sweeps) - len(ok_i)
    if raw:
        off = _circ(raw)
        r["launch_std"] = float(off.std())
        r["launch_maxabs"] = float(np.abs(off).max())
        r["launch_over2"] = float(np.mean(np.abs(off) > 2))
        r["launch_median"] = float(np.median(np.asarray(raw)))
        r["baseline_std"] = float(np.std(base))
        has = np.array([per_sweep[i] is not None for i in ok_i])
        r["launch_max_overrun"] = float(np.abs(off[has]).max()) if has.any() else None
        r["launch_max_clean"] = float(np.abs(off[~has]).max()) if (~has).any() else None
    return r


def verdicts(r):
    """(check, status, text). Status is OK / CHECK / BAD; they are hints for reading the numbers, not a guarantee."""
    v = []
    a = r["adc_us"]
    if a is None:
        v.append(("analogRead time", "CHECK", "no INFO: ADC_US line seen (old firmware, or the port opened after the board booted: reset it and rerun)"))
    else:
        v.append(("analogRead time", "OK" if a <= 50 else "CHECK" if a <= 80 else "BAD",
                  "%.1f us per read; must stay well under the 100 us slot" % a))
    v.append(("boot", "BAD" if r["errors"] else "OK" if r["post_passed"] else "CHECK",
              "; ".join(r["errors"]) if r["errors"] else ("POST_PASSED seen" if r["post_passed"] else "no POST_PASSED seen (port opened after boot?)")))
    if r["sweeps"] == 0:
        v.append(("sweeps", "BAD", "no sweeps arrived. NO_SWEEP_SYNC lines: %d (GPIO27 beat missing or the board did not start)" % r["no_sync"]))
        return v
    rate = r["rate"]
    if rate is not None:
        v.append(("sweep rate", "OK" if rate >= 9 else "CHECK",
                  "%.1f sweeps/s (%s)" % (rate, "re-arm catches every beat" if rate >= 9 else "about 5/s means the re-arm missed the next beat, as the old firmware did" if rate < 5.5 else "between 5 and 10: the re-arm sometimes misses the beat")))
    v.append(("lost / corrupt", "OK" if r["crc_errors"] == 0 and r["missing_ids"] == 0 else "BAD",
              "%d CRC errors, %d sweep ids never arrived" % (r["crc_errors"], r["missing_ids"])))
    f = r["overrun_frac"]
    v.append(("overruns", "OK" if f <= 0.01 else "CHECK" if f <= 0.05 else "BAD",
              "%d of %d sweeps had a SAMPLER_OVERRUN warning (%.1f%%), %d late slots in total" % (r["overrun_sweeps"], r["sweeps"], 100 * f, r["late_slots"])))
    if "launch_std" in r:
        far = int(round(r["launch_over2"] * r["sweeps"]))
        v.append(("launch steadiness", "OK" if r["launch_std"] <= 1 and r["launch_maxabs"] <= 2 else "CHECK",
                  "launch edge moves %.2f samples rms, at most %.1f; %d sweep(s) more than 2 samples from the median (a slip: those sweeps are shifted)" % (r["launch_std"], r["launch_maxabs"], far)))
        if r["launch_max_overrun"] is not None and r["launch_max_clean"] is not None:
            good = r["launch_max_overrun"] <= max(2.0, r["launch_max_clean"])
            v.append(("fill after a miss (F3)", "OK" if good else "BAD",
                      "launch moved at most %.1f samples in sweeps WITH an overrun vs %.1f in clean sweeps" % (r["launch_max_overrun"], r["launch_max_clean"])))
    if r["unaligned"]:
        v.append(("alignment", "CHECK", "%d sweeps had no square wave to align (is WAVE connected?)" % r["unaligned"]))
    stable = not r["reboots"] and not r["crash_lines"]
    v.append(("stability", "OK" if stable else "BAD",
              "no reboot or watchdog message during the run" if stable else "%d reboot(s), crash text: %s" % (r["reboots"], "; ".join(r["crash_lines"][:3]) or "none")))
    return v


def print_report(r, label=""):
    print("=" * 66)
    print("BENCH CHECK" + (" - " + label if label else ""))
    print("=" * 66)
    print("sweeps: %d in %.0f s | CRC errors %d | missing ids %d | NO_SWEEP_SYNC lines %d" % (r["sweeps"], r["duration"], r["crc_errors"], r["missing_ids"], r["no_sync"]))
    if r["sweeps"]:
        h = r["missed_hist"]
        print("overruns: %d sweeps | late slots per warning: 1:%d  2:%d  3-4:%d  5+:%d%s" % (
            r["overrun_sweeps"], h["1"], h["2"], h["3-4"], h["5+"],
            " | first late index min/median/max %d/%d/%d" % r["first_idx"] if r["first_idx"] else ""))
        if "launch_std" in r:
            print("launch edge: median at sample %.1f, rms movement %.2f, max %.1f | baseline spread %.1f counts" % (r["launch_median"], r["launch_std"], r["launch_maxabs"], r["baseline_std"]))
    print("-" * 66)
    for name, status, text in verdicts(r):
        print("%-6s %-24s %s" % (status, name, text))
    print("-" * 66)
    print("Copy this whole report back. OK/CHECK/BAD are hints for reading the numbers, not a guarantee.")


# ---------------------------------------------------------------------------- simulated board (for --selftest and the tests)
def synth_sweep(k0, echo_rt=60.0, noise=4.0, rng=None):
    """One raw sweep (1000 ADC counts) of the equivalent-time square wave with an open-circuit echo, launch edge at k0."""
    rng = rng or np.random.default_rng(0)
    i = np.arange(N)
    x = ((i - k0 + 500) % N) - 500
    cl = lambda y: np.clip(y, 0, 1)
    st = lambda y: cl(y / 4 + 0.5) + 0.97 * cl((y - echo_rt) / 4 + 0.5)
    v = 0.15 + 0.5 * (st(x) - st(x - 500) + st(x + 1000) - st(x + 500))
    return np.clip(np.round(v / 3.3 * 4095 + 400 + rng.normal(0, noise, N)), 0, 4095)


class SimBoard:
    """Pretends to be the firmware: the same bytes, on a simulated clock (each read() advances it by the 50 ms port timeout)."""

    def __init__(self, rate=10.0, seed=1, adc_us=14.2, overrun_rate=0.03, bad_rate=0.01, reboot_at=None,
                 corrupt_at=None, slip_at=None, silent=False, boot_lines=True):
        self.t, self.rate, self.rng = 0.0, rate, np.random.default_rng(seed)
        self.overrun_rate, self.bad_rate = overrun_rate, bad_rate
        self.reboot_at, self.corrupt_at, self.slip_at, self.silent = reboot_at, corrupt_at, slip_at, silent
        self.sweeping, self.next, self.id = False, 0.0, 0
        self.buf = bytearray(b"INFO: ADC_US=%.1f\r\nPOST_PASSED: SYSTEM_READY\r\n" % adc_us if boot_lines else b"")

    def now(self):
        return self.t

    def write(self, data):
        for c in bytes(data):
            if c == ord("S") and not self.sweeping and not self.silent:
                self.sweeping, self.next = True, self.t + 1.0 / self.rate
            elif c == ord("I"):
                self.sweeping = False

    def _emit(self):
        self.id += 1
        if self.reboot_at == self.id:
            self.buf += b"POST_PASSED: SYSTEM_READY\r\n"
        r = self.rng.random()
        if r < self.bad_rate:
            self.buf += b"WARN: SAMPLER_OVERRUN idx=%d missed=5\r\n" % int(self.rng.integers(100, 900))
        elif r < self.bad_rate + self.overrun_rate:
            self.buf += b"WARN: SAMPLER_OVERRUN idx=%d missed=%d\r\n" % (int(self.rng.integers(100, 900)), int(self.rng.integers(1, 3)))
        k0 = 300 + self.rng.normal(0, 0.3) + (6 if self.slip_at == self.id else 0)
        pkt = bytearray(build_packet(synth_sweep(k0, rng=self.rng), self.id))
        if self.corrupt_at == self.id:
            pkt[100] ^= 0xFF
        self.buf += pkt

    def read(self, n):
        self.t += 0.05
        while self.sweeping and self.next <= self.t:
            self._emit()
            self.next += 1.0 / self.rate
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out


class _SerialPort:
    def __init__(self, path, baud):
        import serial                                                     # pip install pyserial
        self.ser = serial.Serial(path, baud, timeout=0.05)

    def read(self, n):
        return self.ser.read(n)

    def write(self, data):
        self.ser.write(data)
        self.ser.flush()

    def close(self):
        self.ser.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("port", nargs="?", help="serial port, e.g. /dev/cu.usbserial-0001 or COM5")
    ap.add_argument("-t", "--seconds", type=float, default=60.0, help="how long to record sweeps (default 60)")
    ap.add_argument("--baud", type=int, default=BAUD)
    ap.add_argument("--boot-wait", type=float, default=3.0, help="seconds to listen for the boot lines after the port opens")
    ap.add_argument("--save", help="also save the raw sweeps to this .npz file")
    ap.add_argument("--label", default="", help="a name for this run in the report, e.g. old-firmware or new-firmware")
    ap.add_argument("--selftest", action="store_true", help="run against a simulated board (no hardware)")
    a = ap.parse_args(argv)
    if a.selftest:
        port = SimBoard()
        dec, sweeps, times = run_bench(port, a.seconds, a.boot_wait, clock=port.now)
    else:
        if not a.port:
            ap.error("give the serial port, or use --selftest")
        port = _SerialPort(a.port, a.baud)
        try:
            dec, sweeps, times = run_bench(port, a.seconds, a.boot_wait)
        finally:
            port.close()
    r = analyze(dec, sweeps, times)
    print_report(r, a.label or ("simulated board" if a.selftest else ""))
    if a.save and sweeps:
        np.savez(a.save, sweeps=np.array(sweeps), ids=np.array([e[1] for e in dec.events if e[0] == "sweep"]))
        print("saved %d sweeps to %s" % (len(sweeps), a.save))
    return 0 if sweeps else 1


if __name__ == "__main__":
    sys.exit(main())

"""Run: python3 test_averaging_cal.py   (needs numpy and scipy; no hardware, no pyserial)
Checks sweep averaging, the ADC calibration table and the serial packet decoder used by live_capture.py."""
import json
import os
import tempfile

import numpy as np

from adc_cal import AdcCalibration
from dsp_engine import align_sweep, average_sweeps, align_and_average
from live_capture import PacketDecoder, build_packet, crc16, measure

fails = 0


def ok(cond, msg):
    global fails
    if not cond:
        fails += 1
    print(("pass " if cond else "FAIL ") + msg)


C = 299792458.0
rng = np.random.default_rng(5)


def adc(v):
    """made-up ESP32 ADC: 3 percent low gain, +40 mV offset, a bend in the middle"""
    return np.clip(np.round((0.97 * v + 0.04 + 0.02 * np.sin(np.pi * v / 3.3)) / 3.3 * 4095), 0, 4095)


def sweep(dist, k0, sd, vf=0.65, nonlinear=False):
    """one period of the 1 MHz wave: rising launch at k0, open-circuit echo, falling edge 500 samples later"""
    rt = 2 * dist / (vf * C) * 1e9
    cl = lambda y: np.clip(y, 0, 1)
    st = lambda y: cl(y / 4 + 0.5) + 0.97 * cl((y - rt) / 4 + 0.5)
    x = ((np.arange(1000) - k0 + 500) % 1000) - 500
    v = 0.15 + 0.5 * (st(x) - st(x - 500) + st(x + 1000) - st(x + 500))
    counts = adc(v) if nonlinear else np.round(v / 3.3 * 4095 + 400)
    return np.clip(np.round(counts + rng.normal(0, sd, 1000)), 0, 4095)


# ---- crc / packet decoder
ok(crc16(b"123456789") == 0x4B37, "crc16: the standard check value for poly 0xA001, init 0xFFFF (0x4B37)")
pk = [build_packet((np.arange(1000) * 7 + i) & 0xFFF, i) for i in range(1, 7)]
pk[2] = pk[2][:100] + bytes([pk[2][100] ^ 0xFF]) + pk[2][101:]          # corrupt one sample byte: CRC must catch it
pk[4:5] = []                                                              # sweep 5 never arrives
stream = b"POST_PASSED: SYSTEM_READY\r\n" + pk[0] + b"junk\n" + b"".join(pk[1:])
dec, got = PacketDecoder(), []
for i in range(0, len(stream), 37):                                       # small USB-style reads
    got += dec.feed(stream[i:i + 37])
ok(dec.good == 4 and dec.crc_errors == 1 and dec.missed == 2, "decoder: 4 good, 1 CRC error, sweeps missed counted (%d, %d, %d)" % (dec.good, dec.crc_errors, dec.missed))
ok(len(got) == 4 and all(len(g) == 1000 for g in got) and got[0][5] == 36.0, "decoder: payload comes out intact, 1000 samples each")
ok("POST_PASSED: SYSTEM_READY" in dec.text, "decoder: ASCII status lines are kept apart from packets")

# ---- ADC calibration
cal = AdcCalibration()
for v in [0.1, 0.4, 0.8, 1.2, 1.6, 2.0, 2.3, 2.6]:
    cal.add(adc(v), v)
ok(cal.ready and len(cal.points) == 8, "calibration: 8 points, sorted by counts")
vs = np.arange(0.15, 2.46, 0.0113)
err_cal = np.abs(cal.to_volts(adc(vs)) - vs).max()
err_ideal = np.abs(adc(vs) / 4095 * 3.3 - vs).max()
ok(err_cal < 0.006 and err_ideal > 0.03, "calibration: worst error %.1f mV calibrated vs %.1f mV uncalibrated" % (err_cal * 1000, err_ideal * 1000))
ok(cal.to_volts(4095) > cal.to_volts(adc(2.6)) and np.isfinite(cal.to_volts(0)) and isinstance(cal.to_volts(1500), float), "calibration: end segments extend, scalar in gives float out")
try:
    cal.add(adc(1.0), 1.9)
    bad = ""
except ValueError as e:
    bad = str(e)
ok("conflicts" in bad and len(cal.points) == 8, "calibration: a contradicting point is refused and the table is unchanged")
d = AdcCalibration()
d.add(1000, 0.8)
d.add(1001, 0.802)
ok(len(d.points) == 1 and abs(d.points[0][0] - 1000.5) < 1e-9, "calibration: two readings of one level merge")
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "cal.json")
    cal.save(path)
    back = AdcCalibration.load(path)
    # a file in exactly the shape the web app writes (version, bits, vref, points of {counts, volts})
    web = os.path.join(tmp, "web.json")
    json.dump({"version": 1, "bits": 12, "vref": 3.3, "points": [{"counts": 500, "volts": 0.4}, {"counts": 3000, "volts": 2.4}]}, open(web, "w"))
    w = AdcCalibration.load(web)
ok(len(back.points) == 8 and abs(back.to_volts(adc(1.4)) - cal.to_volts(adc(1.4))) < 1e-3 and cal.to_dict()["version"] == 1, "calibration: JSON round trip")
ok(w.ready and abs(w.to_volts(1750) - 1.4) < 1e-9, "calibration: loads the file the web app saves")
try:
    AdcCalibration.from_dict({"foo": 1})
    m = ""
except ValueError as e:
    m = str(e)
ok("points" in m, "calibration: a file without points is refused")

# ---- averaging
aligned = [align_sweep(sweep(3, 300 + int(rng.integers(-2, 3)), 3))[0] for _ in range(16)]
mean, info = average_sweeps(aligned)
ok(info["used"] == 16 and 2 < info["noise"] < 4.5 and info["noise_avg"] < 1.3, "average: noise %.2f -> %.2f counts over 16 sweeps (expect about 3 -> 0.75)" % (info["noise"], info["noise_avg"]))

glitched = []
for i in range(10):
    sw = sweep(3, 300, 2)
    if i in (3, 7):
        sw = np.clip(sw + rng.normal(0, 250, 1000), 0, 4095)
    glitched.append(align_sweep(sw)[0])
mean, info = average_sweeps(glitched)
ref = align_sweep(sweep(3, 300, 0))[0]
n = min(len(ref), len(mean))
ok(info["rejected"] == 2 and info["used"] == 8 and np.abs(mean[:n] - ref[:n]).max() < 4, "average: 2 glitched sweeps of 10 dropped, result within %.1f counts of clean" % np.abs(mean[:n] - ref[:n]).max())
one, i1 = average_sweeps([ref])
ok(i1["used"] == 1 and np.array_equal(one, ref), "average: one sweep passes through")

# ---- align + average from raw sweeps, with a dead (flat) one in the middle
raw = [sweep(4, 200 + int(rng.integers(-2, 3)), 3) for _ in range(8)]
raw.insert(4, np.full(1000, 1500.0))
mean, info = align_and_average(raw)
ok(info["skipped"] == 1 and info["used"] == 8 and abs(info["launch"] - 100) < 2.5, "align_and_average: flat sweep skipped, 8 averaged, launch near index 100 (%.2f)" % info["launch"])
try:
    align_and_average([np.full(1000, 1500.0)] * 3)
    m = ""
except ValueError as e:
    m = str(e)
ok("WAVE" in m, "align_and_average: all-flat input says to check WAVE")

# ---- shorts, resistive shorts and long opens survive alignment (the echo of a short is a FALLING edge; the board output
#      cannot go below 0.15 V, so the clock's own falling edge can be invisible)
def board(dist, gamma, k0, vf=0.65):
    rt = 2 * dist / (vf * C) * 1e9
    cl = lambda y: np.clip(y, 0, 1)
    st = lambda y: cl(y / 4 + 0.5) + gamma * cl((y - rt) / 4 + 0.5)
    x = ((np.arange(1000) - k0 + 500) % 1000) - 500
    v = np.maximum(0.15, 0.15 + 0.5 * (st(x) - st(x - 500) + st(x + 1000) - st(x + 500)))
    return np.round(v / 3.3 * 4095 + rng.normal(0, 2, 1000)), rt


bad = []
for name, g in [("open", 0.97), ("short", -0.97), ("10 ohm", -120 / 140), ("100 ohm", -120 / 320)]:
    for dist in [1.5, 3, 8, 15, 22, 28]:
        for k0 in [40, 300, 777]:
            sw, rt = board(dist, g, k0)
            out, info = align_sweep(sw)
            if not info["ok"] or abs(info["rise"] - k0) > 3 or len(out) < 100 + rt + 10:
                bad.append((name, dist, k0, info.get("rise"), len(out)))
ok(not bad, "align_sweep: open, short, 10 ohm and 100 ohm faults at 1.5 to 28 m keep the launch and the echo (%d of 72 missed)%s" % (len(bad), " " + str(bad[:3]) if bad else ""))

# ---- whole path: nonlinear ADC, calibrated vs not
raw = [sweep(4, 200 + int(rng.integers(-2, 3)), 4, nonlinear=True) for _ in range(16)]
res_c, _ = measure(raw, cal, vf=0.65)
res_u, _ = measure(raw, None, vf=0.65)
ok(res_c is not None and "Open" in res_c["fault_type"] and abs(res_c["distance_m"] - 4.0) < 0.15, "measure: calibrated open end at %.3f m (true 4.000)" % (res_c["distance_m"] if res_c else float("nan")))
ok(res_u is not None and abs(res_u["distance_m"] - 4.0) < 0.3, "measure: uncalibrated path also runs (%.3f m)" % (res_u["distance_m"] if res_u else float("nan")))

print("%d FAILED" % fails if fails else "ALL PASSED")
raise SystemExit(1 if fails else 0)

"""Run: python3 test_bench_check.py   (needs numpy and scipy; no hardware, no pyserial)
Checks bench_check.py against a simulated board: sweep rate, CRC and missing ids, overrun warnings paired with the sweep they
belong to, launch-edge steadiness (including the wrap at sample 0/1000), reboot detection, and the report verdicts."""
import io
import contextlib

import numpy as np

import bench_check as B
from live_capture import PacketDecoder, build_packet

fails = 0


def ok(cond, msg):
    global fails
    if not cond:
        fails += 1
    print(("pass " if cond else "FAIL ") + msg)


def run(board, seconds=20.0):
    dec, sweeps, times = B.run_bench(board, seconds, 3.0, clock=board.now)
    return dec, sweeps, times, B.analyze(dec, sweeps, times)


def status(r, name):
    return {n: s for n, s, _ in B.verdicts(r)}.get(name)


# a healthy board at 10 sweeps/s with a few overruns
b = B.SimBoard(rate=10.0, seed=3)
dec, sweeps, times, r = run(b)
warn_lines = [l for l in dec.text if "SAMPLER_OVERRUN" in l]
slots = sum(int(B.OVERRUN.search(l).group(2)) for l in warn_lines)
ok(abs(r["sweeps"] - 200) <= 2 and 9.5 <= r["rate"] <= 10.5, "healthy board: %d sweeps at %.1f/s" % (r["sweeps"], r["rate"]))
ok(r["crc_errors"] == 0 and r["missing_ids"] == 0 and r["reboots"] == 0 and r["adc_us"] == 14.2 and r["post_passed"] == 1, "no CRC errors, no missing ids, no reboot, ADC_US 14.2 and POST_PASSED read from the boot lines")
ok(len(warn_lines) > 0 and r["overrun_sweeps"] == len(warn_lines) and r["late_slots"] == slots, "overrun warnings counted: %d sweeps, %d late slots (board sent %d warnings, %d slots)" % (r["overrun_sweeps"], r["late_slots"], len(warn_lines), slots))
ok(r["launch_std"] < 1.0 and r["launch_max_overrun"] is not None and r["launch_max_overrun"] <= 2.0 and status(r, "fill after a miss (F3)") == "OK", "launch edge steady (%.2f samples rms) and not moved by overruns (max %.1f)" % (r["launch_std"], r["launch_max_overrun"]))
ok(status(r, "sweep rate") == "OK" and status(r, "stability") == "OK" and status(r, "lost / corrupt") == "OK", "verdicts: rate, lost/corrupt and stability are OK")
ok(r["first_idx"] is not None and 100 <= r["first_idx"][0] <= r["first_idx"][2] < 900, "first late index range reported")

# old firmware speed: 5 sweeps/s
dec, sweeps, times, r = run(B.SimBoard(rate=5.0, seed=4))
ok(4.5 <= r["rate"] <= 5.5 and status(r, "sweep rate") == "CHECK", "5 sweeps/s is reported as CHECK (%.1f/s)" % r["rate"])

# a corrupted packet and a missing sweep
dec, sweeps, times, r = run(B.SimBoard(rate=10.0, seed=5, corrupt_at=40))
ok(r["crc_errors"] == 1 and status(r, "lost / corrupt") == "BAD" and r["missing_ids"] >= 1, "corrupted packet: %d CRC error, %d id never arrived -> BAD" % (r["crc_errors"], r["missing_ids"]))

# a reboot in the middle of the run
dec, sweeps, times, r = run(B.SimBoard(rate=10.0, seed=6, reboot_at=60))
ok(r["reboots"] == 1 and status(r, "stability") == "BAD", "board that prints POST_PASSED mid-run is flagged as a reboot")

# a 6-sample slip of the launch edge
dec, sweeps, times, r = run(B.SimBoard(rate=10.0, seed=7, overrun_rate=0, bad_rate=0, slip_at=50))
ok(r["launch_maxabs"] >= 5 and status(r, "launch steadiness") == "CHECK", "a 6 sample launch slip shows up (max %.1f samples)" % r["launch_maxabs"])

# launch edge right at the 0 / 1000 wrap must not look like a 1000 sample jump
pk = bytearray()
rng = np.random.default_rng(1)
for i, k0 in enumerate([999.7, 0.4, 999.8, 0.3, 999.6, 0.5], start=1):
    pk += build_packet(B.synth_sweep(k0, rng=rng), i)
d = PacketDecoder()
sw = d.feed(bytes(pk))
rr = B.analyze(d, sw, [i * 0.1 for i in range(len(sw))])
ok(len(sw) == 6 and rr["launch_maxabs"] < 1.5, "launch at the wrap of the sweep: movement %.2f samples, not about 1000" % rr["launch_maxabs"])

# a warning belongs to the sweep that follows it; old firmware text (no numbers) counts as an overrun of unknown size
pk = bytearray(b"WARN: SAMPLER_OVERRUN idx=412 missed=2\r\n") + build_packet(B.synth_sweep(300, rng=rng), 1) + build_packet(B.synth_sweep(300, rng=rng), 2)
pk += b"WARN: SAMPLER_OVERRUN\r\n" + build_packet(B.synth_sweep(300, rng=rng), 3) + build_packet(B.synth_sweep(300, rng=rng), 6)
d = PacketDecoder()
sw = d.feed(bytes(pk))
rr = B.analyze(d, sw, [0.0, 0.1, 0.2, 0.3])
ok(rr["overrun_sweeps"] == 2 and rr["late_slots"] == 2 and rr["first_idx"] == (412, 412, 412) and rr["missing_ids"] == 2, "warning pairs with the next sweep; old text counted without numbers; ids 4 and 5 reported missing")

# nothing arrives
quiet = B.SimBoard(silent=True)
dec, sweeps, times = B.run_bench(quiet, 10.0, 3.0, clock=quiet.now)
rq = B.analyze(dec, sweeps, times)
ok(rq["sweeps"] == 0 and status(rq, "sweeps") == "BAD", "silent board: no sweeps, reported BAD, run ends by itself")

# command line
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = B.main(["--selftest", "-t", "8"])
out = buf.getvalue()
ok(code == 0 and "BENCH CHECK" in out and "sweep rate" in out and "launch steadiness" in out, "--selftest prints the full report and exits 0")

# the board must be told to stop
class Rec(B.SimBoard):
    writes = []

    def write(self, data):
        Rec.writes.append(bytes(data))
        super().write(data)


rec = Rec(seed=8)
B.run_bench(rec, 3.0, 3.0, clock=rec.now)
ok(Rec.writes[0] == b"S\n" and Rec.writes[-1] == b"I", "sends S to start and I at the end (%s ... %s)" % (Rec.writes[0], Rec.writes[-1]))

print("ALL PASSED" if not fails else "%d FAILED" % fails)
raise SystemExit(1 if fails else 0)

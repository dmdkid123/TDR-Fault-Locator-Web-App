"""Live capture from the ESP32 over USB serial, without the browser: read N sweeps, align and average them, apply the
ADC calibration, find the fault, print the distance.

    python3 live_capture.py COM5                       # Windows
    python3 live_capture.py /dev/cu.usbserial-0001 -n 16 --cal adc-calibration.json --vf 0.65

Needs pyserial (pip install pyserial). Packet format (firmware serial_protocol.h):
    [0xAA55 u16][count u16][sweepID u32][count x u16][CRC16 u16], little-endian, CRC16 poly 0xA001 init 0xFFFF over the samples.
Commands: 'S' starts streaming sweeps, 'I' stops. Everything outside a packet is ASCII status ("POST_PASSED: SYSTEM_READY",
"ERR: ...")."""
import argparse
import struct
import sys
import time

import numpy as np

from adc_cal import AdcCalibration
from dsp_engine import TDRSignalProcessor, align_and_average

BAUD = 921600
SAMPLES = 1000


def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def build_packet(samples, sweep_id):
    """Reference encoder (mirrors the firmware); used by the tests."""
    body = struct.pack("<%dH" % len(samples), *[int(s) & 0xFFFF for s in samples])
    return struct.pack("<HHI", 0xAA55, len(samples), sweep_id) + body + struct.pack("<H", crc16(body))


class PacketDecoder:
    """Feed it bytes in any chunking; it returns complete, CRC-checked sweeps and collects the ASCII text lines."""

    def __init__(self, expected=SAMPLES):
        self.buf = bytearray()
        self.expected = expected
        self.good = 0
        self.crc_errors = 0
        self.text = []
        self.last_id = None
        self.missed = 0
        self.events = []                       # in arrival order: ('text', line), ('sweep', id), ('crc', id); bench_check.py pairs warnings with sweeps

    def feed(self, chunk):
        self.buf += chunk
        sweeps = []
        while True:
            i = self.buf.find(b"\x55\xaa")
            if i < 0:
                keep = 1 if self.buf[-1:] == b"\x55" else 0          # a lone 0x55 may be half a marker
                self._text(bytes(self.buf[:len(self.buf) - keep]))
                del self.buf[:len(self.buf) - keep]
                break
            if i > 0:
                self._text(bytes(self.buf[:i]))
                del self.buf[:i]
            if len(self.buf) < 8:
                break
            _, count, sweep_id = struct.unpack_from("<HHI", self.buf)
            if count != self.expected:                               # false marker inside other data
                del self.buf[:1]
                continue
            total = 8 + 2 * count + 2
            if len(self.buf) < total:
                break
            body = bytes(self.buf[8:8 + 2 * count])
            (rx,) = struct.unpack_from("<H", self.buf, 8 + 2 * count)
            if crc16(body) == rx:
                if self.last_id is not None and sweep_id > self.last_id + 1:
                    self.missed += sweep_id - self.last_id - 1
                self.last_id = sweep_id
                self.good += 1
                self.events.append(("sweep", sweep_id))
                sweeps.append(np.frombuffer(body, dtype="<u2").astype(float))
                del self.buf[:total]
            else:
                self.crc_errors += 1
                self.events.append(("crc", sweep_id))
                del self.buf[:2]
        return sweeps

    def _text(self, raw):
        for line in raw.decode("latin1").splitlines():
            line = line.strip()
            if line and all(32 <= ord(c) < 127 for c in line):
                self.text.append(line)
                self.events.append(("text", line))


def read_sweeps(port, n, timeout=10.0, baud=BAUD):
    import serial                                                      # pip install pyserial
    dec = PacketDecoder()
    got = []
    with serial.Serial(port, baud, timeout=0.1) as ser:
        ser.reset_input_buffer()
        ser.write(b"S\n")
        t0 = time.time()
        try:
            while len(got) < n and time.time() - t0 < timeout:
                got += dec.feed(ser.read(4096))
        finally:
            ser.write(b"I")                                            # never leave the board sweeping
    if len(got) < n:
        raise RuntimeError("Only %d of %d sweeps arrived in %.0f s (crc errors %d). Status lines: %s"
                           % (len(got), n, timeout, dec.crc_errors, "; ".join(dec.text[-3:]) or "none"))
    return got[:n], dec


def measure(sweeps, cal=None, vf=0.65):
    """Raw sweeps -> (result dict, average info). `cal` is an AdcCalibration or None."""
    mean, info = align_and_average(sweeps)
    volts = cal.to_volts(mean) if cal is not None and cal.ready else mean / 4095.0 * 3.3
    proc = TDRSignalProcessor(velocity_factor=vf)
    _, _, found = proc.process_sweep(volts, launch_sample_index=info["launch"])
    return (found[0] if found else None), info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("port")
    ap.add_argument("-n", "--sweeps", type=int, default=16, help="sweeps to average (default 16, about 1.6 s)")
    ap.add_argument("--cal", help="ADC calibration JSON (from the web app or adc_cal.py)")
    ap.add_argument("--vf", type=float, default=0.65, help="velocity factor (default 0.65)")
    a = ap.parse_args(argv)
    cal = AdcCalibration.load(a.cal) if a.cal else None
    sweeps, dec = read_sweeps(a.port, a.sweeps)
    res, info = measure(sweeps, cal, a.vf)
    print("sweeps: %d good, %d crc errors, %d missed | averaged %d of %d (%d rejected), noise %.1f -> %.1f counts"
          % (dec.good, dec.crc_errors, dec.missed, info["used"], info["total"], info["rejected"], info["noise"], info["noise_avg"]))
    print("ADC calibration: " + ("%d points" % len(cal.points) if cal and cal.ready else "none (ideal counts / 4095 x 3.3 V)"))
    if res is None:
        print("No fault found.")
        return 0
    print("%s at %.3f m (round trip %.1f ns)" % (res["fault_type"], res["distance_m"], res["round_trip_time_ns"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())

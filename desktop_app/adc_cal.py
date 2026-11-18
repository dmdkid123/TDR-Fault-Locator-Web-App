"""ESP32 ADC calibration: a table of (counts, volts) points measured with known DC levels, applied as straight lines
between the points. Same JSON file as the web app's Setup > ADC calibration:
    {"version": 1, "bits": 12, "vref": 3.3, "points": [{"counts": 540.0, "volts": 0.4}, ...]}
Mirrors AdcCalibration in tdr-ui/js/device.js."""
import json
import numpy as np


class AdcCalibration:
    def __init__(self, bits=12, vref=3.3, points=None):
        self.bits = int(bits)
        self.vref = float(vref)
        self.points = []                       # sorted by counts: [(counts, volts), ...]
        for c, v in (points or []):
            self.add(c, v)

    @property
    def full(self):
        return 2 ** self.bits - 1

    @property
    def ready(self):
        return len(self.points) >= 2

    def add(self, counts, volts):
        """Add one reading (counts may be the mean of many). Raises ValueError if it contradicts the existing points."""
        counts, volts = float(counts), float(volts)
        if not (0 <= counts <= self.full):
            raise ValueError("ADC reading %s is outside 0 to %d." % (counts, self.full))
        if not (0 <= volts <= 5):
            raise ValueError("The voltage must be between 0 and 5 V.")
        pts = list(self.points)
        for i, (c, v) in enumerate(pts):
            if abs(c - counts) < 2:            # two readings of the same level: merge
                pts[i] = ((c + counts) / 2, (v + volts) / 2)
                break
        else:
            pts.append((counts, volts))
        pts.sort()
        for (c0, v0), (c1, v1) in zip(pts, pts[1:]):
            if not v1 > v0:
                raise ValueError("That point conflicts with the others: %.1f counts for %.3f V is not above %.1f counts "
                                 "for %.3f V. Check the meter reading and that the input was steady." % (c1, v1, c0, v0))
        self.points = pts
        return self

    def to_volts(self, counts):
        """counts (scalar or array) -> volts. With fewer than 2 points this is the ideal counts / full * vref line."""
        x = np.asarray(counts, dtype=float)
        if not self.ready:
            return x / self.full * self.vref
        c = np.array([p[0] for p in self.points])
        v = np.array([p[1] for p in self.points])
        out = np.interp(x, c, v)               # clamps outside the table, so extend the end segments by hand
        lo, hi = x < c[0], x > c[-1]
        out = np.where(lo, v[0] + (x - c[0]) * (v[1] - v[0]) / (c[1] - c[0]), out)
        out = np.where(hi, v[-1] + (x - c[-1]) * (v[-1] - v[-2]) / (c[-1] - c[-2]), out)
        return out if out.ndim else float(out)

    def max_deviation_mv(self):
        return max((abs(v - c / self.full * self.vref) * 1000 for c, v in self.points), default=0.0)

    def to_dict(self):
        return {"version": 1, "bits": self.bits, "vref": self.vref,
                "points": [{"counts": round(c, 2), "volts": round(v, 4)} for c, v in self.points]}

    @classmethod
    def from_dict(cls, d):
        if not isinstance(d, dict) or not isinstance(d.get("points"), list):
            raise ValueError('That is not an ADC calibration file (it has no "points" list).')
        return cls(d.get("bits", 12), d.get("vref", 3.3), [(p["counts"], p["volts"]) for p in d["points"]])

    def save(self, path):
        with open(path, "w") as f:
            json.dump(self.to_dict(), f, indent=2)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            return cls.from_dict(json.load(f))

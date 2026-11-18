# TDR Fault Locator (user interface)

A dashboard for the ECE 480 Team 10 TDR wiring fault locator. It reads a capture from the board (USB serial) or from a scope file, finds the reflections, says what kind of fault it is and how far away, then shows where that is on the vehicle's wiring in 3D. No installs, no build step, no internet needed.

## Run it in VS Code

1. Open this folder in VS Code.
2. Install the **Live Server** extension (VS Code will suggest it).
3. Right-click `index.html` and choose **Open with Live Server**.

No Live Server? In a terminal inside this folder run `py -m http.server 5500` and open http://localhost:5500. Double-clicking `index.html` also works for everything except possibly USB serial.

Use **Chrome or Edge**. USB serial (Web Serial) is not available in Firefox or Safari. CSV files, the demo and the 3D view work in any current browser.

## The four tabs

| Tab | What it does |
|---|---|
| Measure | Connect the board (or the virtual device, or open a scope CSV), see the trace, get the verdict: fault type, distance, and the wire segment and XYZ position. |
| 3D locator | Orbit and zoom the harness with the fault marked and a search zone highlighted. Optional vehicle body from an STL. |
| Demo | Animated walkthrough of one measurement in five stages (launch, reflect, reconstruct, analyze, locate) with six scenarios. It runs the same analysis code as Measure. "Open in Measure" sends the demo capture into the real pipeline. |
| Setup | Velocity factor, impedance, rise time, thresholds, time stretch, device settings, velocity calibration, harness JSON, STL. |

## Connecting the device

Press **Connect USB device**, pick the board's serial port, then **Capture**. Settings are in Setup, under Device connection.

The board should send plain text lines at the configured baud rate (default 115200):

```
START                 optional
<time>,<value>        one per sample, e.g. 1.250000000e-03,2.4871
...
END                   optional
```

- `time` is the time on the **stretched** waveform (what the scope would show). With the 1 MHz / 10 Hz sampler the stretch is 100000, which is the default.
- A single `value` per line also works; set the sample interval in Setup.
- ADC counts work: choose "ADC counts", then set the bits and reference voltage.
- Without `END`, a capture finishes after a short pause in the data. Lines that start with a letter (log messages) are ignored.
- If "Capture command" in Setup is not empty (default `MEASURE`), the app sends it plus a newline when you press Capture. Clear it if the board streams on its own.

The **virtual device** streams a simulated capture through exactly the same line parser, so you can test the whole path with no hardware.

## Scope CSV files

Any CSV with a time column and a voltage column. Header units like `Time (ms)` and `(mV)` are understood, as is the units row PicoScope writes. Drag the file onto the page or use **Open scope CSV**. Add a **known-good reference** (the same circuit on a healthy harness) to remove normal connector and splice reflections.

Samples are in `sample/`. Load `fuel_pump_open_1p9m.csv` with the default settings and you should get an open circuit at 1.90 m. Load `fuel_pump_good_reference.csv` as the reference to see the connector reflection disappear.

## Using the real vehicle

The built-in harness and body are mock geometry. To use the real data:

1. **Harness.** Setup > Harness model takes JSON: `nodes` (name: [x, y, z] in mm), and `nets` (one per circuit: a `root` node at the test point and `segments` with `from`, `to`, optional `via` points along the route, optional `length_mm`, optional `color`). Export the wire routes from the 3D CAD into this shape. `electrical_length_factor` (default 1.03 in the example) accounts for twist and slack.
2. **Vehicle body.** Setup > Vehicle body > Load STL (binary or ASCII, millimetres, same coordinate frame as the harness).
3. **Velocity factor.** Capture an open-ended wire of known length, enter the length in Setup > Calibrate, press the button. A 3% error is about 9 cm at 3 m, so do this before trusting distances.

## How the answer is worked out

Time stretch removed, then: launch edge found, step normalised to a reflection coefficient, steep edges detected, each edge's step size classified (open about +1, short about -1, partial values are resistive shorts or high resistance), time converted to distance with `d = vp x c x t / 2`, then walked along the circuit's wire route. The analysis is a line-by-line port of `tdr_locator.py` and the two give identical results on the same data.

## Limits to know about

- First-order model: distances are reliable, amplitudes beyond a splice or a partial fault are approximate.
- Blind zone of about 0.3 m after the test point with a 1 ns edge; two features closer than about 10 cm merge.
- The first real fault along the wire is the one reported. Beyond a break nothing is visible.
- Where a circuit branches the echo cannot say which branch, so every branch at that distance is marked.
- A reflection within the search zone of a circuit's far end is treated as the expected end of line.
- 3D positions are only as good as the CAD routes and the velocity factor.

## Tests

Needs Node.js (no packages):

```
node test/tdr.test.js       # engine: math, fault types, accuracy sweep, noise, harness mapping
node test/device.test.js    # CSV and serial line parsing
```

## Files

```
index.html          the page
css/style.css       styles
js/tdr.js           analysis engine (port of tdr_locator.py)
js/harness_data.js  example harness (mock geometry)
js/device.js        CSV parser, USB serial, virtual device
js/chart.js         scope-style trace
js/viewer.js        WebGL 3D viewer (no libraries)
js/carmesh.js       placeholder body + STL reader
js/demo.js          Demo tab
js/app.js           ties it together
sample/             example captures
test/               Node tests
```

## Added in version 6

- **Live view**: "Start live view" under Capture keeps the board sweeping and updates the trace and the result about 10 times a second.
- **Reference in one click**: "Use this capture as reference" takes the trace on screen as the healthy reference. The reference is lined up on the launch edge before it is subtracted.
- **Branched circuits**: the normal reflection of a junction (about -1/3) is recognised and not reported as a fault. Reflections past a junction are corrected for the signal lost there (4/9 for a two-way split). With a healthy reference loaded, the app picks the faulty branch from the end-of-wire echo that has disappeared.
- **Sub-sample timing**: edges are timed where they cross their halfway level, by interpolating between samples. At 1 ns per sample the worst error in the tests drops from 8.6 cm to 1.7 cm.
- **Board log**: messages from the board and counts of good sweeps, checksum failures and dropped overrun sweeps, under the Device card.
- **Calibration steps** in Setup, with saved wire types.
- **History** of the last 12 captures (show, compare on the trace, use as reference) and **Print report** (use the browser's "Save as PDF").
- **Virtual device**: models wire ends and junctions, has a "No fault (healthy)" option, and lets you pick the branch for the fault.
- The binary sweep is rotated using the longest low stretch, not the biggest rising edge, so an open circuit is no longer mistaken for the launch edge.

Always replace the whole folder from the zip. If index.html and the scripts are from different versions, the page shows a red bar saying so.

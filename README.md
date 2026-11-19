# TDR Fault Locator (ECE 480 Team 10)

Everything for the project in one folder: the web app that reads the board and finds the fault, and the ESP32 firmware.

```
TDR-Fault-Locator/
  index.html, css/, js/   the web app (this is also what the GitHub Pages site serves)
  sample/                 example scope captures to try without the board
  test/                   web app tests (Node.js)
  firmware/               ESP32 firmware, PlatformIO project
    src/                  main.cpp, adc_sampler.h, serial_protocol.h, si5351_driver.h
    host_test/run.sh      checks the firmware on a PC, including that the web app decodes its packets
```

## Run the web app in VS Code

1. **File > Open Folder** and pick this `TDR-Fault-Locator` folder.
2. Install **Live Server** when VS Code suggests it (or from the Extensions panel).
3. Right-click `index.html` and choose **Open with Live Server**. It opens at http://127.0.0.1:5500.

No Live Server? **Terminal > Run Task > Start web app (no extension needed)**, then open http://localhost:5500. It needs Python.

Use **Chrome or Edge**. The USB connection to the board only works in those two. Everything else (CSV files, the demo, the 3D view) works in any current browser.

## Measure with the board

1. Plug the ESP32 into USB. Close the Arduino or PlatformIO serial monitor if it is open, because only one program can use the port.
2. Press **Connect USB device** and pick the board's port (it shows as `10c4:ea60` or similar).
3. Press **Capture** for one measurement, or **Start live view** to measure continuously.

The defaults match the firmware: binary sweep packets at 921600 baud, 1000 samples 100 µs apart, which is 1 ns per sample after the 100,000× time stretch. If you changed **Setup > Sample interval**, set it back to **100**, or every distance is off.

The **Board log** under the Device card shows what the board reports and, after each capture, how many sweeps were used and why any were dropped.

### Testing a plain cable on the bench

Under **Circuit under test**, pick **BENCH_CABLE**.

- **Length known:** type it in feet. The far end is reported as the expected end of line, not a fault.
- **Length unknown:** leave it blank. The first full open is taken as the far end and the app shows **Measured cable length**. A break looks the same as the end of a cable, so enter the length when you know it.

The pulse bounces between the far end and the board, so a trace also shows repeats past the end of the cable. Those are listed as **Echo past the end**, not as faults.

Distances depend on the velocity factor (0.66 by default). Calibrate it once per cable type in **Setup > Calibration**, using a piece of known length with the far end open.

## Update the GitHub Pages site

The site is the top level of this folder. Copy `index.html`, `css/`, `js/`, `sample/` and `test/` into the repository (keep their folder names), commit and push. The site updates within a minute or two. Then press Ctrl+F5 on it.

If the page shows a red bar saying the files are from different versions, `index.html` and `js/app.js` do not match. Upload both from this folder.

## Build and flash the firmware

1. Install the **PlatformIO IDE** extension.
2. Open the `firmware` folder in its own VS Code window (**File > Open Folder > firmware**). PlatformIO needs `platformio.ini` at the top of the window's folder.
3. Use the PlatformIO toolbar at the bottom: check mark to build, arrow to upload. The serial monitor is already set to 921600.

To check the firmware without hardware (Linux, macOS or WSL, with g++, Python 3 and Node.js): `sh firmware/host_test/run.sh`.

## Run the web app tests

**Terminal > Run Task > Run web app tests**, or `node test/tdr.test.js` and `node test/device.test.js`. Needs Node.js.

## The four tabs

| Tab | What it does |
|---|---|
| Measure | Connect the board (or the virtual device, or open a scope CSV), see the trace, get the verdict: fault type, distance, and where it is on the circuit. History, report printing and live view are here too. |
| 3D locator | Orbit and zoom the harness with the fault marked and a search zone highlighted. |
| Demo | Animated walkthrough of one measurement in five stages with six example faults. It runs the same analysis code as Measure. |
| Setup | Velocity factor, impedance, thresholds, time stretch, device settings, calibration, harness JSON. |

## Known hardware issues (19 Nov)

- **Signal near the top of the ADC.** Right after the pulse the board reads about 3,750 of 4,095 counts, where the ESP32 ADC (11 dB setting) stops being accurate (Espressif rates it to about 2.45 V). An open roughly doubles the voltage, so it can be squashed. A resistor divider on the sampler's WAVE output into GPIO34, sized so the pulse step reaches only about 1.0 to 1.2 V, leaves room for it.
- **Signal sag.** The level drifts back toward the middle on both halves of each sweep, as if AC-coupled with roughly a 40 ms time constant in real time. The app copes with it, but it shrinks the steps from faults far down the wire.
- **Unexplained drop at 0.58 m** with the 5.1 ft test cord after the connector was changed. It was not there with nothing connected.

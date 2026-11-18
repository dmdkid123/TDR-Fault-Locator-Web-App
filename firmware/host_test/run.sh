#!/bin/sh
cd "$(dirname "$0")" || exit 1
SRC=../src
INC="-std=c++17 -Wall -I stubs -I $SRC"
fail() { echo "FAILED: $1"; exit 1; }

g++ $INC host_si.cpp -o /tmp/tdr_si || fail "compiling host_si.cpp"
echo "--- default: both clocks on PLLA (schematic) ---"
/tmp/tdr_si | python3 decode_si.py || fail "decoding the Si5351 registers"
echo "--- CLK1 on PLLB (build flag alternative) ---"
g++ $INC -DSI5351_CLK1_ON_PLLB host_si.cpp -o /tmp/tdr_si_b || fail "compiling host_si.cpp with SI5351_CLK1_ON_PLLB"
/tmp/tdr_si_b | python3 decode_si.py || fail "decoding the PLLB variant"
g++ $INC host_pkt.cpp -o /tmp/tdr_pkt || fail "compiling host_pkt.cpp"
/tmp/tdr_pkt > /tmp/tdr_pkt.bin
node feed.js /tmp/tdr_pkt.bin || fail "decoding packets with device.js"
g++ $INC host_fill.cpp -o /tmp/tdr_fill || fail "compiling host_fill.cpp"
/tmp/tdr_fill || fail "fillSlots check"
# The warning text must match what the web app parses: /SAMPLER_OVERRUN idx=(-?\d+) missed=(\d+)/ (agreed with David)
FMT=$(sed -n 's/.*Serial.printf("\(WARN: SAMPLER_OVERRUN[^"]*\)\\n".*/\1/p' $SRC/main.cpp)
[ -n "$FMT" ] || fail "WARN: SAMPLER_OVERRUN printf not found in main.cpp"
printf "$FMT\n" 412 2 | node -e 'const l=require("fs").readFileSync(0,"utf8").trim(),m=/SAMPLER_OVERRUN idx=(-?\d+) missed=(\d+)/.exec(l);if(!m||m[1]!=="412"||m[2]!=="2"){console.log("BAD LINE:",l);process.exit(1)}console.log("warning text matches the agreed format:",l)' || fail "warning text does not match the agreed format"
for v in 3 2; do
  g++ $INC -DESP_ARDUINO_VERSION_MAJOR=$v -fsyntax-only -x c++ $SRC/main.cpp || fail "main.cpp for Arduino-ESP32 $v.x"
  echo "main.cpp compiles for Arduino-ESP32 $v.x"
done

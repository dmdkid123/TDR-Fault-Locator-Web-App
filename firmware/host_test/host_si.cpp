#include <Arduino.h>
#include <Wire.h>
#include "si5351_driver.h"
int main() { Si5351ClockGen g; bool ok = g.begin(21, 22); printf("begin=%d\n", ok); for (int r = 0; r < 256; r++) if (Wire.regs[r] && r) printf("%d %d\n", r, Wire.regs[r]); return 0; }

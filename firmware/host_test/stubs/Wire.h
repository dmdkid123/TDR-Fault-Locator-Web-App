#pragma once
#include <Arduino.h>
struct TwoWire {
  uint8_t regs[256] = {0}; uint8_t buf[64]; int n = 0; int rdReg = 0;
  void begin(int, int, uint32_t) {}
  void beginTransmission(uint8_t) { n = 0; }
  size_t write(uint8_t v) { buf[n++] = v; return 1; }
  size_t write(const uint8_t* p, size_t len) { for (size_t i = 0; i < len; i++) buf[n++] = p[i]; return len; }
  uint8_t endTransmission(bool = true) { if (n >= 2) for (int i = 1; i < n; i++) regs[(buf[0] + i - 1) & 0xFF] = buf[i]; else if (n == 1) rdReg = buf[0]; return 0; }
  uint8_t requestFrom(uint8_t, uint8_t) { return 1; }
  int read() { return regs[rdReg]; }   // status register (0) reads 0: SYS_INIT clear, both PLLs locked
};
static TwoWire Wire;

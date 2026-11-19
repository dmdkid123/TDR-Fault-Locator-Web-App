#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 3
#endif
#define IRAM_ATTR
#define INPUT 0
#define INPUT_PULLDOWN 1
#define OUTPUT 2
#define HIGH 1
#define LOW 0
#define FALLING 2
#define ADC_11db 3
#define digitalPinToInterrupt(p) (p)
inline void pinMode(int, int) {}
inline void digitalWrite(int, int) {}
inline void attachInterrupt(int, void (*)(), int) {}
inline void analogReadResolution(int) {}
inline void analogSetPinAttenuation(int, int) {}
inline int analogRead(int) { return 0; }
inline unsigned long millis() { return 0; }
inline unsigned long micros() { return 0; }
inline void delay(unsigned long) {}
inline void yield() {}
struct hw_timer_s; typedef hw_timer_s hw_timer_t;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
inline hw_timer_t* timerBegin(uint32_t) { return nullptr; }
inline void timerAttachInterrupt(hw_timer_t*, void (*)()) {}
inline void timerAlarm(hw_timer_t*, uint64_t, bool, uint64_t) {}
inline void timerRestart(hw_timer_t*) {}
#else
inline hw_timer_t* timerBegin(uint8_t, uint16_t, bool) { return nullptr; }
inline void timerAttachInterrupt(hw_timer_t*, void (*)(), bool) {}
inline void timerAlarmWrite(hw_timer_t*, uint64_t, bool) {}
inline void timerAlarmEnable(hw_timer_t*) {}
inline void timerWrite(hw_timer_t*, uint64_t) {}
#endif
struct HardwareSerial {
  void begin(unsigned long) {}
  int available() { return 0; }
  int read() { return -1; }
  void flush() {}
  size_t write(const uint8_t* b, size_t n) { return fwrite(b, 1, n, stdout); }
  void println(const char* s) { fprintf(stderr, "%s\n", s); }
  __attribute__((format(printf, 2, 3))) void printf(const char* f, ...) { va_list ap; va_start(ap, f); vfprintf(stderr, f, ap); va_end(ap); }
};
static HardwareSerial Serial;

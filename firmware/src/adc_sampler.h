#ifndef ADC_SAMPLER_H
#define ADC_SAMPLER_H

#include <Arduino.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "soc/gpio_struct.h"

#define SAMPLES_PER_SWEEP  1000
#define SAMPLE_INTERVAL_US 100   // 100 us * 1000 = 100 ms sweep window

// ---------------------------------------------------------------------------
// Equivalent-time sampler.
//
//  * The sweep-sync pin (GPIO27, falling edge = start of a 10 Hz beat) restarts a
//    hardware timer, so sample 0 is phase-locked to the beat every sweep.
//  * The timer fires every 100 us and only wakes a high-priority FreeRTOS task
//    (pinned to core 0). The task performs analogRead(), which is NOT ISR-safe,
//    so the ADC is never touched from interrupt context.
//  * Because of the 100,000x time expansion, 1 us of real-time jitter is only
//    10 ps of equivalent time (~0.1 mm of cable), so timer + task wake latency
//    is negligible, unlike the old micros() spin-wait which blocked the CPU.
//
// Works with Arduino-ESP32 core 2.x and 3.x (timer API differs; handled below).
// ---------------------------------------------------------------------------

class ETSSampler {
public:
    static volatile bool     armed;       // waiting for next sync edge
    static volatile bool     capturing;   // sweep in progress
    static volatile bool     sweepReady;  // full sweep in buffer
    static volatile uint32_t missedSlots; // sample slots the task was late for this sweep (filled, not skipped)
    static volatile int16_t  firstMissIdx;// sample index of the first late slot, -1 if none
    static volatile uint16_t sampleIndex;
    static uint16_t          sampleBuffer[SAMPLES_PER_SWEEP];

    void init(int syncPin, int adcPin) {
        s_adcPin  = adcPin;
        s_syncPin = syncPin;

        pinMode(syncPin, INPUT_PULLDOWN);
        pinMode(adcPin, INPUT);
        analogReadResolution(12);
        analogSetPinAttenuation(adcPin, ADC_11db); // 0..~3.1 V range

        xTaskCreatePinnedToCore(samplerTask, "ets_adc", 4096, nullptr,
                                configMAX_PRIORITIES - 1, &s_task, 0);   // F5: highest priority on core 0 so nothing delays a sample

        // The sample timer is created by samplerTask on core 0 (F2) so its interrupt runs on
        // core 0, away from the GPIO27 sync interrupt that attaches here on the Arduino core.
        for (int t = 0; s_timer == nullptr && t < 500; t++) delay(1);
        attachInterrupt(digitalPinToInterrupt(syncPin), onSweepSyncISR, FALLING);
    }

    // Arm for the next sync edge. Call after the previous sweep has been consumed.
    void arm() {
        sweepReady   = false;
        missedSlots  = 0;
        firstMissIdx = -1;
        armed        = true;
        // F1: the sync flip-flop can bounce while CLK0/CLK1 edges line up. The ISR switches its own
        // interrupt off at the first edge of a sweep; switch it on again here, after clearing any
        // edge that latched while it was off.
        GPIO.status_w1tc = (1UL << s_syncPin);
        gpio_intr_enable((gpio_num_t)s_syncPin);
    }

    void disarm() {
        armed = false;
        gpio_intr_disable((gpio_num_t)s_syncPin);
    }

    // True once per completed sweep; data is then valid in sampleBuffer
    // until arm() is called again.
    bool captureSweep() {
        if (!sweepReady) return false;
        sweepReady = false;
        return true;
    }

private:
    static int           s_adcPin;
    static int           s_syncPin;
    static hw_timer_t* volatile s_timer;
    static TaskHandle_t  s_task;

    // The interrupt routines are defined below the class, NOT inline here: an inline (header) member with IRAM_ATTR gets its
    // literal pool placed outside IRAM and the linker stops with "dangerous relocation: l32r: literal placed after use".
    static void onSweepSyncISR();
    static void onSampleTimerISR();

public:
    // Fill the slots the task was late for. The ADC reading `v` belongs to the LAST due slot
    // (slot i+slots-1), so earlier due slots are interpolated from the previous sample to `v`.
    // Returns the new sample index. Pure function so host_test can check it.
    static uint16_t fillSlots(uint16_t* buf, uint16_t i, uint16_t v, uint32_t slots) {
        uint16_t prev = (i > 0) ? buf[i - 1] : v;
        for (uint32_t k = 0; k < slots && i < SAMPLES_PER_SWEEP; k++) {
            int32_t x = (int32_t)prev + ((int32_t)v - (int32_t)prev) * (int32_t)(k + 1) / (int32_t)slots;
            buf[i++] = (uint16_t)x;
        }
        return i;
    }

private:
    static void startTimer() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
        hw_timer_t* t = timerBegin(1000000);                 // 1 MHz tick
        timerAttachInterrupt(t, &onSampleTimerISR);
        timerAlarm(t, SAMPLE_INTERVAL_US, true, 0);          // auto-reload every 100 us
#else
        hw_timer_t* t = timerBegin(0, 80, true);             // 80 MHz / 80 = 1 MHz tick
        timerAttachInterrupt(t, &onSampleTimerISR, true);
        timerAlarmWrite(t, SAMPLE_INTERVAL_US, true);
        timerAlarmEnable(t);
#endif
        s_timer = t;                                         // init() waits for this
    }

    static void samplerTask(void*) {
        startTimer();                                        // F2: runs on core 0
        for (;;) {
            uint32_t pending = ulTaskNotifyTake(pdTRUE, portMAX_DELAY); // clears count
            if (!capturing) continue;

            uint16_t i = sampleIndex;
            if (i >= SAMPLES_PER_SWEEP) continue;
            uint16_t v = (uint16_t)analogRead(s_adcPin);

            // F3: `pending` ticks are due. A late task fills the missed slots instead of shifting
            // every later sample by 1 ns. At index 0 the notify count can include the sync wake-up
            // plus a stale tick, which is not a real miss.
            uint32_t slots = (i == 0 || pending == 0) ? 1 : pending;
            if (slots > 1) {
                missedSlots = missedSlots + (slots - 1);
                if (firstMissIdx < 0) firstMissIdx = (int16_t)i;
            }
            i = fillSlots(sampleBuffer, i, v, slots);
            sampleIndex = i;
            if (i >= SAMPLES_PER_SWEEP) {
                capturing  = false;
                sweepReady = true;
            }
        }
    }
};

volatile bool     ETSSampler::armed       = false;
volatile bool     ETSSampler::capturing   = false;
volatile bool     ETSSampler::sweepReady  = false;
volatile uint32_t ETSSampler::missedSlots = 0;
volatile int16_t  ETSSampler::firstMissIdx = -1;
volatile uint16_t ETSSampler::sampleIndex = 0;
uint16_t          ETSSampler::sampleBuffer[SAMPLES_PER_SWEEP];
int               ETSSampler::s_adcPin    = 34;
int               ETSSampler::s_syncPin   = 27;
hw_timer_t* volatile ETSSampler::s_timer  = nullptr;
TaskHandle_t      ETSSampler::s_task      = nullptr;

void IRAM_ATTR ETSSampler::onSweepSyncISR() {
    gpio_intr_disable((gpio_num_t)s_syncPin);   // one edge per arm(); bounces must not re-enter
    if (!armed || capturing) return;
    armed       = false;
    sampleIndex = 0;
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    timerRestart(s_timer);          // phase-lock the 100 us grid to the beat
#else
    timerWrite(s_timer, 0);
#endif
    capturing = true;
    BaseType_t woken = pdFALSE;     // sample 0 is taken immediately at sync
    vTaskNotifyGiveFromISR(s_task, &woken);
    if (woken == pdTRUE) { portYIELD_FROM_ISR(); }
}

void IRAM_ATTR ETSSampler::onSampleTimerISR() {
    if (!capturing) return;
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(s_task, &woken);
    if (woken == pdTRUE) { portYIELD_FROM_ISR(); }
}

#endif

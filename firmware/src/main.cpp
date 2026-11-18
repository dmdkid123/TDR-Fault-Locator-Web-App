#include <Arduino.h>
#include "si5351_driver.h"
#include "adc_sampler.h"
#include "serial_protocol.h"

#define PIN_SDA        21
#define PIN_SCL        22
#define PIN_PULSE_EN   -1   // not wired in the POC (pulse driver always on); set a GPIO here if you add an enable. GPIO17 is PSRAM on WROVER boards.
#define PIN_SWEEP_SYNC 27
#define PIN_ADC_INPUT  34   // WAVE output of the sampler (POC schematic), ADC1_CH6, input-only

enum SystemState { STATE_POST, STATE_IDLE, STATE_SWEEPING, STATE_ERROR };

SystemState  currentState = STATE_POST;
Si5351ClockGen clockGen;
ETSSampler   sampler;
uint32_t     sweepCounter = 0;
uint32_t     lastArmMs    = 0;
uint32_t     lastWarnMs   = 0;
static uint16_t sendBuffer[SAMPLES_PER_SWEEP];   // F6: copy of the finished sweep, sent while the next one is captured

static inline void pulseEnable(bool on) {
    if (PIN_PULSE_EN >= 0) digitalWrite(PIN_PULSE_EN, on ? HIGH : LOW);
}

static void enterSweeping() {
    sampler.arm();
    lastArmMs  = millis();
    lastWarnMs = lastArmMs;
    currentState = STATE_SWEEPING;
}

static void enterIdle() {
    sampler.disarm();
    currentState = STATE_IDLE;
}

void setup() {
    Serial.begin(SERIAL_BAUD);
    if (PIN_PULSE_EN >= 0) pinMode(PIN_PULSE_EN, OUTPUT);
    pulseEnable(false);

    if (!clockGen.begin(PIN_SDA, PIN_SCL)) {
        currentState = STATE_ERROR;
        Serial.println("ERR: SI5351_I2C_FAILED");
        return;
    }

    sampler.init(PIN_SWEEP_SYNC, PIN_ADC_INPUT);

    // F5: time 100 analogRead() calls. One read must be well under the 100 us sample slot.
    {
        uint32_t t0 = micros();
        for (int k = 0; k < 100; k++) (void)analogRead(PIN_ADC_INPUT);
        Serial.printf("INFO: ADC_US=%.1f\n", (micros() - t0) / 100.0f);
    }
    pulseEnable(true);
    currentState = STATE_IDLE;
    Serial.println("POST_PASSED: SYSTEM_READY");
}

void loop() {
    if (Serial.available() > 0) {
        char cmd = Serial.read();
        if (cmd == 'S' && currentState == STATE_IDLE)           enterSweeping();
        else if (cmd == 'I' && currentState == STATE_SWEEPING)  enterIdle();
    }

    switch (currentState) {
        case STATE_IDLE:
            break;

        case STATE_SWEEPING:
            if (sampler.captureSweep()) {
                sweepCounter++;
                // F6: copy the sweep and re-arm at once, so the next beat (100 ms later) is not missed while
                // this packet is being sent. Without the copy the send had to finish first (about 5 sweeps/s).
                memcpy(sendBuffer, ETSSampler::sampleBuffer, sizeof(sendBuffer));
                const uint32_t missed    = ETSSampler::missedSlots;    // read before arm() resets them
                const int      firstMiss = (int)ETSSampler::firstMissIdx;
                sampler.arm();
                lastArmMs = millis();
                if (missed > 0) {      // must print BEFORE the packet; the app pairs it with that sweep
                    Serial.printf("WARN: SAMPLER_OVERRUN idx=%d missed=%u\n", firstMiss, (unsigned)missed);
                }
                SerialProtocol::sendPacket(sendBuffer, SAMPLES_PER_SWEEP, sweepCounter);
            } else if (millis() - lastArmMs > 1000 && millis() - lastWarnMs > 1000) {
                Serial.println("WARN: NO_SWEEP_SYNC");   // GPIO27 beat signal missing
                lastWarnMs = millis();
            }
            break;

        case STATE_ERROR:
            pulseEnable(false);
            Serial.println("ERR: SI5351_I2C_FAILED");
            delay(2000);   // repeat so a host that connects late still sees it
            break;

        default:
            break;
    }
}

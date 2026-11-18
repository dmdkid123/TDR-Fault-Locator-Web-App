// Checks ETSSampler::fillSlots (F3): missed slots are interpolated, indexes never shift, the sweep never overflows.
#include <Arduino.h>
#include "adc_sampler.h"
static int bad = 0;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); bad++; } } while (0)
int main() {
    static uint16_t buf[SAMPLES_PER_SWEEP] = {0};
    // on time: one slot, the reading lands at its own index
    buf[9] = 100; uint16_t i = ETSSampler::fillSlots(buf, 10, 200, 1);
    CHECK(i == 11 && buf[10] == 200);
    // 3 slots due (2 missed): 100 -> 400 gives 200, 300, 400 at 10..12, next index is 13
    buf[9] = 100; i = ETSSampler::fillSlots(buf, 10, 400, 3);
    CHECK(i == 13 && buf[10] == 200 && buf[11] == 300 && buf[12] == 400);
    // falling values and 12-bit extremes stay in range
    buf[19] = 4095; i = ETSSampler::fillSlots(buf, 20, 0, 4);
    CHECK(i == 24 && buf[20] == 3072 && buf[21] == 2048 && buf[22] == 1024 && buf[23] == 0);
    // index 0 has no previous sample: all slots take the reading
    i = ETSSampler::fillSlots(buf, 0, 777, 1); CHECK(i == 1 && buf[0] == 777);
    // at the end of the sweep extra slots are dropped, never written past the buffer
    buf[SAMPLES_PER_SWEEP - 2] = 10; i = ETSSampler::fillSlots(buf, SAMPLES_PER_SWEEP - 1, 50, 5);
    CHECK(i == SAMPLES_PER_SWEEP);
    if (bad) return 1;
    puts("fillSlots OK");
    return 0;
}

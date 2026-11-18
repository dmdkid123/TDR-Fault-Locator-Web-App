#ifndef SERIAL_PROTOCOL_H
#define SERIAL_PROTOCOL_H

#include <Arduino.h>

#ifndef SAMPLES_PER_SWEEP
#define SAMPLES_PER_SWEEP 1000
#endif

// 921600 baud moves a 2010-byte packet in ~22 ms. At 115200 it takes ~175 ms,
// which cannot keep up with the 10 sweeps/s the hardware produces.
#define SERIAL_BAUD 921600

// Wire format (all fields little-endian, which is native on the ESP32):
//   [0xAA55 u16][sampleCount u16][sweepID u32][sampleCount x u16][CRC16 u16]
// CRC16: poly 0xA001 (reflected 0x8005, "MODBUS"), init 0xFFFF, over the sample bytes only.
// On the wire the sync marker therefore appears as bytes 0x55 0xAA.
struct __attribute__((packed)) SweepPacketHeader {
    uint16_t syncMarker;   // 0xAA55
    uint16_t sampleCount;  // 1000
    uint32_t sweepID;      // monotonic counter
};
static_assert(sizeof(SweepPacketHeader) == 8, "SweepPacketHeader must be 8 bytes");

class SerialProtocol {
public:
    static uint16_t crc16(const uint8_t* data, size_t len) {
        uint16_t crc = 0xFFFF;
        for (size_t i = 0; i < len; i++) {
            crc ^= data[i];
            for (int j = 0; j < 8; j++) {
                if (crc & 1) crc = (crc >> 1) ^ 0xA001;
                else         crc >>= 1;
            }
        }
        return crc;
    }

    static bool sendPacket(const uint16_t* samples, uint16_t count, uint32_t sweepId) {
        if (count > SAMPLES_PER_SWEEP) return false;

        // Assemble the whole packet and issue ONE write so nothing interleaves with it
        static uint8_t txBuf[sizeof(SweepPacketHeader) + SAMPLES_PER_SWEEP * 2 + 2];

        SweepPacketHeader header = { 0xAA55, count, sweepId };
        const size_t payloadLen = (size_t)count * sizeof(uint16_t);
        uint16_t crc = crc16((const uint8_t*)samples, payloadLen);

        size_t n = 0;
        memcpy(txBuf + n, &header, sizeof(header));  n += sizeof(header);
        memcpy(txBuf + n, samples, payloadLen);      n += payloadLen;
        memcpy(txBuf + n, &crc, sizeof(crc));        n += sizeof(crc);

        Serial.write(txBuf, n);
        return true;
    }
};

#endif

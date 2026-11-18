#include <Arduino.h>
#include "serial_protocol.h"
int main() { static uint16_t s[1000]; for (int i = 0; i < 1000; i++) s[i] = (i * 37 + (i > 500 ? 1800 : 0)) & 0x0FFF; SerialProtocol::sendPacket(s, 1000, 7); SerialProtocol::sendPacket(s, 1000, 8); return 0; }

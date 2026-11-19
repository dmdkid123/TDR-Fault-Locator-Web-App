#pragma once
#include "FreeRTOS.h"
#include <stdint.h>
inline int xTaskCreatePinnedToCore(void (*)(void*), const char*, uint32_t, void*, UBaseType_t, TaskHandle_t*, BaseType_t) { return 1; }
inline void vTaskNotifyGiveFromISR(TaskHandle_t, BaseType_t*) {}
inline uint32_t ulTaskNotifyTake(BaseType_t, uint32_t) { return 1; }

#pragma once
#include <stdint.h>
struct gpio_dev_t { uint32_t status_w1tc; };
static gpio_dev_t GPIO;

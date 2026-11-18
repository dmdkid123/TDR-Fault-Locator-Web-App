#pragma once
typedef int gpio_num_t;
inline int gpio_intr_enable(gpio_num_t) { return 0; }
inline int gpio_intr_disable(gpio_num_t) { return 0; }

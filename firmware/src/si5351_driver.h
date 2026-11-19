#ifndef SI5351_DRIVER_H
#define SI5351_DRIVER_H

#include <Arduino.h>
#include <Wire.h>

// ---------------------------------------------------------------------------
// Si5351A driver for the TDR clock pair
//
//   CLK0 = 1,000,000 Hz  (pulse drive)      PLLA = 25 MHz x 36 = 900.000000 MHz, MS0 = /900 (integer)
//   CLK1 =   999,990 Hz  (sampling strobe)
//
// Default (matches the POC schematic, "CLK0 and CLK1 both run on PLL A"):
//   CLK1 also uses PLLA; MS1 = 900 + 100/11111 = 900.009000090 (fractional), 900 MHz / that = 999,990.0000 Hz exactly.
//   Both outputs share one VCO, so VCO phase noise is common to both and cancels in their relative timing.
// Alternative, build with -DSI5351_CLK1_ON_PLLB:
//   PLLB = 25 MHz x (35+24991/25000) = 899.991000 MHz, MS1 = /900 (integer divider, less divider jitter, separate VCO).
//   Use whichever shows less edge jitter on the scope.
// Assumes a 25 MHz crystal (standard on Si5351A breakouts).
// Register map / formulas: Silicon Labs AN619.
// ---------------------------------------------------------------------------

#define SI5351_I2C_ADDR       0x60
#define SI5351_XTAL_HZ        25000000UL

// Crystal load capacitance (reg 183, bits 7:6; low bits must stay 010010).
//   0x52 = 6 pF, 0x92 = 8 pF, 0xD2 = 10 pF.  Match your crystal's datasheet.
#ifndef SI5351_XTAL_LOAD
#define SI5351_XTAL_LOAD      0xD2
#endif

#define SI5351_REG_STATUS      0
#define SI5351_REG_OUT_EN      3
#define SI5351_REG_CLK0_CTRL   16
#define SI5351_REG_CLK1_CTRL   17
#define SI5351_REG_PLLA        26
#define SI5351_REG_PLLB        34
#define SI5351_REG_MS0         42
#define SI5351_REG_MS1         50
#define SI5351_REG_PLL_RESET   177
#define SI5351_REG_XTAL_LOAD   183

// CLKx_CTRL: [7]=PDN [6]=MS_INT [5]=MS_SRC(0=PLLA,1=PLLB) [4]=INV [3:2]=SRC(11=MS) [1:0]=IDRV(11=8mA)
#define SI5351_CLK0_CTRL_VAL   0x4F   // integer MS, PLLA, multisynth, 8 mA
#ifdef SI5351_CLK1_ON_PLLB
#define SI5351_CLK1_CTRL_VAL   0x6F   // integer MS, PLLB, multisynth, 8 mA
#define SI5351_LOL_MASK        0x60   // LOL_B | LOL_A
#else
#define SI5351_CLK1_CTRL_VAL   0x0F   // FRACTIONAL MS (MS_INT must be 0), PLLA, multisynth, 8 mA
#define SI5351_LOL_MASK        0x20   // only PLLA is used, so ignore LOL_B
#endif

class Si5351ClockGen {
public:
    static constexpr uint32_t TX_FREQ_HZ     = 1000000UL;
    static constexpr uint32_t STROBE_FREQ_HZ = 999990UL;

    bool begin(int sdaPin, int sclPin) {
        Wire.begin(sdaPin, sclPin, 400000); // 400 kHz fast-mode I2C

        Wire.beginTransmission(SI5351_I2C_ADDR);
        if (Wire.endTransmission() != 0) {
            return false; // chip not responding
        }

        // Wait for SYS_INIT (status bit 7) to clear after power-up
        uint8_t status = 0xFF;
        uint32_t t0 = millis();
        while (millis() - t0 < 100) {
            if (!readRegister(SI5351_REG_STATUS, status)) return false;
            if (!(status & 0x80)) break;
            delay(1);
        }
        if (status & 0x80) return false;

        // 1. Disable all outputs, power down all output drivers
        writeRegister(SI5351_REG_OUT_EN, 0xFF);
        for (uint8_t r = 16; r <= 23; r++) writeRegister(r, 0x80);

        // 2. Crystal load capacitance
        writeRegister(SI5351_REG_XTAL_LOAD, SI5351_XTAL_LOAD);

        // 3. PLLs:  fVCO = fXTAL * (a + b/c)
        setFractional(SI5351_REG_PLLA, 36, 0, 1);          // 900.000000 MHz
#ifdef SI5351_CLK1_ON_PLLB
        setFractional(SI5351_REG_PLLB, 35, 24991, 25000);  // 899.991000 MHz
#endif

        // 4. Multisynths: fOUT = fVCO / (a + b/c)
        setFractional(SI5351_REG_MS0, 900, 0, 1);          // 1,000,000 Hz
#ifdef SI5351_CLK1_ON_PLLB
        setFractional(SI5351_REG_MS1, 900, 0, 1);          //   999,990 Hz (899.991 MHz / 900)
#else
        setFractional(SI5351_REG_MS1, 900, 100, 11111);    //   999,990 Hz (900 MHz / 900.00900009)
#endif

        // 5. Reset the PLLs so outputs start phase-aligned
        writeRegister(SI5351_REG_PLL_RESET, 0xAC);

        // 6. Output control, then enable CLK0 + CLK1 (bit=0 -> enabled)
        writeRegister(SI5351_REG_CLK0_CTRL, SI5351_CLK0_CTRL_VAL);
        writeRegister(SI5351_REG_CLK1_CTRL, SI5351_CLK1_CTRL_VAL);

        // 7. Confirm the PLL(s) in use locked (status bit6 = LOL_B, bit5 = LOL_A)
        delay(20);
        if (!readRegister(SI5351_REG_STATUS, status)) return false;
        if (status & SI5351_LOL_MASK) return false;

        writeRegister(SI5351_REG_OUT_EN, 0xFC);
        return true;
    }

private:
    // Writes the 8-byte P1/P2/P3 parameter block used by both PLLs and multisynths.
    // value = a + b/c ; P1 = 128a + floor(128b/c) - 512 ; P2 = 128b - c*floor(128b/c) ; P3 = c
    void setFractional(uint8_t baseReg, uint32_t a, uint32_t b, uint32_t c) {
        uint32_t floor128 = (uint32_t)(((uint64_t)128 * b) / c);
        uint32_t p1 = 128UL * a + floor128 - 512UL;
        uint32_t p2 = 128UL * b - (uint32_t)c * floor128;
        uint32_t p3 = c;

        uint8_t block[8];
        block[0] = (p3 >> 8) & 0xFF;
        block[1] = p3 & 0xFF;
        block[2] = (p1 >> 16) & 0x03;            // P1[17:16] (R_DIV / DIVBY4 left at 0)
        block[3] = (p1 >> 8) & 0xFF;
        block[4] = p1 & 0xFF;
        block[5] = (((p3 >> 16) & 0x0F) << 4) | ((p2 >> 16) & 0x0F);
        block[6] = (p2 >> 8) & 0xFF;
        block[7] = p2 & 0xFF;

        Wire.beginTransmission(SI5351_I2C_ADDR);
        Wire.write(baseReg);
        Wire.write(block, 8);
        Wire.endTransmission();
    }

    void writeRegister(uint8_t reg, uint8_t value) {
        Wire.beginTransmission(SI5351_I2C_ADDR);
        Wire.write(reg);
        Wire.write(value);
        Wire.endTransmission();
    }

    bool readRegister(uint8_t reg, uint8_t &value) {
        Wire.beginTransmission(SI5351_I2C_ADDR);
        Wire.write(reg);
        if (Wire.endTransmission(false) != 0) return false;
        if (Wire.requestFrom((uint8_t)SI5351_I2C_ADDR, (uint8_t)1) != 1) return false;
        value = Wire.read();
        return true;
    }
};

#endif

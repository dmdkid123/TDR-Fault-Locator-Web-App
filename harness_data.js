/* Built-in example harness (mock geometry, millimetres, vehicle frame). Replace with the real CAD export in Setup.
 * Plain script: window.TDR_HARNESS in the browser, module.exports in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TDR_HARNESS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    units: 'mm',
    electrical_length_factor: 1.03,
    nodes: {
      TP: [0, 0, 0], FW_CONN: [1150, 120, 180], UNDERBODY: [2000, 200, -60], PUMP: [3000, 350, -120],
      ECM_P7: [0, 0, 0], SPL1: [1200, -100, 80], SENSOR_A: [2100, -450, 120], SENSOR_B: [2550, 380, 60],
      ECM_P12: [0, 40, 0], COWL: [650, 60, 220], FLOOR_F: [1700, -300, -190], SILL_R: [3200, -330, -170], TAILGATE: [4050, -360, 120]
    },
    nets: {
      FUEL_PUMP: {
        root: 'TP',
        segments: [
          { id: 'S1', from: 'TP', to: 'FW_CONN', via: [[500, 40, 60], [900, 90, 150]], color: '#e6c229' },
          { id: 'S2', from: 'FW_CONN', to: 'UNDERBODY', via: [[1400, 150, 100], [1700, 260, -20]], color: '#e6c229' },
          { id: 'S3', from: 'UNDERBODY', to: 'PUMP', color: '#e6c229' }
        ]
      },
      SENSOR_5V: {
        root: 'ECM_P7',
        segments: [
          { id: 'B0', from: 'ECM_P7', to: 'SPL1', color: '#e8e8e8' },
          { id: 'B1', from: 'SPL1', to: 'SENSOR_A', via: [[1600, -300, 100]], color: '#4aa3ff' },
          { id: 'B2', from: 'SPL1', to: 'SENSOR_B', via: [[1600, 100, 70], [2100, 300, 60]], color: '#5fd38d' }
        ]
      },
      BED_LAMP: {
        root: 'ECM_P12',
        segments: [
          { id: 'L1', from: 'ECM_P12', to: 'COWL', via: [[300, 50, 120]], color: '#ff7a3d' },
          { id: 'L2', from: 'COWL', to: 'FLOOR_F', via: [[1000, -80, 120], [1350, -250, -60]], color: '#ff7a3d' },
          { id: 'L3', from: 'FLOOR_F', to: 'SILL_R', via: [[2400, -320, -200]], color: '#ff7a3d' },
          { id: 'L4', from: 'SILL_R', to: 'TAILGATE', via: [[3700, -345, -60]], color: '#ff7a3d' }
        ]
      }
    }
  };
});

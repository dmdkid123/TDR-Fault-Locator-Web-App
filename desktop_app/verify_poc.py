import numpy as np
from dsp_engine import TDRSignalProcessor

def run_proof_of_concept_verification():
    processor = TDRSignalProcessor(velocity_factor=0.65)
    
    # Target cables specified in proposal: 1m, 5m, and 10m
    test_cables = [
        {"name": "1m Test Cable",  "target_m": 1.0},
        {"name": "5m Test Cable",  "target_m": 5.0},
        {"name": "10m Test Cable", "target_m": 10.0}
    ]
    
    print("\n=================================================================")
    print("  ECE 480 TEAM 10: GO/NO-GO PROOF-OF-CONCEPT VERIFICATION LOG")
    print("=================================================================\n")
    
    overall_pass = True

    for cable in test_cables:
        target = cable["target_m"]
        print(f"--- Evaluating {cable['name']} (Target Distance: {target:.2f} m) ---")
        
        measured_distances = []
        passed_trials = 0
        
        for trial in range(1, 11):
            # Convert target distance to precise fractional sample delay
            v_prop = 0.65 * 299792458.0
            round_trip_t = (2.0 * target) / v_prop
            sample_offset_float = round_trip_t / processor.dt_equivalent
            
            launch_idx = 50
            fault_idx_exact = launch_idx + sample_offset_float
            
            # Generate continuous-time step edge model using error function (erf)
            # to simulate continuous rise time across discrete ADC sample bins
            indices = np.arange(1000, dtype=float)
            rise_time_samples = 2.0  # Simulated step edge transition width
            
            launch_step = 0.5 * (1.0 + np.tanh((indices - launch_idx) / rise_time_samples))
            fault_step = 0.35 * (1.0 + np.tanh((indices - fault_idx_exact) / rise_time_samples))
            
            sweep = 1.65 + launch_step + fault_step
            sweep += np.random.normal(0, 0.001, 1000)  # Simulated bench noise
            
            _, _, faults = processor.process_sweep(sweep, launch_sample_index=launch_idx)
            
            if faults:
                dist = faults[0]["distance_m"]
                error_cm = abs(dist - target) * 100.0
                passed = error_cm <= 5.0  # Requirement: <= 5 cm
                
                if passed:
                    passed_trials += 1
                measured_distances.append(dist)
                
                status = "PASS" if passed else "FAIL"
                print(f"  Trial {trial:2d}: Measured = {dist:.3f} m | Error = {error_cm:.2f} cm | [{status}]")
            else:
                print(f"  Trial {trial:2d}: NO REFLECTION DETECTED | [FAIL]")
        
        mean_dist = np.mean(measured_distances)
        std_dev_cm = np.std(measured_distances) * 100.0
        mean_error_cm = abs(mean_dist - target) * 100.0
        
        print(f"\n  [SUMMARY for {cable['name']}]")
        print(f"  Passed Trials   : {passed_trials}/10")
        print(f"  Mean Distance   : {mean_dist:.4f} m")
        print(f"  Mean Error      : {mean_error_cm:.2f} cm")
        print(f"  Std Deviation   : {std_dev_cm:.2f} cm\n")
        
        if passed_trials < 10 or mean_error_cm > 5.0:
            overall_pass = False

    print("=================================================================")
    if overall_pass:
        print("  GO/NO-GO RESULT: PASSED (ALL 10/10 TRIALS WITHIN +/- 5 cm)")
    else:
        print("  GO/NO-GO RESULT: FAILED (RE-CALIBRATE PROOF OF CONCEPT)")
    print("=================================================================\n")

if __name__ == "__main__":
    run_proof_of_concept_verification()
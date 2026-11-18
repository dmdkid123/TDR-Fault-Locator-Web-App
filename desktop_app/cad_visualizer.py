import pyvista as pv
import numpy as np

class VehicleCADVisualizer:
    def __init__(self):
        self.plotter = pv.Plotter(title="ECE 480 Team 10 - Vehicle Wire Harness CAD Overlay")
        self.plotter.set_background("black")
        
        # Simulated 3D wire harness line path (Chrysler Pacifica body run)
        self.harness_points = np.array([
            [0.0, 0.0, 0.0],    # Connector J1
            [0.5, 0.0, 0.0],
            [1.0, 0.2, 0.1],    # Main firewall pass-through
            [2.0, 0.5, 0.1],
            [3.5, 0.5, -0.2],   # Dashboard Y-Splice
            [5.0, 0.8, -0.2],   # Leg A (Rear Bumper)
            [5.0, 0.1, -0.2]    # Leg B (Door Module)
        ])
        
    def render_harness_and_fault(self, fault_distance_m):
        # Create 3D harness curve
        spline = pv.Spline(self.harness_points, 500)
        tube = spline.tube(radius=0.015)
        
        self.plotter.add_mesh(tube, color="cyan", opacity=0.7, label="CAN Harness Run")
        
        # Compute 3D fault point along the wire path
        path_length = spline.length
        clamp_dist = min(fault_distance_m, path_length)
        param = clamp_dist / path_length
        
        point_idx = int(param * (spline.n_points - 1))
        fault_pt = spline.interpolate_value(param * np.arange(500))
        
        # Highlight fault in 3D
        sphere = pv.Sphere(radius=0.08, center=self.harness_points[int(param * (len(self.harness_points)-1))])
        self.plotter.add_mesh(sphere, color="red", render_points_as_spheres=True, label="Detected Fault Location")
        
        self.plotter.add_legend()
        self.plotter.show(interactive_update=True)

if __name__ == "__main__":
    cad = VehicleCADVisualizer()
    cad.render_harness_and_fault(fault_distance_m=2.35)
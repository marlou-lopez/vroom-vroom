import { Euler, Quaternion } from "three";
import { headingDir, type Vec3 } from "./coords";

// The driver's eye relative to the car's visual centre (LMU's graphical centre: the recorded position is the physics point,
// `visualForward` ahead of it is passed to `cockpitEye`). X
/** Eye height above the drawn road (m). The drawn road is at the recorded point's height (LMU's offset puts the visual centre 0.33 m lower, not applied: see cockpit-view.md), so this is eye height over the drawn road. */
export const EYE_HEIGHT_M = 0.98;
/** How far left of the car's centreline the driver sits (m); LMU cars are left-hand drive. */
export const EYE_LEFT_M = 0.11;
/** How far the camera looks down relative to the car (degrees), on top of the car's pitch: more road, less sky. */
export const EYE_PITCH_DOWN_DEG = 1.5;
/** How far ahead of the car's visual centre the eye is (m). */
export const EYE_FORWARD_M = 0.3;
/** Vertical field of view (degrees), mirroring LMU's `Vertical FOV Degrees` setting in the user's Settings.JSON (44). Horizontal follows the panel's aspect, as in LMU. */
export const COCKPIT_FOV = 44;
export const COCKPIT_NEAR_M = 0.1;

/**
 * Where the driver's eye is and how it is turned, in three.js axes. `car` is the car's position (exaggerated road height),
 * `heading` the direction of travel (0 = east), `pitch` nose up positive, `roll` leaning right positive (all radians).
 * The camera looks along -z with y up, so its Euler (order YXZ) is yaw `heading - pi/2`, pitch about x, and roll about z
 * negated (a camera turned clockwise, seen from behind, leans right). `visualForward` is how far the car's visual centre is ahead of `car` (m).
 */
export function cockpitEye(car: Vec3, heading: number, pitch: number, roll: number, visualForward = 0): { position: Vec3; quaternion: [number, number, number, number] } {
  const fwd = headingDir(heading);
  const left = { x: -Math.sin(heading), z: -Math.cos(heading) }; // left of travel in three.js axes
  const q = new Quaternion().setFromEuler(new Euler(pitch, heading - Math.PI / 2, -roll, "YXZ"));
  return {
    position: {
      x: car.x + fwd.x * (EYE_FORWARD_M + visualForward) + left.x * EYE_LEFT_M,
      y: car.y + EYE_HEIGHT_M,
      z: car.z + fwd.z * (EYE_FORWARD_M + visualForward) + left.z * EYE_LEFT_M,
    },
    quaternion: [q.x, q.y, q.z, q.w],
  };
}

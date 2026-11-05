import { PerspectiveCamera, Vector3 } from "three";
import { smoothHeading } from "../../../lib/camera";
import { headingDir, type Vec3 } from "./coords";
import type { ViewMode } from "./viewModes";

export type { ViewMode } from "./viewModes";

/**
 * What a rig is given each draw: the lap car and the line ahead of it, in three.js world coordinates (heights already
 * exaggerated). `jumped` is true after a seek, so smoothing restarts instead of swinging.
 * A cockpit rig will use `eye`: the driver's eye position and orientation (from the shared-memory position and orientation
 * matrix, #94 follow-up), which this frame can carry without changing the other rigs.
 */
export interface CameraFrame {
  car: Vec3;
  heading: number;
  ahead: Vec3;
  jumped: boolean;
  eye?: { position: Vec3; quaternion: [number, number, number, number] };
}

/** One camera behaviour. `enter` is called when the mode becomes active; `update` places the camera each draw; `zoom` handles the wheel (factor > 1 = further away). */
export interface CameraRig {
  readonly id: ViewMode;
  enter(frame: CameraFrame, cam: PerspectiveCamera): void;
  update(frame: CameraFrame, cam: PerspectiveCamera): void;
  zoom(factor: number): void;
  /** Distance (m) from the camera to the car, for the fog range. */
  distance(cam: PerspectiveCamera): number;
  /** Called when another mode takes over. */
  leave?(): void;
}

export interface ChaseParams { back: number; height: number }
export const CHASE_DEFAULT: ChaseParams = { back: 12, height: 4.5 };
/** A chase camera can be zoomed between these multiples of its default distance. */
export const CHASE_ZOOM_MIN = 0.4, CHASE_ZOOM_MAX = 8;
export const CHASE_HEADING_ALPHA = 0.12;
export const CHASE_HEIGHT_ALPHA = 0.15;
/** Aim a little above the road at the point ahead, so the horizon sits in the upper third. */
export const CHASE_LOOK_LIFT_M = 1.2;

/** Where the chase camera sits and what it looks at: `back` m behind the car along `heading`, `height` m above it, aimed at `ahead`. */
export function chasePlacement(car: Vec3, heading: number, ahead: Vec3, p: ChaseParams): { position: Vec3; target: Vec3 } {
  const d = headingDir(heading);
  return {
    position: { x: car.x - d.x * p.back, y: car.y + p.height, z: car.z - d.z * p.back },
    target: { x: ahead.x, y: ahead.y + CHASE_LOOK_LIFT_M, z: ahead.z },
  };
}

export class ChaseRig implements CameraRig {
  readonly id = "chase";
  private zoomK = 1;
  private heading = 0;
  private height = 0;
  enter(f: CameraFrame, cam: PerspectiveCamera) {
    cam.up.set(0, 1, 0);
    cam.near = 0.5;
    cam.updateProjectionMatrix();
    this.heading = f.heading;
    this.height = f.car.y;
  }
  update(f: CameraFrame, cam: PerspectiveCamera) {
    this.heading = f.jumped ? f.heading : smoothHeading(this.heading, f.heading, CHASE_HEADING_ALPHA);
    this.height = f.jumped ? f.car.y : this.height + (f.car.y - this.height) * CHASE_HEIGHT_ALPHA;
    const p = chasePlacement({ ...f.car, y: this.height }, this.heading, f.ahead, { back: CHASE_DEFAULT.back * this.zoomK, height: CHASE_DEFAULT.height * this.zoomK });
    cam.position.set(p.position.x, p.position.y, p.position.z);
    cam.lookAt(p.target.x, p.target.y, p.target.z);
  }
  zoom(factor: number) {
    this.zoomK = Math.min(Math.max(this.zoomK * factor, CHASE_ZOOM_MIN), CHASE_ZOOM_MAX);
  }
  distance(_cam?: PerspectiveCamera) {
    return Math.hypot(CHASE_DEFAULT.back, CHASE_DEFAULT.height) * this.zoomK;
  }
}

export const TOP_DEFAULT_M = 600, TOP_MIN_M = 60, TOP_MAX_M = 9000;

/** Straight down above the car, north at the top of the screen. */
export class TopRig implements CameraRig {
  readonly id = "top";
  private h = TOP_DEFAULT_M;
  enter(_f: CameraFrame, cam: PerspectiveCamera) {
    cam.near = 5;
    cam.updateProjectionMatrix();
  }
  update(f: CameraFrame, cam: PerspectiveCamera) {
    cam.up.set(0, 0, -1); // three -z is north
    cam.position.set(f.car.x, f.car.y + this.h, f.car.z);
    cam.lookAt(f.car.x, f.car.y, f.car.z);
  }
  zoom(factor: number) {
    this.h = Math.min(Math.max(this.h * factor, TOP_MIN_M), TOP_MAX_M);
  }
  distance(_cam?: PerspectiveCamera) {
    return this.h;
  }
}

/** The bit of three's OrbitControls the orbit rig needs (so it can be tested without a DOM). */
export interface OrbitLike { target: Vector3; enabled: boolean; update(): unknown }

/**
 * Free orbit around the car. The user's drag and wheel are handled by the controls; this rig only keeps the target on the car
 * by moving the camera by the car's movement, so the viewing offset the user chose is kept while the car drives.
 */
export class OrbitRig implements CameraRig {
  readonly id = "orbit";
  private readonly delta = new Vector3();
  private readonly controls: OrbitLike;
  constructor(controls: OrbitLike) {
    this.controls = controls;
  }
  enter(f: CameraFrame, cam: PerspectiveCamera) {
    cam.up.set(0, 1, 0);
    cam.near = 0.5;
    cam.updateProjectionMatrix();
    this.controls.enabled = true;
    // Start from the chase view's place, so switching modes does not jump.
    const place = chasePlacement(f.car, f.heading, f.ahead, { back: 25, height: 14 });
    cam.position.set(place.position.x, place.position.y, place.position.z);
    this.controls.target.set(f.car.x, f.car.y + 1, f.car.z);
    this.controls.update();
  }
  update(f: CameraFrame, cam: PerspectiveCamera) {
    this.delta.set(f.car.x - this.controls.target.x, f.car.y + 1 - this.controls.target.y, f.car.z - this.controls.target.z);
    cam.position.add(this.delta);
    this.controls.target.add(this.delta);
    this.controls.update();
  }
  zoom() { /* the controls' own wheel handling */ }
  distance(cam: PerspectiveCamera) {
    return cam.position.distanceTo(this.controls.target);
  }
  leave() {
    this.controls.enabled = false;
  }
}

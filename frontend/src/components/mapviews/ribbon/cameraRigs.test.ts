import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { headingDir } from "./coords";
import { CHASE_DEFAULT, CHASE_LOOK_LIFT_M, CHASE_ZOOM_MAX, ChaseRig, OrbitRig, TOP_MAX_M, TopRig, chasePlacement, type CameraFrame } from "./cameraRigs";

const frame = (over: Partial<CameraFrame> = {}): CameraFrame => ({
  car: { x: 100, y: 10, z: -50 }, heading: 0, ahead: { x: 130, y: 12, z: -50 }, jumped: false, ...over,
});

describe("chasePlacement", () => {
  const car = { x: 100, y: 10, z: -50 };
  const ahead = { x: 130, y: 12, z: -50 };

  it("sits behind the car along its heading and above it", () => {
    const p = chasePlacement(car, 0, ahead, CHASE_DEFAULT);
    expect(p.position.x).toBeCloseTo(100 - CHASE_DEFAULT.back); // heading east: behind is west
    expect(p.position.y).toBeCloseTo(10 + CHASE_DEFAULT.height);
    expect(p.position.z).toBeCloseTo(-50);
  });

  it("is behind for any heading (north: the camera is south of the car)", () => {
    const h = Math.PI / 2;
    const p = chasePlacement(car, h, ahead, CHASE_DEFAULT);
    const d = headingDir(h);
    const dot = (p.position.x - car.x) * d.x + (p.position.z - car.z) * d.z;
    expect(dot).toBeCloseTo(-CHASE_DEFAULT.back);
    expect(p.position.z).toBeGreaterThan(car.z); // south = +z
  });

  it("looks at the point ahead, a little above the road", () => {
    const p = chasePlacement(car, 0, ahead, CHASE_DEFAULT);
    expect(p.target).toEqual({ x: 130, y: 12 + CHASE_LOOK_LIFT_M, z: -50 });
  });
});

describe("rigs", () => {
  it("the chase rig puts the camera behind the car and aims it ahead", () => {
    const cam = new PerspectiveCamera();
    const rig = new ChaseRig();
    rig.enter(frame(), cam);
    rig.update(frame(), cam);
    expect(cam.position.x).toBeLessThan(100);
    const dir = cam.getWorldDirection(new Vector3());
    expect(dir.x).toBeGreaterThan(0.9); // looking east
  });

  it("the chase rig smooths a heading change but jumps after a seek", () => {
    const cam = new PerspectiveCamera();
    const rig = new ChaseRig();
    rig.enter(frame(), cam);
    rig.update(frame({ heading: Math.PI / 2 }), cam);
    expect(cam.position.x).toBeLessThan(100); // still mostly east-facing after one step
    rig.update(frame({ heading: Math.PI / 2, jumped: true }), cam);
    expect(cam.position.x).toBeCloseTo(100, 3); // snapped to north: the camera is straight south of the car
  });

  it("zoom is clamped", () => {
    const rig = new ChaseRig();
    rig.zoom(1e6);
    expect(rig.distance(new PerspectiveCamera())).toBeCloseTo(Math.hypot(CHASE_DEFAULT.back, CHASE_DEFAULT.height) * CHASE_ZOOM_MAX);
  });

  it("the top rig looks straight down with north up the screen", () => {
    const cam = new PerspectiveCamera();
    const rig = new TopRig();
    rig.enter(frame(), cam);
    rig.update(frame(), cam);
    expect(cam.getWorldDirection(new Vector3()).y).toBeCloseTo(-1);
    // Screen-up is world north (-z).
    const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    expect(up.z).toBeCloseTo(-1);
    rig.zoom(1e6);
    expect(rig.distance(cam)).toBe(TOP_MAX_M);
  });

  it("the orbit rig keeps its offset to the car while the car moves", () => {
    const cam = new PerspectiveCamera();
    const controls = { target: new Vector3(), enabled: false, update: () => {} };
    const rig = new OrbitRig(controls);
    rig.enter(frame(), cam);
    expect(controls.enabled).toBe(true);
    const offset = cam.position.clone().sub(controls.target);
    rig.update(frame({ car: { x: 140, y: 10, z: -50 } }), cam);
    expect(controls.target.x).toBeCloseTo(140);
    expect(cam.position.clone().sub(controls.target).distanceTo(offset)).toBeCloseTo(0, 6);
    rig.leave();
    expect(controls.enabled).toBe(false);
  });
});

import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CockpitRig, DEFAULT_FOV, type CameraFrame } from "./cameraRigs";
import { COCKPIT_FOV, EYE_FORWARD_M, EYE_HEIGHT_M, EYE_LEFT_M, EYE_PITCH_DOWN_DEG, cockpitEye } from "./cockpit";

const car = { x: 100, y: 10, z: -50 };
const quat = (e: ReturnType<typeof cockpitEye>) => new Quaternion(...e.quaternion);
const look = (e: ReturnType<typeof cockpitEye>) => new Vector3(0, 0, -1).applyQuaternion(quat(e));
const rightOf = (e: ReturnType<typeof cockpitEye>) => new Vector3(1, 0, 0).applyQuaternion(quat(e));

describe("cockpitEye", () => {
  it("looks along the heading: east, north, west", () => {
    const east = look(cockpitEye(car, 0, 0, 0)), north = look(cockpitEye(car, Math.PI / 2, 0, 0)), west = look(cockpitEye(car, Math.PI, 0, 0));
    expect(east.toArray()).toEqual([expect.closeTo(1), expect.closeTo(0), expect.closeTo(0)]);
    expect(north.toArray()).toEqual([expect.closeTo(0), expect.closeTo(0), expect.closeTo(-1)]); // three -z is north
    expect(west.x).toBeCloseTo(-1);
  });

  it("sits above the road, ahead of the reference point and left of the centreline", () => {
    const e = cockpitEye(car, 0, 0, 0); // heading east: left is north (-z)
    expect(e.position.y).toBeCloseTo(10 + EYE_HEIGHT_M);
    expect(e.position.x).toBeCloseTo(100 + EYE_FORWARD_M);
    expect(e.position.z).toBeCloseTo(-50 - EYE_LEFT_M);
    const n = cockpitEye(car, Math.PI / 2, 0, 0); // heading north: left is west (-x)
    expect(n.position.x).toBeCloseTo(100 - EYE_LEFT_M);
    expect(n.position.z).toBeCloseTo(-50 - EYE_FORWARD_M);
  });

  it("measures the eye from the visual centre, which is ahead of the recorded point", () => {
    const e = cockpitEye(car, 0, 0, 0, 0.0745); // heading east
    expect(e.position.x).toBeCloseTo(100 + EYE_FORWARD_M + 0.0745);
  });

  it("pitch up raises the line of sight, pitch down lowers it", () => {
    expect(look(cockpitEye(car, 0, 0.1, 0)).y).toBeCloseTo(Math.sin(0.1));
    expect(look(cockpitEye(car, 0, -0.1, 0)).y).toBeCloseTo(-Math.sin(0.1));
  });

  it("leaning right (positive roll) lowers the right side of the view and does not change where it looks", () => {
    const flat = cockpitEye(car, 0.7, 0.05, 0), lean = cockpitEye(car, 0.7, 0.05, 0.1);
    expect(rightOf(flat).y).toBeCloseTo(0, 6);
    expect(rightOf(lean).y).toBeCloseTo(-Math.sin(0.1));
    expect(look(lean).distanceTo(look(flat))).toBeLessThan(1e-9);
  });
});

describe("CockpitRig", () => {
  const frame = (): CameraFrame => ({ car, heading: 0, ahead: car, jumped: false, eye: cockpitEye(car, 0.3, 0.02, -0.04) });

  it("puts the camera on the eye and takes its orientation", () => {
    const cam = new PerspectiveCamera();
    const rig = new CockpitRig();
    const f = frame();
    rig.enter(f, cam);
    expect(cam.position.x).toBeCloseTo(f.eye!.position.x);
    expect(cam.position.y).toBeCloseTo(f.eye!.position.y);
    const tilted = new Quaternion(...f.eye!.quaternion).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -EYE_PITCH_DOWN_DEG * Math.PI / 180));
    expect(cam.quaternion.angleTo(tilted)).toBeLessThan(1e-6);
    expect(cam.fov).toBe(COCKPIT_FOV);
    expect(cam.near).toBeLessThan(0.5);
  });

  it("calibrated eye constants", () => {
    expect(EYE_HEIGHT_M).toBe(0.98);
    expect(EYE_LEFT_M).toBe(0.11);
    expect(EYE_PITCH_DOWN_DEG).toBe(1.5);
  });

  it("tilts down: a point straight ahead at eye height projects above the image centre", () => {
    const cam = new PerspectiveCamera(COCKPIT_FOV, 16 / 9, 0.1, 1000);
    const rig = new CockpitRig();
    const f: CameraFrame = { car, heading: 0, ahead: car, jumped: false, eye: cockpitEye(car, 0, 0, 0) };
    rig.enter(f, cam);
    cam.updateMatrixWorld(true);
    const p = f.eye!.position;
    const ndc = new Vector3(p.x + 50, p.y, p.z).project(cam);
    expect(ndc.y).toBeGreaterThan(0);
    // 1.5 deg below the horizon at 44 deg vertical FOV: tan(1.5 deg) / tan(22 deg)
    expect(ndc.y).toBeCloseTo(Math.tan(1.5 * Math.PI / 180) / Math.tan(22 * Math.PI / 180), 4);
    // the car's pitch still adds: nose up 0.1 rad raises the horizon off the centre line by less than without
    const up: CameraFrame = { ...f, eye: cockpitEye(car, 0, 0.1, 0) };
    rig.update(up, cam);
    cam.updateMatrixWorld(true);
    const p2 = up.eye!.position;
    expect(new Vector3(p2.x + 50, p2.y, p2.z).project(cam).y).toBeLessThan(ndc.y);
  });

  it("follows the car frame by frame", () => {
    const cam = new PerspectiveCamera();
    const rig = new CockpitRig();
    rig.enter(frame(), cam);
    const moved = { ...frame(), eye: cockpitEye({ x: 130, y: 12, z: -50 }, 0, 0, 0) };
    rig.update(moved, cam);
    expect(cam.position.x).toBeCloseTo(130 + EYE_FORWARD_M);
  });

  it("restores the field of view when another mode takes over", () => {
    const cam = new PerspectiveCamera();
    const rig = new CockpitRig();
    rig.enter(frame(), cam);
    rig.leave();
    expect(cam.fov).toBe(DEFAULT_FOV);
  });

  it("ignores a frame without an eye and the wheel", () => {
    const cam = new PerspectiveCamera();
    const rig = new CockpitRig();
    rig.enter(frame(), cam);
    const before = cam.position.clone();
    rig.update({ ...frame(), eye: undefined }, cam);
    rig.zoom();
    expect(cam.position.equals(before)).toBe(true);
  });
});

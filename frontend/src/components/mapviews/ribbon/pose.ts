import type { XY } from "../../../lib/geo";
import { pointAt } from "../../../lib/geo";
import { heightAt } from "./heights";

/** A car in scene metres: position, road height under it, travel heading (0 = east, pi/2 = north) and pitch (radians, positive = nose up). */
export interface CarPose { east: number; north: number; height: number; heading: number; pitch: number }

/** The pitch is measured over this many metres each side of the car along its line. */
export const PITCH_HALF_M = 3;

/**
 * A car at fractional grid distance `d` on `line`. The road height is `heights` at d (the car's reference point height, so
 * the body is drawn on it). Pitch is the slope of that height along the car's own line over +/- PITCH_HALF_M, times the
 * vertical `exaggeration` so the car sits flat on the exaggerated surface.
 */
export function carPose(line: XY, heights: Float64Array, d: number, heading: number, exaggeration = 1): CarPose {
  const p = pointAt(line, d);
  const last = Math.max(line.x.length - 1, 0);
  const a = Math.max(d - PITCH_HALF_M, 0), b = Math.min(d + PITCH_HALF_M, last);
  const pa = pointAt(line, a), pb = pointAt(line, b);
  const run = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const rise = (heightAt(heights, b) - heightAt(heights, a)) * exaggeration;
  return { east: p.x, north: p.y, height: heightAt(heights, d), heading, pitch: run > 0.1 ? Math.atan2(rise, run) : 0 };
}

/** The point `ahead` metres further along the line, with its road height. */
export function aheadPoint(line: XY, heights: Float64Array, d: number, ahead: number): { east: number; north: number; height: number } {
  const p = pointAt(line, d + ahead);
  return { east: p.x, north: p.y, height: heightAt(heights, d + ahead) };
}

/**
 * three.js rotation of a car model built with its nose along local +z and used with Euler order "YXZ":
 * yaw about y turns +z onto the heading, then pitch about local x (a rotation of -pitch tips the nose up).
 */
export function carEuler(pose: Pick<CarPose, "heading" | "pitch">): { y: number; x: number } {
  return { y: pose.heading + Math.PI / 2, x: -pose.pitch };
}

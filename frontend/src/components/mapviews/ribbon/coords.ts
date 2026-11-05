// The one place that maps scene metres (x east, y north, plus a height) to three.js world coordinates.
//   three x = east, three y = up (height), three z = -north.
// three.js is right-handed with y up, so with z = -north, looking along -z is north, and the
// map reads the right way up from above. Heights are passed through unexaggerated here: the renderer scales the whole
// ribbon group's y by the exaggeration factor, and `toThree` takes the factor for the things drawn outside that group (cars, camera).

export interface Vec3 { x: number; y: number; z: number }

/** three.js position of scene point (east, north) at `height` metres, with the vertical exaggeration applied. */
export function toThree(east: number, north: number, height: number, exaggeration = 1): Vec3 {
  return { x: east, y: height * exaggeration, z: -north };
}

/** Writes the unexaggerated three.js position of a point into `out[3i .. 3i + 3)`. */
export function writeThree(out: Float32Array, i: number, east: number, north: number, height: number): void {
  out[3 * i] = east;
  out[3 * i + 1] = height;
  out[3 * i + 2] = -north;
}

/** Unit direction (in three.js axes, horizontal) of a heading in radians (0 = east, pi/2 = north). */
export function headingDir(heading: number): Vec3 {
  return { x: Math.cos(heading), y: 0, z: -Math.sin(heading) };
}

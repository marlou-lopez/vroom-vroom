import { BufferGeometry, Path, Shape, ShapeGeometry } from "three";

/**
 * The windscreen opening of the McLaren 720S GT3 Evo at the user's seat (vertical FOV 44 deg), measured from in-game screenshots.
 * Points are (tan of the horizontal angle, tan of the vertical angle) from the view axis, + = right / up. The frame is fixed to the
 * camera, so it is built in this tangent space and stays right for any window aspect.
 */
const FAR_RIGHT = 3; // the opening runs on to the right past any plausible aspect (the right pillar is outside the 16:9 view)
export const COCKPIT_OPENING: readonly (readonly [number, number])[] = [
  [-0.4938, 0.1796], [-0.4040, 0.1781], [-0.2245, 0.1691], [-0.0449, 0.1631], [0.1347, 0.1571], [0.3142, 0.1541],
  [0.4938, 0.1541], [FAR_RIGHT, 0.1571], [FAR_RIGHT, -0.0898], [0.5163, -0.0860], [0.1047, -0.0883], [-0.1646, -0.0898], [-0.4100, -0.0898],
];
/** Half extents of the covered area in tan space: well beyond any view. */
const OUTER_X = 4, OUTER_Y = 3;

/** Distance in front of the camera at which the frame is drawn (m): just beyond the cockpit near plane. */
export const COCKPIT_FRAME_DISTANCE_M = 0.15;

/**
 * The frame as a flat mesh: a big rectangle with the opening cut out, at depth -`distance` in camera space
 * (positions are (tx, ty) * distance, so it covers the same view angles at any distance).
 */
export function buildCockpitFrameGeometry(distance = COCKPIT_FRAME_DISTANCE_M, opening = COCKPIT_OPENING): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(-OUTER_X, -OUTER_Y);
  shape.lineTo(OUTER_X, -OUTER_Y);
  shape.lineTo(OUTER_X, OUTER_Y);
  shape.lineTo(-OUTER_X, OUTER_Y);
  shape.closePath();
  const hole = new Path();
  opening.forEach(([x, y], i) => (i === 0 ? hole.moveTo(x, y) : hole.lineTo(x, y)));
  hole.closePath();
  shape.holes.push(hole);
  const g = new ShapeGeometry(shape);
  const pos = g.getAttribute("position");
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * distance, pos.getY(i) * distance, -distance);
  pos.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

// The Monza corner map, from the real reference lap (lap 6 of the 5 Nov recording, the fastest valid lap).
import type { Corner } from "../types";
import { cornersFromApexes, type ApexSpec, type CornerSignals } from "./spaTrack";

export const MONZA_TRACK_ID = "monza-grand-prix";
/** The recorded laps are 5777-5780 m on the 1 m grid. */
export const MONZA_TRACK_LENGTH_M = 5778;

/**
 * Apexes on the reference lap: speed minima for the chicanes and Lesmos, the lateral-g peak for the flat-out Curva Grande
 * (which has no speed minimum). The speed minima on laps 5, 6 and 9-12 fall within a few tens of metres of these.
 * Ascari 3 is the left-hand exit of the chicane: the speed hardly dips there, so it comes from the steering peak.
 */
const MONZA_APEXES: ApexSpec[] = [
  { id: "rettifilo1", name: "Rettifilo 1", apex: 935, complex: "Rettifilo" },
  { id: "rettifilo2", name: "Rettifilo 2", apex: 980, complex: "Rettifilo" },
  { id: "curvagrande", name: "Curva Grande", apex: 1357 },
  { id: "roggia1", name: "Roggia 1", apex: 2154, complex: "Roggia" },
  { id: "roggia2", name: "Roggia 2", apex: 2184, complex: "Roggia" },
  { id: "lesmo1", name: "Lesmo 1", apex: 2564 },
  { id: "lesmo2", name: "Lesmo 2", apex: 2877 },
  { id: "ascari1", name: "Ascari 1", apex: 3958, complex: "Ascari" },
  { id: "ascari2", name: "Ascari 2", apex: 4065, complex: "Ascari" },
  { id: "ascari3", name: "Ascari 3", apex: 4140, complex: "Ascari" },
  { id: "parabolica", name: "Parabolica", apex: 5193 },
];

export function monzaCorners(ref?: CornerSignals, lengthM: number = MONZA_TRACK_LENGTH_M): Corner[] {
  return cornersFromApexes(MONZA_APEXES, ref, lengthM);
}

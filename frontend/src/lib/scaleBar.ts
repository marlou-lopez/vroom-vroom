/** A scale bar's length: a round number of metres whose bar is at most `maxPx` wide at `pxPerMetre`. */
export function scaleBar(pxPerMetre: number, maxPx = 120): { metres: number; px: number } {
  const raw = maxPx / pxPerMetre;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const metres = [5, 2, 1].map((k) => k * pow).find((m) => m <= raw) ?? pow;
  return { metres, px: metres * pxPerMetre };
}

/** "50 m", "1 km", "1.5 km". */
export const scaleLabel = (metres: number): string =>
  metres >= 1000 ? `${Math.round(metres / 100) / 10} km` : `${metres} m`;

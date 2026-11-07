/** Rounds to 1/`perSec` s first, then splits into `m:ss.fff`, so 59.97 can't become `0:60.0`. */
function splitRounded(s: number, perSec: number): string {
  const units = Math.round(s * perSec);
  const m = Math.floor(units / (60 * perSec));
  const rest = units - m * 60 * perSec;
  const digits = String(perSec).length - 1;
  const sec = (rest / perSec).toFixed(digits);
  return `${m}:${rest < 10 * perSec ? "0" : ""}${sec}`;
}

/** `2:23.751` */
export function formatLapTime(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "–:––.–––";
  return splitRounded(s, 1000);
}

/** `1:32.4` playback clock. */
export function formatClock(s: number): string {
  return splitRounded(s, 10);
}

/** `+0.841` / `−0.120` (true minus sign). */
export function formatDelta(x: number): string {
  return `${x < 0 ? "−" : "+"}${Math.abs(x).toFixed(3)}`;
}

/** `3 Nov` from an ISO-8601 local datetime. */
export function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** 0 is neutral, negative is reverse. */
export function gearLabel(g: number | undefined): string {
  if (g === undefined) return "–";
  return g === 0 ? "N" : g < 0 ? "R" : String(g);
}

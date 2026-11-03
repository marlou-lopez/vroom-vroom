/** `2:23.751` */
export function formatLapTime(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "–:––.–––";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(3)}`;
}

/** `1:32.4` playback clock. */
export function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
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

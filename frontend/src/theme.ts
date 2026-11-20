// Design tokens from spec §9. Dark only; there is no light theme.
export const colors = {
  bg: "#0E0F11",
  border: "#1F2329",
  hover: "#1A1D22",
  selected: "#1A1D22",
  text: "#D8DCE2",
  muted: "#9AA3AE",
  you: "#3DD6F5",
  comparison: "#B9C0CA",
  issue: "#FF7A59",
  minor: "#E3B341",
  strength: "#34B88A",
  /** Timing-screen purple: the lap holds the ideal lap's segment (vroom-bi4.2). */
  ideal: "#B26BFF",
  reviewed: "#868E99",
  brake: "#F0504F",
  throttle: "#3FB950",
  /** Wheel lockup marks (brake trace, map line) and wheelspin marks (throttle trace, map line). */
  lockup: "#FF3B3B",
  wheelspin: "#FFB020",
  /** Experimental balance marks (vroom-pnw.15): understeer (steering strip, map line) and oversteer. */
  understeer: "#4C8DFF",
  oversteer: "#FF4FD8",
  /** Wheels off the track (vroom-pnw.24): red on an invalid lap (map, strips, scrubber), tan "close call" on a valid one. */
  offTrack: "#FF2D55",
  closeCall: "#B08968",
  /** Map base line, scrubber baseline. */
  line: "#23272E",
  /** Outlines of controls inside panels (wheels, bars, popups). */
  borderStrong: "#2A2F37",
  popup: "#14161A",
  /** Text on an accent-coloured button. */
  onAccent: "#061317",
  textSoft: "#A9B0BA",
  wheelSpoke: "#3A404A",
  /** Scenery of the 3D cockpit view: sky overhead, haze at the horizon (also the fog colour), and two mowing-band greens. */
  sky: "#2F4F78",
  skyHorizon: "#8EA3B8",
  grass: "#3A5629",
  grassAlt: "#42612F",
  /** The car interior around the windscreen in the cockpit view: near-black carbon. */
  cockpitInterior: "#121417",
  /** The lit side of the cockpit's carbon trim: the roof header, pillar and dash top shade from `cockpitInterior` towards it; edge highlights. */
  cockpitTrim: "#4A525E",
  /** The car's bonnet paint seen at the windscreen's lower corners (a neutral silver-grey, lit from above). */
  cockpitBonnet: "#7D8691",
  /** Regions are tones, not boxes (vroom-pnw.66): the page sits on `bg`, a region on `surface`, a control or card inside it on `surface2`. */
  surface: "#15171B",
  surface2: "#1B1E23",
} as const;

/** Annotation colour per finding kind (spec §9). `inconsistent` has no colour in the spec; it reuses `minor`. */
export const annotationColors = {
  issue: colors.issue,
  minor: colors.minor,
  strength: colors.strength,
  inconsistent: colors.minor,
  reviewed: colors.reviewed,
} as const;

export const fonts = {
  sans: "Inter, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

export const sizes = {
  /** Prose (vroom-pnw.66). The stage keeps `fontStage`. */
  fontBase: 13,
  /** Smallest text outside the strips and canvas. */
  fontSmall: 12,
  /** Smallest text in the stage (strips, transport, wheels, map overlays), where density matters (vroom-pnw.53). */
  fontStage: 11,
  /** Sentence-case titles: section title, lede, page heading. */
  fontTitle: 15,
  fontLede: 15,
  fontH1: 20,
  lineHeight: 1.45,
  /** Inline control height in px; primary and segmented controls use `controlLarge` (WCAG 2.2 2.5.8 wants 24). */
  control: 28,
  controlLarge: 30,
  radius: 6,
  pad: 8,
  gap: 8,
  /** Space between page regions. */
  region: 12,
  headerHeight: 36,
} as const;

export const theme = { colors, annotationColors, fonts, sizes } as const;
export type Theme = typeof theme;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every token as a CSS custom property name and value, e.g. `--color-bg`, `--color-border-strong`, `--radius`. */
export function themeVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) vars[`--color-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(annotationColors)) vars[`--color-annotation-${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(fonts)) vars[`--font-${kebab(k)}`] = v;
  vars["--font-size-base"] = `${sizes.fontBase}px`;
  vars["--font-size-small"] = `${sizes.fontSmall}px`;
  vars["--font-size-stage"] = `${sizes.fontStage}px`;
  vars["--font-size-title"] = `${sizes.fontTitle}px`;
  vars["--font-size-lede"] = `${sizes.fontLede}px`;
  vars["--font-size-h1"] = `${sizes.fontH1}px`;
  vars["--line-height"] = String(sizes.lineHeight);
  vars["--control-large"] = `${sizes.controlLarge}px`;
  vars["--region"] = `${sizes.region}px`;
  vars["--control"] = `${sizes.control}px`;
  vars["--radius"] = `${sizes.radius}px`;
  vars["--pad"] = `${sizes.pad}px`;
  vars["--gap"] = `${sizes.gap}px`;
  vars["--header-height"] = `${sizes.headerHeight}px`;
  return vars;
}

/** Writes the tokens to `:root` so CSS Modules can use `var(--color-bg)` etc. Called once from main.tsx before render. */
export function applyThemeVariables(root: Pick<HTMLElement, "style"> = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables())) root.style.setProperty(name, value);
}

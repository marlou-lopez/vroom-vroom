// Design tokens from spec §9. Dark only; there is no light theme.
export const colors = {
  bg: "#0E0F11",
  border: "#1F2329",
  hover: "#1A1D22",
  selected: "#1A1D22",
  text: "#D8DCE2",
  muted: "#868E99",
  you: "#3DD6F5",
  comparison: "#B9C0CA",
  issue: "#FF7A59",
  minor: "#E3B341",
  strength: "#34B88A",
  reviewed: "#868E99",
  brake: "#F0504F",
  throttle: "#3FB950",
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
  fontBase: 12,
  radius: 4,
  pad: 6,
  gap: 6,
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

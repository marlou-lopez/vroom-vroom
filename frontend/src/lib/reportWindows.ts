// The working windows the session report judges against (vroom-bi4.11), one table for the code; the same values, with their
// sources, are in docs/session-report/windows.md. Every value is an editable assumption: LMU publishes no window per car, so these
// are community guidance and engineering rules of thumb, shown next to each event. Keep the doc and this table in step.
import type { ReportWindow } from "../api/types";

export interface Window { min: number; max: number; source: string }

export interface ClassWindows {
  /** The compound the windows are for. The recording does not name it, so this is the class's dry default. */
  compound: string;
  tyre_surface_c: Window;
  tyre_carcass_c: Window;
  tyre_pressure_kpa: Window;
  /** Largest left to right (tread edge to edge) surface temperature difference, mean of the axle's wheels; min is 0. */
  tyre_spread_c: Window;
  brake_c: Window;
  /** Front disc temperature over rear disc temperature. */
  brake_front_rear_ratio: Window;
}

const SRC_TYRE_TEMP = "Community guidance for LMU: 80-100 C typical (clockwerkradio.com 'How to Heat Tyres Quickly During Qualifying in LMU'); TheTenths LMU GT3 setup guides give 85-100 C for grip and 80-95 C for a race stint";
const SRC_NO_FIGURE = "No published LMU figure found (searched 2026-11-18); engineering assumption, to be replaced with measured values";

export const GT3_WINDOWS: ClassWindows = {
  compound: "dry (medium)",
  tyre_surface_c: { min: 80, max: 100, source: SRC_TYRE_TEMP },
  tyre_carcass_c: { min: 80, max: 110, source: `${SRC_NO_FIGURE}; carcass runs a little above the surface (LMU wiki, Tire management: low pressure raises carcass temperature)` },
  tyre_pressure_kpa: { min: 160, max: 185, source: `${SRC_NO_FIGURE}; the mock's own GT3 recordings run 168-175 kPa hot (24.4-25.4 psi). TheTenths lists 27.1-27.3 psi as cold setup values, a different quantity` },
  tyre_spread_c: { min: 0, max: 12, source: `${SRC_NO_FIGURE}; rule of thumb that a tread edge-to-edge spread beyond about 10-15 C means camber or pressure is off` },
  brake_c: { min: 300, max: 650, source: `${SRC_NO_FIGURE}; the LMU brake display shows red while braking and asks for more duct when it stays red all lap (Simracing Arnout, 'More Tire Heat LMU')` },
  brake_front_rear_ratio: { min: 1.0, max: 1.5, source: `${SRC_NO_FIGURE}; GT3 brake bias sits forward, so the front discs run hotter than the rear` },
};

const HYPERCAR_WINDOWS: ClassWindows = {
  compound: "dry (medium)",
  tyre_surface_c: { min: 80, max: 100, source: SRC_TYRE_TEMP },
  tyre_carcass_c: { min: 80, max: 110, source: `${SRC_NO_FIGURE}; as GT3` },
  tyre_pressure_kpa: { min: 160, max: 190, source: `${SRC_NO_FIGURE}; the FIA WEC hypercar/LMP2 rule sets a minimum hot pressure per tyre (FIA WEC decision D0048, 2023) but the value is not public` },
  tyre_spread_c: { min: 0, max: 12, source: `${SRC_NO_FIGURE}; as GT3` },
  brake_c: { min: 350, max: 700, source: `${SRC_NO_FIGURE}; carbon discs run hotter than GT3 steel, so the window is moved up` },
  brake_front_rear_ratio: { min: 0.8, max: 1.5, source: `${SRC_NO_FIGURE}; hypercars brake on both axles with regeneration at the rear` },
};

const LMP2_WINDOWS: ClassWindows = {
  ...HYPERCAR_WINDOWS,
  tyre_pressure_kpa: { min: 160, max: 190, source: `${SRC_NO_FIGURE}; as hypercar` },
  brake_c: { min: 300, max: 650, source: `${SRC_NO_FIGURE}; steel discs, as GT3` },
  brake_front_rear_ratio: { min: 1.0, max: 1.5, source: `${SRC_NO_FIGURE}; as GT3` },
};

/** Every car class the report knows. A class missing here gets a report with the tyre and brake categories unavailable. */
export const CLASS_WINDOWS: Record<string, ClassWindows> = { GT3: GT3_WINDOWS, Hypercar: HYPERCAR_WINDOWS, LMP2: LMP2_WINDOWS };

export const WINDOW_UNITS: Record<Exclude<keyof ClassWindows, "compound">, string> = {
  tyre_surface_c: "°C", tyre_carcass_c: "°C", tyre_pressure_kpa: "kPa", tyre_spread_c: "°C", brake_c: "°C", brake_front_rear_ratio: "ratio",
};

export function windowsFor(carClass: string): ClassWindows | null {
  return CLASS_WINDOWS[carClass] ?? null;
}

/** The windows as the report returns them. */
export function windowList(w: ClassWindows): ReportWindow[] {
  return (Object.keys(WINDOW_UNITS) as (keyof typeof WINDOW_UNITS)[]).map((key) => ({ key, unit: WINDOW_UNITS[key], min: w[key].min, max: w[key].max, source: w[key].source }));
}

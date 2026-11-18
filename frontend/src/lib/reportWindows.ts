// The working windows the session report judges against (vroom-bi4.11), one table for the code; the same values, with their
// sources, are in docs/session-report/windows.md. Every value is an editable assumption: GT3 values without a published source are measured from the driver's recordings
// (tools/measure-windows.py); the rest are community guidance and engineering rules of thumb, shown next to each event. Keep the doc and this table in step.
import type { ReportWindow } from "../api/types";

export interface Range { min: number; max: number }
/**
 * A window is one range for both axles, or one range per axle where the measurements differ (vroom-bi4.13). `tolerance` is in the
 * window's unit: an event fires only when the per-lap average is outside the range by more than this, and 'problem' needs twice as much.
 */
export type Window = { source: string; tolerance: number } & ({ min: number; max: number } | { front: Range; rear: Range });

/** The range the axle is judged against. */
export function rangeFor(w: Window, axle: "front" | "rear"): Range {
  return "front" in w ? w[axle] : w;
}

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
const SRC_MEASURED = "Measured with tools/measure-windows.py: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18 (10th to 90th percentile of the fastest 20 % of each car and track's flying laps)";
const SRC_NO_FIGURE = "No published LMU figure found (searched 2026-11-18); engineering assumption, to be replaced with measured values";

export const GT3_WINDOWS: ClassWindows = {
  compound: "dry (medium)",
  tyre_surface_c: { tolerance: 3, min: 80, max: 100, source: `${SRC_TYRE_TEMP}. Measured on the driver's fastest GT3 laps (66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18) it was cooler, 74.9-84.7 C; the published range is kept` },
  tyre_carcass_c: { tolerance: 3, front: { min: 79.4, max: 88.1 }, rear: { min: 77.3, max: 82.1 }, source: `${SRC_MEASURED}; carcass runs a little above the surface (LMU wiki, Tire management: low pressure raises carcass temperature)` },
  tyre_pressure_kpa: { tolerance: 3, front: { min: 169.4, max: 174.3 }, rear: { min: 166.3, max: 170.1 }, source: `${SRC_MEASURED}; TheTenths lists 27.1-27.3 psi as cold setup values, a different quantity` },
  tyre_spread_c: { tolerance: 2, front: { min: 0, max: 11.3 }, rear: { min: 0, max: 9.2 }, source: `${SRC_MEASURED}; agrees with the rule of thumb of 10-15 C` },
  brake_c: { tolerance: 10, front: { min: 389, max: 468 }, rear: { min: 310, max: 371 }, source: `${SRC_MEASURED}; the LMU brake display shows red while braking and asks for more duct when it stays red all lap (Simracing Arnout, 'More Tire Heat LMU')` },
  brake_front_rear_ratio: { tolerance: 0.05, min: 1.22, max: 1.27, source: SRC_MEASURED },
};

const HYPERCAR_WINDOWS: ClassWindows = {
  compound: "dry (medium)",
  tyre_surface_c: { tolerance: 3, min: 80, max: 100, source: SRC_TYRE_TEMP },
  tyre_carcass_c: { tolerance: 3, min: 80, max: 110, source: `${SRC_NO_FIGURE}; as GT3` },
  tyre_pressure_kpa: { tolerance: 3, min: 160, max: 190, source: `${SRC_NO_FIGURE}; the FIA WEC hypercar/LMP2 rule sets a minimum hot pressure per tyre (FIA WEC decision D0048, 2023) but the value is not public` },
  tyre_spread_c: { tolerance: 2, min: 0, max: 12, source: `${SRC_NO_FIGURE}; as GT3` },
  brake_c: { tolerance: 10, min: 350, max: 700, source: `${SRC_NO_FIGURE}; carbon discs run hotter than GT3 steel, so the window is moved up` },
  brake_front_rear_ratio: { tolerance: 0.05, min: 0.8, max: 1.5, source: `${SRC_NO_FIGURE}; hypercars brake on both axles with regeneration at the rear` },
};

const LMP2_WINDOWS: ClassWindows = {
  ...HYPERCAR_WINDOWS,
  tyre_pressure_kpa: { tolerance: 3, min: 160, max: 190, source: `${SRC_NO_FIGURE}; as hypercar` },
  brake_c: { tolerance: 10, min: 300, max: 650, source: `${SRC_NO_FIGURE}; steel discs, as GT3` },
  brake_front_rear_ratio: { tolerance: 0.05, min: 1.0, max: 1.5, source: `${SRC_NO_FIGURE}; as GT3` },
};

/** Every car class the report knows. A class missing here gets a report with the tyre and brake categories unavailable. */
export const CLASS_WINDOWS: Record<string, ClassWindows> = { GT3: GT3_WINDOWS, Hypercar: HYPERCAR_WINDOWS, LMP2: LMP2_WINDOWS };

export const WINDOW_UNITS: Record<Exclude<keyof ClassWindows, "compound">, string> = {
  tyre_surface_c: "°C", tyre_carcass_c: "°C", tyre_pressure_kpa: "kPa", tyre_spread_c: "°C", brake_c: "°C", brake_front_rear_ratio: "ratio",
};

export function windowsFor(carClass: string): ClassWindows | null {
  return CLASS_WINDOWS[carClass] ?? null;
}

/** The windows as the report returns them: one row per metric, or a front and a rear row. */
export function windowList(w: ClassWindows): ReportWindow[] {
  return (Object.keys(WINDOW_UNITS) as (keyof typeof WINDOW_UNITS)[]).flatMap((key): ReportWindow[] => {
    const x = w[key], base = { key, unit: WINDOW_UNITS[key], tolerance: x.tolerance, source: x.source };
    return "front" in x
      ? (["front", "rear"] as const).map((axle) => ({ ...base, axle, ...x[axle] }))
      : [{ ...base, axle: "both", min: x.min, max: x.max }];
  });
}

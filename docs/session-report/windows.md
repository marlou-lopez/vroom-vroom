# Session report: working windows (vroom-bi4.11)

The session report judges tyre and brake values against a window per car class and compound. **Every value here is an editable
assumption**, in the same sense as the fuel-weight constant in `docs/stint/fuel-corrected-falloff.md`: LMU does not publish a
window per car, so these come from community guidance and engineering rules of thumb. The code reads the same values from one
module, `frontend/src/lib/reportWindows.ts` (a unit test checks that table against this file and against the car classes in the
mock). Each report returns the windows it used with their source. Searched 2026-11-18; where no published figure exists the
source says so rather than inventing one. The recording does not name the compound, so a window is for the class's dry default.

Sources:
- **[A]** Clockwerk Radio, "How to Heat Tyres Quickly During Qualifying in LMU" (clockwerkradio.com): 80–100 °C typical.
- **[B]** TheTenths LMU GT3 setup guides (thetenths.com/guides/le-mans-ultimate), e.g. BMW M4 GT3 at Silverstone: 85–100 °C for grip, 80–95 °C for a race stint, 27.1–27.3 psi cold pressures.
- **[C]** LMU wiki, "Tire management" (lemansultimate.wiki.gg): low pressure raises carcass temperature, high pressure warms the tyre faster.
- **[D]** Simracing Arnout, "More Tire Heat LMU" (arnouthoekstra.substack.com): brake discs shown red while braking are fine, red all lap means open the ducts.
- **[E]** FIA WEC decision D0048 (2023), Hypercar and LMP2 minimum tyre pressures: the rule exists, the value is not public.
- **measured**: `tools/measure-windows.py` over the driver's own LMU recordings (see "Measured windows" below).
- **none**: no published LMU figure found and too little data to measure; engineering assumption.

| Class | Compound | Window | Axle | Min | Max | Tolerance | Unit | Source |
|---|---|---|---|---|---|---|---|---|
| GT3 | dry (medium) | tyre_surface_c | both | 80 | 100 | 3 | °C | [A], [B] |
| GT3 | dry (medium) | tyre_carcass_c | front | 79.4 | 88.1 | 3 | °C | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18; [C] for direction |
| GT3 | dry (medium) | tyre_carcass_c | rear | 77.3 | 82.1 | 3 | °C | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18; [C] for direction |
| GT3 | dry (medium) | tyre_pressure_kpa | front | 169.4 | 174.3 | 3 | kPa | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18 ([B]'s 27 psi are cold setup values, not comparable) |
| GT3 | dry (medium) | tyre_pressure_kpa | rear | 166.3 | 170.1 | 3 | kPa | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18 ([B]'s 27 psi are cold setup values, not comparable) |
| GT3 | dry (medium) | tyre_spread_c | front | 0 | 11.3 | 2 | °C | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18; the rule of thumb of 10–15 °C agrees |
| GT3 | dry (medium) | tyre_spread_c | rear | 0 | 9.2 | 2 | °C | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18; the rule of thumb of 10–15 °C agrees |
| GT3 | dry (medium) | brake_c | front | 389 | 468 | 10 | °C | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18; [D] for the display |
| GT3 | dry (medium) | brake_c | rear | 310 | 371 | 10 | °C | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18; [D] for the display |
| GT3 | dry (medium) | brake_front_rear_ratio | both | 1.22 | 1.27 | 0.05 | ratio | measured: 66 laps, 3 car entries (all Garage 59), 4 tracks, 2026-11-18 |
| Hypercar | dry (medium) | tyre_surface_c | both | 80 | 100 | 3 | °C | [A], [B] |
| Hypercar | dry (medium) | tyre_carcass_c | both | 80 | 110 | 3 | °C | none; as GT3 |
| Hypercar | dry (medium) | tyre_pressure_kpa | both | 160 | 190 | 3 | kPa | none; [E] |
| Hypercar | dry (medium) | tyre_spread_c | both | 0 | 12 | 2 | °C | none; as GT3 |
| Hypercar | dry (medium) | brake_c | both | 350 | 700 | 10 | °C | none; carbon discs run hotter |
| Hypercar | dry (medium) | brake_front_rear_ratio | both | 0.8 | 1.5 | 0.05 | ratio | none; rear regeneration |
| LMP2 | dry (medium) | tyre_surface_c | both | 80 | 100 | 3 | °C | [A], [B] |
| LMP2 | dry (medium) | tyre_carcass_c | both | 80 | 110 | 3 | °C | none; as GT3 |
| LMP2 | dry (medium) | tyre_pressure_kpa | both | 160 | 190 | 3 | kPa | none; as hypercar |
| LMP2 | dry (medium) | tyre_spread_c | both | 0 | 12 | 2 | °C | none; as GT3 |
| LMP2 | dry (medium) | brake_c | both | 300 | 650 | 10 | °C | none; steel discs, as GT3 |
| LMP2 | dry (medium) | brake_front_rear_ratio | both | 1.0 | 1.5 | 0.05 | ratio | none; as GT3 |

## Measured windows (vroom-0dg)

`tools/measure-windows.py` scans a Telemetry folder (each recording is copied first), keeps valid flying laps, and per car class
takes the fastest 20 % of each car-and-track's laps (groups under 5 flying laps skipped). The window is the 10th to 90th
percentile of those laps (spread: 0 to the 90th percentile), per axle (vroom-bi4.13). A
class gets measured values only with **at least 30 laps from at least 2 tracks**. Run 2026-11-18: 248 recordings, 342 valid flying laps.

- **GT3**: 66 laps, 3 car entries (Garage 59 #10 LM, #10 WEC, #58 LM: the recording names the entry, not the model, so in practice one team's one GT3 car), 4 tracks (Monza, Bahrain, Spa, Le Mans): measured values above. Per axle
  (p10 to p90): surface front 76.9–86.3 and rear 74.5–79.6 °C; carcass front 79.4–88.1 and rear 77.3–82.1 °C; pressure front 169.4–174.3
  and rear 166.3–170.1 kPa; spread front 10.1–11.3 and rear 8.4–9.2 °C; brake front 389–468 and rear 310–371 °C.
- **Disagreement with the published values:** the measured tyre surface range, 74.9–84.7 °C, sits below [A] and [B] (80–100 °C): the
  driver's fastest laps run cooler than the guides' targets. The published 80–100 °C is kept as the window ([A]/[B] take priority).
- **Hypercar and LMP2**: no recordings at all, so all their `none` values stay assumptions. LMP3 (3 laps, 2 tracks) is not in the
  table. Re-run the tool when more recordings exist.
- The brake front/rear ratio depends on that car's brake bias, so 1.22-1.27 is that car's range, not every GT3's.
- The measured windows are per axle (the front runs hotter than the rear), so GT3 carcass, pressure, spread and brake have a front and a
  rear row; surface and the ratio have one row for both axles. A `both` row applies to each axle.
- These windows are narrow (the best laps of three cars), they describe the driver's own best laps, not a general optimum. That is
  why every window has a tolerance (below).

## Tolerance (vroom-bi4.13)

Each window has a tolerance in its unit: an event fires only when a lap's axle average is outside the range by **more than** the
tolerance, and a severity of 'problem' needs the event's mean gap to be at least **twice** the tolerance (a smaller gap is a watch
at most). Values: tyre temperatures (surface, carcass) 3 °C, pressure 3 kPa, tread spread 2 °C, front/rear brake ratio 0.05, and
brake disc temperature 10 °C (discs swing far more than tyres lap to lap; 3 °C would flag noise). First values, editable like the
windows; they live in `reportWindows.ts` and are the Tolerance column above.

**Published values win over measured ones.** The tyre surface keeps the published 80–100 °C ([A], [B]) for both axles, although the
driver's own best laps run cooler (decided 2026-11-18): the report keeps telling you when your tyres run below published guidance.
Measured values only replace `none` entries.

The mock's cars are all GT3. Rule thresholds (laps outside a window before an event, minimum time lost to report, ABS and TC metres
per corner) are first guesses in `RULES` in `frontend/src/lib/sessionReport.ts`.

## Vs your best laps (vroom-0dg)

A tyres/brakes event compares each flying lap outside the session's best laps (the fastest 20 % of timed flying laps, at least 3) with
the best laps' mean, per axle: surface and carcass temperature by 5 °C, pressure by 5 kPa, brake disc temperature by 40 °C, on at least
2 laps whose mean time lost against the best lap is at least 0.05 s (kinds `vs_best_<metric>_<high|low>`). With fewer than 5 timed flying laps
the comparison is skipped and the report's `unavailable` says so for tyres and brakes. Thresholds are in `RULES`.

## Driving events (vroom-bi4.13)

ABS and TC activation per corner is reported only when it coincides with time lost in that corner (at least `minCornerLostS` on those
laps against the best lap) or when the corner's activation on the other timed flying laps differs from the best laps' by at least
`aidBestDiffM` metres and `aidBestDiffShare` of the best laps' value (needs at least 5 traced timed flying laps for the best-laps
set). Otherwise it only describes and is dropped. ABS, TC, lock-up and wheelspin trend events need at least 6 flying laps
(`trendMinLaps`, `cornerTrendMinLaps`).

## Wording rules

Sentences are templates. An event is linked to time lost on the same lap or corner (against the session's own best flying lap) and
phrased "coincides with", never "because". They never mention tyre load, grip or brake bias (LMU zeroes load and grip, and bias is
not recorded), and every number in a sentence is in the event's `numbers`.

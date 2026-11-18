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
- **none**: no published LMU figure found; engineering assumption, to be replaced with measured values.

| Class | Compound | Window | Min | Max | Unit | Source |
|---|---|---|---|---|---|---|
| GT3 | dry (medium) | tyre_surface_c | 80 | 100 | °C | [A], [B] |
| GT3 | dry (medium) | tyre_carcass_c | 80 | 110 | °C | none; [C] for direction |
| GT3 | dry (medium) | tyre_pressure_kpa | 160 | 185 | kPa | none; the mock's GT3 recordings run 168–175 kPa hot ([B]'s 27 psi are cold setup values, not comparable) |
| GT3 | dry (medium) | tyre_spread_c | 0 | 12 | °C | none; rule of thumb 10–15 °C |
| GT3 | dry (medium) | brake_c | 300 | 650 | °C | none; [D] for the display |
| GT3 | dry (medium) | brake_front_rear_ratio | 1.0 | 1.5 | ratio | none; front bias |
| Hypercar | dry (medium) | tyre_surface_c | 80 | 100 | °C | [A], [B] |
| Hypercar | dry (medium) | tyre_carcass_c | 80 | 110 | °C | none; as GT3 |
| Hypercar | dry (medium) | tyre_pressure_kpa | 160 | 190 | kPa | none; [E] |
| Hypercar | dry (medium) | tyre_spread_c | 0 | 12 | °C | none; as GT3 |
| Hypercar | dry (medium) | brake_c | 350 | 700 | °C | none; carbon discs run hotter |
| Hypercar | dry (medium) | brake_front_rear_ratio | 0.8 | 1.5 | ratio | none; rear regeneration |
| LMP2 | dry (medium) | tyre_surface_c | 80 | 100 | °C | [A], [B] |
| LMP2 | dry (medium) | tyre_carcass_c | 80 | 110 | °C | none; as GT3 |
| LMP2 | dry (medium) | tyre_pressure_kpa | 160 | 190 | kPa | none; as hypercar |
| LMP2 | dry (medium) | tyre_spread_c | 0 | 12 | °C | none; as GT3 |
| LMP2 | dry (medium) | brake_c | 300 | 650 | °C | none; steel discs, as GT3 |
| LMP2 | dry (medium) | brake_front_rear_ratio | 1.0 | 1.5 | ratio | none; as GT3 |

The mock's cars are all GT3. Rule thresholds (laps outside a window before an event, minimum time lost to report, ABS and TC metres
per corner) are first guesses in `RULES` in `frontend/src/lib/sessionReport.ts`.

## Wording rules

Sentences are templates. An event is linked to time lost on the same lap or corner (against the session's own best flying lap) and
phrased "coincides with", never "because". They never mention tyre load, grip or brake bias (LMU zeroes load and grip, and bias is
not recorded), and every number in a sentence is in the event's `numbers`.

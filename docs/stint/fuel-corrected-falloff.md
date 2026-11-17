# Fuel-corrected lap-time fall-off (spike vroom-d4g)

**Question:** can the Stint view show a fuel-corrected fall-off (what the tyres cost per lap, with the fuel-weight gain taken out)
and say honestly where its number comes from?

**Answer:** yes, with a stated per-class constant for the fuel-weight effect. On the Monza race of 9 Nov 2026 the raw fall-off of
**+0.050 s a lap** becomes **+0.102 s a lap** once the fuel burnt (2.26 kg a lap) is put back. The recordings cannot measure the
constant within a stint, and fitting it across sessions agrees with the constant but is too noisy to use as the source.

## Why the raw fall-off hides tyre wear

Within one stint without refuelling, fuel load and lap number move together: on the Monza race their correlation is −0.9999. A
least-squares fit of lap time against lap number cannot split "the car is lighter" (faster) from "the tyres are older" (slower). The
+0.050 s a lap the Stint view shows is the sum of both.

The correction needs the fuel-weight effect **k** (seconds a lap per kg) from somewhere else:

  corrected lap time = lap time + k × 0.74 kg/L × (fuel at the stint start − fuel at mid-lap)

that is, each lap's time as if the car still carried the start load. The slope of the corrected times is the tyre (and track)
fall-off. It equals the raw slope plus k × the kg burnt per lap.

## Candidate sources for k, with the Monza race numbers

All figures for the McLaren 720S GT3 Evo, 21 fitted laps (out, in, invalid and the one slow lap left out, as in the raw fit),
3.06 L = 2.26 kg of fuel a flying lap.

| Source | k (s/kg per lap) | Fuel gain a lap | Corrected fall-off |
|---|---|---|---|
| Raw fit, no correction | 0 | 0 | +0.050 s |
| **A. Per-class constant** (GT3: 0.02 % of the lap per kg, 113.8 s median lap) | **0.0228** | 0.051 s | **+0.102 s** |
| B. Fit across Monza sessions (12 sessions, P+Q+R) | 0.019 ± 0.008 | 0.043 s | +0.094 s |
| B. Fit across Monza sessions (races only, 4) | 0.023 ± 0.010 | 0.052 s | +0.103 s |
| B. Fit across Spa sessions (applied to Monza), depending on subset | 0.013–0.028 | 0.029–0.063 s | +0.080–0.114 s |
| C. User setting | whatever the user types | | |

Corrected fall-off for other values of k (from `fuelCorrectedFalloff` on the real file): 0.010 → +0.073, 0.019 → +0.094,
0.025 → +0.107, 0.030 → +0.119 s a lap. So the tyre fall-off on this race is roughly **double** the raw number for any plausible
k, and the choice of k moves it by about ±0.015 s a lap.

### A. A stated per-class constant

The motorsport rule of thumb is about 0.03 s a lap per kg for an 800 kg single-seater on a 90 s lap, which is 0.033 % of the lap per
kg. Lap-time loss goes roughly with the added share of the car's mass, so for a GT3 of about 1,400 kg with driver it scales to about
**0.02 % of the lap per kg**. Expressing it as a share of the lap lets one constant serve every track: 0.023 s/kg at Monza
(113.8 s), 0.028 s/kg at Spa (141.5 s). Fuel density: 0.74 kg/L, typical of racing petrol (LMU's own value per car is not in the
recording).

- For: always available, one number per class, easy to show next to the result ("assumed: …"), the same answer every time.
- Against: an assumption, not a measurement. Correct to within maybe ±30 %, and other classes (LMP2, Hypercar) need their own
  value, which no recording here can check (the few LMP3 sessions have two or three flying laps each).

### B. Fit k from sessions where fuel and tyre age are not collinear

**Refuelling within a session does not help with the data we have.** The 245 recordings (copies, read-only, 2026-11-18) have
10 sessions with a refuel, but none with three or more timed flying laps on both sides of it: in practice the driver refuels and
then stops recording, and the Monza race stop is on the last lap. Getting such a session needs a new recording (a long race with a
mid-race stop), which only the driver can make.

**Across sessions it does work, roughly.** Start loads vary from session to session (qualifying on 10–20 L, races on 25–50 L,
practice on 75–85 L), and tyre age restarts at each out lap, so one fit over all sessions of a car and track,
lap time = a + k × fuel kg + d × tyre age, can separate k from d. `tools/fuel-effect-fit.py` does this:

| Track, sessions | Laps | k (s/kg per lap) | d, tyre (s/lap) |
|---|---|---|---|
| Monza, P+Q+R (12) | 61 | 0.019 ± 0.008 | 0.092 ± 0.020 |
| Monza, P+R (9) | 56 | 0.020 ± 0.009 | 0.093 ± 0.022 |
| Monza, R (4) | 42 | 0.023 ± 0.010 | 0.099 ± 0.021 |
| Spa, P+Q+R (69) | 198 | 0.028 ± 0.005 | 0.146 ± 0.031 |
| Spa, P+R (44) | 160 | 0.013 ± 0.006 | 0.035 ± 0.042 |
| Spa, R (27) | 135 | 0.027 ± 0.009 | 0.073 ± 0.044 |

(± is one standard error. Residual scatter is about 0.8–0.9 s a lap.)

The Monza fits agree with constant A (0.023 s/kg) and their tyre term (0.09–0.10 s a lap) matches the corrected fall-off of the
race (+0.102). That makes A believable. But as the source of k the fit is weak:
- it moves by a factor of two on Spa depending on which sessions go in, more than its own error bars;
- it needs many sessions of the same car and track at different fuel loads; most car and track pairs have a handful;
- it cannot remove what else differs between sessions: the driver getting faster over days (a date term moves Spa races from
  0.027 to 0.018), qualifying effort against race pace, track temperature, tyre compound.

### C. Leave it to the user, per car

A field in the car's settings ("fuel costs __ s/kg a lap"), defaulting to A. It moves the assumption to the person least likely to
know a better number, and adds a settings screen and storage for one value. Worth it only if users ask to override the default.

## What was built

- `frontend/src/lib/stint.ts`: `fuelCorrectedFalloff(rows, effect = GT3_FUEL_EFFECT)` returns the corrected slope with the raw one,
  the assumed s/kg on this stint's lap, the kg burnt per lap and the fuel gain per lap. It corrects from fuel *levels* (start load
  minus mid-lap level), not summed per-lap use, so a lap with a missing reading does not shift the rest. `GT3_FUEL_EFFECT` holds the
  constant, its fuel density and a source string. Tests: synthetic laps (recovers a 0.1 s tyre fall-off hidden under a 0.044 s fuel
  gain; zero effect leaves the slope; a missing reading does not shift it) and the real Monza file (+0.050 raw, 0.0228 s/kg,
  2.26 kg a lap, corrected between +0.09 and +0.11).
- `frontend/src/components/StintPanel.tsx`: under the summary cards, a dashed box labelled **EXPERIMENTAL**: "FUEL-CORRECTED
  FALL-OFF +0.102 s/lap — raw +0.050 + fuel gain 0.051 (2.26 kg a lap × 0.0228 s/kg). Assumed: GT3 rule of thumb (0.02 % of the
  lap per kg, fuel 0.74 kg/L), an assumption." The chart and its line stay raw.
- `tools/fuel-effect-fit.py`: the cross-session fit above (copies each recording, opens it read-only, deletes the copy):
  `uv run --with duckdb --with numpy python -I tools/fuel-effect-fit.py <telemetry dir> <scratch dir> "<track prefix>" "<car prefix>" [PQR]`.

No contract change. The prototype applies the GT3 constant to every car, because the panel does not look at the car class.

## Recommendation

**Keep, with option A**: show the fuel-corrected fall-off next to the raw one, with the constant and its source on screen, using a
per-class constant (GT3 0.02 % of the lap per kg and 0.74 kg/L now; other classes added when a recording can check them, and the
corrected value hidden for a class without one). Keep `tools/fuel-effect-fit.py` as the cross-check, not as the source. Revisit C
only if a user asks to override.

If kept, **vroom-9ki.18's stints endpoint** should carry the fall-offs as computed facts (the coach may only phrase numbers it is
given), per stint:

- `falloff: { slope_s_per_lap, n_laps } | null` (the raw fit, today computed in the client);
- `falloff_fuel_corrected: { slope_s_per_lap, fuel_gain_s_per_lap, kg_per_lap, s_per_kg, assumption: { kg_per_l,
  lap_fraction_per_kg, source } } | null`, null when the car's class has no constant;
- the per-class constants in the backend's car config (`config/cars.yaml` already holds per-car facts), keyed by `car_class`.

## Question for the user

Keep the fuel-corrected fall-off with a stated per-class constant (A), change it (fit per car from your sessions, B, or a per-car
setting, C), or drop it and keep only the raw fall-off?

## Decision (autopilot)

**Keep, with option A** (a per-class constant, shown on screen as an assumption with its source). B and C are not built;
`tools/fuel-effect-fit.py` stays as a cross-check. Decided 2026-11-18 by the autopilot judge (Opus), standing in for the user.

- The raw +0.050 s a lap is misleading: with the fuel gain put back, the Monza tyre fall-off is about double (+0.102). Any plausible
  constant gives +0.09 to +0.11, so the conclusion holds even though the constant is assumed.
- The coach may only phrase numbers computed in code, so both fall-offs belong in the backend's stint facts, not the client.
- A is stated with its source and matches Monza's cross-session fit (0.019–0.023 s/kg against 0.023). A class without a checked
  constant gets null, not a guess.
- B moves by a factor of two on Spa depending on which sessions go in, needs many sessions per car and track, and cannot remove the
  driver improving, track temperature or compound.
- C goes against the spec's non-goal of a Settings page in v1 and its rule that configuration lives in files. A per-class entry in
  `config/cars.yaml` already gives a file override.
- Keying the constant on `car_class` and expressing it as a share of the lap keeps it sim-agnostic and valid on every track.

Follow-ups: **vroom-bi4.9** (raw and corrected fall-off in the stints contract and mock; the panel reads them and loses the
EXPERIMENTAL label) and **vroom-9ki.20** (compute both in racecoach with constants in `config/cars.yaml`, into the coach facts).
vroom-9ki.18 now depends on vroom-bi4.9.

## Built in vroom-bi4.9

The stints contract carries `falloff` and `falloff_fuel_corrected` per stint (`frontend/src/api/types.ts`). The mock computes them with
`lib/stint.ts` and a per-class table (`FUEL_EFFECT_BY_CLASS` in `api/mock/stint.ts`, GT3 only; a class without an entry gets null). The
Stint panel reads both from the API, shows the corrected value next to the raw one with the constant and its source, and has lost the
EXPERIMENTAL label. The chart line stays raw (drawn from a local fit, because the contract carries no intercept). Monza race: raw
+0.050, corrected +0.102 s/lap.

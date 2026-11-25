# Analysis threshold tuning (vroom-9ki.15)

Three heuristics were set from one Spa session. `tools/tune-thresholds.py` reruns them on other
recordings (copies first, never writes). Reviewed 2026-11-25: **8 recordings, 4 tracks beyond the
original Spa session** (Fuji LMP3, Sebring GT3 x2, Bahrain GT3, Monza GT3 x2) plus two Spa GT3
recordings from other days, 4 to 9 clean flying laps each (valid, within 107 % of the best), track
temperature 16 to 44 C. **No wet recording was reviewed**: recordings do record wetness (the `Minimum Path Wetness` event,
`docs/lmu-duckdb-schema.md`), but the backend reader does not read it into `LapMeta.conditions` yet,
so this tool cannot pick wet laps out; the wet check stays open (follow-up filed).

```bash
cd backend && uv run python -I ../tools/tune-thresholds.py <recording.duckdb>...
```

Corners come from `draft_map` (detection on the fastest lap), so counts per corner are for
auto-detected corners, which on Sebring and Monza are merged complexes (5 to 8 per lap).

## Verdicts

| Threshold | Verdict |
|---|---|
| Steering corrections: +-5 m smoothing | **Confirmed** |
| Steering corrections: 10 % prominence | **Adjusted**: add an absolute floor of 0.04 (`STEER_MIN_PROMINENCE`) |
| Corner start: phase start minus 50 m (`LEAD_IN_M`) | **Confirmed** |
| Kerbs: near-edge filter (`EDGE_MARGIN_M` 1.5 m) | **Confirmed** |
| Kerbs: 50 % of laps (`MIN_LAP_SHARE`) | **Confirmed** |
| Kerbs: suspension peak 0.6 (`SUSP_PEAK_MS`) | **Left as is, but it never fires** |

## Steering corrections

Evidence, by the corner's largest smoothed steering (all recordings, current smoothing and 10 %,
without and with the floor; the tool prints this table):

| largest steering | corner-laps | per 100 m, no floor | per 100 m, floor 0.04 |
|---|---|---|---|
| 0 to 0.1 | 14 | 2.16 | 0.15 |
| 0.1 to 0.2 | 69 | 1.61 | 0.57 |
| 0.2 to 0.35 | 115 | 1.33 | 0.99 |
| 0.35 to 0.5 | 158 | 1.17 | 1.15 |
| 0.5 to 1.01 | 113 | 0.94 | 0.94 |

The rate should not rise as the corner gets gentler. It does, because "10 % of the largest
steering" shrinks to sensor-level wobble in a kink. A floor of 0.04 (steering is -1..1; the
fullest lock on these cars is about 0.7) brings the three gentlest bins to 0.15, 0.57 and 0.99 per
100 m and leaves the big corners alone (1.15 and 0.94). It lowers the mean from 3.1 to 2.4 per corner.

Smoothing +-5 m stays: wider smoothing (8, 12 m) just lowers every count about in proportion and
there is no ground truth here to prefer it. The relative prominence stays at 10 %: the
"laps different from the reference" share falls from 66 % to 56 % with the floor and the
corrections that remain are the ones the coach compares against the reference.
The contract and the mock (`coachFacts.ts`, `types.ts`) carry the same floor.

Caveat: there is no labelled ground truth for "a correction", so this removes obvious noise, it
does not prove the remaining count. GT3 at Sebring and the Manthey Monza recording still show 3 or more corrections in
71 to 80 % of corner-laps; those corners are merged complexes with long windows.

| smooth ± m | prominence | floor | mean per corner | corners with ≥ 1 | laps ≠ ref |
|---|---|---|---|---|---|
| 3 | 0.05 | 0.0 | 6.78 | 100 % | 79 % |
| 3 | 0.05 | 0.04 | 3.59 | 94 % | 67 % |
| 3 | 0.10 | 0.0 | 4.25 | 99 % | 75 % |
| 3 | 0.10 | 0.04 | 3.30 | 94 % | 65 % |
| 3 | 0.15 | 0.0 | 2.99 | 99 % | 65 % |
| 3 | 0.15 | 0.04 | 2.62 | 94 % | 57 % |
| 3 | 0.20 | 0.0 | 2.19 | 97 % | 51 % |
| 3 | 0.20 | 0.04 | 2.01 | 94 % | 45 % |
| 5 | 0.05 | 0.0 | 5.11 | 100 % | 79 % |
| 5 | 0.05 | 0.04 | 2.61 | 94 % | 58 % |
| 5 | 0.10 | 0.0 | 3.12 | 99 % | 66 % |
| 5 | 0.10 | 0.04 | 2.41 | 94 % | 56 % |
| 5 | 0.15 | 0.0 | 2.29 | 98 % | 51 % |
| 5 | 0.15 | 0.04 | 1.97 | 94 % | 43 % |
| 5 | 0.20 | 0.0 | 1.78 | 96 % | 39 % |
| 5 | 0.20 | 0.04 | 1.66 | 93 % | 34 % |
| 8 | 0.05 | 0.0 | 3.54 | 100 % | 68 % |
| 8 | 0.05 | 0.04 | 1.91 | 93 % | 43 % |
| 8 | 0.10 | 0.0 | 2.29 | 98 % | 51 % |
| 8 | 0.10 | 0.04 | 1.79 | 93 % | 39 % |
| 8 | 0.15 | 0.0 | 1.73 | 96 % | 38 % |
| 8 | 0.15 | 0.04 | 1.57 | 93 % | 31 % |
| 8 | 0.20 | 0.0 | 1.48 | 94 % | 30 % |
| 8 | 0.20 | 0.04 | 1.40 | 92 % | 25 % |
| 12 | 0.05 | 0.0 | 2.64 | 99 % | 61 % |
| 12 | 0.05 | 0.04 | 1.51 | 91 % | 30 % |
| 12 | 0.10 | 0.0 | 1.81 | 97 % | 39 % |
| 12 | 0.10 | 0.04 | 1.46 | 91 % | 29 % |
| 12 | 0.15 | 0.0 | 1.48 | 94 % | 33 % |
| 12 | 0.15 | 0.04 | 1.36 | 91 % | 26 % |
| 12 | 0.20 | 0.0 | 1.31 | 93 % | 25 % |
| 12 | 0.20 | 0.04 | 1.25 | 91 % | 20 % |

Per recording (current setting):

| recording | corners | laps | mean (±5 m, 10 %, floor 0.04) | ≥ 1 | ≥ 3 | worst corner |
|---|---|---|---|---|---|---|
| fuji-speedway-fuji-spe / LMP3 / adess-racing-team- | 10 | 4 | 3.55 | 100 % | 65 % | t3 (5.2) |
| sebring-international- / GT3 / garage-59-2026-58- | 6 | 5 | 3.70 | 100 % | 80 % | t6 (6.0) |
| sebring-international- / GT3 / mclaren-720s-gt3-e | 6 | 8 | 3.83 | 98 % | 75 % | t5 (5.8) |
| bahrain-international- / GT3 / mclaren-720s-gt3-e | 11 | 5 | 2.02 | 100 % | 27 % | t2 (3.0) |
| autodromo-nazionale-mo / GT3 / manthey-dk-enginee | 6 | 4 | 3.71 | 100 % | 71 % | t6 (5.2) |
| autodromo-nazionale-mo / GT3 / mclaren-720s-gt3-e | 8 | 9 | 2.06 | 76 % | 38 % | t6 (3.7) |
| circuit-de-spa-francor / GT3 / garage-59-2026-58- | 16 | 4 | 2.14 | 95 % | 31 % | t12 (5.2) |
| circuit-de-spa-francor / GT3 / mclaren-720s-gt3-e | 17 | 8 | 1.52 | 93 % | 24 % | t9 (3.0) |

## Corner start

For each detected corner and each lap, where the brake run that ends at the apex begins,
compared with the corner's `start_m`:

| lead-in m | braking corners | brake already on at start | median onset − start (m) | p90 |
|---|---|---|---|---|
| 0 | 414 | 47.1 % | 1 | 16 |
| 25 | 414 | 28.3 % | 24 | 39 |
| 50 | 414 | 27.8 % | 47 | 61 |
| 75 | 416 | 28.1 % | 66 | 85 |
| 100 | 416 | 27.9 % | 73 | 108 |

- "Brake already on at start" is about 28 % at any lead-in of 25 m or more, so a longer lead-in does
  not fix it. Those are corners whose start is clamped to the midpoint to the previous apex
  (apexes under 200 m apart: chicanes, complexes; one-off measurement, not in the tool): 92 % of their corner-laps have the brake on at the start, since the
  braking belongs to the previous corner's exit. In corners with 200 m or more to the previous apex,
  only 6 % of corner-laps brake before the corner start (the earliest 5 % brake 61 m or more before it).
- A 0 m lead-in has the brake already on at the start in 47 % of corner-laps. 50 m puts the start a median 47 m before the
  brake and, away from close corners, keeps 94 % of the braking inside. 75 and 100 m only widen the window. 50 m stays.

## Kerbs

| recording | laps | flagged m / lap | of which near the edge | off-edge repeating on ≥ 50 % of laps (m) |
|---|---|---|---|---|
| fuji-speedway-fuji-spe / LMP3 / adess-racing-team- | 4 | 141 | 138 | 0 |
| sebring-international- / GT3 / garage-59-2026-58- | 5 | 164 | 161 | 0 |
| sebring-international- / GT3 / mclaren-720s-gt3-e | 8 | 162 | 157 | 0 |
| bahrain-international- / GT3 / mclaren-720s-gt3-e | 5 | 488 | 466 | 11 |
| autodromo-nazionale-mo / GT3 / manthey-dk-enginee | 4 | 399 | 389 | 9 |
| autodromo-nazionale-mo / GT3 / mclaren-720s-gt3-e | 9 | 386 | 380 | 0 |
| circuit-de-spa-francor / GT3 / garage-59-2026-58- | 4 | 846 | 742 | 115 |
| circuit-de-spa-francor / GT3 / mclaren-720s-gt3-e | 8 | 898 | 812 | 35 |

| edge margin m | suspension peaks | min lap share | kerbs found (all recordings) | per recording |
|---|---|---|---|---|
| 0.5 | on | 0.5 | 48 | 1, 2, 3, 7, 8, 6, 10, 11 |
| 1.0 | on | 0.5 | 77 | 4, 4, 5, 11, 12, 10, 16, 15 |
| 1.5 | on | 0.5 | 85 | 5, 4, 5, 11, 12, 9, 19, 20 |
| 2.5 | on | 0.5 | 88 | 5, 4, 5, 11, 12, 9, 22, 20 |
| 4.0 | on | 0.5 | 88 | 5, 4, 5, 11, 12, 9, 22, 20 |
| 1.5 | off | 0.5 | 85 | 5, 4, 5, 11, 12, 9, 19, 20 |
| 1.5 | on | 0.3 | 107 | 5, 4, 7, 22, 12, 12, 19, 26 |
| 1.5 | on | 0.7 | 56 | 1, 3, 3, 9, 7, 7, 13, 13 |

- Edge margin: 0.5 m loses 40 % of the kerbs, 1.0 m about 10 %; 2.5 m adds only 3 on one Spa
  recording (19 to 22). 1.5 m stays.
- Off-edge flagged metres that repeat on at least half of the laps (drains, concrete) are 0 on
  Fuji, Sebring and Monza (Mclaren), 9 to 11 m on Bahrain and Monza (Manthey) and 35 to 115 m on Spa
  (many more drains there): the filter removes them, so the type-5 over-count is handled.
- Min lap share 0.3 doubles the kerbs on Bahrain (11 to 22) from few laps; 0.7 drops a third.
  0.5 stays.
- Suspension peaks: the kerb count is identical with the path switched off, so at 0.6 it adds no
  kerb on real data (its p99 off-kerb values sit below 0.6).

| recording | p50 speed on kerb (units/s) | p50 off kerb | p99 off kerb |
|---|---|---|---|
| fuji-speedway-fuji-spe / LMP3 / adess-racing-team- | 0.03 | 0.01 | 0.05 |
| sebring-international- / GT3 / garage-59-2026-58- | 0.09 | 0.07 | 0.37 |
| sebring-international- / GT3 / mclaren-720s-gt3-e | 0.08 | 0.07 | 0.36 |
| bahrain-international- / GT3 / mclaren-720s-gt3-e | 0.06 | 0.03 | 0.15 |
| autodromo-nazionale-mo / GT3 / manthey-dk-enginee | 0.07 | 0.03 | 0.14 |
| autodromo-nazionale-mo / GT3 / mclaren-720s-gt3-e | 0.09 | 0.04 | 0.22 |
| circuit-de-spa-francor / GT3 / garage-59-2026-58- | 0.07 | 0.03 | 0.20 |
| circuit-de-spa-francor / GT3 / mclaren-720s-gt3-e | 0.07 | 0.03 | 0.21 |

On a kerb the median is 0.03 to 0.09 against 0.01 to 0.07 off it and the off-kerb 99th percentile is
0.05 to 0.37, so the signal does not separate cleanly. Lowering the threshold to 0.3 finds 0 to 2 more
kerbs per recording and 0.15 up to 6 more (one-off sweep, not in the tool), none of them verifiable. Left at 0.6 until the
`Susp Pos` unit is checked (`docs/lmu-duckdb-schema.md`); the kerb flag carries detection.

## Not covered

- Wet conditions (see above).
- Other car classes at the extremes (Hypercar, LMP2 at speed): Fuji LMP3 is the only prototype.

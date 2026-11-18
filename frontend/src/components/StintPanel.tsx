// The Stint view (spike vroom-pnw.26, built in vroom-bi4.4). Per lap: time, fuel and virtual energy used, tyre surface temperature
// and wear per corner; plus the lap-time fall-off line (out, in, invalid and slow laps excluded). Data: api.sessionStints(sessionId).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { sessionStintsOptions } from "../api/queries";
import type { SessionMeta, Stint, Wheels } from "../api/types";
import { formatLapTime, formatShortDate } from "../lib/format";
import { falloff as fitFalloff, falloffPlot, stintRows, stintSummary, type FitExclusion } from "../lib/stint";
import { cx } from "../lib/cx";
import ui from "./ui.module.css";
import styles from "./StintPanel.module.css";

const EXCLUDED: Record<FitExclusion, string> = { out: "out lap", in: "in lap", incomplete: "incomplete", invalid: "invalid", slow: "slow (> 2 % off the median)" };
const f1 = (v: number | null, unit = "") => (v === null ? "—" : `${v.toFixed(1)}${unit}`);
const f2 = (v: number | null, unit = "") => (v === null ? "—" : `${v.toFixed(2)}${unit}`);
const signed = (v: number, digits = 3) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;

/** Four wheel values laid out like the car seen from above: FL FR on top, RL RR below. */
function WheelGrid({ v, digits = 0, label }: { v: Wheels | null; digits?: number; label: string }) {
  if (!v) return <span className={styles.dim}>—</span>;
  const t = (x: number) => x.toFixed(digits);
  return (
    <span className={styles.wheels} aria-label={`${label}: front left ${t(v.fl)}, front right ${t(v.fr)}, rear left ${t(v.rl)}, rear right ${t(v.rr)}`}>
      <span>{t(v.fl)}</span><span>{t(v.fr)}</span><span>{t(v.rl)}</span><span>{t(v.rr)}</span>
    </span>
  );
}

function StintBody({ stint, session, multi }: { stint: Stint; session: SessionMeta; multi: boolean }) {
  const rows = useMemo(() => stintRows(stint.laps), [stint]);
  const sum = useMemo(() => stintSummary(rows), [rows]);
  // The numbers come from the API (stint.falloff, stint.falloff_fuel_corrected); the chart's line needs the intercept, so it is drawn from a local raw fit.
  const plot = useMemo(() => falloffPlot(rows, fitFalloff(rows), 1000, 160), [rows]);
  const raw = stint.falloff;
  const corrected = stint.falloff_fuel_corrected;
  const hasEnergy = stint.laps.some((l) => l.energy_start_pct !== null);
  const cards: { k: string; v: string; title?: string }[] = [
    { k: "FALL-OFF", v: raw ? `${signed(raw.slope_s_per_lap)} s/lap` : "—", title: raw ? `Least-squares fit over ${raw.n_laps} laps` : undefined },
    { k: "FUEL / LAP", v: f2(sum.fuelPerLap, " L") },
    { k: "ENERGY / LAP", v: hasEnergy ? f2(sum.energyPerLap, " %") : "n/a" },
    {
      k: "RANGE", v: `${f1(sum.fuelRangeLaps, " laps")} on fuel · ${hasEnergy ? f1(sum.energyRangeLaps, " laps") : "—"} on energy`,
      title: "Laps the starting load lasts at the mean use per flying lap",
    },
    { k: "LIMIT", v: sum.limit === null ? "—" : sum.limit === "energy" ? "virtual energy" : "fuel" },
    { k: "WEAR / LAP", v: sum.wearPerLap ? `${sum.wearPerLap.fl.toFixed(2)} ${sum.wearPerLap.fr.toFixed(2)} / ${sum.wearPerLap.rl.toFixed(2)} ${sum.wearPerLap.rr.toFixed(2)} %` : "—", title: "FL FR / RL RR" },
  ];
  return (
    <>
      <div className={styles.meta}>
        {multi ? `Stint ${stint.stint_no} · ` : ""}{session.session_type} · {formatShortDate(session.started_at)} · {stint.laps.length} laps
      </div>
      <div className={styles.cards}>
        {cards.map((c) => (
          <div key={c.k} className={styles.card} title={c.title}>
            <div className={styles.cardKey}>{c.k}</div>
            <div className={styles.cardValue}>{c.v}</div>
          </div>
        ))}
      </div>
      {corrected && (
        // The fuel-weight effect is an assumed per-class constant (docs/stint/fuel-corrected-falloff.md), shown with its source.
        <div className={styles.corrected} aria-label="Fuel-corrected fall-off">
          <span className={styles.cardKey}>FUEL-CORRECTED FALL-OFF</span>
          <span className={styles.cardValue}>{signed(corrected.slope_s_per_lap)} s/lap</span>
          <span className={styles.dim}>
            {raw ? `raw ${signed(raw.slope_s_per_lap)} + ` : ""}fuel gain {corrected.fuel_gain_s_per_lap.toFixed(3)} s/lap ({corrected.kg_per_lap.toFixed(2)} kg a lap ×{" "}
            {corrected.s_per_kg.toFixed(4)} s/kg). Assumed: {corrected.assumption.source}.
          </span>
        </div>
      )}
      <div className={styles.plot}>
        <svg viewBox="0 0 1000 160" preserveAspectRatio="none" role="img" aria-label="Lap time against lap number, with the fall-off line">
          <path d="M0 40 L1000 40 M0 80 L1000 80 M0 120 L1000 120" className={styles.grid} />
          {plot.fit && <path d={plot.fit} className={styles.fit} />}
        </svg>
        {/* Points as HTML so they stay round under the stretched viewBox. */}
        {plot.points.map((p) => (
          <span
            key={p.lapNo}
            className={cx(styles.dot, p.excluded && styles.dotOut)}
            style={{ left: `${p.x / 10}%`, top: `${(p.y / 160) * 100}%` }}
            title={`Lap ${p.lapNo}${p.excluded ? ` (${EXCLUDED[p.excluded]}, not in the fit)` : ""}`}
          />
        ))}
        {plot.points.length > 0 && (
          <>
            <div className={cx(styles.axis, styles.axisTop)}>{formatLapTime(plot.lo)}</div>
            <div className={cx(styles.axis, styles.axisBottom)}>{formatLapTime(plot.hi)}</div>
          </>
        )}
      </div>
      <div className={styles.legend}>
        <span><span className={styles.legendDot} /> lap in the fit</span>
        <span><span className={cx(styles.legendDot, styles.dotOut)} /> left out (out, in, slow)</span>
        <span>━ fall-off line</span>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Lap</th>
              <th scope="col">Kind</th>
              <th scope="col" className={styles.num}>Time</th>
              <th scope="col" className={styles.num}>Fuel used</th>
              <th scope="col" className={styles.num}>Fuel left</th>
              {hasEnergy && <th scope="col" className={styles.num}>Energy used</th>}
              {hasEnergy && <th scope="col" className={styles.num}>Energy left</th>}
              <th scope="col" title="Lap mean of the tread surface, °C: FL FR / RL RR">Tyre °C</th>
              <th scope="col" title="Tread left at the end of the lap, %: FL FR / RL RR">Tread left %</th>
              <th scope="col" title="Lap mean, kPa: FL FR / RL RR">Pressure</th>
              <th scope="col" title="Lap mean of the disc, °C: FL FR / RL RR">Brake °C</th>
              <th scope="col" className={styles.num}>Track</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.lap.lap_no} className={r.excluded ? styles.excluded : undefined} title={r.excluded ? `Not in the fit: ${EXCLUDED[r.excluded]}` : undefined}>
                <td className={styles.num}>{r.lap.lap_no}</td>
                <td>{r.lap.kind}{r.excluded === "invalid" ? " · invalid" : r.excluded === "slow" ? " · slow" : ""}</td>
                <td className={styles.num}>{r.lap.lap_time_s ? formatLapTime(r.lap.lap_time_s) : "—"}</td>
                <td className={styles.num}>{r.fuelUsed === null ? "refuel" : f2(r.fuelUsed, " L")}</td>
                <td className={styles.num}>{f1(r.lap.fuel_end_l, " L")}</td>
                {hasEnergy && <td className={styles.num}>{r.energyUsed === null ? "refill" : f2(r.energyUsed, " %")}</td>}
                {hasEnergy && <td className={styles.num}>{f1(r.lap.energy_end_pct, " %")}</td>}
                <td><WheelGrid v={r.lap.tyre_surface_c} label="Tyre surface °C" /></td>
                <td><WheelGrid v={r.lap.tyre_wear_end_pct} digits={1} label="Tread left %" /></td>
                <td><WheelGrid v={r.lap.tyre_pressure_kpa} label="Pressure kPa" /></td>
                <td><WheelGrid v={r.lap.brake_c} label="Brake °C" /></td>
                <td className={styles.num}>{Math.round(r.lap.track_temp_c)}°C</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The session's stints, split at pit stops. Renders nothing when the session has none or the request fails. */
export function StintPanel({ session }: { session: SessionMeta }) {
  const q = useQuery(sessionStintsOptions(session.session_id));
  // A stint without a flying lap (the out lap that ends a recording after a stop) has nothing to show.
  const stints = (q.data ?? []).filter((st) => st.laps.some((l) => l.kind === "flying"));
  if (q.error || stints.length === 0) return null;
  return (
    <section aria-label="Stint" className={cx(ui.panel, styles.panel)}>
      <div className={styles.head}>
        <span className={ui.heading}>RACE RUN</span>
      </div>
      {stints.map((s) => <StintBody key={s.stint_no} stint={s} session={session} multi={stints.length > 1} />)}
    </section>
  );
}

// EXPERIMENTAL (vroom-pnw.26, spike): the Stint view. Per lap: time, fuel and virtual energy used, tyre surface temperature and
// wear per corner; plus the lap-time fall-off line (out, in, invalid and slow laps excluded). Data: api.stints() (experimental).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Stint, Wheels } from "../api/types";
import { formatLapTime, formatShortDate } from "../lib/format";
import { falloffPlot, stintRows, stintSummary, type FitExclusion } from "../lib/stint";
import { cx } from "../lib/cx";
import ui from "./ui.module.css";
import styles from "./StintPanel.module.css";

const EXCLUDED: Record<FitExclusion, string> = { out: "out lap", in: "in lap", incomplete: "incomplete", invalid: "invalid", slow: "slow (> 2 % off the median)" };
const f1 = (v: number | null, unit = "") => (v === null ? "—" : `${v.toFixed(1)}${unit}`);
const f2 = (v: number | null, unit = "") => (v === null ? "—" : `${v.toFixed(2)}${unit}`);

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

function StintBody({ stint }: { stint: Stint }) {
  const rows = useMemo(() => stintRows(stint.laps), [stint]);
  const sum = useMemo(() => stintSummary(rows), [rows]);
  const plot = useMemo(() => falloffPlot(rows, sum.falloff, 1000, 160), [rows, sum.falloff]);
  const hasEnergy = stint.laps.some((l) => l.energy_start_pct !== null);
  const cards: { k: string; v: string; title?: string }[] = [
    { k: "FALL-OFF", v: sum.falloff ? `${sum.falloff.slope >= 0 ? "+" : ""}${sum.falloff.slope.toFixed(3)} s/lap` : "—", title: sum.falloff ? `Least-squares fit over ${sum.falloff.n} laps` : undefined },
    { k: "FUEL / LAP", v: f2(sum.fuelPerLap, " L") },
    { k: "ENERGY / LAP", v: hasEnergy ? f2(sum.energyPerLap, " %") : "n/a" },
    {
      k: "RANGE", v: `${f1(sum.fuelRangeLaps)} fuel · ${hasEnergy ? f1(sum.energyRangeLaps) : "—"} energy`,
      title: "Laps the starting load lasts at the mean use per flying lap",
    },
    { k: "LIMIT", v: sum.limit === null ? "—" : sum.limit === "energy" ? "virtual energy" : "fuel" },
    { k: "WEAR / LAP %", v: sum.wearPerLap ? `${sum.wearPerLap.fl.toFixed(2)} ${sum.wearPerLap.fr.toFixed(2)} / ${sum.wearPerLap.rl.toFixed(2)} ${sum.wearPerLap.rr.toFixed(2)}` : "—", title: "FL FR / RL RR" },
  ];
  return (
    <>
      <div className={styles.meta}>
        {stint.session_type} · {formatShortDate(stint.started_at)} · {stint.laps.length} laps · {stint.source}
      </div>
      <div className={styles.cards}>
        {cards.map((c) => (
          <div key={c.k} className={styles.card} title={c.title}>
            <div className={styles.cardKey}>{c.k}</div>
            <div className={styles.cardValue}>{c.v}</div>
          </div>
        ))}
      </div>
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

/** The stints recorded with this track and car. Renders nothing when there are none. */
export function StintPanel({ trackId, carId }: { trackId: string; carId: string }) {
  const q = useQuery({ queryKey: ["experimental", "stints"], queryFn: () => api.stints(), staleTime: Infinity });
  const mine = (q.data ?? []).filter((s) => s.track_id === trackId && s.car_id === carId);
  if (q.error) return <section aria-label="Stint" className={ui.panel}><div className={ui.muted}>Stint: {q.error.message}</div></section>;
  if (mine.length === 0) return null;
  return (
    <section aria-label="Stint" className={cx(ui.panel, styles.panel)}>
      <div className={styles.head}>
        <span className={ui.heading}>STINT</span>
        <span className={styles.badge}>EXPERIMENTAL</span>
      </div>
      {mine.map((s) => <StintBody key={s.stint_id} stint={s} />)}
    </section>
  );
}

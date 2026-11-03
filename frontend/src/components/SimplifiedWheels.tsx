import type { ChannelArrays } from "../api/types";
import { gearLabel } from "../lib/format";
import type { PlaybackModel } from "../lib/model";
import { formatSteering, indexAtTime, wheelRotation } from "../lib/playback";
import { usePlayback } from "../state/playback";
import { colors } from "../theme";
import styles from "./SimplifiedWheels.module.css";

export interface SimplifiedWheelsProps {
  model: PlaybackModel;
  youName: string;
  refName: string;
}

function Driver({ name, color, ch, i, rangeDeg }: { name: string; color: string; ch: ChannelArrays; i: number; rangeDeg: number | null }) {
  const norm = ch.steering[i];
  const deg = wheelRotation(norm, rangeDeg);
  const label = formatSteering(norm, rangeDeg);
  const bars = [
    { k: "BRK", v: ch.brake[i], color: colors.brake },
    { k: "THR", v: ch.throttle[i], color: colors.throttle },
  ];
  return (
    <div className={styles.driver}>
      <div className={styles.name} style={{ color }}>{name}</div>
      <svg width={190} height={190} viewBox="0 0 120 120" role="img" aria-label={`${name} steering ${label}`}>
        <circle cx={60} cy={60} r={52} className={styles.rim} />
        <g transform={`rotate(${deg.toFixed(1)} 60 60)`}>
          <circle cx={60} cy={60} r={52} className={styles.ring} style={{ stroke: color }} />
          <path d="M60 8 L60 20" className={styles.mark} style={{ stroke: color }} />
          <path d="M10 62 L46 62 M74 62 L110 62 M60 74 L60 112" className={styles.spokes} />
          <circle cx={60} cy={62} r={13} className={styles.hub} />
        </g>
      </svg>
      <div className={styles.label}>{label}</div>
      <div className={styles.row}>
        <div className={styles.gear}>{gearLabel(ch.gear[i])}</div>
        {bars.map((b) => (
          <div key={b.k} className={styles.bar}>
            <div className={styles.track}>
              <div style={{ height: `${Math.round(b.v * 100)}%`, background: b.color }} />
            </div>
            <div className={styles.barLabel}>{b.k}</div>
          </div>
        ))}
      </div>
      <div className={styles.speed}>
        {Math.round(ch.speed_kmh[i])} <span className={styles.unit}>km/h</span>
      </div>
    </div>
  );
}

export function SimplifiedWheels({ model, youName, refName }: SimplifiedWheelsProps) {
  const tau = usePlayback((s) => s.tau);
  const { cmp } = model;
  const iy = indexAtTime(cmp.lap.t, tau);
  const ir = indexAtTime(cmp.ref.t, tau);
  return (
    <div className={styles.wheels}>
      <Driver name={youName} color={colors.you} ch={cmp.lap} i={iy} rangeDeg={cmp.lap_steering_range_deg} />
      <Driver name={refName} color={colors.comparison} ch={cmp.ref} i={ir} rangeDeg={cmp.ref_steering_range_deg} />
    </div>
  );
}

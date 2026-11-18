// A session recorded without lap traces (the Monza race) cannot open a lap on the Telemetry page, so `/?session=<id>` shows its
// Session tab alone. A session that does have traces is sent on to its default lap (vroom-bi4.12).
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSessionLaps, useSessions } from "../../api/queries";
import { formatShortDate } from "../../lib/format";
import { defaultLap } from "../../lib/laps";
import { withParams } from "../../lib/urlParams";
import { SessionTab } from "./SessionTab";
import styles from "./Session.module.css";
import tel from "../../pages/TelemetryPage.module.css";

export function TracelessSession({ sessionId }: { sessionId: string }) {
  const [, setParams] = useSearchParams();
  const navigate = useNavigate();
  const sessions = useSessions().data;
  const lapsQ = useSessionLaps(sessionId);
  const session = sessions?.find((s) => s.session_id === sessionId);
  const target = lapsQ.data ? defaultLap(lapsQ.data) : null;
  useEffect(() => {
    if (target) setParams((p) => withParams(p, { session: null, lap: target.lap_id }), { replace: true });
  }, [target, setParams]);

  if (lapsQ.error) return <div className={tel.message}>Could not load that session.</div>;
  if (!lapsQ.data || target) return <div className={tel.message}>Loading…</div>;
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <select className={styles.sessionPick} aria-label="Session" value={sessionId} onChange={(e) => navigate(`/?session=${encodeURIComponent(e.target.value)}`)}>
          {(sessions ?? []).slice().sort((a, b) => b.started_at.localeCompare(a.started_at)).map((s) => (
            <option key={s.session_id} value={s.session_id}>{s.track_name} · {s.car_name} · {formatShortDate(s.started_at)}</option>
          ))}
        </select>
        <span className={styles.note}>{session ? `${session.session_type}: ` : ""}recorded without lap traces</span>
      </div>
      <SessionTab sessionId={sessionId} onOpen={() => {}} />
    </div>
  );
}

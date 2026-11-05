import { useMemo, useRef, useState, type MouseEvent } from "react";
import { useQueries } from "@tanstack/react-query";
import { sessionLapsOptions, useCalibrate, useLandmarkMutation, useLapTrace, useSessions, useTrackMap } from "../api/queries";
import { errorInfo, type CalibrationResult, type GridChannel, type Landmark, type LandmarkKind, type SessionMeta } from "../api/types";
import { AddLandmarkForm, LandmarkEditor } from "../components/LandmarkEditor";
import { landmarkFill, landmarkStroke } from "../lib/landmarks";
import { bestValidLap } from "../lib/laps";
import { projectLatLon, nearestCorner, nearestPoint, pointAtDistance, GPS_SMOOTH_HALF, polylinePath, segmentPath, smoothClosed, type Projection } from "../lib/trackmap";
import { cx } from "../lib/cx";
import ui from "../components/ui.module.css";
import styles from "./TracksPage.module.css";

const W = 200;
const H = 240;
const PAD = 14;
const GEO_CHANNELS: GridChannel[] = ["lat", "lon"];
const VIEWBOX = `${-PAD} ${-PAD} ${W + 2 * PAD} ${H + 2 * PAD}`;

interface Err {
  code: string;
  message: string;
}

interface Geometry {
  proj: Projection;
  distance: number[];
  basePath: string;
}

export function TracksPage() {
  const sessionsQ = useSessions();
  const sessions = sessionsQ.data ?? null;
  const [trackId, setTrackId] = useState<string | null>(null);
  const [selectedCorner, setSelectedCorner] = useState<string | null>(null);
  const [calResult, setCalResult] = useState<CalibrationResult | null>(null);
  const [adding, setAdding] = useState<{ distanceM: number; cornerId: string | null; left: number; top: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const mapBoxRef = useRef<HTMLDivElement>(null);

  // Tracks come from the sessions' distinct track ids, newest first.
  const tracks = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; newest: SessionMeta }>();
    for (const s of [...(sessions ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at))) {
      if (!seen.has(s.track_id)) seen.set(s.track_id, { id: s.track_id, name: s.track_name, newest: s });
    }
    return [...seen.values()];
  }, [sessions]);
  const activeId = trackId && tracks.some((t) => t.id === trackId) ? trackId : (tracks[0]?.id ?? null);

  const mapQ = useTrackMap(activeId);
  const map = mapQ.data ?? null;
  const landmarkM = useLandmarkMutation(activeId);
  const calibrateM = useCalibrate();

  // Geometry: GPS of the best valid lap (else any lap) of the newest session on this track that has one.
  const trackSessions = useMemo(
    () => (sessions ?? []).filter((x) => x.track_id === activeId).sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [sessions, activeId],
  );
  const lapsQ = useQueries({
    queries: trackSessions.map((s) => sessionLapsOptions(s.session_id)),
    combine: (rs) => ({ laps: rs.map((r) => r.data), error: rs.find((r) => r.error)?.error ?? null }),
  });
  const geoLapId = useMemo(() => {
    for (const laps of lapsQ.laps) {
      if (!laps) return null; // still loading: keep newest-first order
      const lap = bestValidLap(laps) ?? laps.find((l) => l.kind === "flying") ?? laps[0];
      if (lap) return lap.lap_id;
    }
    return null;
  }, [lapsQ]);
  const traceQ = useLapTrace(geoLapId, GEO_CHANNELS);
  const geo = useMemo<Geometry | null>(() => {
    const tr = traceQ.data;
    if (!tr?.ch.lat || !tr.ch.lon) return null;
    const proj = projectLatLon(smoothClosed(tr.ch.lat, GPS_SMOOTH_HALF), smoothClosed(tr.ch.lon, GPS_SMOOTH_HALF), W, H);
    return { proj, distance: tr.distance, basePath: polylinePath(proj, 0, proj.x.length - 1, 2) };
  }, [traceQ.data]);

  const failure = landmarkM.error ?? calibrateM.error ?? sessionsQ.error ?? mapQ.error ?? lapsQ.error ?? traceQ.error;
  const error: Err | null = failure ? errorInfo(failure) : null;
  const busy = landmarkM.isPending;
  const calibrating = calibrateM.isPending;

  const selectTrack = (id: string) => {
    setTrackId(id);
    setSelectedCorner(null);
    setCalResult(null);
    setAdding(null);
    landmarkM.reset();
    calibrateM.reset();
  };

  const cornerSegs = useMemo(() => {
    if (!map || !geo) return [];
    return map.corners.map((c) => ({
      c,
      d: c.start_m > c.end_m ? "" : segmentPath(geo.proj, geo.distance, c.start_m, c.end_m),
      label: pointAtDistance(geo.proj, geo.distance, c.apex_m),
    }));
  }, [map, geo]);

  const calibrate = () => {
    if (!activeId) return;
    landmarkM.reset();
    calibrateM.mutate(activeId, { onSuccess: setCalResult, onError: () => setCalResult(null) });
  };

  const onMapClick = (e: MouseEvent<SVGSVGElement>) => {
    if (!e.altKey || !geo || !map || !svgRef.current || !mapBoxRef.current) return;
    const ctm = svgRef.current.getScreenCTM();
    if (!ctm) return;
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const local = pt.matrixTransform(ctm.inverse());
    const { index } = nearestPoint(geo.proj, local.x, local.y);
    if (index < 0) return;
    const distanceM = geo.distance[index];
    const box = mapBoxRef.current.getBoundingClientRect();
    setAdding({
      distanceM,
      cornerId: nearestCorner(map, distanceM)?.id ?? null,
      left: Math.min(Math.max(4, e.clientX - box.left + 8), Math.max(4, box.width - 238)),
      top: Math.min(Math.max(4, e.clientY - box.top + 8), Math.max(4, box.height - 190)),
    });
  };

  if (sessions === null && !error) return <div className={styles.status}>Loading…</div>;
  if (tracks.length === 0) return <div className={styles.status}>{error ? `${error.code}: ${error.message}` : "No tracks yet. Import a recording first."}</div>;

  const visibleLandmarks = (map?.landmarks ?? []).filter((l) => !selectedCorner || l.corner_id === selectedCorner);
  const selectedName = map?.corners.find((c) => c.id === selectedCorner)?.name ?? "all corners";
  const matched = calResult ? calResult.map.corners.length - calResult.missing.length : 0;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        {tracks.map((t) => (
          <button key={t.id} type="button" aria-pressed={t.id === activeId} onClick={() => selectTrack(t.id)} className={ui.chip}>
            {t.name}
          </button>
        ))}
        <div className={styles.spacer} />
        <button type="button" disabled={calibrating || !map} onClick={calibrate} className={cx(ui.btnPrimary, styles.calibrate)}>
          {calibrating ? "Calibrating…" : "Re-calibrate from ★ reference"}
        </button>
      </div>
      <div role="status" className={cx(ui.panel, styles.statusBar, error && styles.error, (calResult || error) && styles.mono)}>
        {error
          ? `${error.code}: ${error.message}`
          : calResult
            ? `Matched ${matched} of ${calResult.map.corners.length} corners · ${calResult.unmapped.length} unmapped detected · ${calResult.missing.length} missing`
            : "Re-calibrate to match the corners detected on the reference lap against this map."}
      </div>

      <div className={styles.columns}>
        <section aria-label="Track map" className={cx(ui.panel, styles.mapPanel)}>
          <div className={styles.mapHead}>
            <div className={ui.heading}>MAP · ALT-CLICK TO ADD A LANDMARK</div>
            <div className={styles.legend}>
              <span className={styles.confirmed}>●</span> confirmed <span className={styles.detected}>●</span> detected <span>○</span> low (not used by coach)
            </div>
          </div>
          <div ref={mapBoxRef} className={styles.mapBox}>
            {geo && map ? (
              <svg ref={svgRef} viewBox={VIEWBOX} onClick={onMapClick} role="img" aria-label="Track map" className={styles.map}>
                <path d={geo.basePath} className={styles.base} />
                {cornerSegs.map(({ c, d }) =>
                  d ? (
                    <path
                      key={c.id}
                      d={d}
                      aria-label={c.name}
                      onClick={(e) => {
                        if (!e.altKey) setSelectedCorner(c.id);
                      }}
                      className={cx(styles.seg, c.id === selectedCorner && styles.selected)}
                    />
                  ) : null,
                )}
                {cornerSegs.map(({ c, label }) => (
                  <text
                    key={c.id}
                    x={label.x + (label.x > W / 2 ? 8 : -8)}
                    y={label.y + 2}
                    textAnchor={label.x > W / 2 ? "start" : "end"}
                    className={cx(styles.cornerName, c.id === selectedCorner && styles.selected)}
                  >
                    {c.name}
                  </text>
                ))}
                {map.landmarks.map((l) => {
                  const p = pointAtDistance(geo.proj, geo.distance, l.distance_m);
                  return (
                    <circle key={l.id} cx={p.x} cy={p.y} r={2.4} className={styles.landmark} style={{ fill: landmarkFill(l.confidence), stroke: landmarkStroke(l.confidence) }}>
                      <title>{l.label}</title>
                    </circle>
                  );
                })}
              </svg>
            ) : (
              <div className={styles.loadingMap}>{error ? "" : "Loading map…"}</div>
            )}
            {adding && map && (
              <AddLandmarkForm
                distanceM={adding.distanceM}
                corners={map.corners}
                defaultCornerId={adding.cornerId}
                style={{ left: adding.left, top: adding.top }}
                onCancel={() => setAdding(null)}
                onSubmit={({ label, kind, cornerId }) => {
                  const lm: Landmark = {
                    id: `custom-${Date.now()}`, label, kind: kind as LandmarkKind, distance_m: Math.round(adding.distanceM),
                    corner_id: cornerId, confidence: "confirmed",
                  };
                  setAdding(null);
                  landmarkM.mutate({ op: "add", landmark: lm });
                }}
              />
            )}
          </div>
        </section>

        <div className={styles.side}>
          <section aria-label="Corners" className={ui.panel}>
            <div className={cx(ui.heading, styles.cornersHead)}>CORNERS{map ? ` · ${map.corners.length}` : ""}</div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col" className={styles.left}>Name</th>
                    <th scope="col" className={styles.left}>Complex</th>
                    <th scope="col">start</th>
                    <th scope="col">apex</th>
                    <th scope="col">end</th>
                  </tr>
                </thead>
                <tbody>
                  {(map?.corners ?? []).map((c) => (
                    <tr key={c.id} className={cx(c.id === selectedCorner && styles.selected)}>
                      <td className={cx(styles.left, styles.nameCell)}>
                        <button
                          type="button"
                          aria-pressed={c.id === selectedCorner}
                          onClick={() => setSelectedCorner(c.id === selectedCorner ? null : c.id)}
                          className={styles.nameBtn}
                        >
                          {c.name}{c.approx ? " ~" : ""}
                        </button>
                      </td>
                      <td className={cx(styles.left, styles.complex)}>{c.complex ?? ""}</td>
                      <td>{Math.round(c.start_m)} m</td>
                      <td>{Math.round(c.apex_m)} m</td>
                      <td>{Math.round(c.end_m)} m</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <LandmarkEditor
            title={selectedName}
            landmarks={visibleLandmarks}
            busy={busy}
            onConfirm={(id) => landmarkM.mutate({ op: "patch", landmarkId: id, patch: { confirm: true } })}
            onDelete={(id) => landmarkM.mutate({ op: "delete", landmarkId: id })}
          />
        </div>
      </div>
    </div>
  );
}

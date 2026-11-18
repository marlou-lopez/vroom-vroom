import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { useQueries, type QueryObserverResult } from "@tanstack/react-query";
import { sessionLapsOptions, useCalibrate, useLandmarkMutation, useLapTrace, useSessions, useTrackMap } from "../api/queries";
import { errorInfo, type CalibrationResult, type GridChannel, type LapWithRef, type Landmark, type LandmarkKind, type NewLandmark, type SessionMeta } from "../api/types";
import { ADD_LANDMARK_BTN_ID, AddLandmarkForm, LandmarkEditor } from "../components/LandmarkEditor";
import { landmarkFill, landmarkStroke } from "../lib/landmarks";
import { bestValidLap } from "../lib/laps";
import { nearestCorner, nearestPoint, pointAtDistance, polylinePath, cornerSegmentPath, type Projection } from "../lib/trackmap";
import { buildProjection } from "../lib/model";
import { boundsOf, placeMapLabels } from "../lib/mapLabels";
import { cx } from "../lib/cx";
import ui from "../components/ui.module.css";
import styles from "./TracksPage.module.css";

const PAD = 6;
const FONT_FRAC = 0.03; // label font size as a share of the track's longer side
const TOAST_MS = 8000;
const GEO_CHANNELS: GridChannel[] = ["lat", "lon"];

// Stable reference: useQueries re-runs a combine only when the results change, so geoLapId's memo can hold.
function combineLaps(rs: QueryObserverResult<LapWithRef[], Error>[]) {
  return { laps: rs.map((r) => r.data), error: rs.find((r) => r.error)?.error ?? null };
}

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
  const [adding, setAdding] = useState<{ seq: number; distanceM: number; cornerId: string | null; left?: number; top?: number; inline?: boolean } | null>(null);
  const addSeq = useRef(0);
  // A delete is held back for TOAST_MS so Undo restores the landmark exactly (the contract can't re-add one with its confidence).
  const [pending, setPending] = useState<Landmark | null>(null);
  const pendingRef = useRef<Landmark | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const commitRef = useRef<() => void>(() => {});
  // The side-panel form is prefilled from the selected corner: close it when the selection changes so it can't go stale.
  const selectCorner = (id: string | null) => {
    setSelectedCorner(id);
    setAdding((a) => (a?.inline ? null : a));
  };
  const closeInline = () => {
    setAdding(null);
    requestAnimationFrame(() => document.getElementById(ADD_LANDMARK_BTN_ID)?.focus());
  };
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
  useEffect(() => {
    commitRef.current = () => {
      const l = pendingRef.current;
      if (!l) return;
      pendingRef.current = null;
      setPending(null);
      landmarkM.mutate({ op: "delete", landmarkId: l.id });
    };
  });
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => commitRef.current(), TOAST_MS);
    return () => clearTimeout(t);
  }, [pending]);
  useEffect(() => () => commitRef.current(), []); // leaving the page commits the delete

  // Geometry: GPS of the best valid lap (else any lap) of the newest session on this track that has one.
  const trackSessions = useMemo(
    () => (sessions ?? []).filter((x) => x.track_id === activeId).sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [sessions, activeId],
  );
  const lapsQ = useQueries({
    queries: trackSessions.map((s) => sessionLapsOptions(s.session_id)),
    combine: combineLaps, // module-level so its result only changes with the query data
  });
  const geoLapId = useMemo(() => {
    for (const laps of lapsQ.laps) {
      if (!laps) return null; // still loading: keep newest-first order
      const withTrace = laps.filter((l) => l.has_trace);
      const lap = bestValidLap(laps) ?? withTrace.find((l) => l.kind === "flying") ?? withTrace[0];
      if (lap) return lap.lap_id;
    }
    return null;
  }, [lapsQ]);
  const traceQ = useLapTrace(geoLapId, GEO_CHANNELS);
  const geo = useMemo<Geometry | null>(() => {
    const tr = traceQ.data;
    if (!tr?.ch.lat || !tr.ch.lon) return null;
    const proj = buildProjection(tr.ch.lat, tr.ch.lon);
    return { proj, distance: tr.distance, basePath: polylinePath(proj, 0, proj.x.length - 1, 2) };
  }, [traceQ.data]);

  const failure = landmarkM.error ?? calibrateM.error ?? sessionsQ.error ?? mapQ.error ?? lapsQ.error ?? traceQ.error;
  const error: Err | null = failure ? errorInfo(failure) : null;
  const busy = landmarkM.isPending;
  const calibrating = calibrateM.isPending;

  const selectTrack = (id: string) => {
    commitRef.current();
    setTrackId(id);
    setSelectedCorner(null);
    setCalResult(null);
    setAdding(null);
    landmarkM.reset();
    calibrateM.reset();
  };

  const deleteLandmark = (id: string) => {
    const landmark = map?.landmarks.find((l) => l.id === id);
    if (!landmark) return;
    commitRef.current(); // an earlier held delete is final once another starts
    setPending(landmark);
  };
  const undoDelete = () => setPending(null);

  const cornerSegs = useMemo(() => {
    if (!map || !geo) return [];
    return map.corners.map((c) => ({
      c,
      d: cornerSegmentPath(geo.proj, geo.distance, c.start_m, c.end_m),
      label: pointAtDistance(geo.proj, geo.distance, c.apex_m),
    }));
  }, [map, geo]);

  // Corner labels placed so none overlap, and a viewBox that fits the track plus its labels to the panel.
  const layout = useMemo(() => {
    if (!geo) return null;
    const xs = geo.proj.x, ys = geo.proj.y;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
    const fontSize = span * FONT_FRAC;
    const obstacles = xs.map((x, i) => ({ x, y: ys[i] })).filter((_, i) => i % 3 === 0);
    const labels = placeMapLabels(cornerSegs.map(({ c, label }) => ({ id: c.id, text: c.name, x: label.x, y: label.y })), { fontSize, obstacles });
    const b = boundsOf(geo.proj, labels);
    const w = b.maxX - b.minX + 2 * PAD, h = b.maxY - b.minY + 2 * PAD;
    return { labels, fontSize, viewBox: `${b.minX - PAD} ${b.minY - PAD} ${w} ${h}`, aspect: w / h };
  }, [geo, cornerSegs]);

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
      seq: ++addSeq.current,
      distanceM,
      cornerId: nearestCorner(map, distanceM)?.id ?? null,
      left: Math.min(Math.max(4, e.clientX - box.left + 8), Math.max(4, box.width - 238)),
      top: Math.min(Math.max(4, e.clientY - box.top + 8), Math.max(4, box.height - 190)),
    });
  };

  const openAddForm = () => {
    if (!map) return;
    const corner = map.corners.find((c) => c.id === selectedCorner);
    setAdding({ seq: ++addSeq.current, distanceM: corner ? Math.round(corner.apex_m) : 0, cornerId: corner?.id ?? null, inline: true });
  };

  const addForm = adding && map && (
    <AddLandmarkForm
      key={adding.seq} // remount per open: the form's state only reads its props initially
      distanceM={adding.distanceM}
      corners={map.corners}
      defaultCornerId={adding.cornerId}
      inline={adding.inline}
      style={adding.inline ? undefined : { left: adding.left, top: adding.top }}
      maxM={geo ? geo.distance[geo.distance.length - 1] : undefined}
      onCancel={() => (adding.inline ? closeInline() : setAdding(null))}
      onSubmit={({ label, kind, cornerId, distanceM }) => {
        const lm: NewLandmark = { label, kind: kind as LandmarkKind, distance_m: Math.round(distanceM), corner_id: cornerId };
        if (adding.inline) closeInline();
        else setAdding(null);
        landmarkM.mutate({ op: "add", landmark: lm });
      }}
    />
  );

  if (sessions === null && !error) return <div className={styles.status}>Loading…</div>;
  if (tracks.length === 0) return <div className={styles.status}>{error ? `${error.code}: ${error.message}` : "No tracks yet. Import a recording first."}</div>;

  const visibleLandmarks = (map?.landmarks ?? []).filter((l) => l.id !== pending?.id && (!selectedCorner || l.corner_id === selectedCorner));
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
        <button type="button" disabled={calibrating || !map} onClick={calibrate} className={cx(ui.btn, styles.calibrate)}>
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
          <div ref={mapBoxRef} className={styles.mapBox} style={layout ? ({ aspectRatio: layout.aspect, "--aspect": layout.aspect } as CSSProperties) : undefined}>
            {geo && map && layout ? (
              // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- Alt-click is the fast path; the keyboard path is the Add landmark button in the Landmarks panel
              <svg ref={svgRef} viewBox={layout.viewBox} onClick={onMapClick} role="img" aria-label="Track map" className={styles.map}>
                <path d={geo.basePath} className={styles.base} />
                {cornerSegs.map(({ c, d }) =>
                  d ? (
                    <path
                      key={c.id}
                      d={d}
                      aria-label={c.name}
                      onClick={(e) => {
                        if (!e.altKey) selectCorner(c.id);
                      }}
                      className={cx(styles.seg, c.id === selectedCorner && styles.selected)}
                    />
                  ) : null,
                )}
                {layout.labels.map((l) =>
                  l.leader ? <line key={`${l.id}-leader`} x1={l.anchor.x} y1={l.anchor.y} x2={l.edge.x} y2={l.edge.y} className={styles.leader} /> : null,
                )}
                {layout.labels.map((l) => (
                  <text
                    key={l.id}
                    x={l.x}
                    y={l.y}
                    data-ax={l.anchor.x}
                    data-ay={l.anchor.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={layout.fontSize}
                    className={cx(styles.cornerName, l.id === selectedCorner && styles.selected)}
                  >
                    {l.text}
                  </text>
                ))}
                {map.landmarks.filter((l) => l.id !== pending?.id).map((l) => {
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
            {addForm && !adding?.inline && addForm}
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
                          onClick={() => selectCorner(c.id === selectedCorner ? null : c.id)}
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
            corners={map?.corners ?? []}
            busy={busy}
            onConfirm={(id) => landmarkM.mutate({ op: "patch", landmarkId: id, patch: { confirm: true } })}
            onDelete={deleteLandmark}
            onAdd={openAddForm}
          />
          {adding?.inline && addForm}
        </div>
      </div>
      {pending && (
        <div role="status" className={styles.toast}>
          <span>Deleted {pending.label}</span>
          <button type="button" onClick={undoDelete} className={ui.btn}>Undo</button>
        </div>
      )}
    </div>
  );
}

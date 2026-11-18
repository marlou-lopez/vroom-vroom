import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { withParams } from "../lib/urlParams";
import { AnalysisBar } from "../components/AnalysisBar";
import { AnnotationCardProvider, type AnnotationCardActions } from "../components/AnnotationPopup";
import { ScrubberBadges, ScrubberOffTrack, ScrubberSections, type BadgeHandlers } from "../components/AnnotationOverlays";
import { CornersTable } from "../components/CornersTable";
import { DetailedStrips } from "../components/DetailedStrips";
import { EngineerLine } from "../components/EngineerLine";
import { SimplifiedWheels } from "../components/SimplifiedWheels";
import { TrackPanel } from "../components/TrackPanel";
import { Transport } from "../components/Transport";
import { CornerRail } from "../components/workspace/CornerRail";
import { LapRail } from "../components/workspace/LapRail";
import wsStyles from "../components/workspace/Workspace.module.css";
import { leadInTime, toAnnotations, type Annotation } from "../lib/annotations";
import { effectiveValid, type Corner } from "../api/types";
import { CORNER_LEAD_M } from "../lib/annotations";
import { cornerRailRows } from "../lib/cornerRail";
import { comparisonName } from "../lib/compareName";
import { timeAtDistance } from "../lib/playback";
import { buildModel } from "../lib/model";
import { invalidHint } from "../lib/offTrack";
import { PlaybackProvider, usePlayback, usePlaybackStore, type PlaybackView } from "../state/playback";
import { useAnnotationPopup } from "../state/useAnnotationPopup";
import { useCoach } from "../state/useCoach";
import { useTelemetryData } from "../state/useTelemetryData";
import styles from "./TelemetryPage.module.css";
import ui from "../components/ui.module.css";

const EMPTY_ANNOTATIONS: Annotation[] = [];

export function TelemetryPage() {
  return (
    <PlaybackProvider>
      <Telemetry />
    </PlaybackProvider>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return <div className={styles.message}>{children}</div>;
}

function Telemetry() {
  const [params, setParams] = useSearchParams();
  const lapParam = params.get("lap");
  const refParam = params.get("ref");
  const { ctx, cmp, candidates, trackMap, geometry, error } = useTelemetryData(lapParam, refParam);
  const store = usePlaybackStore();
  const view = usePlayback((s) => s.view);
  const [expanded, setExpanded] = useState(false);
  const [keptCtx, setKeptCtx] = useState<typeof ctx>(null);
  if (ctx && ctx !== keptCtx) setKeptCtx(ctx);
  // Like the lap rail, the corner rail stays mounted (filter and scroll survive) while the next comparison loads.
  const [keptCmp, setKeptCmp] = useState<typeof cmp>(null);
  if (cmp && cmp !== keptCmp) setKeptCmp(cmp);
  const [tab, setTab] = useState<"strips" | "corners">("strips");

  // Escape collapses the expanded map, unless something else (an open popup) already handled it.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // No ?lap: reflect the resolved default in the URL, keeping every other param.
  useEffect(() => {
    if (!lapParam && ctx) setParams((p) => withParams(p, { lap: ctx.lap.lap_id }), { replace: true });
  }, [lapParam, ctx, setParams]);

  const model = useMemo(() => (cmp ? buildModel(cmp) : null), [cmp]);

  useEffect(() => {
    if (!model) return;
    store.setDuration(model.duration);
    store.setLaps(model.cmp.lap_id, model.cmp.ref_lap_id);
  }, [model, store]);

  // ?at=<metres> (from the ideal lap's breakdown and segment strips): open the lap at that distance, once per lap and distance.
  const atParam = params.get("at");
  const seekedAt = useRef<string | null>(null);
  useEffect(() => {
    const m = atParam === null || atParam.trim() === "" ? NaN : Number(atParam);
    if (!model || !Number.isFinite(m) || model.cmp.lap_id !== lapParam) return;
    const key = `${model.cmp.lap_id}|${atParam}`;
    if (seekedAt.current === key) return;
    seekedAt.current = key;
    store.pause();
    store.seek(timeAtDistance(model.cmp.lap.t, model.cmp.distance, m - CORNER_LEAD_M));
  }, [model, atParam, lapParam, store]);

  // Coach results for this lap and comparison; Analyze and Average together form one annotation set.
  const coach = useCoach(ctx?.lap.lap_id ?? null, cmp?.ref_lap_id ?? null);
  const popup = useAnnotationPopup();
  // All findings, kept whether or not the notes are shown: the Analysis bar counts these.
  const allAnnotations = useMemo<Annotation[]>(
    () => (cmp && trackMap ? toAnnotations(coach.results, cmp, trackMap) : []),
    [cmp, trackMap, coach.results],
  );
  // What the map, strips and scrubber draw: nothing while notes are hidden.
  const annotations = useMemo<Annotation[]>(
    () => (coach.showNotes ? allAnnotations : EMPTY_ANNOTATIONS),
    [coach.showNotes, allAnnotations],
  );

  const seekTo = useCallback((a: Annotation) => cmp && store.seek(leadInTime(cmp, a)), [cmp, store]);
  // Stable between renders, so the memoised track views only render when something they draw changes.
  const handlers = useMemo<BadgeHandlers>(() => ({ onSeek: seekTo }), [seekTo]);
  const seekToCornerStart = useCallback(
    (startM: number) => {
      if (!cmp) return;
      store.pause();
      store.seek(leadInTime(cmp, { startM }));
    },
    [cmp, store],
  );
  const seekToCorner = useCallback((c: Corner) => seekToCornerStart(c.start_m), [seekToCornerStart]);
  const { deepDives, setReviewed, askCorner } = coach;
  const { setOpen } = popup;
  const onPlay = useCallback(
    (a: Annotation) => {
      seekTo(a);
      store.play();
    },
    [seekTo, store],
  );
  const onToggleReviewed = useCallback((a: Annotation) => void setReviewed(a.findingId, !a.reviewed), [setReviewed]);
  const onAsk = useCallback((a: Annotation) => askCorner(a.cornerId), [askCorner]);
  // Stable, so the card context's consumers only render when an input changes.
  const cardActions = useMemo<AnnotationCardActions>(
    () => ({ deepDives, setOpen, onPlay, onToggleReviewed, onAsk }),
    [deepDives, setOpen, onPlay, onToggleReviewed, onAsk],
  );

  const lapTime = ctx?.laps.find((l) => l.lap_id === cmp?.lap_id)?.lap_time_s ?? null;
  // The ideal lap is not in the session's lap list: its time comes from the candidate.
  const refTime = ctx?.laps.find((l) => l.lap_id === cmp?.ref_lap_id)?.lap_time_s ?? candidates.find((c) => c.lap_id === cmp?.ref_lap_id)?.lap_time_s ?? null;
  // Stable, so the memoised track views don't render for unrelated page state.
  const lapTimes = useMemo(() => (cmp ? { lap: lapTime, ref: refTime } : undefined), [cmp, lapTime, refTime]);

  const selectLap = (id: string) => setParams((p) => withParams(p, { lap: id, ref: null, at: null }));
  const selectRef = (id: string | null) => setParams((p) => withParams(p, { lap: ctx!.lap.lap_id, ref: id, at: null }));

  // Whether the lap counts as valid (the manual override wins); decides whether its wheels-off marks are red or grey.
  const lapValid = ctx ? effectiveValid(ctx.lap) : true;
  const offTrackHint = useMemo(() => (cmp && !lapValid ? invalidHint(cmp.lap, trackMap) : null), [cmp, trackMap, lapValid]);
  const ideal = candidates.find((c) => c.is_ideal) ?? null;
  const refCand = candidates.find((c) => c.lap_id === cmp?.ref_lap_id) ?? null;
  const priorityCorners = useMemo(
    () => new Set([...annotations.map((a) => a.cornerId), ...(cmp && trackMap ? cornerRailRows(cmp, trackMap.corners).filter((r) => r.kind === "loss").map((r) => r.corner.id) : [])]),
    [annotations, cmp, trackMap],
  );
  const youName = ctx ? `You · L${ctx.lap.lap_no}` : "You";
  const refShort = comparisonName(refCand, ctx?.laps ?? []);
  const refName = refCand ? `Comparison · ${refCand.is_reference ? "★" : ""}${refCand.label}` : "Comparison";

  const views: { id: PlaybackView; label: string }[] = [
    { id: "detailed", label: "Detailed" },
    { id: "simplified", label: "Simplified" },
  ];

  return (
    <AnnotationCardProvider value={cardActions}>
      {ctx && (
        <AnalysisBar
          coach={coach} annotations={allAnnotations} disabled={coach.running !== null}
          totalDelta={cmp ? (cmp.delta[cmp.delta.length - 1] ?? null) : null}
        />
      )}
      {(() => {
        const body = error && !model ? (
          error.code === "unknown_lap" ? (
            <Message>
              <div className={styles.missing}>
                <p>That lap no longer exists</p>
                <div className={styles.actions}>
                  <Link to="/" className={ui.btn}>Open latest lap</Link>
                  <Link to="/sessions" className={ui.btn}>Sessions</Link>
                </div>
              </div>
            </Message>
          ) : (
            <Message>{error.code}: {error.message}</Message>
          )
        ) : !model ? (
          <Message>Loading…</Message>
        ) : (
          <>
            {cmp?.warning && <div className={styles.warning}>{cmp.warning}</div>}
            {cmp && cmp.lap_id === cmp.ref_lap_id && (
              <div className={styles.warning} role="note">
                This lap is the comparison lap, so every delta is zero.
                {ideal && <> <button type="button" className={ui.btn} onClick={() => selectRef(ideal.lap_id)}>Compare with the ideal lap</button></>}
              </div>
            )}
            <div className={styles.grid} data-expanded={expanded || undefined}>
              <TrackPanel
                model={model} trackMap={trackMap} geometry={geometry}
                annotations={annotations} handlers={handlers}
                lapTimes={lapTimes} lapValid={lapValid}
                refName={refShort}
                expanded={expanded} onToggleExpanded={() => setExpanded((x) => !x)}
                footer={<EngineerLine annotations={annotations} trackMap={trackMap} model={model} />}
              />
              {!expanded && (
              <section aria-label="Inputs" className={styles.inputs}>
                <div className={styles.viewBar}>
                  <ToggleGroup.Root
                    type="single" aria-label="Inputs tab" className={styles.viewToggle}
                    value={tab} onValueChange={(v) => v && setTab(v as "strips" | "corners")}
                  >
                    <ToggleGroup.Item value="strips" className={ui.toggleItem}>Strips</ToggleGroup.Item>
                    <ToggleGroup.Item value="corners" className={ui.toggleItem}>Corners</ToggleGroup.Item>
                  </ToggleGroup.Root>
                  {tab === "strips" && (
                    <ToggleGroup.Root
                      type="single" aria-label="Input view" className={styles.viewToggle}
                      value={view} onValueChange={(v) => v && store.setView(v as PlaybackView)}
                    >
                      {views.map((v) => (
                        <ToggleGroup.Item key={v.id} value={v.id} className={ui.toggleItem}>{v.label}</ToggleGroup.Item>
                      ))}
                    </ToggleGroup.Root>
                  )}
                </div>
                {tab === "corners" ? (
                  <CornersTable corners={model.cmp.corners} trackMap={trackMap} onSeek={seekToCorner} />
                ) : view === "detailed" ? <DetailedStrips model={model} geometry={geometry} annotations={annotations} handlers={handlers} lapValid={lapValid} corners={trackMap?.corners} youName={youName} refName={refName} /> : <SimplifiedWheels model={model} youName={youName} refName={refName} />}
              </section>
              )}
            </div>
          </>
        );
        // The rail stays mounted while the next lap loads (its focus and scroll survive), so it shows the last loaded lap meanwhile.
        const railCtx = ctx ?? (error ? null : keptCtx);
        if (!railCtx) return body;
        return (
          <div className={wsStyles.layout}>
            <LapRail
              session={railCtx.session} laps={railCtx.laps} lap={railCtx.lap} refLapId={cmp?.ref_lap_id ?? null}
              candidates={candidates} warning={cmp?.warning ?? null} invalidHint={offTrackHint}
              onSelectLap={selectLap} onSelectRef={selectRef}
            />
            <div className={wsStyles.center}>{body}</div>
            {(cmp ?? keptCmp) && (
              <CornerRail cmp={(cmp ?? keptCmp)!} trackMap={trackMap} annotations={annotations} deepDives={deepDives} onSeek={seekToCornerStart} />
            )}
          </div>
        );
      })()}
      {model && (
        <Transport
          model={model} trackMap={trackMap} refName={refShort ?? undefined} priorityCornerIds={priorityCorners}
          scrubberLayer={<><ScrubberOffTrack model={model} valid={lapValid} /><ScrubberSections annotations={annotations} duration={model.duration} /></>}
          scrubberBadges={<ScrubberBadges annotations={annotations} duration={model.duration} h={handlers} />}
        />
      )}
    </AnnotationCardProvider>
  );
}

import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { HeaderSlot } from "../components/AppShell";
import { BiggestLosses } from "../components/BiggestLosses";
import { AnalysisBar } from "../components/AnalysisBar";
import { AnnotationCardProvider, type AnnotationCardActions } from "../components/AnnotationPopup";
import { ScrubberBadges, ScrubberSections, type BadgeHandlers } from "../components/AnnotationOverlays";
import { DetailedStrips } from "../components/DetailedStrips";
import { EngineerLine } from "../components/EngineerLine";
import { LapPicker } from "../components/LapPicker";
import { SimplifiedWheels } from "../components/SimplifiedWheels";
import { TrackPanel } from "../components/TrackPanel";
import { Transport } from "../components/Transport";
import { leadInTime, toAnnotations, type Annotation } from "../lib/annotations";
import { biggestLosses, type CornerLoss } from "../lib/biggestLosses";
import { CORNER_LEAD_M } from "../lib/annotations";
import { timeAtDistance } from "../lib/playback";
import { buildModel } from "../lib/model";
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

  // Escape collapses the expanded map, unless something else (an open popup) already handled it.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // No ?lap: reflect the resolved default in the URL.
  useEffect(() => {
    if (!lapParam && ctx) setParams({ lap: ctx.lap.lap_id }, { replace: true });
  }, [lapParam, ctx, setParams]);

  const model = useMemo(() => (cmp ? buildModel(cmp) : null), [cmp]);

  useEffect(() => {
    if (!model) return;
    store.setDuration(model.duration);
    store.setLaps(model.cmp.lap_id, model.cmp.ref_lap_id);
  }, [model, store]);

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
  // Free, from the comparison alone: shown before any coach command.
  const losses = useMemo(() => (cmp && trackMap ? biggestLosses(cmp, trackMap.corners) : null), [cmp, trackMap]);
  const seekToLoss = useCallback(
    (l: CornerLoss) => {
      if (!cmp) return;
      store.pause();
      store.seek(timeAtDistance(cmp.lap.t, cmp.distance, l.startM - CORNER_LEAD_M));
    },
    [cmp, store],
  );
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
  const refTime = ctx?.laps.find((l) => l.lap_id === cmp?.ref_lap_id)?.lap_time_s ?? null;
  // Stable, so the memoised track views don't render for unrelated page state.
  const lapTimes = useMemo(() => (cmp ? { lap: lapTime, ref: refTime } : undefined), [cmp, lapTime, refTime]);

  const selectLap = (id: string) => setParams({ lap: id });
  const selectRef = (id: string | null) => setParams(id ? { lap: ctx!.lap.lap_id, ref: id } : { lap: ctx!.lap.lap_id });

  const refCand = candidates.find((c) => c.lap_id === cmp?.ref_lap_id) ?? null;
  const youName = ctx ? `You · L${ctx.lap.lap_no}` : "You";
  const refName = refCand ? `Comparison · ${refCand.is_reference ? "★" : ""}${refCand.label}` : "Comparison";

  const views: { id: PlaybackView; label: string }[] = [
    { id: "detailed", label: "Detailed" },
    { id: "simplified", label: "Simplified" },
  ];

  return (
    <AnnotationCardProvider value={cardActions}>
      {ctx && (
        <HeaderSlot>
          <LapPicker
            session={ctx.session} laps={ctx.laps} lap={ctx.lap} refLapId={cmp?.ref_lap_id ?? null}
            warning={cmp?.warning ?? null} candidates={candidates}
            onSelectLap={selectLap} onSelectRef={selectRef}
          />
        </HeaderSlot>
      )}
      {ctx && (
        <AnalysisBar
          coach={coach} annotations={allAnnotations} disabled={coach.running !== null}
          totalDelta={cmp ? (cmp.delta[cmp.delta.length - 1] ?? null) : null}
        />
      )}
      {ctx && <BiggestLosses result={losses} onSeek={seekToLoss} />}
      {error && !model ? (
        <Message>{error.code}: {error.message}</Message>
      ) : !model ? (
        <Message>Loading…</Message>
      ) : (
        <>
          {cmp?.warning && <div className={styles.warning}>{cmp.warning}</div>}
          <div className={styles.grid} data-expanded={expanded || undefined}>
            <TrackPanel
              model={model} trackMap={trackMap} geometry={geometry}
              annotations={annotations} handlers={handlers}
              lapTimes={lapTimes}
              expanded={expanded} onToggleExpanded={() => setExpanded((x) => !x)}
              footer={<EngineerLine annotations={annotations} trackMap={trackMap} model={model} />}
            />
            {!expanded && (
            <section aria-label="Inputs" className={styles.inputs}>
              <div className={styles.viewBar}>
                <ToggleGroup.Root
                  type="single" aria-label="Input view" className={styles.viewToggle}
                  value={view} onValueChange={(v) => v && store.setView(v as PlaybackView)}
                >
                  {views.map((v) => (
                    <ToggleGroup.Item key={v.id} value={v.id} className={ui.toggleItem}>{v.label}</ToggleGroup.Item>
                  ))}
                </ToggleGroup.Root>
              </div>
              {view === "detailed" ? <DetailedStrips model={model} geometry={geometry} annotations={annotations} handlers={handlers} /> : <SimplifiedWheels model={model} youName={youName} refName={refName} />}
            </section>
            )}
          </div>
          <Transport
            model={model} trackMap={trackMap}
            scrubberLayer={<ScrubberSections annotations={annotations} duration={model.duration} />}
            scrubberBadges={<ScrubberBadges annotations={annotations} duration={model.duration} h={handlers} />}
          />
        </>
      )}
    </AnnotationCardProvider>
  );
}

import * as Slider from "@radix-ui/react-slider";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TrackMap } from "../api/types";
import { formatClock, formatDistance } from "../lib/format";
import type { PlaybackModel } from "../lib/model";
import { CORNER_LEAD_M } from "../lib/annotations";
import { layoutCornerLabels } from "../lib/cornerLabels";
import { readoutCorner } from "../lib/trackmap";
import { distanceAtTime, timeAtDistance } from "../lib/playback";
import { RATES, usePlayback, usePlaybackStore, type Rate } from "../state/playback";
import { cx } from "../lib/cx";
import { ShortcutsPopover } from "./ShortcutsPopover";
import styles from "./Transport.module.css";
import ui from "./ui.module.css";

export interface TransportProps {
  model: PlaybackModel;
  trackMap: TrackMap | null;
  /**
   * Task 15 seam: drawn inside the scrubber (shaded sections; x is `t / duration * 100` percent)
   * and badges above it. Both are positioned by the caller against the same percent scale.
   */
  scrubberLayer?: ReactNode;
  scrubberBadges?: ReactNode;
  /** Name of the comparison lap, for the delta trace's label. */
  refName?: string;
  /** Corners that have a finding or are among the biggest losses: their labels are never dropped. */
  priorityCornerIds?: ReadonlySet<string>;
}

/** Slider resolution, and the PageUp/PageDown jump. */
const SEEK_STEP_S = 0.05;
const PAGE_SEEK_S = 5;

export function Transport({ model, trackMap, scrubberLayer, scrubberBadges, refName, priorityCornerIds }: TransportProps) {
  const store = usePlaybackStore();
  const tau = usePlayback((s) => s.tau);
  const playing = usePlayback((s) => s.playing);
  const rate = usePlayback((s) => s.rate);
  const { cmp, duration } = model;

  // Corner labels: hide one when it would overlap the previous visible one (the name stays in aria-label/title).
  const ticksRef = useRef<HTMLDivElement>(null);
  const [ticksW, setTicksW] = useState(0);
  useEffect(() => {
    const el = ticksRef.current;
    if (!el) return;
    setTicksW(el.clientWidth);
    const ro = new ResizeObserver(() => setTicksW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ticks = useMemo(() => {
    const items = (trackMap?.corners ?? []).map((c) => ({
      id: c.id, name: c.name, priority: priorityCornerIds?.has(c.id) ?? false,
      frac: duration > 0 ? timeAtDistance(cmp.lap.t, cmp.distance, c.apex_m) / duration : 0,
    }));
    const labels = layoutCornerLabels(items, ticksW);
    return (trackMap?.corners ?? []).map((c, i) => ({ c, frac: items[i].frac, label: labels[i] }));
  }, [trackMap, cmp, duration, ticksW, priorityCornerIds]);

  const dNow = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const leadInId = usePlayback((s) => s.leadInCornerId);
  const currentCorner = trackMap ? (readoutCorner(trackMap, dNow, leadInId, CORNER_LEAD_M)?.corner ?? null) : null;

  // The ticks are one tab stop (a roving tabindex): arrows, Home and End move between all of them, hidden labels included.
  const tickEls = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeTick, setActiveTick] = useState(0);
  const tabStop = Math.min(Math.max(0, activeTick), Math.max(0, ticks.length - 1));
  const onTickKeyDown = (e: KeyboardEvent, i: number) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const last = ticks.length - 1;
    const to = e.key === "ArrowRight" ? Math.min(last, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    setActiveTick(to);
    tickEls.current[to]?.focus();
  };

  /** Radix steps arrows by 0.05 s; PageUp and PageDown are 5 s here (Radix would use 10 steps). Home and End are Radix's. */
  const onScrubKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "PageUp" && e.key !== "PageDown") return;
    e.preventDefault(); // Radix skips its own handling of a default-prevented key.
    store.seekBy(e.key === "PageUp" ? PAGE_SEEK_S : -PAGE_SEEK_S);
  };

  return (
    <div className={styles.transport}>
      <div className={styles.controls}>
        <button type="button" aria-label="Back 5 seconds" className={ui.btn} onClick={() => store.seekBy(-5)}>−5s</button>
        <button type="button" onClick={() => store.toggle()} className={cx(ui.btnPrimary, styles.play)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" aria-label="Forward 5 seconds" className={ui.btn} onClick={() => store.seekBy(5)}>+5s</button>
        <ToggleGroup.Root
          type="single" aria-label="Playback speed" className={styles.speeds}
          value={String(rate)}
          onValueChange={(v) => v && store.setRate(Number(v) as Rate)}
        >
          {RATES.map((r) => (
            <ToggleGroup.Item key={r} value={String(r)} className={cx(ui.toggleItem, styles.speed)}>{r}×</ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <div className={styles.spacer} />
        <div className={styles.clock}>
          <span data-testid="transport-distance" title="Distance along the lap">{formatDistance(dNow)}</span>
          {" · "}{formatClock(tau)} / {formatClock(duration)}
        </div>
        <ShortcutsPopover />
      </div>
      <div className={styles.scrubWrap}>
        <Slider.Root
          className={styles.scrubber}
          min={0}
          max={duration > 0 ? duration : 1}
          step={SEEK_STEP_S}
          value={[Math.min(tau, duration > 0 ? duration : 1)]}
          disabled={duration <= 0}
          onValueChange={([t]) => store.seek(t)}
          onKeyDown={onScrubKeyDown}
        >
          <div className={styles.layers}>
            {scrubberLayer}
            <svg viewBox="0 0 1000 34" preserveAspectRatio="none" aria-hidden="true">
              <path d="M0 17 L1000 17" className={styles.baseline} />
              <path d={model.scrubPath} className={styles.delta} />
            </svg>
            <span className={styles.deltaLabel} data-testid="scrubber-delta-label">Time gained or lost vs {refName ?? "the comparison lap"}</span>
            <span className={styles.zeroLabel}>0 · level</span>
          </div>
          <Slider.Thumb className={styles.thumb} aria-label="Lap position" aria-valuetext={formatClock(tau)} />
        </Slider.Root>
        {scrubberBadges}
      </div>
      <div ref={ticksRef} className={styles.ticks} role="group" aria-label="Corners: arrow keys move between them">
        {ticks.map(({ c, frac, label }, i) => (
          <button
            key={c.id}
            ref={(el) => void (tickEls.current[i] = el)}
            type="button"
            aria-label={c.name}
            title={c.name}
            tabIndex={i === tabStop ? 0 : -1}
            onFocus={() => setActiveTick(i)}
            onKeyDown={(e) => onTickKeyDown(e, i)}
            onClick={() => store.seek(timeAtDistance(cmp.lap.t, cmp.distance, c.start_m - CORNER_LEAD_M), c.id)}
            className={cx(styles.tick, currentCorner?.id === c.id && styles.current)}
            style={{ left: `${frac * 100}%` }}
          >
            {/* A label that does not fit falls back to a short code, then to a dot as the click target. */}
            {label.text}
          </button>
        ))}
      </div>
    </div>
  );
}

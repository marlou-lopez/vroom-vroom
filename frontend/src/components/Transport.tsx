import * as Slider from "@radix-ui/react-slider";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TrackMap } from "../api/types";
import { formatClock } from "../lib/format";
import type { PlaybackModel } from "../lib/model";
import { CORNER_LEAD_M } from "../lib/annotations";
import { cornerAt } from "../lib/trackmap";
import { distanceAtTime, timeAtDistance } from "../lib/playback";
import { RATES, usePlayback, usePlaybackStore, type Rate } from "../state/playback";
import { cx } from "../lib/cx";
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
}

/** Slider resolution, and the PageUp/PageDown jump. */
const SEEK_STEP_S = 0.05;
const PAGE_SEEK_S = 5;

const LABEL_CHAR_PX = 5.6; // 10 px Inter, average glyph width
const LABEL_PAD_PX = 4 + 4;

export function Transport({ model, trackMap, scrubberLayer, scrubberBadges }: TransportProps) {
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
    const all = (trackMap?.corners ?? [])
      .map((c) => ({ c, frac: duration > 0 ? timeAtDistance(cmp.lap.t, cmp.distance, c.apex_m) / duration : 0 }))
      .sort((a, b) => a.frac - b.frac);
    let prevRight = -Infinity;
    return all.map(({ c, frac }) => {
      const half = (c.name.length * LABEL_CHAR_PX + LABEL_PAD_PX) / 2;
      const x = frac * ticksW;
      const visible = x - half >= prevRight;
      if (visible) prevRight = x + half;
      return { c, frac, visible };
    });
  }, [trackMap, cmp, duration, ticksW]);

  const dNow = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const currentCorner = trackMap ? cornerAt(trackMap, dNow) : null;

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
        <div className={styles.clock}>{formatClock(tau)} / {formatClock(duration)}</div>
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
          </div>
          <Slider.Thumb className={styles.thumb} aria-label="Lap position" aria-valuetext={formatClock(tau)} />
        </Slider.Root>
        {scrubberBadges}
      </div>
      <div ref={ticksRef} className={styles.ticks}>
        {ticks.map(({ c, frac, visible }) => (
          <button
            key={c.id}
            type="button"
            aria-label={c.name}
            title={c.name}
            tabIndex={visible ? 0 : -1}
            onClick={() => store.seek(timeAtDistance(cmp.lap.t, cmp.distance, c.start_m - CORNER_LEAD_M))}
            className={cx(styles.tick, currentCorner?.id === c.id && styles.current)}
            style={{ left: `${frac * 100}%` }}
          >
            {/* A hidden label leaves a dot as its click target. */}
            {visible ? c.name : "·"}
          </button>
        ))}
      </div>
    </div>
  );
}

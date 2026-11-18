import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { sessionLapsOptions, usePatchLap, useSessions } from "../../api/queries";
import { effectiveValid, type CompareCandidate, type LapWithRef, type SessionMeta } from "../../api/types";
import { comparisonName } from "../../lib/compareName";
import { cx } from "../../lib/cx";
import { formatLapTime, formatShortDate } from "../../lib/format";
import { formatGap } from "../../lib/idealGauge";
import { defaultLap } from "../../lib/laps";
import { loadSetting, saveSetting } from "../mapviews/shared/storage";
import { SetupChip } from "../SetupChip";
import ui from "../ui.module.css";
import styles from "./Workspace.module.css";

/**
 * The session's laps as an always-visible list on the left of the Telemetry page (replaces the header pickers).
 * Enter on a row (or a click) studies that lap; R (or the row's "ref" button) makes it the comparison; arrows move
 * between rows. Quick picks cover comparisons that are not laps of this session (track reference, ideal lap).
 * Collapsing it to a thin strip is remembered.
 */
export interface LapRailProps {
  session: SessionMeta;
  laps: LapWithRef[];
  lap: LapWithRef;
  refLapId: string | null;
  candidates: CompareCandidate[];
  /** `CompareResponse.warning`: set when the comparison lap is a different car. */
  warning: string | null;
  /** For an invalid lap: where its wheels likely left the track (a guess: LMU records no invalidation event). */
  invalidHint?: string | null;
  onSelectLap(lapId: string): void;
  /** `null` selects the track/car reference. */
  onSelectRef(lapId: string | null): void;
}

const KEY = "vroom.lapRail";
const STATES = ["open", "collapsed"] as const;

export function LapRail({ session, laps, lap, refLapId, candidates, warning, invalidHint, onSelectLap, onSelectRef }: LapRailProps) {
  const [state, setState] = useState<(typeof STATES)[number]>(() => loadSetting(KEY, STATES, "open"));
  const [validOnly, setValidOnly] = useState(true);
  const [sessionNote, setSessionNote] = useState<string | null>(null);
  const sessions = useSessions().data;
  const qc = useQueryClient();
  const patchLap = usePatchLap().mutate; // refetches laps, comparisons and candidates

  const toggle = (next: (typeof STATES)[number]) => {
    setState(next);
    saveSetting(KEY, next);
  };

  if (state === "collapsed") {
    return (
      <aside aria-label="Laps" className={cx(styles.rail, styles.railCollapsed)} data-collapsed="true">
        <button type="button" className={styles.collapseBtn} aria-expanded={false} aria-label="Show the lap list" title="Show the lap list" onClick={() => toggle("open")}>
          ▸
        </button>
        <span className={styles.vertical} aria-hidden="true">L{lap.lap_no}</span>
      </aside>
    );
  }

  const lapId = lap.lap_id;
  const timed = laps.filter((l) => l.kind === "flying" && effectiveValid(l) && l.lap_time_s !== null);
  const best = timed.length ? Math.min(...timed.map((l) => l.lap_time_s!)) : null;
  // The studied lap and the comparison stay listed even when the filter would hide them (an in-lap picked from a deep link).
  const shown = laps.filter((l) => !validOnly || (l.kind === "flying" && effectiveValid(l)) || l.lap_id === lapId || l.lap_id === refLapId);
  const candidateIds = new Set(candidates.map((c) => c.lap_id));
  const ideal = candidates.find((c) => c.is_ideal) ?? null;
  const reference = candidates.find((c) => c.is_reference) ?? null;
  const refCand = candidates.find((c) => c.lap_id === refLapId) ?? null;
  const refName = comparisonName(refCand, laps);
  const sessionLapIds = new Set(laps.map((l) => l.lap_id));
  const otherCands = candidates.filter((c) => !c.is_ideal && !sessionLapIds.has(c.lap_id));
  const self = lapId === refLapId;
  const keepOpen = (e: Event) => e.preventDefault();

  const pickSession = async (id: string) => {
    if (id === session.session_id) return;
    setSessionNote(null);
    try {
      const target = defaultLap(await qc.fetchQuery(sessionLapsOptions(id)));
      if (target) onSelectLap(target.lap_id);
      else setSessionNote("That session has no valid lap to open.");
    } catch {
      setSessionNote("Could not load that session.");
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const rows = Array.from(e.currentTarget.closest("ul")?.querySelectorAll<HTMLButtonElement>("button[data-lap-id]") ?? []);
    const i = rows.findIndex((r) => r === document.activeElement);
    if (i < 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (e.key === "r" || e.key === "R") {
      const id = rows[i].dataset.lapId!;
      if (id !== lapId && candidateIds.has(id)) {
        e.preventDefault();
        onSelectRef(id);
      }
    }
  };

  return (
    <aside aria-label="Laps" className={styles.rail}>
      <div className={styles.railHead}>
        <span className={styles.heading}>Laps</span>
        <label className={styles.check}>
          <input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} /> Hide laps with track-limit cuts
        </label>
        <button type="button" className={styles.collapseBtn} aria-expanded aria-label="Hide the lap list" title="Hide the lap list" onClick={() => toggle("collapsed")}>
          ◂
        </button>
      </div>
      <select
        className={styles.sessionSelect} aria-label="Session" value={session.session_id}
        title={`${session.track_name} · ${session.car_name}`}
        onChange={(e) => void pickSession(e.target.value)}
      >
        {(sessions ?? [session]).slice().sort((a, b) => b.started_at.localeCompare(a.started_at)).map((s) => (
          <option key={s.session_id} value={s.session_id}>
            {s.track_name} · {s.car_name} · {formatShortDate(s.started_at)}
          </option>
        ))}
      </select>
      {sessionNote && <p className={styles.hint} role="status">{sessionNote}</p>}
      <div className={styles.studied}>
        <span className={styles.you}>
          ● L{lap.lap_no} {lap.lap_time_s === null ? "—" : formatLapTime(lap.lap_time_s)}
          {!effectiveValid(lap) && (
            <span className={styles.invalid} title={invalidHint ? "A guess: the first place two wheels were on grass or gravel" : undefined}> {invalidHint ?? "invalid"}</span>
          )}
        </span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className={styles.collapseBtn} aria-label={`Actions for L${lap.lap_no}`} title="Pin as your best lap, mark valid or invalid">⋯</DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} collisionPadding={8} className={ui.menuContent}>
              <DropdownMenu.Item className={ui.menuItem} onSelect={(e) => { keepOpen(e); patchLap({ lapId, patch: { pinned_reference: !lap.pinned_reference } }); }}>
                {lap.pinned_reference ? `Unpin L${lap.lap_no} as your best lap` : `Pin L${lap.lap_no} as your best lap`}
              </DropdownMenu.Item>
              {lap.kind === "flying" && (
                <DropdownMenu.Item className={ui.menuItem} onSelect={(e) => { keepOpen(e); patchLap({ lapId, patch: { valid_override: !effectiveValid(lap) } }); }}>
                  Mark {effectiveValid(lap) ? "invalid" : "valid"}
                </DropdownMenu.Item>
              )}
              {lap.valid_override !== null && (
                <DropdownMenu.Item className={ui.menuItem} onSelect={(e) => { keepOpen(e); patchLap({ lapId, patch: { valid_override: null } }); }}>
                  Reset to automatic
                </DropdownMenu.Item>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className={styles.versus}>
        <span className={styles.comparison}>○ compared with {refName ?? (refLapId ? "…" : "choose")}</span>
        {warning ? <span className={styles.badge} title={warning}>DIFFERENT CAR</span> : <SetupChip lapSessionId={session.session_id} laps={laps} refLapId={refLapId} refName={refName} />}
      </div>
      {self && (
        <p className={styles.hint} role="status">
          This lap is the one you are comparing with, so there is nothing to compare. Pick another lap, or compare with the best possible lap.
        </p>
      )}
      <div className={styles.quick} role="group" aria-label="Compare with">
        <button type="button" className={styles.quickBtn} aria-pressed={reference !== null && refLapId === reference.lap_id} onClick={() => onSelectRef(null)}>
          ★ Your best lap
        </button>
        {ideal && (
          <button type="button" className={cx(styles.quickBtn, styles.idealBtn)} aria-pressed={refLapId === ideal.lap_id} onClick={() => onSelectRef(ideal.lap_id)}>
            Best possible lap {ideal.lap_time_s === null ? "" : formatLapTime(ideal.lap_time_s)}
          </button>
        )}
      </div>
      {otherCands.length > 0 && (
        <select
          className={styles.sessionSelect} aria-label="Compare with another day" value=""
          title="Compare with a lap from another session on this track"
          onChange={(e) => e.target.value && onSelectRef(e.target.value)}
        >
          <option value="">Compare with another day…</option>
          {otherCands.map((c) => (
            <option key={c.lap_id} value={c.lap_id}>{c.label}{c.other_car ? " (different car)" : ""}</option>
          ))}
        </select>
      )}
      <ul className={styles.lapList} aria-label="Session laps">
        {shown.map((l) => {
          const isYou = l.lap_id === lapId;
          const isRef = l.lap_id === refLapId;
          const gap = best !== null && l.lap_time_s !== null && l.kind === "flying" && effectiveValid(l) ? l.lap_time_s - best : null;
          return (
            <li key={l.lap_id} className={styles.lapRow} data-you={isYou || undefined} data-ref={isRef || undefined}>
              <button type="button" data-lap-id={l.lap_id} className={styles.lapMain} aria-current={isYou || undefined} onClick={() => onSelectLap(l.lap_id)} onKeyDown={onKeyDown}>
                <span className={styles.lapMarker} aria-hidden="true">{isYou ? "●" : isRef ? "○" : ""}</span>
                <span className={styles.lapNo}>L{l.lap_no}</span>
                <span className={styles.lapTime}>{l.lap_time_s === null ? "—" : formatLapTime(l.lap_time_s)}</span>
                <span className={styles.lapGap}>
                  {l.kind !== "flying" ? l.kind.toUpperCase() : !effectiveValid(l) ? "invalid" : gap === 0 ? "best" : gap === null ? "" : formatGap(gap)}
                  {l.is_reference && <span title="Your best lap on this track and car"> ★</span>}
                </span>
              </button>
              {!isYou && candidateIds.has(l.lap_id) && (
                <button
                  type="button" className={styles.refBtn} aria-pressed={isRef}
                  aria-label={`Compare with L${l.lap_no}`} title="Use as the comparison lap (R)"
                  onClick={() => onSelectRef(l.lap_id)}
                >
                  Compare
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className={styles.legend}>
        <span className={styles.you}>●</span> your lap · <span className={styles.ref}>○</span> the lap you compare with
      </p>
    </aside>
  );
}

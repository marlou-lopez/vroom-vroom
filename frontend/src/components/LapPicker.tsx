import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState, type ReactNode } from "react";
import { usePatchLap } from "../api/queries";
import { effectiveValid, type CompareCandidate, type LapWithRef, type SessionMeta } from "../api/types";
import { formatLapTime, formatShortDate } from "../lib/format";
import { cx } from "../lib/cx";
import { colors } from "../theme";
import styles from "./LapPicker.module.css";
import ui from "./ui.module.css";

export interface LapPickerProps {
  session: SessionMeta;
  laps: LapWithRef[];
  lap: LapWithRef;
  /** The lap actually compared against (null while the comparison loads or failed). */
  refLapId: string | null;
  /** `CompareResponse.warning`: set when the comparison lap is a different car. */
  warning: string | null;
  /** `compare-candidates` for `lap` (loaded by the page so it can also name the comparison lap). */
  candidates: CompareCandidate[];
  onSelectLap(lapId: string): void;
  /** `null` selects the track/car reference. */
  onSelectRef(lapId: string | null): void;
}

const lapText = (l: LapWithRef) => `L${l.lap_no} ${l.lap_time_s === null ? "—" : formatLapTime(l.lap_time_s)}`;

function Badge({ children, color, title }: { children: ReactNode; color: string; title?: string }) {
  return (
    <span title={title} className={styles.badge} style={{ color }}>
      {children}
    </span>
  );
}

export function LapPicker({ session, laps, lap, refLapId, warning, candidates, onSelectLap, onSelectRef }: LapPickerProps) {
  const [validOnly, setValidOnly] = useState(false);
  const lapId = lap.lap_id;

  const shown = laps.filter((l) => !validOnly || (l.kind === "flying" && effectiveValid(l)));
  const refCand = candidates.find((c) => c.lap_id === refLapId) ?? null;
  const previous = candidates.find((c) => c.is_previous) ?? null;
  const patchLap = usePatchLap().mutate; // refetches laps, comparisons and candidates
  const pin = (l: LapWithRef) => patchLap({ lapId: l.lap_id, patch: { pinned_reference: !l.pinned_reference } });
  // Pin and mark-valid act on the open menu's lap and leave the menu open, like Radix's checkbox item below.
  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <>
      <div className={styles.session}>
        {session.track_name} · {session.car_name} · {formatShortDate(session.started_at)}
      </div>
      <div className={styles.pickers}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className={styles.trigger}>
            <span className={styles.you}>
              ● {lapText(lap)}
              {!effectiveValid(lap) && <span className={styles.invalid}> invalid</span>} ▾
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className={cx(ui.menuContent, styles.content)}>
              <DropdownMenu.CheckboxItem
                checked={validOnly}
                onCheckedChange={setValidOnly}
                onSelect={keepOpen}
                className={cx(ui.menuItem, styles.check)}
              >
                <span className={styles.box} aria-hidden="true"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>
                Valid flying laps only
              </DropdownMenu.CheckboxItem>
              {shown.map((l) => (
                <DropdownMenu.Item key={l.lap_id} className={ui.menuItem} data-selected={l.lap_id === lapId} onSelect={() => onSelectLap(l.lap_id)}>
                  <span className={cx(styles.lapText, l.lap_id === lapId && styles.lapSelected)}>{lapText(l)}</span>
                  {l.is_reference && <span title="Reference for this track and car" className={styles.star}>★</span>}
                  {l.kind !== "flying" && <Badge color={colors.muted}>{l.kind === "incomplete" ? "INC" : l.kind.toUpperCase()}</Badge>}
                  {!effectiveValid(l) && <Badge color={colors.issue}>INVALID</Badge>}
                  {l.valid_override !== null && <Badge color={colors.muted} title="Validity set by hand">MANUAL</Badge>}
                </DropdownMenu.Item>
              ))}
              <div className={styles.footer}>
                <DropdownMenu.Item className={cx(ui.menuItem, styles.footerBtn)} onSelect={(e) => { keepOpen(e); pin(lap); }}>
                  {lap.pinned_reference ? `Unpin L${lap.lap_no} as reference` : `Pin L${lap.lap_no} as reference`}
                </DropdownMenu.Item>
                {lap.kind === "flying" && (
                  <DropdownMenu.Item
                    className={cx(ui.menuItem, styles.footerBtn)}
                    onSelect={(e) => {
                      keepOpen(e);
                      patchLap({ lapId: lap.lap_id, patch: { valid_override: effectiveValid(lap) ? false : true } });
                    }}
                  >
                    Mark {effectiveValid(lap) ? "invalid" : "valid"}
                  </DropdownMenu.Item>
                )}
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <span className={styles.muted}>vs</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className={styles.trigger}>
            <span className={styles.comparison}>
              ○ {refCand ? `${refCand.is_reference ? "★" : ""}${refCand.label}` : refLapId ? "…" : "choose"} ▾
            </span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className={cx(ui.menuContent, styles.content)}>
              <DropdownMenu.Item className={ui.menuItem} onSelect={() => onSelectRef(null)}>
                <span>Reference lap</span><span className={styles.muted}>(default)</span>
              </DropdownMenu.Item>
              {previous && (
                <DropdownMenu.Item className={ui.menuItem} onSelect={() => onSelectRef(previous.lap_id)}>
                  <span>Previous lap</span><span className={cx(styles.lapText, styles.muted)}>{previous.label}</span>
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className={ui.menuSeparator} />
              {candidates.length === 0 && <div className={styles.empty}>No other laps on this track.</div>}
              {candidates.map((c) => (
                <DropdownMenu.Item key={c.lap_id} className={ui.menuItem} data-selected={c.lap_id === refLapId} onSelect={() => onSelectRef(c.lap_id)}>
                  <span className={styles.lapText}>{c.label}</span>
                  {c.is_reference && <span title="Reference" className={styles.star}>★</span>}
                  {c.other_car && <Badge color={colors.minor} title={c.car_name}>DIFFERENT CAR</Badge>}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {warning && <Badge color={colors.minor} title={warning}>DIFFERENT CAR</Badge>}
      </div>
    </>
  );
}

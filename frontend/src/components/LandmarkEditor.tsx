import { useState, type CSSProperties } from "react";
import type { Corner, Landmark, LandmarkKind } from "../api/types";
import { cx } from "../lib/cx";
import { landmarkFill, landmarkStroke } from "../lib/landmarks";
import styles from "./LandmarkEditor.module.css";
import ui from "./ui.module.css";

const KINDS: LandmarkKind[] = ["brake_board", "kerb_entry", "kerb_apex", "kerb_exit", "custom"];

export const ADD_LANDMARK_BTN_ID = "add-landmark-btn";

export interface LandmarkEditorProps {
  title: string;
  landmarks: Landmark[];
  busy: boolean;
  onConfirm(id: string): void;
  onDelete(id: string): void;
  /** Keyboard path to the add form (Alt-click on the map is the fast path). */
  onAdd?(): void;
}

/** The selected corner's landmarks: Confirm (low confidence only) and Delete. */
export function LandmarkEditor({ title, landmarks, busy, onConfirm, onDelete, onAdd }: LandmarkEditorProps) {
  return (
    <section aria-label="Landmarks" className={styles.editor}>
      <div className={styles.head}>
        <div className={styles.title}>LANDMARKS · {title}</div>
        <div className={styles.note}>Only confirmed and detected landmarks reach the coach</div>
        {onAdd && <button type="button" id={ADD_LANDMARK_BTN_ID} onClick={onAdd} className={styles.small}>Add landmark</button>}
      </div>
      {landmarks.length === 0 ? (
        <div className={styles.empty}>No landmarks here yet. Alt-click the map or use Add landmark.</div>
      ) : (
        landmarks.map((l) => (
          <div key={l.id} className={styles.row}>
            <span aria-hidden className={styles.dot} style={{ background: landmarkFill(l.confidence), borderColor: landmarkStroke(l.confidence) }} />
            <div className={styles.body}>
              <div className={styles.label}>{l.label}</div>
              <div className={styles.meta}>{l.kind} · {Math.round(l.distance_m)} m · {l.confidence}</div>
            </div>
            {l.confidence === "low" && (
              <button type="button" disabled={busy} onClick={() => onConfirm(l.id)} className={cx(styles.small, styles.confirm)}>Confirm</button>
            )}
            <button type="button" disabled={busy} aria-label={`Delete ${l.label}`} onClick={() => onDelete(l.id)} className={styles.small}>Delete</button>
          </div>
        ))
      )}
    </section>
  );
}

export interface AddLandmarkFormProps {
  distanceM: number;
  corners: Corner[];
  /** Prefilled with the nearest corner. */
  defaultCornerId: string | null;
  style?: CSSProperties;
  /** Lay the form out in the page flow (side panel) instead of floating over the map. */
  inline?: boolean;
  /** Largest allowed distance (track length), if known. */
  maxM?: number;
  onSubmit(v: { label: string; kind: LandmarkKind; cornerId: string | null; distanceM: number }): void;
  onCancel(): void;
}

/** Small inline form opened by alt-clicking the map or by the Add landmark button. */
export function AddLandmarkForm({ distanceM, corners, defaultCornerId, style, inline, maxM, onSubmit, onCancel }: AddLandmarkFormProps) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<LandmarkKind>("custom");
  const [cornerId, setCornerId] = useState<string>(defaultCornerId ?? "");
  const [distance, setDistance] = useState(String(Math.round(distanceM)));
  const dist = distance.trim() === "" ? NaN : Number(distance);
  const validDistance = Number.isFinite(dist) && dist >= 0 && (maxM === undefined || dist <= maxM);
  return (
    <form
      aria-label="Add landmark"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim() && validDistance) onSubmit({ label: label.trim(), kind, cornerId: cornerId || null, distanceM: dist });
      }}
      className={cx(styles.form, inline && styles.inline)}
      style={style}
    >
      <div className={styles.formTitle}>New landmark</div>
      {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- form the user just opened; moving focus to its first field is intended */}
      <input autoFocus aria-label="Label" placeholder="Label (e.g. 100 board)" value={label} onChange={(e) => setLabel(e.target.value)} className={styles.field} />
      <input type="number" min={0} max={maxM === undefined ? undefined : Math.floor(maxM)} step={1} aria-label="Distance (m)" value={distance} onChange={(e) => setDistance(e.target.value)} className={styles.field} />
      <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as LandmarkKind)} className={styles.field}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <select aria-label="Corner" value={cornerId} onChange={(e) => setCornerId(e.target.value)} className={styles.field}>
        <option value="">No corner</option>
        {corners.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className={styles.formActions}>
        <button type="submit" disabled={!label.trim() || !validDistance} className={cx(ui.btnPrimary, styles.add)}>Add</button>
        <button type="button" onClick={onCancel} className={styles.small}>Cancel</button>
      </div>
    </form>
  );
}

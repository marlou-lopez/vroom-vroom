import { useState, type CSSProperties } from "react";
import type { Corner, Landmark, LandmarkConfidence, LandmarkKind } from "../api/types";
import { cx } from "../lib/cx";
import { colors } from "../theme";
import styles from "./LandmarkEditor.module.css";
import ui from "./ui.module.css";

const KINDS: LandmarkKind[] = ["brake_board", "kerb_entry", "kerb_apex", "kerb_exit", "custom"];

export const landmarkFill = (c: LandmarkConfidence): string => (c === "confirmed" ? colors.you : c === "detected" ? colors.strength : "none");
export const landmarkStroke = (c: LandmarkConfidence): string => (c === "low" ? colors.muted : landmarkFill(c));

export interface LandmarkEditorProps {
  title: string;
  landmarks: Landmark[];
  busy: boolean;
  onConfirm(id: string): void;
  onDelete(id: string): void;
}

/** The selected corner's landmarks: Confirm (low confidence only) and Delete. */
export function LandmarkEditor({ title, landmarks, busy, onConfirm, onDelete }: LandmarkEditorProps) {
  return (
    <section aria-label="Landmarks" className={styles.editor}>
      <div className={styles.head}>
        <div className={styles.title}>LANDMARKS · {title}</div>
        <div className={styles.note}>Only confirmed and detected landmarks reach the coach</div>
      </div>
      {landmarks.length === 0 ? (
        <div className={styles.empty}>No landmarks here yet. Alt-click the map to add one.</div>
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
  onSubmit(v: { label: string; kind: LandmarkKind; cornerId: string | null }): void;
  onCancel(): void;
}

/** Small inline form opened by alt-clicking the map. */
export function AddLandmarkForm({ distanceM, corners, defaultCornerId, style, onSubmit, onCancel }: AddLandmarkFormProps) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<LandmarkKind>("custom");
  const [cornerId, setCornerId] = useState<string>(defaultCornerId ?? "");
  return (
    <form
      aria-label="Add landmark"
      onSubmit={(e) => {
        e.preventDefault();
        if (label.trim()) onSubmit({ label: label.trim(), kind, cornerId: cornerId || null });
      }}
      className={styles.form}
      style={style}
    >
      <div className={styles.formTitle}>New landmark at {Math.round(distanceM)} m</div>
      <input autoFocus aria-label="Label" placeholder="Label (e.g. 100 board)" value={label} onChange={(e) => setLabel(e.target.value)} className={styles.field} />
      <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as LandmarkKind)} className={styles.field}>
        {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <select aria-label="Corner" value={cornerId} onChange={(e) => setCornerId(e.target.value)} className={styles.field}>
        <option value="">No corner</option>
        {corners.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div className={styles.formActions}>
        <button type="submit" disabled={!label.trim()} className={cx(ui.btnPrimary, styles.add)}>Add</button>
        <button type="button" onClick={onCancel} className={styles.small}>Cancel</button>
      </div>
    </form>
  );
}

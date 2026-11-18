import type { Corner, Landmark, LandmarkConfidence, LandmarkKind } from "../api/types";
import { colors } from "../theme";

export const landmarkFill = (c: LandmarkConfidence): string => (c === "confirmed" ? colors.you : c === "detected" ? colors.strength : "none");
export const landmarkStroke = (c: LandmarkConfidence): string => (c === "low" ? colors.muted : landmarkFill(c));

export const KIND_NAMES: Record<LandmarkKind, string> = {
  brake_board: "Brake board",
  kerb_entry: "Kerb entry",
  kerb_apex: "Kerb apex",
  kerb_exit: "Kerb exit",
  custom: "Custom",
};

export interface LandmarkGroup {
  /** Corner id, or null for landmarks with no corner. */
  cornerId: string | null;
  name: string;
  landmarks: Landmark[];
}

/** Landmarks grouped by corner (in the order of `corners`, no-corner last), each group sorted by distance. */
export function groupLandmarks(landmarks: Landmark[], corners: Corner[]): LandmarkGroup[] {
  const byId = new Map<string, Landmark[]>();
  for (const l of landmarks) {
    const key = l.corner_id !== null && corners.some((c) => c.id === l.corner_id) ? l.corner_id : "";
    byId.set(key, [...(byId.get(key) ?? []), l]);
  }
  const sorted = (ls: Landmark[]) => [...ls].sort((a, b) => a.distance_m - b.distance_m);
  const groups: LandmarkGroup[] = [];
  for (const c of corners) {
    const ls = byId.get(c.id);
    if (ls) groups.push({ cornerId: c.id, name: c.name, landmarks: sorted(ls) });
  }
  const none = byId.get("");
  if (none) groups.push({ cornerId: null, name: "No corner", landmarks: sorted(none) });
  return groups;
}

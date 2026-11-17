import type { CarSetup } from "../api/types";

/** One setting that differs. `from` is the reference's value and `to` the lap's; null means the setting is missing on that side. */
export interface SetupChange {
  key: string;
  label: string;
  from: string | null;
  to: string | null;
}

/**
 * The settings that differ between the reference's setup and the lap's, in the lap's order (settings only the reference has come last).
 * A key only the lap has is "added" (`from` null), a key only the reference has is "removed" (`to` null). Equal setups give [].
 */
export function diffSetups(reference: CarSetup, lap: CarSetup): SetupChange[] {
  const ref = new Map(reference.entries.map((e) => [e.key, e]));
  const changes: SetupChange[] = [];
  const seen = new Set<string>();
  for (const e of lap.entries) {
    seen.add(e.key);
    const r = ref.get(e.key);
    if (!r) changes.push({ key: e.key, label: e.label, from: null, to: e.value });
    else if (r.value !== e.value) changes.push({ key: e.key, label: e.label, from: r.value, to: e.value });
  }
  for (const r of reference.entries) if (!seen.has(r.key)) changes.push({ key: r.key, label: r.label, from: r.value, to: null });
  return changes;
}

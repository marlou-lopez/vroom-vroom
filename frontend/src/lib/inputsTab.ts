export type InputsTab = "strips" | "corners" | "session";
export const INPUTS_TAB_KEY = "vroom.inputsTab";

export function parseInputsTab(raw: string | null | undefined): InputsTab {
  return raw === "corners" || raw === "session" ? raw : "strips";
}

function defaultStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadInputsTab(storage: Pick<Storage, "getItem"> | null = defaultStorage()): InputsTab {
  try { return parseInputsTab(storage?.getItem(INPUTS_TAB_KEY)); } catch { return "strips"; }
}

export function saveInputsTab(tab: InputsTab, storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  try { storage?.setItem(INPUTS_TAB_KEY, tab); } catch { /* not remembered */ }
}

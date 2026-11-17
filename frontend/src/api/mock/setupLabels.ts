// Readable names for LMU's setup keys. Small on purpose: a key not listed here is shown as its own key (the contract's fallback).
// The real backend needs the same table (vroom-pnw.25 notes).
const LABELS: Record<string, string> = {
  VM_REAR_WING: "Rear wing",
  VM_FRONT_WING: "Front wing",
  VM_FRONT_ANTISWAY: "Front ARB",
  VM_REAR_ANTISWAY: "Rear ARB",
  VM_BRAKE_BALANCE: "Brake balance",
  VM_BRAKE_PRESSURE: "Brake pressure",
  VM_BRAKE_DUCTS: "Front brake ducts",
  VM_BRAKE_DUCTS_REAR: "Rear brake ducts",
  VM_ANTILOCKBRAKESYSTEMMAP: "ABS map",
  VM_TRACTIONCONTROLMAP: "TC map",
  VM_TRACTIONCONTROLPOWERCUTMAP: "TC power cut",
  VM_TRACTIONCONTROLSLIPANGLEMAP: "TC slip angle",
  VM_ENGINE_MIXTURE: "Engine mixture",
  VM_DIFF_PRELOAD: "Diff preload",
  VM_FRONT_TOEIN: "Front toe",
  VM_REAR_TOEIN: "Rear toe",
  VM_FRONT_TIRE_COMPOUND: "Front tyre compound",
  VM_REAR_TIRE_COMPOUND: "Rear tyre compound",
  VM_FUEL_LEVEL: "Fuel",
  VM_VIRTUAL_ENERGY: "Virtual energy",
  VM_STEER_LOCK: "Steering lock",
};
const WHEELS: Record<string, string> = { FL: "front left", FR: "front right", RL: "rear left", RR: "rear right" };
const WHEEL_ITEMS: Record<string, string> = {
  PRESSURE: "tyre pressure", CAMBER: "camber", SPRING: "spring", RIDEHEIGHT: "ride height", PACKERS: "packers",
  SLOWBUMP: "slow bump", FASTBUMP: "fast bump", SLOWREBOUND: "slow rebound", FASTREBOUND: "fast rebound",
  BRAKEDISC: "brake disc", BRAKEPAD: "brake pad", COMPOUND: "tyre compound",
};

/** "Rear wing" for VM_REAR_WING; per-wheel keys like WM_CAMBER-W_FL give "Front left camber"; anything else falls back to the key. */
export function setupLabel(key: string): string {
  const fixed = LABELS[key];
  if (fixed) return fixed;
  const m = /^WM_([A-Z]+)-W_(FL|FR|RL|RR)$/.exec(key);
  const item = m && WHEEL_ITEMS[m[1]];
  if (m && item) {
    const text = `${WHEELS[m[2]]} ${item}`;
    return text[0].toUpperCase() + text.slice(1);
  }
  return key;
}

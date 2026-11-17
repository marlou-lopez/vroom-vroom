/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffSetups } from "../../lib/setupDiff";
import { ApiError } from "../types";
import { createMockApi } from "./mockApi";
import type { Recording } from "./recording";
import { setupLabel } from "./setupLabels";

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/mock/${name}`, import.meta.url)), "utf8")) as Recording;
const SPA = read("spa-2026-11-03.json");
const MONZA = read("monza-2026-11-05.json");
const engine = () => createMockApi({ coachDelayMs: 0, loadSpa: async () => SPA, loadMonza: async () => MONZA });

describe("recorded setup in the mock files", () => {
  it("Spa and Monza carry the recording's setup as key -> display string", () => {
    for (const rec of [SPA, MONZA]) {
      const s = rec.car_setup!;
      expect(Object.keys(s).length).toBeGreaterThan(100);
      expect(s.VM_STEER_LOCK).toBe("524deg (18.5deg)");
      expect(s.VM_REAR_WING).toMatch(/deg$/);
      for (const v of Object.values(s)) expect(typeof v).toBe("string");
    }
  });

  it("holds no driver or account data (the metadata's DriverName and SteamID are never copied)", () => {
    const text = JSON.stringify(SPA.car_setup) + JSON.stringify(MONZA.car_setup);
    expect(text).not.toMatch(/marlou|lopez|steam|driver|@/i);
    expect(Object.keys(SPA.car_setup!).every((k) => /^(VM|WM)_/.test(k))).toBe(true);
  });
});

describe("GET /sessions/{id}/setup (mock)", () => {
  it("serves the real Spa setup for the 3 Nov session, with readable labels and the key as fallback", async () => {
    const api = engine();
    const s = (await api.sessions()).find((x) => x.started_at.startsWith("2026-11-03"))!;
    const { entries } = await api.sessionSetup(s.session_id);
    expect(entries).toHaveLength(Object.keys(SPA.car_setup!).length);
    expect(entries.find((e) => e.key === "VM_REAR_WING")).toEqual({ key: "VM_REAR_WING", label: "Rear wing", value: SPA.car_setup!.VM_REAR_WING });
    expect(entries.find((e) => e.key === "WM_CAMBER-W_FL")!.label).toBe("Front left camber");
    expect(entries.find((e) => e.key === "VM_GEAR_3")!.label).toBe("VM_GEAR_3");
  });

  it("the synthetic 1 Nov session differs from the real one in exactly three settings", async () => {
    const api = engine();
    const sessions = await api.sessions();
    const real = await api.sessionSetup(sessions.find((x) => x.started_at.startsWith("2026-11-03"))!.session_id);
    const synth = await api.sessionSetup(sessions.find((x) => x.started_at.startsWith("2026-11-01"))!.session_id);
    const changes = diffSetups(real, synth);
    expect(changes.map((c) => c.key).sort()).toEqual(["VM_BRAKE_BALANCE", "VM_FRONT_ANTISWAY", "VM_REAR_WING"]);
    expect(changes.find((c) => c.key === "VM_REAR_WING")).toMatchObject({ label: "Rear wing", from: SPA.car_setup!.VM_REAR_WING, to: "8.0 deg" });
    // Sessions that share the recording without overrides have the same setup.
    const other = await api.sessionSetup(sessions.find((x) => x.started_at.startsWith("2026-10-29T14"))!.session_id);
    expect(diffSetups(real, other)).toEqual([]);
  });

  it("a session with no recorded setup gives an empty list, and an unknown session is unknown_session", async () => {
    const api = engine();
    const race = (await api.sessions()).find((x) => x.session_type === "Race")!;
    expect(await api.sessionSetup(race.session_id)).toEqual({ entries: [] });
    await expect(api.sessionSetup("nope")).rejects.toMatchObject({ code: "unknown_session" });
    await expect(api.sessionSetup("nope")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("setupLabel", () => {
  it("names per-wheel keys and falls back to the key", () => {
    expect(setupLabel("WM_PRESSURE-W_RR")).toBe("Rear right tyre pressure");
    expect(setupLabel("VM_UNKNOWN_THING")).toBe("VM_UNKNOWN_THING");
    expect(setupLabel("WM_SRUBBER-W_FL")).toBe("WM_SRUBBER-W_FL");
  });
});

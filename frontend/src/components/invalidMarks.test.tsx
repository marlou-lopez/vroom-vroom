// The invalid-lap marks on the scrubber and the classic map (vroom-ake): shown only on an invalid lap with a wheels-off
// stretch, and a click seeks to the stretch's start.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "../api/mock/mockApi";
import type { Recording } from "../api/mock/recording";
import { effectiveValid } from "../api/types";
import { invalidNotice } from "../lib/invalidLap";
import { AnnotationBadges } from "./mapviews/shared/AnnotationBadges";
import { likelyInvalidRun, offTrackRuns } from "../lib/offTrack";
import { buildModel } from "../lib/model";
import { PlaybackProvider } from "../state/playback";
import { ScrubberInvalidMark } from "./AnnotationOverlays";
import { ClassicMapView } from "./mapviews/ClassicMapView";
import { newestBest } from "../test/mockServer";

const REC = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../public/mock/spa-2026-11-03.json"), "utf8")) as Recording;

async function models() {
  const api = createMockApi({ coachDelayMs: 0, loadSpa: async () => REC });
  const { laps, best } = await newestBest(api);
  const bad = laps.find((l) => !effectiveValid(l) && l.lap_time_s === null) ?? laps.find((l) => !effectiveValid(l))!;
  return { bad: buildModel(await api.compare(bad.lap_id)), good: buildModel(await api.compare(best.lap_id)) };
}

describe("invalid-lap scrubber mark", () => {
  it("marks the first wheels-off stretch of an invalid lap and seeks to it on click", async () => {
    const { bad } = await models();
    const run = likelyInvalidRun(offTrackRuns(bad.cmp.lap))!;
    const seek = vi.fn();
    render(<ScrubberInvalidMark model={bad} valid={false} onSeekDistance={seek} />);
    fireEvent.click(screen.getByTestId("scrubber-invalid-mark"));
    expect(seek).toHaveBeenCalledWith(bad.cmp.distance[run.start]);
  });
  it("shows nothing on a valid lap", async () => {
    const { good } = await models();
    render(<ScrubberInvalidMark model={good} valid onSeekDistance={() => {}} />);
    expect(screen.queryByTestId("scrubber-invalid-mark")).toBeNull();
  });
});

describe("invalid-lap map mark", () => {
  const view = (model: Awaited<ReturnType<typeof models>>["bad"], lapValid: boolean, onSeekDistance: (m: number) => void) => (
    <PlaybackProvider>
      <ClassicMapView model={model} trackMap={null} geometry={null} annotations={[]} handlers={{ onSeek: () => {}, onSeekDistance }} lapValid={lapValid} invalidAtM={invalidNotice(lapValid, model.cmp.lap, model.cmp.distance, null)?.atM ?? null} />
    </PlaybackProvider>
  );
  it("draws a clickable mark on an invalid lap", async () => {
    const { bad } = await models();
    const run = likelyInvalidRun(offTrackRuns(bad.cmp.lap))!;
    const seek = vi.fn();
    render(view(bad, false, seek));
    fireEvent.click(screen.getByTestId("map-invalid-mark"));
    expect(seek).toHaveBeenCalledWith(bad.cmp.distance[run.start]);
  });
  it("draws none on a valid lap", async () => {
    const { good } = await models();
    render(view(good, true, () => {}));
    expect(screen.queryByTestId("map-invalid-mark")).toBeNull();
  });
});

describe("invalid-lap mark in the WebGL views' shared badge layer", () => {
  const layer = (atM: number | null, seek: (m: number) => void) => (
    <AnnotationBadges annotations={[]} handlers={{ onSeek: () => {}, onSeekDistance: seek }} badgeEls={{ current: new Map() }} invalidAtM={atM} />
  );
  it("draws a clickable mark at the page's spot on an invalid lap", async () => {
    const { bad } = await models();
    const atM = invalidNotice(false, bad.cmp.lap, bad.cmp.distance, null)!.atM!;
    const seek = vi.fn();
    render(layer(atM, seek));
    fireEvent.click(screen.getByTestId("view-invalid-mark"));
    expect(seek).toHaveBeenCalledWith(atM);
  });
  it("draws none on a valid lap or when no spot was found", async () => {
    const { good } = await models();
    expect(invalidNotice(true, good.cmp.lap, good.cmp.distance, null)).toBeNull();
    render(layer(null, () => {}));
    expect(screen.queryByTestId("view-invalid-mark")).toBeNull();
  });
});

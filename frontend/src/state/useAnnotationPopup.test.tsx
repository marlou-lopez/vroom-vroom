import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { PlaybackProvider, usePlaybackStore } from "./playback";
import { useAnnotationPopup } from "./useAnnotationPopup";

const wrapper = ({ children }: { children: ReactNode }) => <PlaybackProvider>{children}</PlaybackProvider>;

function setup(playing: boolean) {
  const hook = renderHook(() => ({ popup: useAnnotationPopup(), store: usePlaybackStore() }), { wrapper });
  if (playing) hook.result.current.store.play();
  return hook.result;
}

describe("useAnnotationPopup", () => {
  it("pauses playback when the first card opens and resumes when the last closes", () => {
    const r = setup(true);
    const { popup, store } = r.current;
    popup.setOpen("a", true);
    expect(store.get().playing).toBe(false);
    popup.setOpen("b", true);
    expect(store.get().playing).toBe(false);
    popup.setOpen("a", false);
    expect(store.get().playing).toBe(false); // b is still open
    popup.setOpen("b", false);
    expect(store.get().playing).toBe(true);
  });

  it("does not start playback when it wasn't playing", () => {
    const r = setup(false);
    const { popup, store } = r.current;
    popup.setOpen("a", true);
    popup.setOpen("a", false);
    expect(store.get().playing).toBe(false);
  });

  it("ignores a duplicate open key (it must not re-record 'was playing' from the paused state)", () => {
    const r = setup(true);
    const { popup, store } = r.current;
    popup.setOpen("a", true);
    popup.setOpen("a", true);
    popup.setOpen("a", false);
    expect(store.get().playing).toBe(true);
  });

  it("ignores closing a card that was never opened", () => {
    const r = setup(true);
    const { popup, store } = r.current;
    popup.setOpen("ghost", false);
    expect(store.get().playing).toBe(true);
  });

  it("forgets the resume flag after resuming, so a later cycle starts from the live state", () => {
    const r = setup(true);
    const { popup, store } = r.current;
    popup.setOpen("a", true);
    popup.setOpen("a", false);
    expect(store.get().playing).toBe(true);
    store.pause();
    popup.setOpen("a", true);
    popup.setOpen("a", false);
    expect(store.get().playing).toBe(false);
  });

  it("returns a stable object across renders", () => {
    const hook = renderHook(() => useAnnotationPopup(), { wrapper });
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
  });
});

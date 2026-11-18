import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Finding } from "../api/types";
import type { Annotation } from "../lib/annotations";
import { AnnotationCardProvider, AnnotationHoverCard, OPEN_DELAY_MS, type AnnotationCardActions } from "./AnnotationPopup";

const finding = {
  id: "f1", corner: "Eau Rouge", kind: "issue", time_s: 0.123, what: "Lifted early", fix: "Stay flat",
  evidence: [], cue_type: "none",
} as unknown as Finding;
const ann = { findingId: "f1", cornerId: "c1", color: "#f00", label: "1", finding, reviewed: false } as unknown as Annotation;

function setup() {
  const actions: AnnotationCardActions = {
    deepDives: {}, setOpen: vi.fn(), onPlay: vi.fn(), onToggleReviewed: vi.fn(), onAsk: vi.fn(async () => undefined),
  };
  const onSeek = vi.fn();
  render(
    <AnnotationCardProvider value={actions}>
      <AnnotationHoverCard annotation={ann}>
        <button type="button" onClick={onSeek}>badge</button>
      </AnnotationHoverCard>
    </AnnotationCardProvider>,
  );
  return { actions, onSeek, user: userEvent.setup() };
}

describe("AnnotationHoverCard keyboard access", () => {
  it("opens from the focused trigger with Enter and reaches every action by keyboard", async () => {
    const { actions, onSeek, user } = setup();
    const badge = screen.getByRole("button", { name: "badge" });
    await user.tab();
    expect(document.activeElement).toBe(badge);

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Eau Rouge" })).toBeTruthy();
    expect(onSeek).not.toHaveBeenCalled();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play from here" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Mark reviewed" }));
    await user.keyboard("{Enter}");
    expect(actions.onToggleReviewed).toHaveBeenCalledWith(ann);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Explain this corner in more detail" }));
    await user.keyboard("{Enter}");
    expect(actions.onAsk).toHaveBeenCalledWith(ann);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const { user } = setup();
    const badge = screen.getByRole("button", { name: "badge" });
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(badge);
  });

  it("still previews on mouse hover and seeks on click", async () => {
    const { onSeek, user } = setup();
    const badge = screen.getByRole("button", { name: "badge" });
    await user.hover(badge);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await user.click(badge);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("moves focus into a card that hover already opened when Enter is pressed", async () => {
    const { user } = setup();
    const badge = screen.getByRole("button", { name: "badge" });
    await user.hover(badge);
    await screen.findByRole("dialog");
    badge.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play from here" }));
  });

  it("announces the popup on the trigger", async () => {
    const { user } = setup();
    const badge = screen.getByRole("button", { name: "badge" });
    expect(badge.getAttribute("aria-haspopup")).toBe("dialog");
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    badge.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog");
    expect(badge.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("AnnotationHoverCard click and hover", () => {
  it("does not preview before the hover delay", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user } = setup();
      await user.hover(screen.getByRole("button", { name: "badge" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(OPEN_DELAY_MS - 100); });
      expect(screen.queryByRole("dialog")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on click at once, keeps open when the pointer leaves, and closes on a second click", async () => {
    const { user, onSeek } = setup();
    const badge = screen.getByRole("button", { name: "badge" });
    await user.click(badge);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onSeek).toHaveBeenCalledTimes(1);
    await user.unhover(badge);
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(badge);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

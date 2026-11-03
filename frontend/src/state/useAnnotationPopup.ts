import { useCallback, useMemo, useRef } from "react";
import { usePlaybackStore } from "./playback";

/**
 * Pause/resume bookkeeping for the annotation hover cards. Positioning, hover delays and dismissal are Radix
 * HoverCard's job; this only knows which cards are open. The first card to open pauses playback (remembering
 * whether it was playing) and the last one to close resumes it. Several triggers can exist for one finding
 * (map badge, strip chip, scrubber badge), so cards are tracked by a caller-chosen key.
 */
export function useAnnotationPopup() {
  const store = usePlaybackStore();
  const openKeys = useRef(new Set<string>());
  const resume = useRef(false);

  const setOpen = useCallback(
    (key: string, open: boolean) => {
      const keys = openKeys.current;
      if (open) {
        if (keys.has(key)) return;
        if (keys.size === 0) {
          resume.current = store.get().playing;
          store.pause();
        }
        keys.add(key);
      } else {
        if (!keys.delete(key) || keys.size > 0) return;
        if (resume.current) store.play();
        resume.current = false;
      }
    },
    [store],
  );

  return useMemo(() => ({ setOpen }), [setOpen]);
}

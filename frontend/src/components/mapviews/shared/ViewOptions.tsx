import * as Popover from "@radix-ui/react-popover";
import type { ReactNode } from "react";
import { cx } from "../../../lib/cx";
import ui from "../../ui.module.css";
import styles from "./toolbar.module.css";

/** The "Experimental" badge, at the end of the first toolbar row of both detailed views (same place in 2D and 3D). */
export function ExperimentalTag() {
  return <span className={styles.experimental} title="Still being worked on; it may change or be removed">Experimental</span>;
}

/** One row of the View options popover: a caption over its controls, with an optional plain-words explanation. */
export function OptionRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={styles.optRow}>
      <span className={styles.optLabel}>{label}</span>
      {children}
      {hint && <span className={styles.optHint}>{hint}</span>}
    </div>
  );
}

/** The "View options" button and its popover (Radix) for the rarely used options of a track view. */
export function ViewOptions({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <Popover.Root>
      <Popover.Trigger className={cx(ui.btn, styles.small)} disabled={disabled}>View options ▾</Popover.Trigger>
      <Popover.Portal>
        {/* data-controls: the map's pointer and wheel handlers must ignore events from here (React portals bubble to the view). */}
        <Popover.Content
          className={styles.content} data-controls="" align="end" sideOffset={6} collisionPadding={8} aria-label="View options"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

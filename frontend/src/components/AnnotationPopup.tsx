import * as Popover from "@radix-ui/react-popover";
import { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import type { Finding } from "../api/types";
import { formatDelta } from "../lib/format";
import type { Annotation } from "../lib/annotations";
import { cx } from "../lib/cx";
import styles from "./AnnotationPopup.module.css";
import ui from "./ui.module.css";

/** What a hover card needs from the page. Provided once by the Telemetry page. */
export interface AnnotationCardActions {
  /** Corner deep-dive findings by corner id. */
  deepDives: Record<string, Finding>;
  /** Open/close notifications, for the pause-while-open behaviour (`useAnnotationPopup`). */
  setOpen(key: string, open: boolean): void;
  onPlay(a: Annotation): void;
  onToggleReviewed(a: Annotation): void;
  onAsk(a: Annotation): Promise<unknown>;
}

const Ctx = createContext<AnnotationCardActions | null>(null);
export const AnnotationCardProvider = Ctx.Provider;

const TAG: Record<Finding["kind"], string> = { issue: "COSTING TIME", minor: "MINOR", strength: "STRENGTH", inconsistent: "INCONSISTENT" };
const CUE: Record<Finding["cue_type"], string | null> = { landmark: "LANDMARK", feel: "FEEL", own_lap: "OWN LAP", none: null };

const loss = (f: Finding) => (f.kind === "inconsistent" ? `±${f.time_s.toFixed(3)} s` : `${formatDelta(f.time_s)} s`);

export const OPEN_DELAY_MS = 100;
export const CLOSE_DELAY_MS = 250;

/**
 * Wraps one badge or chip (the single child, which receives the anchor props) with the annotation's card. The card
 * is portalled to `document.body`, so panel `overflow: hidden` cannot clip it, and Radix places it below the
 * trigger, flipping above or sideways near the viewport edges.
 *
 * The mouse previews it by hover (open and close delays, and the card stays open while the pointer is on it); the
 * keyboard opens it with Enter, Space or ArrowDown on the focused trigger, which moves focus into the card so its
 * buttons are reachable. Escape closes it and returns focus to the trigger. A click still reaches the child's own
 * handler (seek). This is a non-modal Popover rather than a HoverCard because HoverCard content is unreachable
 * from the keyboard.
 */
export function AnnotationHoverCard({ annotation, children }: { annotation: Annotation; children: ReactElement }) {
  const actions = useContext(Ctx);
  const key = useId();
  const [open, setOpenState] = useState(false);
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anchorEl = useRef<HTMLElement | null>(null);
  const contentEl = useRef<HTMLDivElement | null>(null);
  /** Opened by the keyboard: hover leave must not close it, and focus moves into it. */
  const byKeyboard = useRef(false);
  /** Closed from inside the card (Escape, Play): focus goes back to the trigger. */
  const focusBack = useRef(false);

  const change = (next: boolean) => {
    setOpenState(next);
    actionsRef.current?.setOpen(key, next);
  };
  const schedule = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => change(next), delay);
  };
  // A card that unmounts while open (notes hidden, other lap) must still release the pause.
  useEffect(() => () => {
    clearTimeout(timer.current);
    actionsRef.current?.setOpen(key, false);
  }, [key]);

  if (!actions) return children;

  const hoverOn = (e: ReactPointerEvent) => {
    anchorEl.current = e.currentTarget as HTMLElement;
    if (e.pointerType === "touch") return;
    if (!byKeyboard.current) schedule(true, OPEN_DELAY_MS);
    else clearTimeout(timer.current);
  };
  const hoverOff = (e: ReactPointerEvent) => {
    if (e.pointerType === "touch" || byKeyboard.current) return;
    schedule(false, CLOSE_DELAY_MS);
  };
  const keyOpen = (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
    // Capture phase: the child's own Enter-to-seek handler must not also run.
    e.preventDefault();
    e.stopPropagation();
    anchorEl.current = e.currentTarget as HTMLElement;
    byKeyboard.current = true;
    clearTimeout(timer.current);
    if (open) contentEl.current?.querySelector<HTMLElement>("button")?.focus(); // already open from hover: no auto-focus will run
    else change(true);
  };
  const close = (next: boolean) => {
    clearTimeout(timer.current);
    change(next);
  };

  return (
    <Popover.Root open={open} onOpenChange={close}>
      <Popover.Anchor
        asChild
        onPointerEnter={hoverOn}
        onPointerLeave={hoverOff}
        aria-haspopup="dialog"
        aria-expanded={open}
        onKeyDownCapture={keyOpen}
        // A button activates on Space at keyup; keydown's preventDefault is not enough in every browser.
        onKeyUpCapture={(e) => { if (e.key === " " && e.target === e.currentTarget) e.preventDefault(); }}
      >
        {children}
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={contentEl}
          side="bottom" align="start" sideOffset={8} collisionPadding={8}
          role="dialog" aria-label={annotation.finding.corner}
          className={styles.card} style={{ borderTopColor: annotation.color }}
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={(e) => { if (e.pointerType !== "touch" && !byKeyboard.current) schedule(false, CLOSE_DELAY_MS); }}
          // Hover opens must not steal focus; keyboard opens move it to the first button.
          onOpenAutoFocus={(e) => { if (!byKeyboard.current) e.preventDefault(); }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (focusBack.current && anchorEl.current?.isConnected) anchorEl.current.focus();
            focusBack.current = false;
            byKeyboard.current = false;
          }}
          onEscapeKeyDown={() => { focusBack.current = byKeyboard.current; }}
          // A click on the trigger (seek) is not a click away from the card.
          onInteractOutside={(e) => { if (anchorEl.current?.contains(e.target as Node)) e.preventDefault(); }}
        >
          <CardBody annotation={annotation} actions={actions} onPlay={() => { actions.onPlay(annotation); focusBack.current = byKeyboard.current; close(false); }} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CardBody({ annotation: a, actions, onPlay }: { annotation: Annotation; actions: AnnotationCardActions; onPlay(): void }) {
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const f = a.finding;
  const cue = CUE[f.cue_type];
  const deepDive = actions.deepDives[a.cornerId];

  const ask = async () => {
    setAsking(true);
    setAskError(null);
    try {
      await actions.onAsk(a);
    } catch (e) {
      const x = e as { code?: string; message?: string };
      setAskError(`${x.code ?? "error"}: ${x.message ?? String(e)}`);
    } finally {
      setAsking(false);
    }
  };

  return (
    <>
      <div className={styles.head}>
        <div className={styles.corner}>{f.corner}</div>
        <div className={styles.loss} style={{ color: a.color }}>{loss(f)}</div>
        <div className={styles.spacer} />
        <span className={styles.tag} style={{ color: a.color }}>{a.reviewed ? "REVIEWED" : TAG[f.kind]}</span>
      </div>
      <div className={styles.what}>{f.what}</div>
      <div className={styles.fix}>
        <span className={styles.fixLabel}>Fix · </span>
        {f.fix}{" "}
        {cue && <span className={styles.cue}>{cue}</span>}
      </div>
      {f.evidence.length > 0 && <div className={styles.evidence}>{f.evidence.join(" · ")}</div>}
      {deepDive && (
        <div className={styles.dive}>
          <div className={styles.diveHead}>ABOUT THIS CORNER · <span>{loss(deepDive)}</span></div>
          <div className={styles.what}>{deepDive.what}</div>
          <div className={styles.fix}><span className={styles.fixLabel}>Fix · </span>{deepDive.fix}</div>
          {deepDive.evidence.length > 0 && <div className={styles.evidence}>{deepDive.evidence.join(" · ")}</div>}
        </div>
      )}
      {askError && <div className={styles.error}>{askError}</div>}
      <div className={styles.actions}>
        <button type="button" onClick={onPlay} className={cx(ui.btnPrimary, styles.primary)}>Play from here</button>
        <button type="button" onClick={() => actions.onToggleReviewed(a)} className={ui.btn}>{a.reviewed ? "Mark unreviewed" : "Mark reviewed"}</button>
        <button type="button" onClick={() => void ask()} disabled={asking} className={ui.btn}>{asking ? "Asking…" : "Ask about this corner"}</button>
      </div>
    </>
  );
}

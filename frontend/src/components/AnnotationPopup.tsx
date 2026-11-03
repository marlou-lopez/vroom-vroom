import * as HoverCard from "@radix-ui/react-hover-card";
import { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, type ReactElement } from "react";
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
 * Wraps one badge or chip (the single child, which receives the Radix trigger props) with the annotation's
 * hover card. The card is portalled to `document.body`, so panel `overflow: hidden` cannot clip it, and Radix
 * places it below the trigger, flipping above or sideways near the viewport edges.
 */
export function AnnotationHoverCard({ annotation, children }: { annotation: Annotation; children: ReactElement }) {
  const actions = useContext(Ctx);
  const key = useId();
  const [open, setOpenState] = useState(false);
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  const change = (next: boolean) => {
    setOpenState(next);
    actionsRef.current?.setOpen(key, next);
  };
  // A card that unmounts while open (notes hidden, other lap) must still release the pause.
  useEffect(() => () => actionsRef.current?.setOpen(key, false), [key]);

  if (!actions) return children;
  return (
    <HoverCard.Root open={open} onOpenChange={change} openDelay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="bottom" align="start" sideOffset={8} collisionPadding={8}
          role="dialog" aria-label={annotation.finding.corner}
          className={styles.card} style={{ borderTopColor: annotation.color }}
        >
          <CardBody annotation={annotation} actions={actions} onPlay={() => { actions.onPlay(annotation); change(false); }} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
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

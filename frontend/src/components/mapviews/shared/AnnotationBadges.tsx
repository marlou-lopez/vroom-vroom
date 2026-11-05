import type { Annotation } from "../../../lib/annotations";
import { AnnotationHoverCard } from "../../AnnotationPopup";
import type { BadgeHandlers } from "../../AnnotationOverlays";
import styles from "./AnnotationBadges.module.css";

/**
 * The corner badges and hover cards over a WebGL view. The layer is positioned by the view each draw: it moves the
 * element registered for a finding with `transform: translate(...)` and `visibility`, so React never re-renders per frame.
 */
export function AnnotationBadges({ annotations, handlers, badgeEls }: {
  annotations: Annotation[];
  handlers: BadgeHandlers;
  badgeEls: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}) {
  return (
    <div className={styles.badges}>
      {annotations.map((a) => (
        <AnnotationHoverCard key={a.findingId} annotation={a}>
          <button
            type="button"
            data-annotation-badge=""
            aria-label={`${a.finding.corner} ${a.label} ${a.finding.kind}`}
            className={styles.badge}
            style={{ background: a.color }}
            ref={(el) => {
              if (el) badgeEls.current.set(a.findingId, el);
              else badgeEls.current.delete(a.findingId);
            }}
            onClick={() => handlers.onSeek(a)}
          >
            {a.label}
          </button>
        </AnnotationHoverCard>
      ))}
    </div>
  );
}

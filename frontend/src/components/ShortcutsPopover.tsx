import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
import { isTypingTarget, SHORTCUT_GROUPS } from "../lib/shortcuts";
import styles from "./ShortcutsPopover.module.css";
import ui from "./ui.module.css";

/** The "?" button and the list of keys; pressing "?" anywhere outside a text field toggles it too. */
export function ShortcutsPopover() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      // Inside the open popover "?" still closes it; elsewhere a text field keeps its own "?".
      if (t && isTypingTarget(t) && !t.closest("[data-shortcuts]")) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={ui.btn} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" side="top" sideOffset={4} collisionPadding={8} className={styles.panel} aria-label="Keyboard shortcuts" data-shortcuts
          // Focus goes back to where it was, not to the "?" button (Space there would reopen the list).
          onCloseAutoFocus={(e) => { e.preventDefault(); if (document.activeElement && document.activeElement !== document.body) (document.activeElement as HTMLElement).blur?.(); }}>
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title} className={styles.group}>
              <h3 className={styles.title}>{g.title}</h3>
              <dl className={styles.rows}>
                {g.rows.map((r) => (
                  <div key={r.keys.join("|") + r.what} className={styles.row}>
                    <dt>{r.keys.map((k) => <kbd key={k} className={styles.kbd}>{k}</kbd>)}</dt>
                    <dd>{r.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

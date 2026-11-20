import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import styles from "./AppShell.module.css";

const SlotCtx = createContext<HTMLElement | null>(null);

/** Renders its children into the right-hand side of the header. */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const el = useContext(SlotCtx);
  return el ? createPortal(children, el) : null;
}

export function AppShell() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const { pathname, search } = useLocation();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        {/* No page nav: the scope line (Track and car › Session › Lap) is the navigation (vroom-pnw.65). */}
        <Link to="/" className={styles.brand}>RACECOACH</Link>
        <div className={styles.spacer} />
        <div ref={setSlot} className={styles.slot} />
      </header>
      <SlotCtx.Provider value={slot}>
        <main className={styles.main}>
          <ErrorBoundary label="page" resetKeys={[pathname, search]}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </SlotCtx.Provider>
    </div>
  );
}

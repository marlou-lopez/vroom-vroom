import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet } from "react-router-dom";
import { cx } from "../lib/cx";
import styles from "./AppShell.module.css";

const SlotCtx = createContext<HTMLElement | null>(null);

/** Renders its children into the right-hand side of the header (used by the Telemetry page for `LapPicker`). */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const el = useContext(SlotCtx);
  return el ? createPortal(children, el) : null;
}

const NAV = [
  { to: "/", label: "Telemetry", end: true },
  { to: "/sessions", label: "Sessions", end: false },
  { to: "/tracks", label: "Tracks", end: false },
];

export function AppShell() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>RACECOACH</div>
        <nav aria-label="Main" className={styles.nav}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx(styles.link, isActive && styles.active)}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className={styles.spacer} />
        <div ref={setSlot} className={styles.slot} />
      </header>
      <SlotCtx.Provider value={slot}>
        <main className={styles.main}>
          <Outlet />
        </main>
      </SlotCtx.Provider>
    </div>
  );
}

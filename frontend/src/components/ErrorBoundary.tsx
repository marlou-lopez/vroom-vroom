import { Component, type ErrorInfo, type ReactNode } from "react";
import { cx } from "../lib/cx";
import ui from "./ui.module.css";
import styles from "./ErrorBoundary.module.css";

interface Props {
  /** Names the failed area in the fallback, e.g. "page" or "track view". */
  label: string;
  /** The boundary clears its error when any of these changes (route, lap, view). */
  resetKeys?: readonly unknown[];
  /** `page` fills the route area, `panel` fills the box it is placed in. */
  variant?: "page" | "panel";
  children: ReactNode;
}

interface State {
  error: Error | null;
  keys: readonly unknown[] | undefined;
}

const sameKeys = (a: readonly unknown[] = [], b: readonly unknown[] = []) =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Catches render errors below it and shows them inline, so the rest of the app keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (sameKeys(state.keys, props.resetKeys)) return null;
    return { keys: props.resetKeys, error: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Render error in ${this.props.label}:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className={cx(styles.box, this.props.variant === "panel" && styles.panel)}>
        <div className={styles.title}>The {this.props.label} hit an error</div>
        <pre className={styles.message}>{error.message || String(error)}</pre>
        <button type="button" className={cx(ui.btn, ui.btnMuted)} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

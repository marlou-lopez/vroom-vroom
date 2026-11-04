import styles from "./PlaceholderView.module.css";

export function PlaceholderView({ issue }: { issue: number }) {
  return <div className={styles.box}>Not built yet — see #{issue}</div>;
}

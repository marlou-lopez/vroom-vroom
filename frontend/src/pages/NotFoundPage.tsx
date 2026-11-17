import { Link, useLocation } from "react-router-dom";
import styles from "./NotFoundPage.module.css";

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Page not found</h1>
      <p className={styles.path}>
        No page at <code>{pathname}</code>
      </p>
      <Link to="/">Back to Telemetry</Link>
    </div>
  );
}

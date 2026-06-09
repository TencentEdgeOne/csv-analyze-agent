/**
 * CancelControl —— Three-state CTA shown while an analysis is running.
 *
 *   running    → "Stop analysis" — coral, prominent, click to abort
 *   cancelling → "Stopping..." — amber spinner, disabled (waiting for backend)
 *   cancelled  → "Back to home" — emerald, click to reset and return to upload
 *
 * The transition is driven by the parent: it calls cancelAnalyze() when the
 * stop button is clicked and flips phase from "running" → "cancelling". Once
 * the agent stream goes idle (i.e. the abort actually propagated), the parent
 * flips phase to "cancelled" so the user can return home.
 */
import styles from "./CancelControl.module.css";
import { useT } from "../i18n";

export type CancelPhase = "running" | "cancelling" | "cancelled";

interface CancelControlProps {
  phase: CancelPhase;
  onStop: () => void;
  onBack: () => void;
}

export function CancelControl({ phase, onStop, onBack }: CancelControlProps) {
  const { t } = useT();

  if (phase === "running") {
    return (
      <button
        type="button"
        className={`${styles.btn} ${styles.stop}`}
        onClick={onStop}
        aria-label={t("cancel.stop")}
      >
        <span className={styles.icon} aria-hidden>
          <span className={styles.stopGlyph} />
        </span>
        <span className={styles.label}>{t("cancel.stop")}</span>
        <span className={styles.hint}>esc</span>
      </button>
    );
  }

  if (phase === "cancelling") {
    return (
      <button
        type="button"
        className={`${styles.btn} ${styles.waiting}`}
        disabled
        aria-busy="true"
        aria-label={t("cancel.stopping")}
      >
        <span className={styles.icon} aria-hidden>
          <span className={styles.spinner} />
        </span>
        <span className={styles.label}>{t("cancel.stopping")}</span>
        <span className={styles.hint}>
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
        </span>
      </button>
    );
  }

  // cancelled → back-home CTA
  return (
    <button
      type="button"
      className={`${styles.btn} ${styles.back}`}
      onClick={onBack}
      aria-label={t("cancel.backHome")}
    >
      <span className={styles.icon} aria-hidden>
        <span className={styles.backGlyph}>←</span>
      </span>
      <span className={styles.label}>{t("cancel.backHome")}</span>
      <span className={styles.hint}>{t("cancel.cancelled")}</span>
    </button>
  );
}

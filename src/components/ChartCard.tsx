/**
 * ChartCard: a single chart card.
 * Fetches SVG from the backend and inlines it with dangerouslySetInnerHTML.
 */
import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { ChartMeta } from "../types";
import { fetchSvg } from "../lib/api";
import styles from "./ChartCard.module.css";

interface ChartCardProps {
  chart: ChartMeta;
  index: number;
  /**
   * Conversation ID required by the EdgeOne agents/ runtime when this
   * card lazily loads its SVG via /static. If `svgContent` is supplied
   * (history view), no network call is made and conversationId is unused.
   */
  conversationId?: string;
  /** Directly pass SVG string (history report mode), bypassing the network request */
  svgContent?: string;
  children?: React.ReactNode;
}

export function ChartCard({ chart, index, conversationId, svgContent, children }: ChartCardProps) {
  const [svg, setSvg] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (svgContent) {
      setSvg(svgContent);
      return;
    }
    let cancelled = false;
    const url = chart.svgUrl;
    if (!url) {
      setErr("missing svg url");
      return;
    }
    if (!conversationId) {
      setErr("missing conversationId for /static fetch");
      return;
    }
    fetchSvg(url, conversationId)
      .then((s) => {
        if (!cancelled) setSvg(s);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [chart.svgUrl, svgContent, conversationId]);

  const handleDownload = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${chart.id}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [svg, chart.id]);

  return (
    <motion.article
      className={styles.card}
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.44,
        ease: [0.22, 0.68, 0.32, 1.18],
      }}
    >
      <header className={styles.head}>
        <span className={styles.label}>
          CHART {String(index + 1).padStart(2, "0")} · {chart.chartType}
        </span>
        {svg && (
          <button
            onClick={handleDownload}
            className={styles.download}
          >
            ⬇ download
          </button>
        )}
      </header>
      <h3 className={styles.title}>{chart.title}</h3>
      {chart.description && (
        <p className={styles.desc}>{chart.description}</p>
      )}
      {svg ? (
        <div
          className={styles.svg}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className={styles.svg}>
          {!err && <span className={styles.loading}>rendering…</span>}
        </div>
      )}
      {err && <div className={styles.err}>failed to load SVG: {err}</div>}
      <div className={styles.foot}>
        <span>{chart.relPath}</span>
        <span className={styles.cols}>
          {chart.relevantColumns.join(" · ")}
        </span>
      </div>
      {children}
    </motion.article>
  );
}

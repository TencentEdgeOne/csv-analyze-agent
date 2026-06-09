/**
 * AgentCanvas: main right-hand canvas that switches content based on phase.
 *
 * idle       → hero guide
 * scanning   → ColumnScan
 * charting   → ChartCard stack
 * insights   → ChartCard + InsightBlock
 * report     → ReportActions + all content
 */
import { AnimatePresence, motion } from "framer-motion";
import type { Phase } from "../hooks/useAgentStream";
import type { AgentStreamState } from "../hooks/useAgentStream";
import { ColumnScan } from "./ColumnScan";
import { ChartCard } from "./ChartCard";
import { InsightBlock } from "./InsightBlock";
import { SummaryIsland } from "./SummaryIsland";
import { ReanalyzeButton } from "./ReanalyzeButton";
import { useT } from "../i18n";
import styles from "./AgentCanvas.module.css";

interface AgentCanvasProps {
  phase: Phase;
  state: AgentStreamState;
  onReset: () => void;
  /**
   * Conversation ID — passed down to ChartCard so that its lazy /static
   * SVG fetch can include Markers-Conversation-Id (required by EdgeOne
   * agents/ runtime).
   */
  conversationId: string;
  /**
   * When true, the run was aborted by the user. We freeze any live
   * scanning/forging animations — the underlying agent stream may have
   * been disconnected before emitting the events that would normally end
   * the phase, so we can't rely on `phase` alone.
   */
  cancelled?: boolean;
}

export function AgentCanvas({ phase, state, onReset, conversationId, cancelled = false }: AgentCanvasProps) {
  const { t } = useT();
  const { upload, charts, insights, done } = state;
  const summary = insights.find((i) => i.kind === "summary");
  const perChart = insights.filter((i) => i.kind === "per_chart");
  const hasChartWork =
    charts.length > 0 || state.tools.some((tool) => tool.agent === "chart");
  const columnScanMode =
    phase === "scanning" && !hasChartWork ? "scan" : "charting";
  const insightNote = state.agentNotes.insight;
  const insightPartial = state.agentStatus.insight === "partial";

  return (
    <section className={styles.canvas}>
      <AnimatePresence mode="wait">
        {phase === "idle" && (
          <motion.div
            key="idle"
            className={styles.hero}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.4 }}
          >
            <h1 className={styles.title}>
              <span>{t("hero.titleTop")}</span>
              <span>{t("hero.titleBottom")}</span>
            </h1>
            <p className={styles.sub}>
              {t("hero.subtitle").split("\n").map((line) => (
                <span key={line}>
                  {line}
                  <br />
                </span>
              ))}
            </p>
            <div className={styles.poweredBy}>{t("hero.poweredBy")}</div>
          </motion.div>
        )}

        {(phase === "scanning" ||
          phase === "charting" ||
          phase === "insights" ||
          phase === "report") && (
          <motion.div
            key="running"
            className={styles.stack}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            {/* Summary island: shown at the very top only during the report phase */}
            {done && summary && <SummaryIsland text={summary.text} />}

            {/* Partial-state banner: insight agent hit max_turns / max_budget,
                we kept everything that was written but want to flag it. */}
            {done && insightPartial && insightNote && (
              <div className={styles.partialBanner} role="status">
                <span className={styles.partialIcon} aria-hidden>
                  ⚠
                </span>
                <span className={styles.partialText}>{insightNote}</span>
              </div>
            )}

            {/* Column Scan —— visible throughout analysis (as data overview), hidden after completion.
                When the user has cancelled, we hide it entirely — the inner CHART FORGE keeps
                CSS-only infinite animations (sweeps, bars, pie arcs) that can't be paused via
                props, so the cleanest fix is to drop the panel altogether. */}
            {!done && !cancelled && upload && (
              <ColumnScan
                distributions={upload.distributions}
                mode={columnScanMode}
                scanning={phase === "scanning" && !cancelled}
                tools={state.tools}
                runningTool={cancelled ? null : state.runningTool}
                chartsGenerated={charts.length}
                insightsActive={phase === "insights" && !cancelled}
              />
            )}

            {/* Chart cards + corresponding insights */}
            {charts.map((c, i) => {
              const liveIdx = perChart.length - 1;
              const chartInsights = perChart.filter(
                (ins) => ins.chartId === c.id,
              );
              return (
                <ChartCard key={c.id} chart={c} index={i} conversationId={conversationId}>
                  {chartInsights.map((ins, j) => {
                    const globalIdx = perChart.indexOf(ins);
                    const isLive = globalIdx === liveIdx && !done;
                    return (
                      <InsightBlock
                        key={`${c.id}-${j}`}
                        text={ins.text}
                        live={isLive}
                      />
                    );
                  })}
                </ChartCard>
              );
            })}

            {/* "Analyze again" CTA appears at the bottom of the canvas after analysis completes
                — also after a user cancel, to give them a clear way back without leaving via the
                left sidebar. */}
            {(done || cancelled) && <ReanalyzeButton onClick={onReset} />}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/**
 * ColumnScan: core visualization for ACT 2.
 *
 * One row per column; 60 div blocks represent normalized distribution values.
 * Color mapping:
 *   numeric   → emerald
 *   datetime  → cyan
 *   categorical / boolean → blue
 *   id        → muted grey
 *   text      → dimmed
 *
 * Scanline effect: rows light up in sequence (CSS stagger); an outer sweeping line adds additional visual flair.
 */
import { useMemo } from "react";
import type { ColumnDistribution } from "../types";
import type { ToolInvocation } from "../hooks/useAgentStream";
import styles from "./ColumnScan.module.css";

type ColumnScanMode = "scan" | "charting";

interface ColumnScanProps {
  distributions: ColumnDistribution[];
  mode: ColumnScanMode;
  /** Whether the component is in "scanning" state — controls the sweeping line */
  scanning?: boolean;
  tools?: ToolInvocation[];
  runningTool?: string | null;
  chartsGenerated?: number;
  targetCharts?: number;
  insightsActive?: boolean;
}

export function ColumnScan({
  distributions,
  mode,
  scanning = false,
  tools = [],
  runningTool = null,
  chartsGenerated = 0,
  targetCharts = 4,
  insightsActive = false,
}: ColumnScanProps) {
  const rows = useMemo(
    () => distributions.slice(0, 24), // Truncate beyond 24 columns to maintain visual density
    [distributions],
  );

  const chartTools = useMemo(
    () => tools.filter((tool) => tool.agent === "chart"),
    [tools],
  );
  const activeTool = chartTools.find((tool) => tool.id === runningTool);
  const recentTools = chartTools.slice(-5);

  if (mode === "charting") {
    return (
      <ChartForge
        activeTool={activeTool}
        recentTools={recentTools}
        chartsGenerated={chartsGenerated}
        targetCharts={targetCharts}
        insightsActive={insightsActive}
      />
    );
  }

  return (
    <div className={`${styles.wrap} ${scanning ? styles.scanning : ""}`}>
      <div className={styles.legend}>
        <span className={styles.legendLabel}>COLUMN SCAN</span>
        <span className={styles.legendMeta}>
          {distributions.length} columns · 60-bin profile
        </span>
      </div>
      <div className={styles.table}>
        {rows.map((d, i) => (
          <div
            key={d.column}
            className={styles.row}
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className={styles.name} title={d.column}>
              {d.column}
            </div>
            <div className={styles.bins}>
              {d.bins.map((v, j) => (
                <span
                  key={j}
                  className={`${styles.bin} ${styles[d.semanticType] ?? ""}`}
                  style={
                    {
                      "--v": v.toFixed(3),
                      "--delay": `${j * 12}ms`,
                    } as React.CSSProperties
                  }
                />
              ))}
            </div>
            <div className={`${styles.chip} ${styles[`chip_${d.semanticType}`] ?? ""}`}>
              {d.semanticType}
            </div>
          </div>
        ))}
      </div>
      {scanning && <div className={styles.sweep} aria-hidden="true" />}
    </div>
  );
}

function ChartForge({
  activeTool,
  recentTools,
  chartsGenerated,
  targetCharts,
  insightsActive,
}: {
  activeTool?: ToolInvocation;
  recentTools: ToolInvocation[];
  chartsGenerated: number;
  targetCharts: number;
  insightsActive: boolean;
}) {
  const visibleSlots = Math.max(targetCharts, chartsGenerated + 1, 3);
  const activeToolName = formatToolName(activeTool?.name ?? "planning chart");
  const title = insightsActive ? "CHARTS READY" : "CHART FORGE";
  const meta = insightsActive
    ? `${chartsGenerated} charts generated · writing insights`
    : `${activeToolName} ${activeTool?.state ?? "running"} · ${chartsGenerated} charts generated`;

  return (
    <div className={`${styles.wrap} ${styles.forge}`}>
      <div className={styles.forgeGlow} aria-hidden="true" />
      <div className={styles.legend}>
        <span className={styles.legendLabel}>{title}</span>
        <span className={styles.liveBadge}>
          <span />
          LIVE
        </span>
      </div>
      <div className={styles.forgeMeta}>{meta}</div>

      <ChartGenerationAnimation />

      <div className={styles.pipelineHeader}>
        <span>tool pipeline</span>
        <span>bar distribution · ratio split · trend line</span>
      </div>
      <div className={styles.toolPipeline}>
        {(recentTools.length ? recentTools : placeholderTools(insightsActive)).map((tool) => (
          <div
            key={tool.id}
            className={styles.toolStep}
            data-state={tool.state}
          >
            <span className={styles.toolDot} />
            <span className={styles.toolName}>{formatToolName(tool.name)}</span>
            {tool.durationMs != null && (
              <span className={styles.toolTime}>
                {(tool.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        ))}
      </div>

      <div className={styles.chartSlots} aria-label={`${chartsGenerated} charts generated`}>
        {Array.from({ length: visibleSlots }).map((_, i) => {
          const state =
            i < chartsGenerated
              ? styles.chartSlotDone
              : i === chartsGenerated && !insightsActive
                ? styles.chartSlotActive
                : styles.chartSlotPending;
          return (
            <div key={i} className={`${styles.chartSlot} ${state}`}>
              <span />
              <span />
              <span />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChartGenerationAnimation() {
  return (
    <div className={styles.chartStage} aria-hidden="true">
      <div className={styles.generatingSweep} />
      <div className={`${styles.vizCard} ${styles.vizBar}`}>
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className={`${styles.vizCard} ${styles.vizPie}`}>
        <svg viewBox="0 0 48 48">
          <circle className={styles.pieBase} cx="24" cy="24" r="15" />
          <circle className={styles.pieArcA} cx="24" cy="24" r="15" />
          <circle className={styles.pieArcB} cx="24" cy="24" r="15" />
          <circle className={styles.pieArcC} cx="24" cy="24" r="15" />
        </svg>
      </div>
      <div className={`${styles.vizCard} ${styles.vizLine}`}>
        <svg viewBox="0 0 80 48">
          <path className={styles.lineArea} d="M6 36 L22 28 L38 31 L54 16 L74 10 L74 44 L6 44 Z" />
          <path className={styles.linePath} d="M6 36 L22 28 L38 31 L54 16 L74 10" />
          {[["6", "36"], ["22", "28"], ["38", "31"], ["54", "16"], ["74", "10"]].map(([cx, cy], i) => (
            <circle
              key={`${cx}-${cy}`}
              className={styles.lineDot}
              cx={cx}
              cy={cy}
              r="2.2"
              style={{ animationDelay: `${i * 140}ms` }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

function formatToolName(name: string) {
  return name.replaceAll("_", " ");
}

function placeholderTools(ready = false): ToolInvocation[] {
  return [
    {
      id: "placeholder-inspect",
      name: "inspect_csv",
      agent: "chart",
      state: "done",
      startedAt: 0,
    },
    {
      id: "placeholder-values",
      name: "get_column_values",
      agent: "chart",
      state: ready ? "done" : "running",
      startedAt: 0,
    },
    {
      id: "placeholder-chart",
      name: "create_chart",
      agent: "chart",
      state: ready ? "done" : "running",
      startedAt: 0,
    },
  ];
}

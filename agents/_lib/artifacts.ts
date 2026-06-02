/**
 * Shared artifact extraction utilities.
 * Used by `persistAnalysisArtifacts` in history.ts to build the full
 * artifacts blob written to context.store. The cloud-functions side
 * (cloud-functions/history-detail) only reads that blob — it doesn't
 * need to rebuild from disk.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "./session.js";
import type { ChartMeta, Insight } from "./types.js";

/**
 * Extract charts from session events.
 */
export function extractChartsFromEvents(events: any[]): ChartMeta[] {
  return events
    .filter((e) => e.type === "chart")
    .map((e) => e.chart);
}

/**
 * Extract insights from session events.
 */
export function extractInsightsFromEvents(events: any[]): Insight[] {
  return events
    .filter((e) => e.type === "insight")
    .map((e) => e.insight);
}

/**
 * Load all SVG content for the given charts from disk.
 * Failures are logged but don't prevent the operation from completing.
 */
export async function loadChartSvgs(
  outDir: string,
  charts: ChartMeta[],
): Promise<Record<string, string>> {
  const svgPromises = charts.map((chart) =>
    readFile(path.join(outDir, chart.relPath), "utf-8")
      .then((content) => [chart.id, content] as const)
      .catch((err) => {
        console.warn(
          `Failed to read SVG for chart ${chart.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }),
  );

  const svgEntries = (await Promise.all(svgPromises)).filter(
    (entry): entry is [string, string] => entry !== null,
  );
  return Object.fromEntries(svgEntries);
}

/**
 * Load HTML report from disk.
 * Returns empty string if the report doesn't exist (e.g., chartsOnly mode).
 */
export async function loadReportHtml(outDir: string): Promise<string> {
  try {
    return await readFile(path.join(outDir, "report.html"), "utf-8");
  } catch (err) {
    console.warn(
      `Failed to read report.html: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "";
  }
}

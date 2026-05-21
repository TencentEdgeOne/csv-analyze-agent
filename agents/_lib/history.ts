/**
 * History 持久化：通过 EdgeOne context.store 写入分析摘要 + 完整制品。
 *
 * 两类记录：
 *   1. analysis_record（轻量快照）：每次状态变更写一条，/history 用
 *   2. analysis_artifacts（完整制品）：分析完成时写一条，/history/detail 用
 */
import type { Session } from "./session.js";
import type { CsvProfile, ChartMeta, Insight } from "./types.js";
import {
  extractChartsFromEvents,
  extractInsightsFromEvents,
  loadChartSvgs,
  loadReportHtml,
} from "./artifacts.js";

// ─── Types ──────────────────────────────────────────────────

export type AnalysisHistoryStatus =
  | Session["status"]
  | "cancelled"
  | "deleted";

export interface CsvAnalysisHistoryRecord {
  kind: "csv_analysis";
  version: 1;
  taskId: string;
  csvName: string;
  size: number;
  status: AnalysisHistoryStatus;
  createdAt: number;
  updatedAt: number;
  rows: number;
  columns: number;
  charts?: number;
  insights?: number;
  cost?: {
    chart?: number;
    insight?: number;
    total: number;
  };
  durationMs?: number;
  reports?: {
    charts: boolean;
    insight: boolean;
    merged: boolean;
    html: boolean;
  };
  error?: string;
}

// ─── Store metadata constants ───────────────────────────────

const APP_NAME = "csv-analyze";
const RECORD_KIND = "analysis_record";
const RECORD_VERSION = 1;
const ARTIFACTS_KIND = "analysis_artifacts";
const ARTIFACTS_VERSION = 1;

// ─── Build record from session + patch ──────────────────────

function buildRecord(
  session: Session,
  patch: Partial<CsvAnalysisHistoryRecord> & { status: AnalysisHistoryStatus },
): CsvAnalysisHistoryRecord {
  const now = Date.now();
  return {
    kind: "csv_analysis",
    version: 1,
    taskId: session.id,
    csvName: session.csvName,
    size: session.csvSize,
    status: patch.status,
    createdAt: session.createdAt,
    updatedAt: now,
    rows: session.profile?.rows ?? 0,
    columns: session.profile?.columns?.length ?? 0,
    // merge optional fields from patch
    ...(patch.charts != null ? { charts: patch.charts } : {}),
    ...(patch.insights != null ? { insights: patch.insights } : {}),
    ...(patch.cost != null ? { cost: patch.cost } : {}),
    ...(patch.durationMs != null ? { durationMs: patch.durationMs } : {}),
    ...(patch.reports != null ? { reports: patch.reports } : {}),
    ...(patch.error != null ? { error: patch.error } : {}),
  };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * 安全地向 context.store 追加一条分析历史记录。
 * 任何 store 写入失败都不影响主分析流程。
 */
export async function appendAnalysisHistory(
  context: any,
  session: Session,
  patch: Partial<CsvAnalysisHistoryRecord> & { status: AnalysisHistoryStatus },
): Promise<void> {
  try {
    const conversationId: string = context?.conversation_id ?? "";
    const store = context?.store ?? null;

    console.log(`[history] append status=${patch.status} conversationId=${conversationId || "(empty)"} store=${store ? "ok" : "null"}`);

    if (!store || !conversationId) {
      return;
    }

    const record = buildRecord(session, patch);

    await store.appendMessage({
      conversationId,
      role: "assistant",
      content: record,
      metadata: {
        app: APP_NAME,
        kind: RECORD_KIND,
        version: RECORD_VERSION,
        taskId: record.taskId,
        status: record.status,
      },
    });
  } catch (err) {
    // 写入失败不影响主流程，仅打印日志
    console.warn(
      "[history] appendAnalysisHistory failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ─── Exports for /history endpoint ──────────────────────────

export { APP_NAME, RECORD_KIND, RECORD_VERSION, ARTIFACTS_KIND, ARTIFACTS_VERSION };

// ─── Helpers for analyze lifecycle ──────────────────────────

/**
 * Build a "done" history patch by extracting summary from the session's events.
 * Used by both analyze/index.ts and analyze/rerun-insights.ts.
 */
export function buildDonePatch(
  s: Session,
  durationMs: number,
): Partial<CsvAnalysisHistoryRecord> & { status: "done" } {
  const doneEvt = s.events.find((e) => e.type === "done");
  return {
    status: "done",
    charts:
      doneEvt?.type === "done"
        ? doneEvt.charts
        : s.events.filter((e) => e.type === "chart").length,
    insights:
      doneEvt?.type === "done"
        ? doneEvt.insights
        : s.events.filter((e) => e.type === "insight").length,
    cost: doneEvt?.type === "done" ? doneEvt.cost : undefined,
    durationMs,
    reports:
      doneEvt?.type === "done"
        ? {
            charts: Boolean(doneEvt.reports.charts),
            insight: Boolean(doneEvt.reports.insight),
            merged: Boolean(doneEvt.reports.merged),
            html: Boolean(doneEvt.reports.html),
          }
        : undefined,
  };
}

/**
 * Build an "error" history patch.
 */
export function buildErrorPatch(
  error: unknown,
  durationMs: number,
): Partial<CsvAnalysisHistoryRecord> & { status: "error" } {
  return {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
    durationMs,
  };
}

// ─── Analysis Artifacts (full result persistence) ───────────

export interface AnalysisArtifacts {
  kind: "csv_analysis_artifacts";
  version: 1;
  taskId: string;
  csvName: string;
  profile: CsvProfile;
  charts: ChartMeta[];
  insights: Insight[];
  svgs: Record<string, string>;
  reportHtml: string;
  cost: { chart?: number; insight?: number; total: number };
  durationMs: number;
  createdAt: number;
}

/**
 * 分析完成后，把完整制品（SVG、insights、报告）持久化到 context.store。
 * 失败不影响主流程。
 */
export async function persistAnalysisArtifacts(
  context: any,
  session: Session,
  cost: { chart?: number; insight?: number; total: number },
  durationMs: number,
): Promise<void> {
  try {
    const conversationId: string = context?.conversation_id ?? "";
    const store = context?.store ?? null;

    if (!store || !conversationId) return;

    const events = session.events ?? [];
    const charts = extractChartsFromEvents(events);
    const insights = extractInsightsFromEvents(events);
    const svgs = await loadChartSvgs(session.outDir, charts);
    const reportHtml = await loadReportHtml(session.outDir);

    const artifacts: AnalysisArtifacts = {
      kind: "csv_analysis_artifacts",
      version: 1,
      taskId: session.id,
      csvName: session.csvName,
      profile: session.profile,
      charts,
      insights,
      svgs,
      reportHtml,
      cost,
      durationMs,
      createdAt: session.createdAt,
    };

    await store.appendMessage({
      conversationId,
      role: "assistant",
      content: artifacts,
      metadata: {
        app: APP_NAME,
        kind: ARTIFACTS_KIND,
        version: ARTIFACTS_VERSION,
        taskId: session.id,
      },
    });

    console.log(`[persist] artifacts persisted for task=${session.id} (${charts.length} charts, ${Object.keys(svgs).length} svgs, reportHtml=${reportHtml.length} bytes)`);
  } catch (err) {
    console.warn(
      "[history] persistAnalysisArtifacts failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

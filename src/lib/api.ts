/**
 * Frontend → Backend HTTP / SSE wrapper.
 *
 * EdgeOne Makers routes (all POST):
 *   POST /upload                  → multipart CSV upload                (agents/)
 *   POST /analyze                 → body:{taskId, action:"get"|"start"|"cancel"|"delete"} (agents/)
 *   POST /analyze/stream          → body:{taskId} → SSE stream          (agents/)
 *   POST /analyze/rerun-insights  → body:{taskId}                       (agents/)
 *   POST /analyze/download        → body:{taskId, kind}                 (agents/)
 *   POST /static                  → body:{taskId, path}                 (agents/)
 *   POST /history                 → analysis history list               (cloud-functions/)
 *   POST /history-detail          → full analysis artifacts             (cloud-functions/)
 *
 * In dev mode, vite proxy forwards these routes to localhost:8088.
 */
import type { AgentEvent } from "./events";
import type { UploadResponse, CsvProfile, ChartMeta, Insight } from "../types";

// ─── History record type ────────────────────────────────────

export type AnalysisHistoryStatus =
  | "uploaded"
  | "running"
  | "done"
  | "error"
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
  cost?: { chart?: number; insight?: number; total: number };
  durationMs?: number;
  reports?: { charts: boolean; insight: boolean; merged: boolean; html: boolean };
  error?: string;
}

/** Returned from /history endpoint — `restorable` is computed locally (see isRestorable). */
export interface HistoryRecordWithRestore extends CsvAnalysisHistoryRecord {
  restorable: boolean;
}

/**
 * Whether a history record can be re-opened from the backend.
 *
 * `done` and `deleted` records are always restorable: their full
 * artifacts (SVG / insights / report) live in the conversation store
 * and are served by /history-detail.
 *
 * `uploaded` / `running` records depended on the in-memory Session map
 * inside the agents process. After /history moved to cloud-functions,
 * that map is no longer reachable from this route, so we treat those
 * states as non-restorable in the UI. The user can still reach a live
 * `running` session via /analyze action=get if they have the taskId.
 *
 * `error` / `cancelled` snapshots have no artifacts to restore.
 */
export function isRestorable(r: CsvAnalysisHistoryRecord): boolean {
  return r.status === "done" || r.status === "deleted";
}

// ─── Conversation header helper ─────────────────────────────

function conversationHeaders(conversationId?: string): Record<string, string> {
  return conversationId
    ? { "makers-conversation-id": conversationId }
    : {};
}

/**
 * EdgeOne Makers serializes requests sharing a `makers-conversation-id`
 * header — concurrent requests get HTTP 409. Most of the time the conflict
 * window is tiny (a slow `/history` overlapping a click) so a quick retry
 * is enough.
 *
 * `init` may be passed as a factory `() => RequestInit` so the body can be
 * rebuilt on each attempt. This matters for multipart uploads — a FormData
 * stream is consumed by the first fetch and must be reconstructed before
 * resending. JSON bodies are safe either way.
 *
 * Retries up to `attempts` times on 409 with exponential back-off.
 * AbortError propagates immediately.
 */
async function fetchWithConflictRetry(
  input: RequestInfo,
  init?: RequestInit | (() => RequestInit),
  attempts = 3,
): Promise<Response> {
  const buildInit = typeof init === "function" ? init : () => init ?? {};
  let lastRes: Response | null = null;
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(input, buildInit());
    if (res.status !== 409) return res;
    lastRes = res;
    // 80ms → 240ms → 720ms — short enough for snappy UX, long enough for
    // a slow /history call (typical 300–600ms) to finish on the server.
    const delay = 80 * Math.pow(3, i);
    await new Promise((r) => setTimeout(r, delay));
  }
  return lastRes!;
}

// ─── API functions ──────────────────────────────────────────

export async function uploadCsv(
  file: File,
  conversationId?: string,
): Promise<UploadResponse> {
  // Retries on 409 — when the user clicks a sample dataset right after page
  // load, /history may still be holding the EdgeOne per-conversation lock
  // server-side even though we've client-aborted it. Short backoff lets the
  // lock release before we resend.
  //
  // Use the factory form so each attempt rebuilds FormData — its body
  // stream is consumed by the first fetch and would fail on retry.
  const res = await fetchWithConflictRetry("/upload", () => {
    const form = new FormData();
    form.append("file", file);
    return {
      method: "POST",
      // multipart: don't set Content-Type, browser auto-adds boundary
      headers: conversationHeaders(conversationId),
      body: form,
    };
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(err?.error ?? `upload failed: ${res.status}`);
  }
  return (await res.json()) as UploadResponse;
}

export async function startAnalyze(
  taskId: string,
  opts: { chartsOnly?: boolean; model?: string; demoMode?: boolean } = {},
  conversationId?: string,
): Promise<void> {
  // Retries on 409 — startAnalyze fires immediately after upload, and on
  // first page load the /history request can still be in flight against
  // the same conversation lock.
  const res = await fetchWithConflictRetry("/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...conversationHeaders(conversationId),
    },
    body: JSON.stringify({ taskId, action: "start", ...opts }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(err?.error ?? `start failed: ${res.status}`);
  }
}

/**
 * Stop a running analysis through the EdgeOne platform-native abort path.
 *
 * Hits POST /analyze/stop, which calls `context.utils.abortActiveRun()` on
 * the runtime — that fires the AbortSignal of the long-lived /analyze/stream
 * connection, which forwards into analyze() / Claude Agent SDK.
 *
 * IMPORTANT: this request must NOT carry the `makers-conversation-id` header
 * of the run we're trying to cancel. The runtime would otherwise treat this
 * request as the active run for that conversation and overwrite the target's
 * AbortSignal with this request's signal — which means we'd abort ourselves
 * instead of the analysis. The conversation_id is passed only via the body.
 *
 * Falls back to the legacy /analyze action=cancel path if the platform
 * endpoint is missing or fails — keeps in-process AbortController flipping.
 */
export async function cancelAnalyze(
  taskId: string,
  conversationId?: string,
): Promise<void> {
  // Platform-native stop: no conversation header.
  try {
    await fetch("/analyze/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        ...(conversationId ? { conversation_id: conversationId } : {}),
      }),
    });
  } catch {
    /* fall through to legacy path */
  }

  // Belt-and-braces: also flip our in-process abort controller via the
  // legacy /analyze action=cancel route. Safe to call after the stop request
  // — handleCancel is idempotent and just records the cancelled state.
  try {
    await fetchWithConflictRetry("/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...conversationHeaders(conversationId),
      },
      body: JSON.stringify({ taskId, action: "cancel" }),
    });
  } catch {
    /* best effort */
  }
}

export async function rerunInsights(
  taskId: string,
  opts: { model?: string } = {},
  conversationId?: string,
): Promise<void> {
  const res = await fetch("/analyze/rerun-insights", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...conversationHeaders(conversationId),
    },
    body: JSON.stringify({ taskId, ...opts }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    throw new Error(err?.error ?? `rerun failed: ${res.status}`);
  }
}

export interface SessionSnapshot {
  taskId: string;
  status: "uploaded" | "running" | "done" | "error";
  csvName: string;
  size: number;
  createdAt: number;
  profile: UploadResponse["profile"];
  distributions: UploadResponse["distributions"];
  events: AgentEvent[];
}

export async function fetchSession(
  taskId: string,
  conversationId?: string,
): Promise<SessionSnapshot | null> {
  try {
    const res = await fetch("/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...conversationHeaders(conversationId),
      },
      body: JSON.stringify({ taskId, action: "get" }),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error ?? `fetch session failed: ${res.status}`);
    }
    return (await res.json()) as SessionSnapshot;
  } catch {
    return null;
  }
}

// ─── History API ────────────────────────────────────────────

/**
 * Fetch the current conversation's analysis history.
 *
 * Goes to cloud-functions, which is NOT subject to EdgeOne's
 * per-conversation lock (that lock is keyed by `makers-conversation-id`
 * and only applies to agent routes). So no 409-retry, no AbortController
 * dance — a plain fetch is enough.
 */
export async function fetchAnalysisHistory(
  conversationId: string,
): Promise<HistoryRecordWithRestore[]> {
  const t0 = performance.now();
  try {
    const res = await fetch("/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    if (!res.ok) {
      if (import.meta.env.DEV) {
        console.warn(`[history] ${res.status} (${(performance.now() - t0).toFixed(0)}ms)`);
      }
      return [];
    }
    const data = (await res.json().catch(() => null)) as {
      conversation_id?: string;
      records?: CsvAnalysisHistoryRecord[];
    } | null;
    const records = Array.isArray(data?.records) ? data!.records : [];
    if (import.meta.env.DEV) {
      console.log(`[history] ${records.length} records (${(performance.now() - t0).toFixed(0)}ms)`);
    }
    // /history lives in cloud-functions and no longer has access to
    // the agents-side in-memory Session map, so it can't compute
    // `restorable` server-side. Inject it locally based on status.
    return records.map((r) => ({ ...r, restorable: isRestorable(r) }));
  } catch (e) {
    console.warn("[history] failed:", e);
    return [];
  }
}

// ─── History Detail (full artifacts) ───────────────────────

/**
 * Analysis artifacts type (mirrors AnalysisArtifacts in agents/_lib/history.ts).
 * Shared between backend and frontend for type safety.
 */
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
 * Fetch full artifacts for a specific analysis (SVG, insights, report).
 *
 * Same as fetchAnalysisHistory: cloud-functions don't auto-parse the
 * `makers-conversation-id` header, so we put conversation_id in the body.
 */
export async function fetchHistoryDetail(
  taskId: string,
  conversationId: string,
): Promise<AnalysisArtifacts | null> {
  const t0 = performance.now();
  try {
    const res = await fetch("/history-detail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, conversation_id: conversationId }),
    });
    if (res.status === 404 || !res.ok) {
      if (import.meta.env.DEV) {
        console.warn(`[history-detail] ${res.status} (${(performance.now() - t0).toFixed(0)}ms)`);
      }
      return null;
    }
    return (await res.json()) as AnalysisArtifacts;
  } catch (e) {
    console.warn("[history-detail] failed:", e);
    return null;
  }
}

// ─── SSE Stream ─────────────────────────────────────────────

/**
 * Subscribe to SSE stream (uses fetch streaming instead of EventSource because EdgeOne doesn't support GET query params).
 * Returns unsubscribe function.
 *
 * Note: SSE long connection does not carry conversation header to avoid EdgeOne runtime returning 409 on concurrent requests.
 */
export function subscribeStream(
  taskId: string,
  onEvent: (evt: AgentEvent) => void,
  onError?: (err: Event | Error) => void,
): () => void {
  const abortController = new AbortController();

  (async () => {
    try {
      const res = await fetch("/analyze/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) {
        onError?.(new Error(`stream failed: ${res.status}`));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const seen = new Set<string>();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames from buffer
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? ""; // last incomplete frame stays in buffer

        for (const frame of frames) {
          if (!frame.trim() || frame.startsWith(":")) continue; // comment/keepalive

          const dataMatch = frame.match(/^data:\s*(.+)$/m);

          if (!dataMatch) continue;

          try {
            const data = JSON.parse(dataMatch[1]!) as AgentEvent;
            const key = eventKey(data);
            if (seen.has(key)) continue;
            seen.add(key);
            onEvent(data);
          } catch {
            // bad frame, skip
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        onError?.(e as Error);
      }
    }
  })();

  return () => abortController.abort();
}

function eventKey(evt: AgentEvent): string {
  switch (evt.type) {
    case "session":
      return `session:${evt.taskId}`;
    case "agent":
      return `agent:${evt.role}:${evt.state}`;
    case "tool":
      return `tool:${evt.id}:${evt.state}`;
    case "chart":
      return `chart:${evt.chart.id}`;
    case "insight":
      return `insight:${evt.insight.kind}:${evt.insight.chartId ?? "summary"}:${fnv1a(evt.insight.text)}`;
    case "cost":
      return `cost:${evt.total.toFixed(6)}:${evt.durationMs}`;
    case "done":
      return `done:${evt.taskId}`;
    case "error":
      return `error:${fnv1a(evt.message)}`;
  }
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Manually trigger file download (POST to get file content then create blob URL)
 */
export async function downloadReport(
  taskId: string,
  kind: "charts" | "insight" | "merged" | "html",
): Promise<void> {
  const res = await fetch("/analyze/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, kind }),
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `report.${kind === "html" ? "html" : "md"}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Fetch an SVG's text content.
 * svgUrl format: "{taskId}/{relPath}" (injected by backend dispatch)
 */
export async function fetchSvg(svgUrl: string): Promise<string> {
  const slashIdx = svgUrl.indexOf("/");
  if (slashIdx === -1) throw new Error(`invalid svgUrl: ${svgUrl}`);
  const taskId = svgUrl.slice(0, slashIdx);
  const filePath = svgUrl.slice(slashIdx + 1);

  const res = await fetch("/static", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, path: filePath }),
  });
  if (!res.ok) throw new Error(`svg fetch ${res.status}`);
  return await res.text();
}

async function safeJson(
  res: Response,
): Promise<{ error?: string } | undefined> {
  try {
    return (await res.json()) as { error?: string };
  } catch {
    return undefined;
  }
}

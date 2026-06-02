/**
 * History handler — EdgeOne Pages Node Function
 * ==============================================
 *
 * File path cloud-functions/history/index.ts maps to **POST /history**.
 *
 * Reads analysis records from `context.agent.store.getMessages()` for the
 * current conversation, deduplicates by taskId (latest updatedAt wins),
 * and returns the list to the frontend.
 *
 * The store-metadata constants below (APP_NAME / RECORD_KIND) and the
 * record shape must agree with the writer in `agents/_lib/history.ts` —
 * keep both sides aligned when fields change.
 *
 * Following the official EdgeOne Pages Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import { createLogger } from "../_logger";
import { jsonResponse, pickConversationId, readJsonBody } from "../_http";

const logger = createLogger("history");

// Must match `agents/_lib/history.ts`.
const APP_NAME = "csv-analyze";
const RECORD_KIND = "analysis_record";

type AnalysisHistoryStatus =
  | "uploaded"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "deleted";

interface CsvAnalysisHistoryRecord {
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

interface StoreMessage {
  messageId?: string;
  role?: string;
  content?: unknown;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export async function onRequestPost(context: any): Promise<Response> {
  const t0 = Date.now();
  const body = await readJsonBody(context);
  const conversationId = pickConversationId(body);
  const store = context.agent?.store ?? null;

  if (!store || !conversationId) {
    logger.log("done", { ms: Date.now() - t0, conversationId, store: !!store, records: 0 });
    return jsonResponse({ conversation_id: conversationId, records: [] });
  }

  let messages: StoreMessage[];
  try {
    messages = await store.getMessages({ conversationId, limit: 100, order: "asc" });
  } catch (err) {
    logger.error("getMessages failed:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ conversation_id: conversationId, records: [] });
  }

  // Deduplicate by taskId, keeping the entry with the highest updatedAt.
  const latest = new Map<string, CsvAnalysisHistoryRecord>();
  for (const item of messages) {
    const meta = item.metadata ?? {};
    if (meta.app !== APP_NAME) continue;
    if (meta.kind !== RECORD_KIND) continue;
    const record = item.content as CsvAnalysisHistoryRecord | null;
    if (!record?.taskId) continue;
    if (record.kind !== "csv_analysis") continue;
    const prev = latest.get(record.taskId);
    if (!prev || record.updatedAt >= prev.updatedAt) {
      latest.set(record.taskId, record);
    }
  }

  const records = [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  logger.log("done", { ms: Date.now() - t0, conversationId, records: records.length });
  return jsonResponse({ conversation_id: conversationId, records });
}

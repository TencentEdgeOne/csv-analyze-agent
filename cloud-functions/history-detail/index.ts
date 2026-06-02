/**
 * History detail handler — EdgeOne Pages Node Function
 * ====================================================
 *
 * File path cloud-functions/history-detail/index.ts maps to
 * **POST /history-detail**.
 *
 * Returns the full artifacts blob (SVG, insights, report HTML) for a
 * given taskId by reading from `context.agent.store`. The previous
 * "fall back to live session" path was removed when this route moved
 * out of `agents/`: the in-memory Session map lives in a different
 * process. Instead, the agent-side now backfills the store on the
 * next /analyze action=get if a "done" session lacks artifacts.
 *
 * The store-metadata constants below (APP_NAME / ARTIFACTS_KIND) and
 * the artifacts shape must agree with the writer in
 * `agents/_lib/history.ts` — keep both sides aligned when fields change.
 *
 * Following the official EdgeOne Pages Node Functions docs:
 *   - export `onRequestPost` for POST handlers
 *   - read JSON body via `await context.request.json()`
 *   - return a `Response` object
 *   https://pages.edgeone.ai/document/node-functions
 */

import { createLogger } from "../_logger";
import {
  errorResponse,
  jsonResponse,
  pickConversationId,
  readJsonBody,
} from "../_http";

const logger = createLogger("history-detail");

// Must match `agents/_lib/history.ts`.
const APP_NAME = "csv-analyze";
const ARTIFACTS_KIND = "analysis_artifacts";

interface AnalysisArtifacts {
  kind: "csv_analysis_artifacts";
  version: 1;
  taskId: string;
  csvName: string;
  profile: unknown;
  charts: unknown[];
  insights: unknown[];
  svgs: Record<string, string>;
  reportHtml: string;
  cost: { chart?: number; insight?: number; total: number };
  durationMs: number;
  createdAt: number;
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
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  if (!taskId) return errorResponse("taskId is required");

  const conversationId = pickConversationId(body);
  const store = context.agent?.store ?? null;

  if (!store || !conversationId) {
    logger.log("miss", { ms: Date.now() - t0, taskId, conversationId, store: !!store });
    return errorResponse("artifacts not found for this taskId", 404);
  }

  try {
    const messages: StoreMessage[] = await store.getMessages({
      conversationId,
      limit: 100,
      order: "desc",
    });

    for (const item of messages) {
      const meta = item.metadata ?? {};
      if (meta.app !== APP_NAME) continue;
      if (meta.kind !== ARTIFACTS_KIND) continue;
      if (meta.taskId !== taskId) continue;

      const artifacts = item.content as AnalysisArtifacts | null;
      if (!artifacts || artifacts.kind !== "csv_analysis_artifacts") continue;

      logger.log("hit", { ms: Date.now() - t0, taskId });
      return jsonResponse(artifacts);
    }
  } catch (err) {
    logger.error("store read failed:", err instanceof Error ? err.message : String(err));
  }

  logger.log("miss", { ms: Date.now() - t0, taskId, conversationId });
  return errorResponse("artifacts not found for this taskId", 404);
}

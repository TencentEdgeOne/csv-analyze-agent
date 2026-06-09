/**
 * /analyze/stop — Abort a running analysis through the EdgeOne runtime.
 *
 * EdgeOne Makers exposes `context.utils.abortActiveRun(conversationId)`, which
 * looks up the currently active streaming run for that conversation and fires
 * its `context.request.signal`. This is the platform-native cancellation path
 * (mirrors claude-agent-starter/agents/stop/index.ts).
 *
 * In csv-analyze, the long-lived run is `/analyze/stream` (the SSE handler).
 * When this stop endpoint runs, the runtime aborts that stream's signal —
 * `/analyze/stream` then forwards the abort to the session's analyze()
 * AbortController, which cancels the underlying Claude Agent SDK query.
 *
 * IMPORTANT (per EdgeOne docs and the starter's notes): the stop request
 * must NOT carry the same `makers-conversation-id` header as the run it is
 * trying to cancel — the runtime would overwrite that run's signal with this
 * request's signal. The frontend therefore sends the conversation_id only in
 * the JSON body.
 */

import { jsonResponse, errorResponse, getRequestBody } from "../_lib/handlers.js";
import { getSession } from "../_lib/session.js";

export async function onRequest(context: any) {
  const { request } = context;

  const parsed = getRequestBody(request);
  if ("error" in parsed) return parsed.error;
  const { body } = parsed;

  // Accept conversation_id from body (canonical, EdgeOne-native) and taskId
  // (fallback for direct testing).
  const conversationId =
    typeof body?.conversation_id === "string" && body.conversation_id.trim()
      ? (body.conversation_id as string).trim()
      : undefined;
  const taskId = typeof body?.taskId === "string" ? body.taskId : undefined;

  if (!conversationId && !taskId) {
    return errorResponse("conversation_id or taskId is required", 400);
  }

  // Best-effort: also flip the in-process AbortController so analyze() reacts
  // immediately even if the runtime has not yet propagated the abort.
  if (taskId) {
    const s = getSession(taskId);
    if (s && s.status === "running") {
      try {
        s.abort?.abort();
      } catch {
        /* ignore */
      }
    }
  }

  // Ask the EdgeOne runtime to abort the active streaming run for this
  // conversation. This is what actually tears down the long-lived
  // /analyze/stream connection and (via its abort listener) propagates into
  // analyze() / Claude SDK.
  let abortResult: unknown = null;
  if (conversationId && typeof context?.utils?.abortActiveRun === "function") {
    try {
      abortResult = context.utils.abortActiveRun(conversationId);
    } catch (e) {
      console.warn("[analyze/stop] abortActiveRun threw:", e);
    }
  }

  console.log(
    `[analyze/stop] conversationId=${conversationId ?? "(none)"} taskId=${
      taskId ?? "(none)"
    } abortResult=${JSON.stringify(abortResult)}`,
  );

  return jsonResponse({
    status:
      (abortResult as { aborted?: boolean })?.aborted === false
        ? "idle"
        : "aborting",
    conversationId,
    taskId,
    ...(abortResult && typeof abortResult === "object" ? abortResult : {}),
  });
}

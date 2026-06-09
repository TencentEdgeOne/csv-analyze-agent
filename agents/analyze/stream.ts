/**
 * POST /analyze/stream — SSE stream
 *
 * EdgeOne runtime does not pass query params, so the frontend initiates SSE via POST + body {taskId}.
 *
 * Cancellation: this is the active long-lived run from EdgeOne's view. When
 * /analyze/stop calls context.utils.abortActiveRun(conversationId), the
 * runtime fires `context.request.signal` here. We forward that to the
 * session's AbortController so analyze() / Claude Agent SDK shut down
 * immediately. (Mirrors the pattern in claude-agent-starter/agents/chat.)
 */
import { formatSse } from "../_lib/session.js";
import { getAndTouchSession, getRequestBody } from "../_lib/handlers.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 100;

export async function onRequest(context: any) {
  const { request } = context;
  const runSignal: AbortSignal | undefined = request?.signal;

  const parsed = getRequestBody(request);
  if ("error" in parsed) return parsed.error;
  const taskId = parsed.body?.taskId as string | undefined;

  const sessionOrError = getAndTouchSession(taskId ?? null);
  if (sessionOrError instanceof Response) return sessionOrError;
  const s = sessionOrError;

  // Forward the EdgeOne runtime abort into the session's analyze() controller.
  // The runtime fires `runSignal` when /analyze/stop calls abortActiveRun().
  // This is the platform-native cancellation path — we don't need the
  // separate /analyze action=cancel anymore, but it's kept for compatibility.
  const onRunAbort = () => {
    try {
      if (s.status === "running") {
        s.abort?.abort();
      }
    } catch {
      /* noop */
    }
  };
  if (runSignal) {
    if (runSignal.aborted) {
      onRunAbort();
    } else {
      runSignal.addEventListener("abort", onRunAbort, { once: true });
    }
  }

  const encoder = new TextEncoder();
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let checkDoneTimer: ReturnType<typeof setInterval> | null = null;

  function cleanup() {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (checkDoneTimer) clearInterval(checkDoneTimer);
    heartbeatTimer = pollTimer = checkDoneTimer = null;
    if (runSignal) {
      runSignal.removeEventListener("abort", onRunAbort);
    }
  }

  const stream = new ReadableStream({
    start(controller) {
      for (const evt of s.events) {
        controller.enqueue(encoder.encode(formatSse(evt)));
      }

      let lastIdx = s.events.length;

      pollTimer = setInterval(() => {
        if (closed) return;
        while (lastIdx < s.events.length) {
          controller.enqueue(encoder.encode(formatSse(s.events[lastIdx]!)));
          lastIdx++;
        }
      }, POLL_INTERVAL_MS);

      heartbeatTimer = setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        }
      }, HEARTBEAT_INTERVAL_MS);

      checkDoneTimer = setInterval(() => {
        if ((s.status === "done" || s.status === "error") && lastIdx >= s.events.length) {
          cleanup();
          setTimeout(() => controller.close(), 300);
        }
      }, 500);

      // If the runtime aborts this run while we're still streaming, drain
      // any remaining buffered events and close the stream cleanly.
      if (runSignal && !runSignal.aborted) {
        runSignal.addEventListener(
          "abort",
          () => {
            // Flush any tail events so the client sees the final
            // error/cancel before the connection drops.
            try {
              while (lastIdx < s.events.length) {
                controller.enqueue(encoder.encode(formatSse(s.events[lastIdx]!)));
                lastIdx++;
              }
            } catch {
              /* ignore */
            }
            cleanup();
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          },
          { once: true },
        );
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

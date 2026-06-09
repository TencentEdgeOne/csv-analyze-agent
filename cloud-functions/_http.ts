/**
 * Shared HTTP helpers for cloud-functions handlers.
 *
 * Cloud-functions sit on a different runtime entry point than agents/, so
 * they can't reuse `agents/_lib/handlers.ts`. These helpers are the
 * minimal wrappers all our cloud-fn routes need: JSON I/O and the
 * conversation-id source rule.
 */

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
} as const;

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

export async function readJsonBody(context: any): Promise<Record<string, unknown>> {
  try {
    const data = await context.request.json();
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the conversationId the agent-side writer used as the store key.
 *
 * Only the JSON body is considered. `context.conversation_id` is null in
 * cloud-functions; `context.agent.conversation_id` is an EdgeOne
 * platform-internal id with no relationship to the frontend's
 * localStorage UUID — using either as a fallback would look up an empty
 * stranger conversation. The frontend (src/lib/api.ts) sends
 * `conversation_id` in the body for exactly this reason.
 */
export function pickConversationId(body: Record<string, unknown>): string {
  const value = body.conversation_id;
  return typeof value === "string" ? value : "";
}

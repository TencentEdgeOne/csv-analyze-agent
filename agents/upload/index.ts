/**
 * POST /upload — File upload handler
 *
 * EdgeOne Makers provides context.request.body as a raw Buffer for multipart requests;
 * we adapt it into a stream and feed busboy via parseMultipart.
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  getWorkRoot,
  ensureWorkspace,
  generateTaskId,
  setSession,
  sanitizeProfile,
  type Session,
} from "../_lib/session.js";
import { jsonResponse, errorResponse } from "../_lib/handlers.js";
import { loadCsv, computeProfile } from "../_lib/tools/shared/csv-stats.js";
import { computeColumnDistributions } from "../_lib/column-distribution.js";
import { parseMultipart } from "../_lib/multipart.js";
import { appendAnalysisHistory } from "../_lib/history.js";

/**
 * Hard cap on the entire multipart request body. Anything larger is rejected
 * with HTTP 413 before we touch busboy or write to disk. This bounds memory
 * use under abuse — without it, a 5 GB upload would be buffered in full
 * before any size check.
 *
 * Kept aligned with `parseMultipart`'s default per-file cap so neither layer
 * is the silent bottleneck.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export async function onRequest(context: any) {
  const { request } = context;
  const contentType = request.headers?.["content-type"] ?? "";

  if (!contentType.includes("multipart/form-data")) {
    return errorResponse("Content-Type must be multipart/form-data");
  }

  const body = request.body;
  if (!body || !Buffer.isBuffer(body)) {
    return errorResponse("no file body received");
  }

  if (body.length > MAX_UPLOAD_BYTES) {
    return errorResponse(
      `upload exceeds ${MAX_UPLOAD_BYTES} bytes (${body.length} bytes received)`,
      413,
    );
  }

  let parsed;
  try {
    parsed = await parseMultipart(body, contentType, {
      maxFileBytes: MAX_UPLOAD_BYTES,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Per-file size hits surface as the busboy "limit" path inside parseMultipart;
    // map them to 413 so the client can distinguish from a malformed body.
    const status = /exceeds \d+ bytes|too many/.test(msg) ? 413 : 400;
    return errorResponse(`multipart parse error: ${msg}`, status);
  }

  const file = parsed.files.find((f) => f.fieldName === "file");
  if (!file) {
    return errorResponse("no file");
  }

  if (!file.fileName.toLowerCase().endsWith(".csv")) {
    return errorResponse("Only .csv files are supported");
  }

  try {
    await ensureWorkspace();
    const taskId = generateTaskId();
    const WORK_ROOT = getWorkRoot();
    const safeName = file.fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const csvPath = path.join(WORK_ROOT, `${taskId}__${safeName}`);
    const outDir = path.join(WORK_ROOT, taskId);
    await mkdir(path.join(outDir, "charts"), { recursive: true });

    await writeFile(csvPath, file.data);

    const { rows, totalRows, sampledRows } = await loadCsv(csvPath);
    const profile = computeProfile(rows, csvPath, totalRows, sampledRows);
    const distributions = computeColumnDistributions(rows, profile);

    const session: Session = {
      id: taskId,
      csvPath,
      csvName: file.fileName,
      csvSize: file.data.length,
      outDir,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      status: "uploaded",
      profile,
      rows,
      distributions,
      events: [],
    };
    setSession(taskId, session);
    await appendAnalysisHistory(context, session, { status: "uploaded" });

    return jsonResponse({
      taskId,
      csvName: file.fileName,
      size: file.data.length,
      profile: sanitizeProfile(profile),
      distributions,
    });
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : String(err),
    );
  }
}

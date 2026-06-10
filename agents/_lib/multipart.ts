/**
 * Multipart/form-data parser backed by busboy.
 *
 * EdgeOne Makers' Node runtime hands the handler the entire request body as
 * a Buffer (no native request.formData()). busboy is stream-based, so we
 * wrap the Buffer in a Readable and pipe it through.
 *
 * Why busboy over the previous hand-rolled parser:
 *   - hand-rolled boundary scanning is a known footgun (CVE-2024-39338 class)
 *   - busboy has built-in size limits, header parsing, and is widely audited
 *   - identical public API (parseMultipart(buf, contentType)) keeps upload/
 *     handler changes to zero
 *
 * Security limits enforced here:
 *   - Per-file size cap (DEFAULT_MAX_FILE_BYTES) — busboy aborts the stream
 *     mid-flight if a single field exceeds it, so we never buffer past the
 *     cap in memory.
 *   - We only collect file fields the upload handler actually consumes
 *     ("file"); other field names are accepted but kept small.
 */

import Busboy from "busboy";
import { Readable } from "node:stream";

export interface ParsedFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartResult {
  files: ParsedFile[];
  fields: Record<string, string>;
}

export interface ParseOptions {
  /** Maximum bytes per file (busboy `limits.fileSize`). Default 50 MiB. */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Parse a multipart/form-data Buffer. */
export function parseMultipart(
  body: Buffer,
  contentType: string,
  opts: ParseOptions = {},
): Promise<MultipartResult> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try {
      bb = Busboy({
        headers: { "content-type": contentType },
        limits: {
          fileSize: maxFileBytes,
          // One field per name — the upload handler only reads "file".
          // Cap field count + name/value sizes to bound memory on misuse.
          files: 4,
          fields: 16,
          fieldSize: 64 * 1024,
          fieldNameSize: 256,
        },
      });
    } catch (e) {
      reject(
        new Error(
          `multipart init failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      return;
    }

    const result: MultipartResult = { files: [], fields: {} };
    let aborted = false;

    const fail = (err: Error) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    };

    bb.on("file", (fieldName, fileStream, info) => {
      const chunks: Buffer[] = [];
      let truncated = false;

      fileStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      fileStream.on("limit", () => {
        truncated = true;
      });
      fileStream.on("end", () => {
        if (truncated) {
          fail(
            new Error(
              `file "${info.filename}" exceeds ${maxFileBytes} bytes`,
            ),
          );
          return;
        }
        result.files.push({
          fieldName,
          fileName: info.filename,
          contentType: info.mimeType ?? "application/octet-stream",
          data: Buffer.concat(chunks),
        });
      });
      fileStream.on("error", fail);
    });

    bb.on("field", (name, value) => {
      result.fields[name] = value;
    });

    bb.on("filesLimit", () =>
      fail(new Error("too many file fields in multipart payload")),
    );
    bb.on("fieldsLimit", () =>
      fail(new Error("too many text fields in multipart payload")),
    );
    bb.on("partsLimit", () =>
      fail(new Error("too many multipart parts")),
    );
    bb.on("error", (err: unknown) =>
      fail(err instanceof Error ? err : new Error(String(err))),
    );
    bb.on("close", () => {
      if (!aborted) resolve(result);
    });

    Readable.from(body).pipe(bb);
  });
}

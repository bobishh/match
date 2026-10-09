import type { WorkerEnv } from "./index";
type JsonObject = Record<string, unknown>;
const maxJsonBytes = 24 * 1024;
export async function readJson(request: Request, maximumBytes = maxJsonBytes): Promise<JsonObject> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new TypeError("Content-Type must be application/json");
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new TypeError("Request body is too large");
  if (!request.body) throw new TypeError("Request body is missing");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("Request body is too large");
        throw new TypeError("Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Request body must be an object");
  return value as JsonObject;
}

export function corsHeaders(request: Request, env: WorkerEnv): Headers {
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  const origin = request.headers.get("origin");
  if (!origin) return headers;
  const allowed = (env.CORS_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowed.includes(origin)) throw new TypeError("Origin is not allowed");
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key");
  headers.set("vary", "Origin");
  return headers;
}

export function json(value: unknown, status = 200, headers = new Headers()): Response {
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers });
}

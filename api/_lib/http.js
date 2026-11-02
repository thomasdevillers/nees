export class AdminError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const NO_STORE = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };

export function adminJson(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function adminFailure(error) {
  if (error instanceof AdminError) return adminJson({ error: error.message }, error.status);
  console.error("Admin operation failed", error instanceof Error ? error.name : "Unknown error");
  return adminJson({ error: "Could not complete this request. Please try again." }, 503);
}

export function requireSameOrigin(request) {
  const url = new URL(request.url);
  const expected = `${url.protocol}//${request.headers.get("host") || url.host}`;
  if (request.headers.get("origin") !== expected) throw new AdminError("Request origin is not allowed.", 403);
}

export async function readAdminBody(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AdminError("Expected JSON.", 415);
  const text = await request.text();
  if (text.length > 16_384) throw new AdminError("Request is too large.", 413);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AdminError("Invalid request."); }
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

// Wraps a handler so every admin endpoint shares the same error handling.
export const handle = fn => async request => { try { return await fn(request); } catch (error) { return adminFailure(error); } };

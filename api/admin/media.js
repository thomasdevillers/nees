import { requireAdmin } from "../_lib/auth.js";
import { deleteMedia, downloadUrl, finishUpload, listMedia, startUpload } from "../_lib/media.js";
import { adminJson, handle, readAdminBody, requireSameOrigin } from "../_lib/http.js";

async function mutation(request) {
  requireSameOrigin(request);
  await requireAdmin(request);
}

// ?id=…[&inline=1] → a short-lived download link; ?clientId=… → that client's files; no query → every file.
export const GET = handle(async request => {
  await requireAdmin(request);
  const params = new URL(request.url).searchParams;
  if (params.has("id")) return adminJson({ url: await downloadUrl(params.get("id"), params.get("inline") === "1") });
  return adminJson({ media: await listMedia(params.get("clientId") || undefined) });
});

// Starts an upload: records the file and returns a signed link the browser PUTs it to.
export const POST = handle(async request => {
  await mutation(request);
  return adminJson(await startUpload(await readAdminBody(request)), 201);
});

// Confirms an upload finished.
export const PATCH = handle(async request => {
  await mutation(request);
  return adminJson({ media: await finishUpload((await readAdminBody(request)).id) });
});

export const DELETE = handle(async request => {
  await mutation(request);
  await deleteMedia(new URL(request.url).searchParams.get("id"));
  return adminJson({ deleted: true });
});

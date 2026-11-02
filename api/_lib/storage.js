import { randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { AdminError } from "./http.js";

/*
 * File storage for client photos and videos. Browsers upload and download directly
 * with short-lived signed URLs, so large files never pass through the Vercel functions.
 *
 *   uploadUrl(key, contentType, seconds) → { url, headers } for a PUT of the file body
 *   downloadUrl(key, fileName, { inline, seconds }) → signed GET URL
 *   head(key) → { size } or null
 *   remove(key)
 */

function disposition(fileName, inline) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** Accepts R2_BUCKET as a plain name or as the bucket's S3 API URL shown in the Cloudflare dashboard. */
export function r2Settings(env = process.env) {
  let account = env.R2_ACCOUNT_ID?.trim(), bucket = env.R2_BUCKET?.trim();
  // EU-jurisdiction buckets live under <account>.eu.r2.cloudflarestorage.com.
  const url = bucket?.match(/^https:\/\/([a-f0-9]+)\.((?:[a-z]+\.)?)r2\.cloudflarestorage\.com\/([^/]+)\/?$/);
  let jurisdiction = "";
  if (url) { account ||= url[1]; jurisdiction = url[2]; bucket = url[3]; }
  return {
    account, bucket, host: account && `${account}.${jurisdiction}r2.cloudflarestorage.com`,
    accessKeyId: env.R2_ACCESS_KEY_ID?.trim(), secretAccessKey: env.R2_SECRET_ACCESS_KEY?.trim(),
  };
}

export function r2Storage() {
  const { host, accessKeyId, secretAccessKey, bucket } = r2Settings();
  if (!host || !accessKeyId || !secretAccessKey || !bucket) throw new AdminError("File storage has not been configured yet. Add the R2 settings in Vercel.", 503);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new AdminError("R2_BUCKET should be the bucket name, e.g. onscene-media.", 503);
  const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const objectUrl = key => new URL(`https://${host}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const presign = async (url, method, headers, seconds) => {
    url.searchParams.set("X-Amz-Expires", String(seconds));
    // allHeaders: also sign Content-Type, which aws4fetch skips by default.
    return (await aws.sign(new Request(url, { method, headers }), { aws: { signQuery: true, allHeaders: true } })).url;
  };
  const call = async (key, method) => {
    const response = await aws.fetch(objectUrl(key), { method, signal: AbortSignal.timeout(10_000) });
    if (!response.ok && response.status !== 404) throw new Error(`R2 ${method} failed with ${response.status}`);
    return response;
  };
  return {
    async uploadUrl(key, contentType, seconds) {
      // Content-Type is signed, so the browser must send exactly this header with the PUT.
      const headers = { "Content-Type": contentType };
      return { url: await presign(objectUrl(key), "PUT", headers, seconds), headers };
    },
    async downloadUrl(key, fileName, { inline = false, seconds = 900 } = {}) {
      const url = objectUrl(key);
      url.searchParams.set("response-content-disposition", disposition(fileName, inline));
      return presign(url, "GET", {}, seconds);
    },
    async head(key) {
      const response = await call(key, "HEAD");
      return response.status === 404 ? null : { size: Number(response.headers.get("content-length")) };
    },
    async remove(key) { await call(key, "DELETE"); },
  };
}

/** In-process stand-in for R2, served by scripts/dev.mjs under /api/dev-storage. */
export function memoryStorage() {
  const objects = new Map(), tokens = new Map();
  const link = (key, method, extra = {}) => {
    const token = randomBytes(16).toString("hex");
    tokens.set(token, { key, method, ...extra });
    return `/api/dev-storage?token=${token}`;
  };
  return {
    objects,
    async uploadUrl(key, contentType) { return { url: link(key, "PUT", { contentType }), headers: { "Content-Type": contentType } }; },
    async downloadUrl(key, fileName, { inline = false } = {}) { return link(key, "GET", { fileName, inline }); },
    async head(key) { return objects.has(key) ? { size: objects.get(key).body.length } : null; },
    async remove(key) { objects.delete(key); },
    put(key, body, contentType) { objects.set(key, { body, contentType }); },
    /** Handles a request to a link made above. */
    serve(token, method, body) {
      const grant = tokens.get(token);
      if (!grant || grant.method !== method) return { status: 403 };
      if (method === "PUT") { objects.set(grant.key, { body, contentType: grant.contentType }); return { status: 200 }; }
      const object = objects.get(grant.key);
      if (!object) return { status: 404 };
      return { status: 200, body: object.body, headers: { "Content-Type": object.contentType, "Content-Disposition": disposition(grant.fileName, grant.inline) } };
    },
  };
}

let override = null;
let shared = null;
export function useStorage(storage) { override = storage; }
export function fileStorage() {
  if (override) return override;
  if (!shared) shared = r2Storage();
  return shared;
}

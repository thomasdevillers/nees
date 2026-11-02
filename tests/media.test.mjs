import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, useDb } from "../api/_lib/db.js";
import { memoryStorage, r2Storage, useStorage } from "../api/_lib/storage.js";
import { safeName } from "../api/_lib/media.js";
import * as session from "../api/admin/session.js";
import * as clients from "../api/admin/clients.js";
import * as media from "../api/admin/media.js";

const ORIGIN = "https://onscene.example";
let cookie = "", storage, client;
const call = async (handler, method, path, body, origin = ORIGIN) => {
  const response = await handler(new Request(`${ORIGIN}/api/admin/${path}`, {
    method, headers: { origin, host: "onscene.example", "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, body: await response.json() };
};
const start = fields => call(media.POST, "POST", "media", { clientId: client.id, fileName: "Promo reel.mp4", contentType: "video/mp4", size: 5, ...fields });
// Simulates the browser's PUT to the signed link.
const upload = (started, body = Buffer.from("hello")) => storage.serve(new URL(started.upload.url, ORIGIN).searchParams.get("token"), "PUT", body);

beforeEach(async () => {
  process.env.ADMIN_PASSWORD = "a-long-test-password";
  delete process.env.VERCEL;
  useDb(memoryDb()); storage = memoryStorage(); useStorage(storage); cookie = "";
  const signIn = await session.POST(new Request(`${ORIGIN}/api/admin/session`, { method: "POST", headers: { origin: ORIGIN, host: "onscene.example", "content-type": "application/json" }, body: JSON.stringify({ password: "a-long-test-password" }) }));
  cookie = signIn.headers.get("set-cookie").split(";")[0];
  client = (await call(clients.POST, "POST", "clients", { name: "Innovation City" })).body.client;
});

describe("client media", () => {
  it("uploads, confirms, lists with previews, downloads and deletes a file", async () => {
    const started = await start({});
    assert.equal(started.status, 201);
    assert.equal(started.body.media.status, "pending");
    assert.deepEqual(started.body.upload.headers, { "Content-Type": "video/mp4" });
    assert.match(started.body.media.objectKey, new RegExp(`^clients/${client.id}/[0-9a-f-]{36}/Promo-reel\.mp4$`));
    assert.equal(upload(started.body).status, 200);
    const done = await call(media.PATCH, "PATCH", "media", { id: started.body.media.id });
    assert.equal(done.body.media.status, "ready");
    const listed = await call(media.GET, "GET", `media?clientId=${client.id}`);
    assert.equal(listed.body.media.length, 1);
    assert.ok(listed.body.media[0].previewUrl);
    const link = await call(media.GET, "GET", `media?id=${started.body.media.id}`);
    const file = storage.serve(new URL(link.body.url, ORIGIN).searchParams.get("token"), "GET");
    assert.equal(file.body.toString(), "hello");
    assert.match(file.headers["Content-Disposition"], /^attachment; filename="Promo reel.mp4"/);
    assert.equal((await call(media.DELETE, "DELETE", `media?id=${started.body.media.id}`)).status, 200);
    assert.equal(storage.objects.size, 0);
    assert.equal((await call(media.GET, "GET", "media")).body.media.length, 0);
  });

  it("rejects files that are not photos or videos, empty, or over 5 GB", async () => {
    assert.equal((await start({ contentType: "application/pdf" })).status, 400);
    assert.equal((await start({ size: 0 })).status, 400);
    assert.equal((await start({ size: 5_000_000_001 })).status, 413);
    assert.equal((await start({ clientId: "00000000-0000-4000-8000-000000000000" })).status, 409);
    assert.equal((await start({ contentType: "image/jpeg", fileName: "poster.jpg" })).status, 201);
  });

  it("refuses to confirm missing or partial uploads, and removes partial ones", async () => {
    const started = (await start({})).body;
    assert.equal((await call(media.PATCH, "PATCH", "media", { id: started.media.id })).status, 409);
    assert.equal((await call(media.GET, "GET", `media?id=${started.media.id}`)).status, 409);
    upload(started, Buffer.from("hel"));
    const partial = await call(media.PATCH, "PATCH", "media", { id: started.media.id });
    assert.equal(partial.status, 409);
    assert.match(partial.body.error, /partly uploaded/);
    assert.equal((await call(media.GET, "GET", "media")).body.media.length, 0);
    assert.equal(storage.objects.size, 0);
  });

  it("will not delete a client who still has files", async () => {
    const started = (await start({})).body;
    upload(started);
    const result = await call(clients.DELETE, "DELETE", `clients?id=${client.id}`);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /1 photo or video/);
  });

  it("requires a session and same-origin requests", async () => {
    cookie = "";
    assert.equal((await call(media.GET, "GET", "media")).status, 401);
    assert.equal((await start({})).status, 401);
    assert.equal((await call(media.POST, "POST", "media", {}, "https://evil.example")).status, 403);
  });
});

describe("R2 links", () => {
  it("signs uploads with the content type and downloads as attachments", async () => {
    Object.assign(process.env, { R2_ACCOUNT_ID: "acct123", R2_ACCESS_KEY_ID: "AKIDEXAMPLE", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "onscene-media" });
    const r2 = r2Storage();
    const put = new URL((await r2.uploadUrl("clients/a/b/Promo reel.mp4", "video/mp4", 3600)).url);
    assert.equal(put.host, "acct123.r2.cloudflarestorage.com");
    assert.equal(put.pathname, "/onscene-media/clients/a/b/Promo%20reel.mp4");
    assert.equal(put.searchParams.get("X-Amz-Expires"), "3600");
    assert.match(put.searchParams.get("X-Amz-SignedHeaders"), /content-type/);
    assert.match(put.searchParams.get("X-Amz-Credential"), /^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    assert.match(put.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
    const get = new URL(await r2.downloadUrl("clients/a/b/x.mp4", "Café reel.mp4", { seconds: 900 }));
    assert.equal(get.searchParams.get("response-content-disposition"), `attachment; filename="Caf_ reel.mp4"; filename*=UTF-8''Caf%C3%A9%20reel.mp4`);
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[key];
    assert.throws(() => r2Storage(), /not been configured/);
  });

  it("makes storage-safe object names", () => {
    assert.equal(safeName("Promo reel (final).MP4"), "Promo-reel-final.MP4");
    assert.equal(safeName("Café.jpg"), "Cafe.jpg");
    assert.equal(safeName("???"), "file");
  });
});

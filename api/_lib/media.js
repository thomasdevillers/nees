import { randomUUID } from "node:crypto";
import { AdminError } from "./http.js";
import { adminDb, conflict } from "./db.js";
import { fileStorage } from "./storage.js";

// A single R2 PUT can carry just under 5 GiB; keep a round limit below that.
export const MAX_FILE_BYTES = 5_000_000_000;
const UPLOAD_SECONDS = 6 * 60 * 60;
const PREVIEW_SECONDS = 60 * 60;
const DOWNLOAD_SECONDS = 15 * 60;
const TYPE = /^(image|video)\/[a-z0-9.+-]+$/;
const isId = value => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

/** A storage-safe version of the file name for the object key. The original is kept for downloads. */
export function safeName(fileName) {
  const cleaned = fileName.normalize("NFKD").replace(/\p{M}/gu, "")
    .replace(/[^\w.-]+/g, "-").replace(/-+(?=\.)|(?<=\.)-+/g, "").replace(/-{2,}/g, "-").replace(/^[-.]+|-+$/g, "");
  return cleaned.slice(-120) || "file";
}

async function find(id) {
  if (!isId(id)) throw conflict.mediaNotFound();
  const item = await (await adminDb()).media.get(id);
  if (!item) throw conflict.mediaNotFound();
  return item;
}

/** Every file's details (no links), for counts. With a client id, that client's files with preview links. */
export async function listMedia(clientId) {
  const all = await (await adminDb()).media.list();
  if (!clientId) return all;
  const storage = fileStorage();
  return Promise.all(all.filter(item => item.clientId === clientId).map(async item => ({
    ...item, previewUrl: item.status === "ready" ? await storage.downloadUrl(item.objectKey, item.fileName, { inline: true, seconds: PREVIEW_SECONDS }) : null,
  })));
}

export async function startUpload(input) {
  if (!isId(input.clientId)) throw new AdminError("Choose a client.");
  const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  if (!fileName || fileName.length > 255) throw new AdminError("The file needs a name of 255 characters or fewer.");
  const contentType = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
  if (!TYPE.test(contentType)) throw new AdminError(`${fileName} is not a photo or video.`);
  if (!Number.isSafeInteger(input.size) || input.size <= 0) throw new AdminError(`${fileName} is empty.`);
  if (input.size > MAX_FILE_BYTES) throw new AdminError(`${fileName} is larger than 5 GB. Export a smaller version and try again.`, 413);
  const db = await adminDb();
  if (!(await db.clients.list()).some(client => client.id === input.clientId)) throw conflict.missingClient();
  const id = randomUUID();
  const objectKey = `clients/${input.clientId}/${id}/${safeName(fileName)}`;
  const storage = fileStorage();
  const upload = await storage.uploadUrl(objectKey, contentType, UPLOAD_SECONDS);
  const media = await db.media.create({ id, clientId: input.clientId, objectKey, fileName, contentType, size: input.size });
  return { media, upload };
}

/** Confirms the browser's upload reached storage intact. */
export async function finishUpload(id) {
  const item = await find(id);
  if (item.status === "ready") return item;
  const storage = fileStorage();
  const stored = await storage.head(item.objectKey);
  if (!stored) throw new AdminError(`${item.fileName} did not reach storage. Try uploading it again.`, 409);
  if (stored.size !== item.size) {
    await storage.remove(item.objectKey);
    await (await adminDb()).media.remove(id);
    throw new AdminError(`${item.fileName} was only partly uploaded. Try uploading it again.`, 409);
  }
  return (await adminDb()).media.markReady(id);
}

export async function downloadUrl(id, inline) {
  const item = await find(id);
  if (item.status !== "ready") throw new AdminError(`${item.fileName} has not finished uploading.`, 409);
  return fileStorage().downloadUrl(item.objectKey, item.fileName, { inline, seconds: DOWNLOAD_SECONDS });
}

export async function deleteMedia(id) {
  const item = await find(id);
  await fileStorage().remove(item.objectKey);
  await (await adminDb()).media.remove(id);
}

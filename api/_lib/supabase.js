import { createClient } from "@supabase/supabase-js";
import { conflict } from "./db.js";

const SCREEN_COLUMNS = "id, number, label, status, notes, created_at, updated_at";
const CLIENT_COLUMNS = "id, name, email, phone, address, created_at, updated_at";
const MEDIA_COLUMNS = "id, client_id, object_key, file_name, content_type, size_bytes, status, created_at, uploaded_at";
const RENTAL_COLUMNS = "id, client_id, address, notes, start_date, end_date, created_at, updated_at, rental_screens(screen_id)";

const toScreen = row => ({ id: row.id, number: row.number, label: row.label, status: row.status, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at });
const toClient = row => ({ id: row.id, name: row.name, email: row.email, phone: row.phone, address: row.address, createdAt: row.created_at, updatedAt: row.updated_at });
const toMedia = row => ({
  id: row.id, clientId: row.client_id, objectKey: row.object_key, fileName: row.file_name, contentType: row.content_type,
  size: Number(row.size_bytes), status: row.status, createdAt: row.created_at, uploadedAt: row.uploaded_at,
});
const toRental = row => ({
  id: row.id, clientId: row.client_id, address: row.address, notes: row.notes, start: row.start_date, end: row.end_date,
  screenIds: (row.rental_screens || []).map(link => link.screen_id), createdAt: row.created_at, updatedAt: row.updated_at,
});

// Postgres error codes raised by the constraints in supabase/migrations.
function check(error, mapping = {}) {
  if (!error) return;
  const mapped = mapping[error.code];
  if (mapped) throw mapped();
  console.error("Supabase request failed", error.code, error.message);
  throw new Error("Database request failed.");
}

export function supabaseDb() {
  // supabase-js adds /rest/v1, /storage/v1 etc. itself, so accept the dashboard's REST URL too.
  const url = process.env.SUPABASE_URL?.trim().replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) },
  });
  const one = async (query, mapping, notFound) => {
    const { data, error } = await query;
    check(error, mapping);
    if (!data && notFound) throw notFound();
    return data;
  };

  return {
    screens: {
      async list() { return (await one(client.from("screens").select(SCREEN_COLUMNS))).map(toScreen); },
      async insert(fields) {
        return toScreen(await one(client.from("screens").insert(fields).select(SCREEN_COLUMNS).single(), { 23505: () => conflict.number(fields.number) }));
      },
      async update(id, fields) {
        return toScreen(await one(client.from("screens").update(fields).eq("id", id).select(SCREEN_COLUMNS).maybeSingle(), { 23505: () => conflict.number(fields.number) }, conflict.screenNotFound));
      },
      async remove(id) {
        await one(client.from("screens").delete().eq("id", id).select("id").maybeSingle(), { 23001: conflict.inUse, 23503: conflict.inUse }, conflict.screenNotFound);
      },
    },
    clients: {
      async list() { return (await one(client.from("clients").select(CLIENT_COLUMNS))).map(toClient); },
      async insert(fields) { return toClient(await one(client.from("clients").insert(fields).select(CLIENT_COLUMNS).single())); },
      async update(id, fields) {
        return toClient(await one(client.from("clients").update(fields).eq("id", id).select(CLIENT_COLUMNS).maybeSingle(), {}, conflict.clientNotFound));
      },
      async remove(id) {
        await one(client.from("clients").delete().eq("id", id).select("id").maybeSingle(), { 23001: conflict.clientInUse, 23503: conflict.clientInUse }, conflict.clientNotFound);
      },
    },
    rentals: {
      async list() { return (await one(client.from("rentals").select(RENTAL_COLUMNS))).map(toRental); },
      async save(id, fields) {
        const saved = await one(client.rpc("save_rental", {
          p_id: id || null, p_client_id: fields.clientId, p_address: fields.address, p_notes: fields.notes,
          p_start: fields.start, p_end: fields.end, p_screen_ids: fields.screenIds,
        }), { "23P01": conflict.doubleBooked, 23503: conflict.missingScreen, P0002: conflict.rentalNotFound });
        return toRental({ ...saved, rental_screens: [...new Set(fields.screenIds)].map(screen_id => ({ screen_id })) });
      },
      async remove(id) {
        await one(client.from("rentals").delete().eq("id", id).select("id").maybeSingle(), {}, conflict.rentalNotFound);
      },
    },
    media: {
      async list() { return (await one(client.from("client_media").select(MEDIA_COLUMNS).order("created_at"))).map(toMedia); },
      async get(id) {
        const row = await one(client.from("client_media").select(MEDIA_COLUMNS).eq("id", id).maybeSingle());
        return row ? toMedia(row) : null;
      },
      async create(fields) {
        const row = { id: fields.id, client_id: fields.clientId, object_key: fields.objectKey, file_name: fields.fileName, content_type: fields.contentType, size_bytes: fields.size };
        return toMedia(await one(client.from("client_media").insert(row).select(MEDIA_COLUMNS).single(), { 23503: conflict.missingClient }));
      },
      async markReady(id) {
        return toMedia(await one(client.from("client_media").update({ status: "ready", uploaded_at: new Date().toISOString() }).eq("id", id).select(MEDIA_COLUMNS).maybeSingle(), {}, conflict.mediaNotFound));
      },
      async remove(id) {
        await one(client.from("client_media").delete().eq("id", id).select("id").maybeSingle(), {}, conflict.mediaNotFound);
      },
    },
    sessions: {
      async get(hash) {
        return await one(client.from("admin_sessions").select("credential").eq("token_hash", hash).gt("expires_at", new Date().toISOString()).maybeSingle());
      },
      async create(hash, credential, seconds) {
        const now = new Date();
        await one(client.from("admin_sessions").delete().lt("expires_at", now.toISOString()));
        await one(client.from("admin_sessions").insert({ token_hash: hash, credential, expires_at: new Date(now.getTime() + seconds * 1000).toISOString() }));
      },
      async remove(hash) { await one(client.from("admin_sessions").delete().eq("token_hash", hash)); },
    },
    async hit(key, seconds) { return await one(client.rpc("admin_login_hit", { p_key: key, p_window_seconds: seconds })); },
  };
}

import { createHash, randomUUID } from "node:crypto";
import { AdminError } from "./http.js";

export const digest = value => createHash("sha256").update(value).digest("hex");

/*
 * Storage is a small repository so the same admin code runs against Supabase in
 * production and an in-memory copy for local development and tests:
 *
 *   screens.list() / insert(fields) / update(id, fields) / remove(id)
 *   clients.list() / insert(fields) / update(id, fields) / remove(id)
 *   rentals.list() / save(id | null, fields) / remove(id)
 *   media.list() / get(id) / create(fields) / markReady(id) / remove(id)
 *   sessions.get(hash) / create(hash, credential, seconds) / remove(hash)
 *   hit(key, seconds) → attempts in the current window
 *
 * Records use camelCase: screens { id, number, label, status, notes, createdAt, updatedAt },
 * clients { id, name, email, phone, address, createdAt, updatedAt },
 * rentals { id, clientId, address, notes, start, end, screenIds, createdAt, updatedAt },
 * media { id, clientId, objectKey, fileName, contentType, size, status, createdAt, uploadedAt }.
 * Both stores enforce unique numbers, existing screens and clients, and no double-booking.
 * A rental saved with an empty address takes the client's default address.
 */

export const conflict = {
  number: number => new AdminError(`Screen #${number} already exists.`, 409),
  inUse: () => new AdminError("This screen is on a rental. Remove it from those rentals first, or mark it retired.", 409),
  clientInUse: () => new AdminError("This client has rentals or media. Delete those first.", 409),
  mediaNotFound: () => new AdminError("That file no longer exists.", 404),
  missingClient: () => new AdminError("That client no longer exists. Refresh and try again.", 409),
  clientNotFound: () => new AdminError("That client no longer exists.", 404),
  missingScreen: () => new AdminError("One of the chosen screens no longer exists. Refresh and try again.", 409),
  doubleBooked: () => new AdminError("One of the chosen screens is already rented on those days.", 409),
  screenNotFound: () => new AdminError("That screen no longer exists.", 404),
  rentalNotFound: () => new AdminError("That rental no longer exists.", 404),
};

export function memoryDb() {
  const screens = new Map(), clients = new Map(), rentals = new Map(), media = new Map(), sessions = new Map(), attempts = new Map();
  const copy = value => structuredClone(value);
  const stamp = () => new Date().toISOString();
  return {
    screens: {
      async list() { return [...screens.values()].map(copy); },
      async insert(fields) {
        if ([...screens.values()].some(screen => screen.number === fields.number)) throw conflict.number(fields.number);
        const now = stamp(), screen = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
        screens.set(screen.id, screen);
        return copy(screen);
      },
      async update(id, fields) {
        if (!screens.has(id)) throw conflict.screenNotFound();
        if ([...screens.values()].some(screen => screen.number === fields.number && screen.id !== id)) throw conflict.number(fields.number);
        const screen = { ...screens.get(id), ...fields, updatedAt: stamp() };
        screens.set(id, screen);
        return copy(screen);
      },
      async remove(id) {
        if (!screens.has(id)) throw conflict.screenNotFound();
        if ([...rentals.values()].some(rental => rental.screenIds.includes(id))) throw conflict.inUse();
        screens.delete(id);
      },
    },
    clients: {
      async list() { return [...clients.values()].map(copy); },
      async insert(fields) {
        const now = stamp(), client = { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
        clients.set(client.id, client);
        return copy(client);
      },
      async update(id, fields) {
        if (!clients.has(id)) throw conflict.clientNotFound();
        const client = { ...clients.get(id), ...fields, updatedAt: stamp() };
        clients.set(id, client);
        return copy(client);
      },
      async remove(id) {
        if (!clients.has(id)) throw conflict.clientNotFound();
        if ([...rentals.values(), ...media.values()].some(item => item.clientId === id)) throw conflict.clientInUse();
        clients.delete(id);
      },
    },
    rentals: {
      async list() { return [...rentals.values()].map(copy); },
      async save(id, fields) {
        if (id && !rentals.has(id)) throw conflict.rentalNotFound();
        if (!clients.has(fields.clientId)) throw conflict.missingClient();
        const screenIds = [...new Set(fields.screenIds)];
        if (screenIds.some(screenId => !screens.has(screenId))) throw conflict.missingScreen();
        const clash = [...rentals.values()].some(other => other.id !== id && other.start <= fields.end && fields.start <= other.end && other.screenIds.some(screenId => screenIds.includes(screenId)));
        if (clash) throw conflict.doubleBooked();
        const now = stamp(), existing = id ? rentals.get(id) : null;
        const address = fields.address || clients.get(fields.clientId).address;
        const rental = { ...fields, address, screenIds, id: id || randomUUID(), createdAt: existing?.createdAt || now, updatedAt: now };
        rentals.set(rental.id, rental);
        return copy(rental);
      },
      async remove(id) { if (!rentals.delete(id)) throw conflict.rentalNotFound(); },
    },
    media: {
      async list() { return [...media.values()].map(copy); },
      async get(id) { return media.has(id) ? copy(media.get(id)) : null; },
      async create(fields) {
        if (!clients.has(fields.clientId)) throw conflict.missingClient();
        const item = { id: fields.id || randomUUID(), ...fields, status: "pending", createdAt: stamp(), uploadedAt: null };
        media.set(item.id, item);
        return copy(item);
      },
      async markReady(id) {
        if (!media.has(id)) throw conflict.mediaNotFound();
        const item = { ...media.get(id), status: "ready", uploadedAt: stamp() };
        media.set(id, item);
        return copy(item);
      },
      async remove(id) { if (!media.delete(id)) throw conflict.mediaNotFound(); },
    },
    sessions: {
      async get(hash) {
        const session = sessions.get(hash);
        if (session && session.expires < Date.now()) sessions.delete(hash);
        return sessions.has(hash) ? { credential: session.credential } : null;
      },
      async create(hash, credential, seconds) { sessions.set(hash, { credential, expires: Date.now() + seconds * 1000 }); },
      async remove(hash) { sessions.delete(hash); },
    },
    async hit(key, seconds) {
      const entry = attempts.get(key);
      const next = entry && entry.ends > Date.now() ? { ...entry, count: entry.count + 1 } : { count: 1, ends: Date.now() + seconds * 1000 };
      attempts.set(key, next);
      return next.count;
    },
  };
}

let override = null;
let shared = null;
export function useDb(db) { override = db; }
export async function adminDb() {
  if (override) return override;
  if (!shared) shared = (await import("./supabase.js")).supabaseDb();
  return shared;
}

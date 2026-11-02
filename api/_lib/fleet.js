import { AdminError } from "./http.js";
import { adminDb, conflict } from "./db.js";

export const SCREEN_STATUSES = ["available", "maintenance", "retired"];
const MAX_RENTAL_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const text = (value, max, label) => {
  if (value == null) return "";
  if (typeof value !== "string") throw new AdminError(`${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AdminError(`${label} must be ${max} characters or fewer.`);
  return trimmed;
};

export function normalizeNumber(value) {
  const number = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(number)) throw new AdminError("Screen number must be 1–20 letters, digits or dashes.");
  return number;
}

export function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

const byNumber = (a, b) => a.number.localeCompare(b.number, "en", { numeric: true });
const byName = (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const byStart = (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id);

export async function listScreens() { return (await (await adminDb()).screens.list()).sort(byNumber); }
export async function listClients() { return (await (await adminDb()).clients.list()).sort(byName); }
export async function listRentals() { return (await (await adminDb()).rentals.list()).sort(byStart); }

function validateScreen(input) {
  const status = input.status ?? "available";
  if (!SCREEN_STATUSES.includes(status)) throw new AdminError("Choose a valid screen status.");
  return { number: normalizeNumber(input.number), label: text(input.label, 80, "Label"), status, notes: text(input.notes, 1000, "Notes") };
}

export async function saveScreen(input, id) {
  const fields = validateScreen(input);
  const db = await adminDb();
  return id ? db.screens.update(id, fields) : db.screens.insert(fields);
}

export async function deleteScreen(id) {
  const [screens, rentals] = await Promise.all([listScreens(), listRentals()]);
  const screen = screens.find(item => item.id === id);
  if (!screen) throw conflict.screenNotFound();
  const booked = rentals.filter(rental => rental.screenIds.includes(id)).length;
  if (booked) throw new AdminError(`Screen #${screen.number} is on ${booked} ${booked === 1 ? "rental" : "rentals"}. Remove it from those rentals first, or mark it retired.`, 409);
  await (await adminDb()).screens.remove(id);
}

function validateClient(input) {
  const name = text(input.name, 120, "Name");
  if (!name) throw new AdminError("Add the client's name.");
  const email = text(input.email, 254, "Email").toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AdminError("Enter a valid email address, or leave it empty.");
  const phone = text(input.phone, 30, "Cellphone");
  if (!/^[0-9+() -]*$/.test(phone)) throw new AdminError("A cellphone number may only use digits, spaces, +, - and brackets.");
  return { name, email, phone, address: text(input.address, 300, "Address") };
}

export async function saveClient(input, id) {
  const fields = validateClient(input);
  const db = await adminDb();
  return id ? db.clients.update(id, fields) : db.clients.insert(fields);
}

export async function deleteClient(id) {
  const [clients, rentals] = await Promise.all([listClients(), listRentals()]);
  const client = clients.find(item => item.id === id);
  if (!client) throw conflict.clientNotFound();
  const booked = rentals.filter(rental => rental.clientId === id).length;
  if (booked) throw new AdminError(`${client.name} has ${booked} ${booked === 1 ? "rental" : "rentals"}. Delete those rentals or move them to another client first.`, 409);
  await (await adminDb()).clients.remove(id);
}

const isId = value => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

function validateRental(input) {
  if (!isId(input.clientId)) throw new AdminError("Choose a client.");
  if (!isDate(input.start) || !isDate(input.end)) throw new AdminError("Choose valid start and end dates.");
  if (input.end < input.start) throw new AdminError("The end date must be on or after the start date.");
  const days = (Date.parse(input.end) - Date.parse(input.start)) / DAY_MS + 1;
  if (days > MAX_RENTAL_DAYS) throw new AdminError(`A rental can be at most ${MAX_RENTAL_DAYS} days.`);
  if (!Array.isArray(input.screenIds) || !input.screenIds.length) throw new AdminError("Choose at least one screen.");
  if (!input.screenIds.every(isId)) throw conflict.missingScreen();
  return { clientId: input.clientId, address: text(input.address, 300, "Address"), notes: text(input.notes, 1000, "Notes"), start: input.start, end: input.end, screenIds: [...new Set(input.screenIds)] };
}

/** Rentals that would double-book any screen in `rental`. */
export function findConflicts(rental, rentals, screens, clients = []) {
  const numbers = new Map(screens.map(screen => [screen.id, screen.number]));
  const names = new Map(clients.map(client => [client.id, client.name]));
  return rentals
    .filter(other => other.id !== rental.id && other.start <= rental.end && rental.start <= other.end)
    .flatMap(other => other.screenIds.filter(screenId => rental.screenIds.includes(screenId))
      .map(screenId => ({ screen: numbers.get(screenId), client: names.get(other.clientId) ?? "another client", start: other.start, end: other.end })));
}

export async function saveRental(input, id) {
  const fields = validateRental(input);
  const [screens, clients, rentals] = await Promise.all([listScreens(), listClients(), listRentals()]);
  if (id && !rentals.some(rental => rental.id === id)) throw conflict.rentalNotFound();
  if (!clients.some(client => client.id === fields.clientId)) throw conflict.missingClient();
  const known = new Set(screens.map(screen => screen.id));
  if (fields.screenIds.some(screenId => !known.has(screenId))) throw conflict.missingScreen();
  // Named clash message for the operator; the database constraint is the final guard.
  const conflicts = findConflicts({ ...fields, id }, rentals, screens, clients);
  if (conflicts.length) {
    const first = conflicts[0];
    const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more clash${conflicts.length > 2 ? "es" : ""})` : "";
    throw new AdminError(`Screen #${first.screen} is already rented to ${first.client} from ${first.start} to ${first.end}${more}.`, 409);
  }
  return (await adminDb()).rentals.save(id || null, fields);
}

export async function deleteRental(id) {
  await (await adminDb()).rentals.remove(id);
}

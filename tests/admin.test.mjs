import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { memoryDb, useDb } from "../api/_lib/db.js";
import * as session from "../api/admin/session.js";
import * as screens from "../api/admin/screens.js";
import * as rentals from "../api/admin/rentals.js";
import * as clients from "../api/admin/clients.js";

const ORIGIN = "https://onscene.example";
let cookie = "";
const call = async (handler, method, path, body, origin = ORIGIN) => {
  const response = await handler(new Request(`${ORIGIN}/api/admin/${path}`, {
    method, headers: { origin, host: "onscene.example", "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const signIn = async () => {
  const result = await call(session.POST, "POST", "session", { password: "a-long-test-password" });
  cookie = result.headers.get("set-cookie").split(";")[0];
  return result;
};
const addScreen = async number => (await call(screens.POST, "POST", "screens", { number })).body.screen;
const addClient = async (name, fields = {}) => (await call(clients.POST, "POST", "clients", { name, ...fields })).body.client;

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "a-long-test-password";
  delete process.env.VERCEL;
  useDb(memoryDb());
  cookie = "";
});

describe("admin access", () => {
  it("rejects reads and writes without a session", async () => {
    assert.equal((await call(screens.GET, "GET", "screens")).status, 401);
    assert.equal((await call(rentals.GET, "GET", "rentals")).status, 401);
    assert.equal((await call(screens.POST, "POST", "screens", { number: "1" })).status, 401);
  });
  it("rejects cross-origin mutations before authentication", async () => {
    await signIn();
    assert.equal((await call(screens.POST, "POST", "screens", { number: "1" }, "https://evil.example")).status, 403);
    assert.equal((await call(session.POST, "POST", "session", { password: "x" }, "https://evil.example")).status, 403);
  });
  it("issues an HttpOnly session cookie and ends it on sign out", async () => {
    assert.equal((await call(session.POST, "POST", "session", { password: "wrong" })).status, 401);
    const result = await signIn();
    assert.match(result.headers.get("set-cookie"), /^onscene_admin=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    assert.equal((await call(session.GET, "GET", "session")).body.authenticated, true);
    await call(session.DELETE, "DELETE", "session");
    assert.equal((await call(session.GET, "GET", "session")).body.authenticated, false);
  });
  it("invalidates sessions when the password changes", async () => {
    await signIn();
    process.env.ADMIN_PASSWORD = "a-different-password";
    assert.equal((await call(screens.GET, "GET", "screens")).status, 401);
  });
  it("rate limits sign-in attempts", async () => {
    for (let i = 0; i < 10; i++) await call(session.POST, "POST", "session", { password: "wrong" });
    assert.equal((await call(session.POST, "POST", "session", { password: "a-long-test-password" })).status, 429);
  });
});

describe("screens", () => {
  beforeEach(signIn);
  it("creates, lists in number order, updates and deletes screens", async () => {
    await addScreen("10"); await addScreen("2"); const a = await addScreen("os-1");
    assert.deepEqual((await call(screens.GET, "GET", "screens")).body.screens.map(s => s.number), ["2", "10", "OS-1"]);
    const updated = await call(screens.PATCH, "PATCH", "screens", { id: a.id, number: "OS-1", label: "Foyer", status: "maintenance" });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.screen.createdAt, a.createdAt);
    assert.equal((await call(screens.DELETE, "DELETE", `screens?id=${a.id}`)).status, 200);
    assert.equal((await call(screens.GET, "GET", "screens")).body.screens.length, 2);
  });
  it("keeps screen numbers unique and valid", async () => {
    const one = await addScreen("7");
    assert.equal((await call(screens.POST, "POST", "screens", { number: " 7 " })).status, 409);
    const two = await addScreen("8");
    assert.equal((await call(screens.PATCH, "PATCH", "screens", { id: two.id, number: "7" })).status, 409);
    assert.equal((await call(screens.PATCH, "PATCH", "screens", { id: one.id, number: "7", label: "Same number is fine" })).status, 200);
    for (const number of ["", "has space", "x".repeat(21), "-1"]) assert.equal((await call(screens.POST, "POST", "screens", { number })).status, 400);
    assert.equal((await call(screens.POST, "POST", "screens", { number: "9", status: "lost" })).status, 400);
  });
  it("will not delete a screen that is on a rental", async () => {
    const screen = await addScreen("3");
    const client = await addClient("Gym Co");
    await call(rentals.POST, "POST", "rentals", { clientId: client.id, start: "2026-11-10", end: "2026-11-12", screenIds: [screen.id] });
    const result = await call(screens.DELETE, "DELETE", `screens?id=${screen.id}`);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /on 1 rental/);
  });
});

describe("clients", () => {
  beforeEach(signIn);
  it("creates, lists by name, updates and deletes clients", async () => {
    await addClient("zeta Events"); const mall = await addClient(" Canal Walk ", { email: "Events@CanalWalk.co.za", phone: "+27 (21) 555-0101", address: "Century City" });
    assert.deepEqual(mall, { ...mall, name: "Canal Walk", email: "events@canalwalk.co.za", phone: "+27 (21) 555-0101", address: "Century City" });
    assert.deepEqual((await call(clients.GET, "GET", "clients")).body.clients.map(c => c.name), ["Canal Walk", "zeta Events"]);
    const updated = await call(clients.PATCH, "PATCH", "clients", { id: mall.id, name: "Canal Walk", address: "Level 1 atrium" });
    assert.equal(updated.body.client.address, "Level 1 atrium");
    assert.equal((await call(clients.DELETE, "DELETE", `clients?id=${mall.id}`)).status, 200);
    assert.equal((await call(clients.DELETE, "DELETE", `clients?id=${mall.id}`)).status, 404);
  });
  it("validates names, emails and cellphone numbers", async () => {
    assert.equal((await call(clients.POST, "POST", "clients", { name: " " })).status, 400);
    assert.equal((await call(clients.POST, "POST", "clients", { name: "A", email: "not-an-email" })).status, 400);
    assert.equal((await call(clients.POST, "POST", "clients", { name: "A", phone: "call me" })).status, 400);
    assert.equal((await call(clients.POST, "POST", "clients", { name: "A", email: "", phone: "" })).status, 201);
  });
  it("will not delete a client that has rentals", async () => {
    const client = await addClient("Club Galaxy"), screen = await addScreen("5");
    await call(rentals.POST, "POST", "rentals", { clientId: client.id, start: "2026-11-10", end: "2026-11-10", screenIds: [screen.id] });
    const result = await call(clients.DELETE, "DELETE", `clients?id=${client.id}`);
    assert.equal(result.status, 409);
    assert.match(result.body.error, /Club Galaxy has 1 rental/);
  });
});

describe("rentals", () => {
  let a, b, mall, wedding;
  beforeEach(async () => {
    await signIn(); a = await addScreen("1"); b = await addScreen("2");
    mall = await addClient("Mall", { address: "Canal Walk, Century City" }); wedding = await addClient("Wedding");
  });
  const book = (fields) => call(rentals.POST, "POST", "rentals", { clientId: mall.id, start: "2026-11-10", end: "2026-11-12", screenIds: [a.id], ...fields });

  it("books existing screens on a date range", async () => {
    const result = await book({ screenIds: [a.id, b.id, a.id] });
    assert.equal(result.status, 201);
    assert.deepEqual(result.body.rental.screenIds, [a.id, b.id]);
    assert.equal(result.body.rental.clientId, mall.id);
    assert.equal((await call(rentals.GET, "GET", "rentals")).body.rentals.length, 1);
  });
  it("uses the client's default address unless the booking overrides it", async () => {
    assert.equal((await book({})).body.rental.address, "Canal Walk, Century City");
    assert.equal((await book({ start: "2026-12-01", end: "2026-12-01", address: "Pop-up stand, V&A Waterfront" })).body.rental.address, "Pop-up stand, V&A Waterfront");
  });
  it("rejects unknown screens, bad dates and missing fields", async () => {
    assert.equal((await book({ screenIds: ["nope"] })).status, 409);
    assert.equal((await book({ screenIds: ["00000000-0000-4000-8000-000000000000"] })).status, 409);
    assert.equal((await book({ screenIds: [] })).status, 400);
    assert.equal((await book({ start: "2026-02-30" })).status, 400);
    assert.equal((await book({ start: "2026-11-13" })).status, 400);
    assert.equal((await book({ clientId: undefined })).status, 400);
    assert.equal((await book({ clientId: "00000000-0000-4000-8000-000000000000" })).status, 409);
    assert.equal((await book({ end: "2027-12-31" })).status, 400);
  });
  it("prevents double-booking a screen on overlapping days", async () => {
    await book({});
    const clash = await book({ clientId: wedding.id, start: "2026-11-12", end: "2026-11-14", screenIds: [b.id, a.id] });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /#1 is already rented to Mall/);
    assert.equal((await book({ clientId: wedding.id, start: "2026-11-13", end: "2026-11-14" })).status, 201);
    assert.equal((await book({ clientId: wedding.id, start: "2026-11-01", end: "2026-11-01", screenIds: [b.id] })).status, 201);
  });
  it("edits a rental without clashing with itself, then deletes it", async () => {
    const { rental } = (await book({})).body;
    const edited = await call(rentals.PATCH, "PATCH", "rentals", { ...rental, end: "2026-11-15", notes: "Extended" });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.rental.end, "2026-11-15");
    assert.equal((await call(rentals.DELETE, "DELETE", `rentals?id=${rental.id}`)).status, 200);
    assert.equal((await call(rentals.DELETE, "DELETE", `rentals?id=${rental.id}`)).status, 404);
  });
});

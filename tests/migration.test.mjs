// Applies the Supabase migration to an in-process Postgres (PGlite) and checks
// that the database itself enforces the fleet rules.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const dir = new URL("../supabase/migrations/", import.meta.url);
let db, client, legacy;
const rejects = async (sql, code, params) => {
  await assert.rejects(db.query(sql, params), error => error.code === code || assert.fail(`expected ${code}, got ${error.code}: ${error.message}`));
};
const screen = async number => (await db.query("insert into screens (number) values ($1) returning id", [number])).rows[0].id;
const save = async (id, start, end, screenIds, clientId = client, address = "") =>
  (await db.query("select * from save_rental($1, $2, $3, '', $4, $5, $6)", [id, clientId, address, start, end, screenIds])).rows[0];

before(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  // Roles Supabase provides out of the box.
  await db.exec("create role anon; create role authenticated; create role service_role;");
  const [first, ...rest] = (await readdir(dir)).filter(name => name.endsWith(".sql")).sort();
  await db.exec(await readFile(new URL(first, dir), "utf8"));
  // Rentals saved before clients existed, to check the clients migration carries them over.
  const screenId = (await db.query("insert into screens (number) values ('LEGACY') returning id")).rows[0].id;
  for (const [name, day] of [["Virgin Active", "2026-01-01"], ["Virgin Active", "2026-01-05"], ["Club Galaxy", "2026-01-09"]])
    await db.query("select save_rental(null, $1, 'Sea Point', '', $2, $2, $3)", [name, day, [screenId]]);
  for (const file of rest) await db.exec(await readFile(new URL(file, dir), "utf8"));
  client = (await db.query("insert into clients (name, address) values ('Client', 'Default address') returning id")).rows[0].id;
  legacy = screenId;
});

describe("clients migration", () => {
  it("turns existing client names into client records and keeps the venue as the address", async () => {
    const { rows } = await db.query(`select c.name, count(*)::int as rentals, min(r.address) as address from rentals r join clients c on c.id = r.client_id
      join rental_screens rs on rs.rental_id = r.id where rs.screen_id = $1 group by c.name order by c.name`, [legacy]);
    assert.deepEqual(rows, [{ name: "Club Galaxy", rentals: 1, address: "Sea Point" }, { name: "Virgin Active", rentals: 2, address: "Sea Point" }]);
    const columns = (await db.query("select column_name from information_schema.columns where table_name = 'rentals'")).rows.map(row => row.column_name);
    assert.ok(columns.includes("client_id") && columns.includes("address") && !columns.includes("client") && !columns.includes("venue"));
  });
});

describe("database rules", () => {
  it("keeps screen numbers unique and well-formed", async () => {
    await screen("1");
    await rejects("insert into screens (number) values ('1')", "23505");
    await rejects("insert into screens (number) values ('lower')", "23514");
    await rejects("insert into screens (number, status) values ('2', 'lost')", "23514");
  });

  it("saves rentals with their screens and refuses double-booking", async () => {
    const a = await screen("A1"), b = await screen("B1");
    const rental = await save(null, "2026-11-10", "2026-11-12", [a, b, a]);
    assert.equal((await db.query("select count(*)::int as n from rental_screens where rental_id = $1", [rental.id])).rows[0].n, 2);
    await rejects("select save_rental(null, $2, '', '', '2026-11-12', '2026-11-14', $1)", "23P01", [[b], client]);
    await save(null, "2026-11-13", "2026-11-14", [b]);
    // A failed save leaves nothing behind.
    assert.equal((await db.query("select count(*)::int as n from rentals where start_date = '2026-11-12'")).rows[0].n, 0);
  });

  it("moves an existing rental without clashing with itself", async () => {
    const c = await screen("C1");
    const rental = await save(null, "2026-12-01", "2026-12-03", [c]);
    await save(rental.id, "2026-12-02", "2026-12-05", [c]);
    const { rows } = await db.query("select during::text from rental_screens where rental_id = $1", [rental.id]);
    assert.equal(rows[0].during, "[2026-12-02,2026-12-06)");
    await rejects("select save_rental(gen_random_uuid(), $2, '', '', '2026-12-01', '2026-12-01', $1)", "P0002", [[c], client]);
  });

  it("keeps booking ranges in sync when dates are edited directly", async () => {
    const d = await screen("D1"), e = await screen("E1");
    const first = await save(null, "2027-01-01", "2027-01-02", [d]);
    await save(null, "2027-01-05", "2027-01-06", [d]);
    await rejects("update rentals set end_date = '2027-01-05' where id = $1", "23P01", [first.id]);
    await db.query("update rentals set end_date = '2027-01-04' where id = $1", [first.id]);
    await rejects("insert into rental_screens (rental_id, screen_id) values ($1, $2)", "23503", [first.id, "00000000-0000-4000-8000-000000000000"]);
    await db.query("insert into rental_screens (rental_id, screen_id) values ($1, $2)", [first.id, e]);
    assert.equal((await db.query("select during::text from rental_screens where screen_id = $1", [e])).rows[0].during, "[2027-01-01,2027-01-05)");
  });

  it("will not delete a screen that is on a rental, and cascades rental deletes", async () => {
    const f = await screen("F1");
    const rental = await save(null, "2027-02-01", "2027-02-01", [f]);
    await rejects("delete from screens where id = $1", "23001", [f]);
    await db.query("delete from rentals where id = $1", [rental.id]);
    await db.query("delete from screens where id = $1", [f]);
  });

  it("validates rental fields", async () => {
    const g = await screen("G1");
    await rejects("select save_rental(null, $2, '', '', '2027-03-02', '2027-03-01', $1)", "23514", [[g], client]);
    await rejects("select save_rental(null, $2, '', '', '2027-01-01', '2028-01-02', $1)", "23514", [[g], client]);
    await rejects("select save_rental(null, gen_random_uuid(), '', '', '2027-03-01', '2027-03-01', $1)", "23503", [[g]]);
  });

  it("fills an empty booking address from the client's default", async () => {
    const h1 = await screen("H1");
    assert.equal((await save(null, "2027-04-01", "2027-04-01", [h1])).address, "Default address");
    assert.equal((await save(null, "2027-04-02", "2027-04-02", [h1], client, "Somewhere else")).address, "Somewhere else");
  });

  it("validates client details and will not delete a client with rentals", async () => {
    await rejects("insert into clients (name) values ('')", "23514");
    await rejects("insert into clients (name, email) values ('A', 'not-an-email')", "23514");
    await rejects("insert into clients (name, phone) values ('A', 'call me')", "23514");
    await db.query("insert into clients (name, email, phone) values ('A', 'a@b.co', '+27 (83) 787-5826')");
    await rejects("delete from clients where id = $1", "23001", [client]);
  });

  it("records client media and keeps it tied to an existing client", async () => {
    const owner = (await db.query("insert into clients (name) values ('Media owner') returning id")).rows[0].id;
    const insert = (fields = {}) => db.query("insert into client_media (client_id, object_key, file_name, content_type, size_bytes) values ($1, $2, $3, $4, $5) returning status",
      [fields.client ?? owner, fields.key ?? `clients/${owner}/${Math.random()}`, fields.name ?? "Reel.mp4", fields.type ?? "video/mp4", fields.size ?? 1000]);
    assert.equal((await insert()).rows[0].status, "pending");
    await rejects("insert into client_media (client_id, object_key, file_name, content_type, size_bytes) values (gen_random_uuid(), 'k', 'a.mp4', 'video/mp4', 1)", "23503");
    for (const fields of [{ type: "application/pdf" }, { size: 0 }, { size: 5000000001 }, { name: "" }])
      await assert.rejects(insert(fields), error => error.code === "23514");
    await insert({ key: "same" });
    await assert.rejects(insert({ key: "same" }), error => error.code === "23505");
    await rejects("delete from clients where id = $1", "23001", [owner]);
  });

  it("counts sign-in attempts per window", async () => {
    const hit = async () => (await db.query("select admin_login_hit('k', 900) as n")).rows[0].n;
    assert.equal(await hit(), 1);
    assert.equal(await hit(), 2);
    await db.query("update admin_login_attempts set window_ends = now() - interval '1 second' where key = 'k'");
    assert.equal(await hit(), 1);
  });

  it("gives the public API roles no access", async () => {
    const { rows } = await db.query(`select count(*)::int as n from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')`);
    assert.equal(rows[0].n, 0);
    const rls = await db.query("select count(*)::int as n from pg_tables where schemaname = 'public' and not rowsecurity");
    assert.equal(rls.rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int as n from pg_proc where proname = 'save_rental'")).rows[0].n, 1);
    for (const fn of ["save_rental", "admin_login_hit"]) {
      const { rows: [grant] } = await db.query(`select has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('service_role', p.oid, 'execute') as service
        from pg_proc p where proname = $1`, [fn]);
      assert.deepEqual(grant, { anon: false, service: true });
    }
  });
});

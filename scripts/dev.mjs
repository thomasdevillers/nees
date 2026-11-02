// Local preview: serves the static site and the /api/admin functions.
// Uses Supabase when its variables are set, otherwise a throwaway in-memory store.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { memoryDb, useDb } from "../api/_lib/db.js";

const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.PORT) || 3000;
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".webp": "image/webp", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".pdf": "application/pdf", ".json": "application/json" };

if (!process.env.ADMIN_PASSWORD) { process.env.ADMIN_PASSWORD = "onscene-dev"; console.log("ADMIN_PASSWORD not set, using: onscene-dev"); }
if (!process.env.SUPABASE_URL) { useDb(memoryDb()); console.log("No Supabase configured: data is kept in memory until this server stops."); }
else if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co(\/rest\/v1)?\/?$/.test(process.env.SUPABASE_URL) && !process.env.SUPABASE_URL.startsWith("http://127.0.0.1")) {
  console.error(`SUPABASE_URL in .env.local looks wrong: ${process.env.SUPABASE_URL}
Use the Project URL from Supabase → Project Settings → Data API, e.g. https://abcdefghijklmnopqrst.supabase.co`);
  process.exit(1);
} else if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SECRET_KEY is missing from .env.local. Use a secret key from Supabase → Project Settings → API Keys.");
  process.exit(1);
} else console.log(`Using Supabase at ${process.env.SUPABASE_URL}`);

async function api(req, res, name) {
  let module;
  try { module = await import(`../api/admin/${name}.js`); } catch { res.writeHead(404).end(); return; }
  const handler = module[req.method];
  if (!handler) { res.writeHead(405).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function file(res, pathname) {
  let path = normalize(join(root, decodeURIComponent(pathname)));
  if (!path.startsWith(root) || /[\/](api|scripts|tests|supabase|node_modules|\.)/.test(path.slice(root.length))) { res.writeHead(404).end("Not found"); return; }
  try { if ((await stat(path)).isDirectory()) path = join(path, "index.html"); } catch { /* handled below */ }
  try { res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" }).end(await readFile(path)); }
  catch { res.writeHead(404).end("Not found"); }
}

createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const match = pathname.match(/^\/api\/admin\/([a-z]+)$/);
  (match ? api(req, res, match[1]) : file(res, pathname)).catch(error => { console.error(error); res.writeHead(500).end(); });
}).listen(port, () => console.log(`OnScene running at http://localhost:${port}  ·  admin at http://localhost:${port}/admin/`));

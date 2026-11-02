import { randomBytes, timingSafeEqual } from "node:crypto";
import { AdminError, readCookie } from "./http.js";
import { adminDb, digest } from "./db.js";

export const SESSION_COOKIE = "onscene_admin";
export const SESSION_SECONDS = 12 * 60 * 60;
const MIN_PASSWORD_LENGTH = 5;
const LOGIN_WINDOW_SECONDS = 15 * 60;

function password() {
  const value = process.env.ADMIN_PASSWORD;
  if (!value || value.length < MIN_PASSWORD_LENGTH) throw new AdminError("Admin access has not been configured.", 503);
  return value;
}
export function passwordMatches(input) {
  return timingSafeEqual(Buffer.from(digest(input)), Buffer.from(digest(password())));
}
function cookie(value, maxAge) {
  const secure = process.env.VERCEL || process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export async function hasAdminSession(request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const session = await (await adminDb()).sessions.get(digest(token));
  return !!session && session.credential === digest(password());
}
export async function requireAdmin(request) {
  if (!await hasAdminSession(request)) throw new AdminError("Please sign in to continue.", 401);
}

/** Returns the Set-Cookie header value for the new session. */
export async function login(request, input) {
  password();
  // Vercel sets this header itself. Elsewhere use a shared limit rather than trusting supplied IPs.
  const ip = process.env.VERCEL ? request.headers.get("x-vercel-forwarded-for") || "unknown" : "local";
  const db = await adminDb();
  const [byIp, total] = await Promise.all([
    db.hit(`ip:${digest(ip)}`, LOGIN_WINDOW_SECONDS),
    db.hit("total", LOGIN_WINDOW_SECONDS),
  ]);
  if (byIp > 10 || total > 100) throw new AdminError("Too many sign-in attempts. Try again in 15 minutes.", 429);
  if (typeof input !== "string" || !passwordMatches(input)) throw new AdminError("Incorrect password.", 401);
  const token = randomBytes(32).toString("hex");
  await db.sessions.create(digest(token), digest(password()), SESSION_SECONDS);
  return cookie(token, SESSION_SECONDS);
}

/** Returns the Set-Cookie header value that clears the session. */
export async function logout(request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token && /^[a-f0-9]{64}$/.test(token)) await (await adminDb()).sessions.remove(digest(token));
  return cookie("", 0);
}

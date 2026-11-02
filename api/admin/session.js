import { hasAdminSession, login, logout } from "../_lib/auth.js";
import { adminJson, handle, readAdminBody, requireSameOrigin } from "../_lib/http.js";

export const GET = handle(async request => adminJson({ authenticated: await hasAdminSession(request) }));

export const POST = handle(async request => {
  requireSameOrigin(request);
  const body = await readAdminBody(request);
  const cookie = await login(request, body.password);
  return adminJson({ authenticated: true }, 200, { "Set-Cookie": cookie });
});

export const DELETE = handle(async request => {
  requireSameOrigin(request);
  return adminJson({ authenticated: false }, 200, { "Set-Cookie": await logout(request) });
});

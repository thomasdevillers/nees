import { requireAdmin } from "../_lib/auth.js";
import { deleteScreen, listScreens, saveScreen } from "../_lib/fleet.js";
import { AdminError, adminJson, handle, readAdminBody, requireSameOrigin } from "../_lib/http.js";

async function mutation(request) {
  requireSameOrigin(request);
  await requireAdmin(request);
}
const idOf = value => {
  if (typeof value !== "string" || !value) throw new AdminError("Missing screen id.");
  return value;
};

export const GET = handle(async request => {
  await requireAdmin(request);
  return adminJson({ screens: await listScreens() });
});

export const POST = handle(async request => {
  await mutation(request);
  return adminJson({ screen: await saveScreen(await readAdminBody(request)) }, 201);
});

export const PATCH = handle(async request => {
  await mutation(request);
  const body = await readAdminBody(request);
  return adminJson({ screen: await saveScreen(body, idOf(body.id)) });
});

export const DELETE = handle(async request => {
  await mutation(request);
  await deleteScreen(idOf(new URL(request.url).searchParams.get("id")));
  return adminJson({ deleted: true });
});

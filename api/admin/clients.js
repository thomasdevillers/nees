import { requireAdmin } from "../_lib/auth.js";
import { deleteClient, listClients, saveClient } from "../_lib/fleet.js";
import { AdminError, adminJson, handle, readAdminBody, requireSameOrigin } from "../_lib/http.js";

async function mutation(request) {
  requireSameOrigin(request);
  await requireAdmin(request);
}
const idOf = value => {
  if (typeof value !== "string" || !value) throw new AdminError("Missing client id.");
  return value;
};

export const GET = handle(async request => {
  await requireAdmin(request);
  return adminJson({ clients: await listClients() });
});

export const POST = handle(async request => {
  await mutation(request);
  return adminJson({ client: await saveClient(await readAdminBody(request)) }, 201);
});

export const PATCH = handle(async request => {
  await mutation(request);
  const body = await readAdminBody(request);
  return adminJson({ client: await saveClient(body, idOf(body.id)) });
});

export const DELETE = handle(async request => {
  await mutation(request);
  await deleteClient(idOf(new URL(request.url).searchParams.get("id")));
  return adminJson({ deleted: true });
});

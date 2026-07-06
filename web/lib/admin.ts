import { CONFIG } from "./config";

export interface AdminUser {
  email: string;
  status: string;
  enabled: boolean;
  tenantId: string | null;
  admin: boolean;
  created: string;
}

async function req(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 403) throw new Error("No tenés permisos");
    const message = await res
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => null);
    throw new Error(message ?? `Error ${res.status}`);
  }
  return res.json();
}

export const listUsers = (t: string): Promise<{ users: AdminUser[] }> =>
  req(t, "/admin/users");

export const createUser = (
  t: string,
  body: { email: string; password: string; tenantId?: string; admin?: boolean },
): Promise<{ email: string }> =>
  req(t, "/admin/users", { method: "POST", body: JSON.stringify(body) });

export const deleteUser = (t: string, email: string): Promise<{ ok: true }> =>
  req(t, `/admin/users/${encodeURIComponent(email)}`, { method: "DELETE" });

export const resetPassword = (
  t: string,
  email: string,
  password: string,
): Promise<{ ok: true }> =>
  req(t, `/admin/users/${encodeURIComponent(email)}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });

export const setRole = (
  t: string,
  email: string,
  admin: boolean,
): Promise<{ ok: true }> =>
  req(t, `/admin/users/${encodeURIComponent(email)}/role`, {
    method: "POST",
    body: JSON.stringify({ admin }),
  });

import { useCallback, useEffect, useState } from 'react';

const KEY = 'auth.token';
export const token = {
  get: () => localStorage.getItem(KEY),
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = token.get();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) { token.clear(); location.reload(); }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : res.statusText);
  return body as T;
}

/** Fetch on mount and whenever `path` changes. `reload()` after a mutation. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);

  const reload = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api<T>(path)
      .then((d) => { setData(d); setError(null); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

// ------------------------------------------------------------------- types

export type Stage = { id: number; name: string; sort_order: number; is_terminal: boolean };
export type Staff = { id: string; name: string; email: string; role: string };
export type ClientRow = {
  id: string; email: string; name: string; tier: string; kyc_status: string;
  risk_profile: string | null; created_at: string; stage_id: number; stage: string;
  owner_staff_id: string | null; owner_name: string | null;
};
export type Client = ClientRow & { phone: string | null; country: string | null };
export type Activity = {
  id: number; at: string; kind: string; actor: string | null; summary: string;
  ref_table: string | null; ref_id: string | null; data: Record<string, unknown>;
};
export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type Task = {
  id: number; client_id: string; assigned_to: string; title: string;
  due_at: string | null; status: TaskStatus;
  client_name: string; assignee_name: string;
};

'use client';

/** Thin client for the PlayLoop JSON API: one error shape, one parse path. */

export type ApiError = { code: string; message: string; status: number };

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(error: ApiError) {
    super(error.message);
    this.status = error.status;
    this.code = error.code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new RequestError({
      code: err?.code ?? 'http_error',
      message: err?.message ?? `Request failed (${res.status})`,
      status: res.status,
    });
  }

  const data = (body as { data?: unknown } | null)?.data;
  return (data ?? body) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
};

export type Viewer = {
  id: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
} | null;

export type MeResponse = { viewer: Viewer; unread: number };

/** Sign in with a handle (no password). Returns true on success. */
export async function signInWithHandle(handle: string): Promise<boolean> {
  const { signIn } = await import('next-auth/react');
  const result = await signIn('handle', { handle, redirect: false });
  return Boolean(result && !result.error);
}

/** Game card shared by explore / saved / tag pages. */
export type MiniGame = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  counts: { likes: number; plays: number };
  creatorHandle: string;
  artifactSha: string;
};

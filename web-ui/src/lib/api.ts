// NanoClaw API client — backend contract frozen.
// Kept identical to legacy web-ui/src/lib/api.ts.

const TOKEN_KEY = 'nanoclaw_auth_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function getBaseUrl(): string {
  return window.location.origin;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get:    <T>(path: string) => request<T>(path),
  post:   <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  put:    <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT',  body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/?token=${encodeURIComponent(getToken())}`;
}

/** Build a URL for an uploaded file with the auth token in the query string. */
export function getUploadUrl(filename: string): string {
  return `/uploads/${encodeURIComponent(filename)}?token=${encodeURIComponent(getToken())}`;
}

/** Build a URL for the group's persona avatar with the auth token in the query string. */
export function getAvatarUrl(): string {
  return `/api/avatar?token=${encodeURIComponent(getToken())}`;
}

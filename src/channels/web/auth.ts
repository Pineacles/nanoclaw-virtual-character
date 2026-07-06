import { IncomingMessage } from 'http';

import { readEnvFile } from '../../env.js';

let cachedToken: string | null = null;

function getToken(): string | null {
  if (cachedToken !== null) return cachedToken;
  const env = readEnvFile(['WEB_AUTH_TOKEN']);
  cachedToken = env.WEB_AUTH_TOKEN || null;
  return cachedToken;
}

export function verifyAuth(req: IncomingMessage): boolean {
  const token = getToken();
  if (!token) return false;

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && parts[1] === token) {
      return true;
    }
  }

  // Check query parameter (for WebSocket upgrade)
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  );
  if (url.searchParams.get('token') === token) {
    return true;
  }

  return false;
}

/**
 * Internal API caller authentication.
 *
 * The /internal/ HTTP routes (memory, chat-query, context) are called by
 * tools running inside agent containers. The source-IP check alone cannot
 * distinguish WHICH container is calling — every container on the bridge
 * network shares the 172.* range, including containers spawned by a
 * different NanoClaw instance on the same host. Without caller identity,
 * one group's agent could read another group's memories by passing a
 * foreign group_folder.
 *
 * Worse, loopback cannot be trusted either: cloudflared runs with host
 * networking, so internet traffic through the tunnel arrives from 127.0.0.1.
 *
 * Fix: the host issues a random token per container spawn, bound to that
 * container's group folder. The token is injected as NANOCLAW_INTERNAL_TOKEN
 * and revoked when the container exits. Every /internal/ request must
 * present the token and may only act on the group it was issued for.
 */
import crypto from 'crypto';

interface TokenRecord {
  groupFolder: string;
  issuedAt: number;
}

const tokens = new Map<string, TokenRecord>();

// Containers are short-lived; expire tokens defensively in case a revoke
// is missed (e.g. host crash mid-run).
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function issueInternalToken(groupFolder: string): string {
  pruneExpired();
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { groupFolder, issuedAt: Date.now() });
  return token;
}

export function revokeInternalToken(token: string): void {
  tokens.delete(token);
}

/**
 * Returns the group folder a token is bound to, or null if unknown/expired.
 */
export function resolveInternalToken(
  token: string | null | undefined,
): string | null {
  if (!token) return null;
  const record = tokens.get(token);
  if (!record) return null;
  if (Date.now() - record.issuedAt > TOKEN_TTL_MS) {
    tokens.delete(token);
    return null;
  }
  return record.groupFolder;
}

/**
 * Authorization decision for an /internal/ request. Every caller must
 * present a valid token and may only act on the group that token was
 * issued for. Endpoints without an explicit group_folder operate on the
 * instance group, so the token group must match it. There is deliberately
 * NO source-IP trust: a reverse proxy with host networking makes internet
 * traffic arrive from loopback.
 */
export function authorizeInternalCall(opts: {
  token: string | null | undefined;
  requestedGroupFolder: string | null;
  instanceGroupFolder: string;
}): { allowed: boolean; reason?: string } {
  const { token, requestedGroupFolder, instanceGroupFolder } = opts;

  const tokenGroup = resolveInternalToken(token);
  if (!tokenGroup) {
    return { allowed: false, reason: 'missing or invalid internal token' };
  }
  const target = requestedGroupFolder ?? instanceGroupFolder;
  if (tokenGroup !== target) {
    return {
      allowed: false,
      reason: `token group "${tokenGroup}" may not act on "${target}"`,
    };
  }
  return { allowed: true };
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [token, record] of tokens) {
    if (now - record.issuedAt > TOKEN_TTL_MS) tokens.delete(token);
  }
}

import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
]);

/**
 * Resolve this instance's assistant name. Identity is treated like a secret:
 * it is NEVER allowed to default to another persona. Resolution order:
 *   1. ASSISTANT_NAME from this instance's own env (process.env / its env file)
 *   2. the assistant.name inside THIS instance's persona folder
 *      (groups/<NANOCLAW_WEB_GROUP>/group.json) — physically scoped to the
 *      persona, so it can never resolve to a different persona's name
 *   3. a neutral, non-persona placeholder ("Assistant")
 * There is intentionally no shared/global persona default (no fixed
 * persona name at all). index.ts additionally refuses to start if the
 * resolved name does not match the persona folder — see the
 * identity-integrity guard.
 */
function resolveAssistantName(): string {
  const fromEnv = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME;
  if (fromEnv) return fromEnv;
  const folder = process.env.NANOCLAW_WEB_GROUP;
  if (folder) {
    try {
      const gj = JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), 'groups', folder, 'group.json'),
          'utf-8',
        ),
      );
      if (gj?.assistant?.name) return String(gj.assistant.name);
    } catch {
      /* fall through to neutral placeholder */
    }
  }
  return 'Assistant';
}

/**
 * Resolve this instance's user name, following the same precedence as
 * resolveAssistantName() (minus the env override, since there is no
 * per-instance USER_NAME env var): the user.name inside THIS instance's
 * persona folder (groups/<NANOCLAW_WEB_GROUP>/group.json), else a neutral
 * placeholder.
 */
function resolveUserName(): string {
  const folder = process.env.NANOCLAW_WEB_GROUP;
  if (folder) {
    try {
      const gj = JSON.parse(
        fs.readFileSync(
          path.resolve(process.cwd(), 'groups', folder, 'group.json'),
          'utf-8',
        ),
      );
      if (gj?.user?.name) return String(gj.user.name);
    } catch {
      /* fall through to neutral placeholder */
    }
  }
  return 'the user';
}

export const ASSISTANT_NAME = resolveAssistantName();
export const USER_NAME = resolveUserName();
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

/**
 * Settle window for message bursts.
 *
 * WhatsApp sends each image / document in a separate message, so a multi-image
 * upload arrives as N messages over ~1–3 seconds. Without batching, the agent
 * fires on the first message and replies before the rest arrive.
 *
 * When new messages are detected for a WhatsApp JID, we wait this many ms of
 * quiet (no further new messages) before invoking the agent. New arrivals
 * during the window reset the timer.
 *
 * Set to 0 to disable (web sessions always pass 0 since they send one
 * composed message at a time). Override via env: WHATSAPP_BURST_SETTLE_MS.
 */
export const WHATSAPP_BURST_SETTLE_MS = Math.max(
  0,
  parseInt(process.env.WHATSAPP_BURST_SETTLE_MS || '4000', 10) || 4000,
);

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(
  PROJECT_ROOT,
  process.env.NANOCLAW_STORE_DIR || 'store',
);
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(
  PROJECT_ROOT,
  process.env.NANOCLAW_DATA_DIR || 'data',
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

/**
 * Read-receipt store — groups/{folder}/presence/receipts.json
 *
 * Insertion-order map: messageId → readAt ISO string.
 * Max 600 entries; trimmed to newest 400 when the cap is exceeded.
 * Writes are atomic (tmp + rename).
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';

const MAX_ENTRIES = 600;
const TRIM_TO = 400;

function receiptsPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'presence', 'receipts.json');
}

function loadReceipts(groupFolder: string): Record<string, string> {
  const p = receiptsPath(groupFolder);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    /* missing or corrupt — start empty */
  }
  return {};
}

function saveReceipts(
  groupFolder: string,
  receipts: Record<string, string>,
): void {
  const p = receiptsPath(groupFolder);
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(receipts, null, 2), 'utf-8');
  fs.renameSync(tmp, p);
}

/**
 * Mark a set of message IDs as read at `readAt`.
 * Returns only the entries that were newly marked (i.e. not previously present).
 */
export function markMessagesRead(
  groupFolder: string,
  ids: string[],
  readAt: string,
): Array<{ id: string; readAt: string }> {
  if (ids.length === 0) return [];

  const receipts = loadReceipts(groupFolder);
  const newlyMarked: Array<{ id: string; readAt: string }> = [];

  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(receipts, id)) {
      receipts[id] = readAt;
      newlyMarked.push({ id, readAt });
    }
  }

  if (newlyMarked.length === 0) return [];

  // Trim if over cap — keep the newest TRIM_TO entries by insertion order
  const entries = Object.entries(receipts);
  const trimmed =
    entries.length > MAX_ENTRIES
      ? entries.slice(entries.length - TRIM_TO)
      : entries;

  const trimmedReceipts: Record<string, string> = {};
  for (const [k, v] of trimmed) {
    trimmedReceipts[k] = v;
  }

  saveReceipts(groupFolder, trimmedReceipts);
  return newlyMarked;
}

/**
 * Return all stored receipts for a group as a messageId → readAt map.
 */
export function getReceipts(groupFolder: string): Record<string, string> {
  return loadReceipts(groupFolder);
}

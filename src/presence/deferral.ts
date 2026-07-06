/**
 * Persistent inbound-reply deferral.
 *
 * When delayed_replies is enabled for a group and the assistant is not
 * online, inbound messages are deferred until her next online window.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { computePresence, readGroupFeature } from './engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeferralRecord {
  until: number; // epoch ms — release at or after this time
  msgCount: number;
  since: number; // epoch ms — when we started deferring
  groupFolder: string;
}

type DeferralStore = Record<string, DeferralRecord>;

// ---------------------------------------------------------------------------
// Test hook — allows overriding DATA_DIR for tests
// ---------------------------------------------------------------------------

let _dataDirOverride: string | null = null;

export function _setDataDirForTest(dir: string): void {
  _dataDirOverride = dir;
  _store = null; // flush lazy cache
}

function getDataDir(): string {
  return _dataDirOverride ?? DATA_DIR;
}

function deferralsPath(): string {
  return path.join(getDataDir(), 'presence-deferrals.json');
}

// ---------------------------------------------------------------------------
// Lazy persistence
// ---------------------------------------------------------------------------

let _store: DeferralStore | null = null;

function loadStore(): DeferralStore {
  if (_store !== null) return _store;
  try {
    _store = JSON.parse(
      fs.readFileSync(deferralsPath(), 'utf-8'),
    ) as DeferralStore;
  } catch {
    _store = {};
  }
  return _store;
}

function persistStore(): void {
  const store = loadStore();
  const p = deferralsPath();
  const tmp = `${p}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    logger.warn({ err }, 'presence-deferral: failed to persist store');
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MSG_COUNT_WAKE = 2; // double-texting wakes her up — the user must never feel locked out
const AWAY_CAP_MS = 75 * 60_000; // 75 minutes cap for 'away' state

/**
 * Call once per inbound user message.
 * Returns `until` epoch ms if deferral is active, null to proceed immediately.
 */
export function maybeDefer(
  chatJid: string,
  groupFolder: string,
  now?: number,
): number | null {
  const ts = now ?? Date.now();

  if (!readGroupFeature(groupFolder, 'delayed_replies')) return null;

  const store = loadStore();
  const existing = store[chatJid];

  if (existing) {
    existing.msgCount += 1;
    if (existing.msgCount >= MSG_COUNT_WAKE) {
      // Double-text — she's being pulled to her phone
      delete store[chatJid];
      persistStore();
      return null;
    }
    persistStore();
    return existing.until;
  }

  // No existing record — compute presence
  const presence = computePresence(groupFolder, { now: ts });
  if (presence.state === 'online') return null;

  let until = presence.nextOnlineAt ?? ts + 15 * 60_000;

  // Apply caps
  if (presence.state === 'away') {
    if (presence.reason === 'event') {
      // She's at a real event: respect the event end time, but cap at 3h max.
      // The event end (nextOnlineAt) already includes the 5–15 min jitter from
      // computePresence, so we just clamp to whichever is sooner.
      until = Math.min(
        presence.nextOnlineAt ?? ts + 3 * 60 * 60_000,
        ts + 3 * 60 * 60_000,
      );
    } else {
      until = Math.min(until, ts + AWAY_CAP_MS);
    }
  }
  // sleeping: no cap — let it run until morning

  const record: DeferralRecord = {
    until,
    msgCount: 1,
    since: ts,
    groupFolder,
  };
  store[chatJid] = record;
  persistStore();
  return until;
}

/**
 * Remove a deferral record immediately (e.g., message was sent / timer fired).
 */
export function clearDeferral(chatJid: string): void {
  const store = loadStore();
  if (chatJid in store) {
    delete store[chatJid];
    persistStore();
  }
}

/**
 * Start the 30-second polling loop.
 * Calls onRelease(chatJid) when a deferral expires or presence becomes online.
 */
export function startDeferralLoop(onRelease: (chatJid: string) => void): void {
  const interval = setInterval(() => {
    try {
      const store = loadStore();
      const now = Date.now();
      const toRelease: string[] = [];

      for (const [chatJid, record] of Object.entries(store)) {
        let shouldRelease = false;
        if (now >= record.until) {
          shouldRelease = true;
        } else {
          try {
            const presence = computePresence(record.groupFolder, { now });
            if (presence.state === 'online') shouldRelease = true;
          } catch (err) {
            logger.warn(
              { err, chatJid },
              'presence-deferral: computePresence error in loop',
            );
          }
        }
        if (shouldRelease) toRelease.push(chatJid);
      }

      for (const chatJid of toRelease) {
        delete store[chatJid];
        persistStore();
        try {
          onRelease(chatJid);
        } catch (err) {
          logger.warn(
            { err, chatJid },
            'presence-deferral: onRelease callback error',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'presence-deferral: loop error');
    }
  }, 30_000);

  // Don't keep process alive just for this
  interval.unref();
}

// Export for use in os.tmpdir-based test tmp dirs
export { os };

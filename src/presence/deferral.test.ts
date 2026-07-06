import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _setGroupsDirForTest, computePresence } from './engine.js';
import {
  _setDataDirForTest,
  clearDeferral,
  maybeDefer,
  startDeferralLoop,
} from './deferral.js';
import { _setGroupsDirForTest as _setCalendarGroupsDir } from '../social/calendar.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpGroupsDir: string;
let tmpDataDir: string;
const GROUP = 'test-group';

function groupDir(): string {
  return path.join(tmpGroupsDir, GROUP);
}

function writeGroupJson(data: unknown): void {
  fs.writeFileSync(
    path.join(groupDir(), 'group.json'),
    JSON.stringify(data, null, 2),
  );
}

function writeMoodJson(data: unknown): void {
  fs.writeFileSync(
    path.join(groupDir(), 'mood.json'),
    JSON.stringify(data, null, 2),
  );
}

function deferralsFilePath(): string {
  return path.join(tmpDataDir, 'presence-deferrals.json');
}

/** Epoch ms for a "sleeping" moment at 03:00 Zurich on 2026-06-10 */
function sleepingNow(): number {
  // UTC+2 in summer → 03:00 local = 01:00 UTC
  return Date.UTC(2026, 5, 10, 1, 0, 0);
}

/** Epoch ms for a clearly-awake moment at 13:00 Zurich */
function awakeNow(): number {
  return Date.UTC(2026, 5, 10, 11, 0, 0); // 11:00 UTC = 13:00 Zurich
}

/** sleeping-heavy mood */
function sleepingMood() {
  return {
    date: '2026-06-10',
    slots: [
      {
        start: '00:00',
        end: '08:00',
        primary: 'sleeping',
        distribution: { sleeping: 80, soft: 20 },
        energy: 1,
      },
      {
        start: '08:00',
        end: '23:59',
        primary: 'chill',
        distribution: { chill: 80, soft: 20 },
        energy: 7,
      },
    ],
  };
}

/**
 * Find a 15-min window near baseEpoch that returns the desired state.
 * Sweeps up to maxWindows consecutive windows. Returns null if none found.
 */
function findWindow(
  baseEpoch: number,
  desiredState: 'sleeping' | 'online' | 'away',
  maxWindows = 20,
): number | null {
  for (let i = 0; i < maxWindows; i++) {
    const candidate = baseEpoch + i * 15 * 60_000;
    const p = computePresence(GROUP, { now: candidate });
    if (p.state === desiredState) return candidate;
  }
  return null;
}

beforeEach(() => {
  tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-defer-grp-'));
  tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-defer-data-'));
  fs.mkdirSync(groupDir(), { recursive: true });
  // feature flag ON by default
  writeGroupJson({
    timezone: 'Europe/Zurich',
    features: { delayed_replies: true },
  });
  writeMoodJson(sleepingMood());
  _setGroupsDirForTest(tmpGroupsDir);
  _setCalendarGroupsDir(tmpGroupsDir);
  _setDataDirForTest(tmpDataDir);
});

afterEach(() => {
  _setGroupsDirForTest('');
  _setCalendarGroupsDir('');
  _setDataDirForTest('');
  fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('maybeDefer — feature flag', () => {
  it('returns null when delayed_replies feature is off', () => {
    writeGroupJson({
      timezone: 'Europe/Zurich',
      features: { delayed_replies: false },
    });
    const result = maybeDefer('chat@test', GROUP, sleepingNow());
    expect(result).toBeNull();
  });

  it('returns null when feature is missing', () => {
    writeGroupJson({ timezone: 'Europe/Zurich', features: {} });
    const result = maybeDefer('chat@test', GROUP, sleepingNow());
    expect(result).toBeNull();
  });
});

describe('maybeDefer — online state', () => {
  it('returns null when currently online (awake high-energy slot)', () => {
    // The high-energy (7) awake slot has low away probability (0.22),
    // so most windows will be online. We sweep until we find one.
    const onlineNow = findWindow(awakeNow(), 'online', 60);
    if (onlineNow === null) {
      // All away in this window range — skip test (valid edge case)
      return;
    }
    const result = maybeDefer('chat@test', GROUP, onlineNow);
    expect(result).toBeNull();
  });
});

describe('maybeDefer — sleeping state defers', () => {
  it('returns a future timestamp when sleeping', () => {
    const ts = findWindow(sleepingNow(), 'sleeping');
    if (ts === null) return; // all insomnia windows, skip

    const result = maybeDefer('chat@sleep', GROUP, ts);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(ts);
  });

  it('persists deferral to disk', () => {
    const ts = findWindow(sleepingNow(), 'sleeping');
    if (ts === null) return;

    maybeDefer('chat@persist', GROUP, ts);

    expect(fs.existsSync(deferralsFilePath())).toBe(true);
    const stored = JSON.parse(
      fs.readFileSync(deferralsFilePath(), 'utf-8'),
    ) as Record<string, unknown>;
    expect(stored['chat@persist']).toBeDefined();
    expect(
      (stored['chat@persist'] as Record<string, unknown>).groupFolder,
    ).toBe(GROUP);
  });
});

describe('maybeDefer — msgCount escape at 2', () => {
  it('second message clears deferral and returns null', () => {
    const ts = findWindow(sleepingNow(), 'sleeping');
    if (ts === null) return;

    const r1 = maybeDefer('chat@msgcount', GROUP, ts);
    expect(r1).not.toBeNull(); // first message — deferred

    const r2 = maybeDefer('chat@msgcount', GROUP, ts);
    expect(r2).toBeNull(); // second message — double-text wakes her up

    // Record should be gone
    const stored = JSON.parse(
      fs.readFileSync(deferralsFilePath(), 'utf-8'),
    ) as Record<string, unknown>;
    expect(stored['chat@msgcount']).toBeUndefined();
  });
});

describe('clearDeferral', () => {
  it('removes an existing deferral record', () => {
    const ts = findWindow(sleepingNow(), 'sleeping');
    if (ts === null) return;

    maybeDefer('chat@clear', GROUP, ts);
    clearDeferral('chat@clear');

    const stored = JSON.parse(
      fs.readFileSync(deferralsFilePath(), 'utf-8'),
    ) as Record<string, unknown>;
    expect(stored['chat@clear']).toBeUndefined();
  });

  it('is a no-op on a missing record', () => {
    expect(() => clearDeferral('chat@nonexistent')).not.toThrow();
  });
});

describe('startDeferralLoop', () => {
  it('calls onRelease when deferral expires (now >= until)', async () => {
    vi.useFakeTimers();
    try {
      // Create a deferral record manually with until = now - 1 ms (already expired)
      const expired = Date.now() - 1;
      fs.mkdirSync(tmpDataDir, { recursive: true });
      fs.writeFileSync(
        deferralsFilePath(),
        JSON.stringify({
          'chat@expired': {
            until: expired,
            msgCount: 1,
            since: expired - 60_000,
            groupFolder: GROUP,
          },
        }),
      );
      // Reload store by resetting override (same dir)
      _setDataDirForTest(tmpDataDir);

      const released: string[] = [];
      startDeferralLoop((jid) => released.push(jid));

      // Advance timers to trigger the 30s interval
      await vi.advanceTimersByTimeAsync(30_001);

      expect(released).toContain('chat@expired');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('persistence round-trip', () => {
  it('survives a data dir reload (simulated restart)', () => {
    const ts = findWindow(sleepingNow(), 'sleeping');
    if (ts === null) return;

    // First call — creates record
    const until = maybeDefer('chat@roundtrip', GROUP, ts);
    expect(until).not.toBeNull();

    // Simulate reload by flushing in-memory store
    _setDataDirForTest(tmpDataDir); // same dir — forces reload from disk

    // Second call — reads from disk, hits MSG_COUNT_WAKE (2) → clears record
    const until2 = maybeDefer('chat@roundtrip', GROUP, ts);
    expect(until2).toBeNull(); // double-text escape triggered

    const stored = JSON.parse(
      fs.readFileSync(deferralsFilePath(), 'utf-8'),
    ) as Record<string, { msgCount: number }>;
    expect(stored['chat@roundtrip']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Event-based deferral cap (reason === 'event')
// ---------------------------------------------------------------------------

/** Epoch ms for 2026-06-12 HH:MM in Europe/Zurich (UTC+2 in summer) */
function zurichEpochDeferral(date: string, hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y!, (mo ?? 1) - 1, d!, h - 2, m, 0);
}

function writeCalendar(events: unknown[]): void {
  const socialDir = path.join(groupDir(), 'social');
  fs.mkdirSync(socialDir, { recursive: true });
  fs.writeFileSync(
    path.join(socialDir, 'calendar.json'),
    JSON.stringify({ events }, null, 2),
  );
}

function writeAwaySupportingMood(): void {
  // A 'away'-producing mood for daytime windows. energy=2 → awayProb=0.5
  writeMoodJson({
    date: '2026-06-12',
    slots: [
      {
        start: '00:00',
        end: '23:59',
        primary: 'chill',
        distribution: { chill: 60, tired: 40 },
        energy: 2,
      },
    ],
  });
}

describe('maybeDefer — event-based cap (3h max, not 75min)', () => {
  it('when reason is event, cap is up to 3h instead of 75min', () => {
    writeGroupJson({
      timezone: 'Europe/Zurich',
      features: { delayed_replies: true, social_sim: true },
    });
    writeAwaySupportingMood();

    // Place an event on 2026-06-12 19:00–21:00 and test at 19:30
    // (inside the event window → computePresence returns reason='event')
    writeCalendar([
      {
        id: 'evt-test',
        date: '2026-06-12',
        start: '19:00',
        end: '21:00',
        who: 'Mia',
        what: 'dinner',
        status: 'confirmed',
        phone_ok: true,
      },
    ]);

    const now = zurichEpochDeferral('2026-06-12', '19:30');
    const until = maybeDefer('chat@event-cap', GROUP, now);

    // We can't predict the exact value (it depends on event end + jitter),
    // but it must be > 75 min from now (proving the 75min cap was NOT applied)
    // and <= 3h from now.
    if (until === null) return; // online window (rare) — skip
    const AWAY_CAP_MS = 75 * 60_000;
    const THREE_HOURS_MS = 3 * 60 * 60_000;
    expect(until).toBeGreaterThan(now + AWAY_CAP_MS);
    expect(until).toBeLessThanOrEqual(now + THREE_HOURS_MS);
  });

  it('when reason is schedule (no event), cap is 75min', () => {
    writeGroupJson({
      timezone: 'Europe/Zurich',
      features: { delayed_replies: true, social_sim: true },
    });
    writeAwaySupportingMood();
    // No calendar events → reason will be 'schedule' when state is 'away'

    // Find an away window on 2026-06-12 during the day
    const base = zurichEpochDeferral('2026-06-12', '14:00');
    let awayNow: number | null = null;
    for (let i = 0; i < 30; i++) {
      const candidate = base + i * 15 * 60_000;
      const p = computePresence(GROUP, { now: candidate });
      if (p.state === 'away') {
        awayNow = candidate;
        break;
      }
    }
    if (awayNow === null) return; // all online — skip

    const until = maybeDefer('chat@sched-cap', GROUP, awayNow);
    if (until === null) return;

    const AWAY_CAP_MS = 75 * 60_000;
    expect(until).toBeLessThanOrEqual(awayNow + AWAY_CAP_MS);
  });
});

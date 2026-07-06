import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _setGroupsDirForTest,
  currentEvent,
  readCalendar,
  upcomingEvents,
  type SocialEvent,
} from './calendar.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
const GROUP = 'test-group';

function groupDir(): string {
  return path.join(tmpDir, GROUP);
}

function socialDir(): string {
  return path.join(groupDir(), 'social');
}

function writeCalendar(data: unknown): void {
  fs.mkdirSync(socialDir(), { recursive: true });
  fs.writeFileSync(
    path.join(socialDir(), 'calendar.json'),
    JSON.stringify(data, null, 2),
  );
}

function writeGroupJson(tz = 'Europe/Zurich'): void {
  fs.writeFileSync(
    path.join(groupDir(), 'group.json'),
    JSON.stringify({ timezone: tz }, null, 2),
  );
}

/**
 * Build an epoch ms for a given local date + time in Europe/Zurich.
 * Zurich is UTC+2 in summer (CEST), so local = UTC + 2h.
 */
function zurichEpoch(date: string, hhmm: string): number {
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);
  // date + time in Zurich local → UTC = local - 2h (CEST)
  const [y, mo, d] = date.split('-').map(Number);
  return Date.UTC(y!, (mo ?? 1) - 1, d!, h - 2, m, 0);
}

function makeEvent(overrides: Partial<SocialEvent> = {}): SocialEvent {
  return {
    id: 'evt-001',
    date: '2026-06-12',
    start: '19:00',
    end: '21:00',
    who: 'Mia',
    what: 'dinner',
    where: 'that thai place in kreis 4',
    status: 'confirmed',
    phone_ok: true,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-calendar-test-'));
  fs.mkdirSync(groupDir(), { recursive: true });
  writeGroupJson();
  _setGroupsDirForTest(tmpDir);
});

afterEach(() => {
  _setGroupsDirForTest('');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readCalendar
// ---------------------------------------------------------------------------

describe('readCalendar', () => {
  it('returns empty array when calendar.json is missing', () => {
    expect(readCalendar(GROUP)).toEqual([]);
  });

  it('returns empty array when calendar.json is corrupt JSON', () => {
    fs.mkdirSync(socialDir(), { recursive: true });
    fs.writeFileSync(path.join(socialDir(), 'calendar.json'), '{ bad json ');
    expect(readCalendar(GROUP)).toEqual([]);
  });

  it('returns empty array when events field is missing', () => {
    writeCalendar({ version: 1 });
    expect(readCalendar(GROUP)).toEqual([]);
  });

  it('returns empty array when events is not an array', () => {
    writeCalendar({ events: 'not-an-array' });
    expect(readCalendar(GROUP)).toEqual([]);
  });

  it('filters out invalid events and keeps valid ones', () => {
    writeCalendar({
      events: [
        makeEvent(), // valid
        { id: 'bad', missing_fields: true }, // invalid
      ],
    });
    const result = readCalendar(GROUP);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('evt-001');
  });

  it('returns all valid events', () => {
    writeCalendar({
      events: [makeEvent(), makeEvent({ id: 'evt-002', who: 'Yuna' })],
    });
    expect(readCalendar(GROUP)).toHaveLength(2);
  });

  it('returns events with all fields intact', () => {
    const ev = makeEvent();
    writeCalendar({ events: [ev] });
    const result = readCalendar(GROUP);
    expect(result[0]).toEqual(ev);
  });
});

// ---------------------------------------------------------------------------
// currentEvent
// ---------------------------------------------------------------------------

describe('currentEvent', () => {
  it('returns null when no events exist', () => {
    expect(currentEvent(GROUP)).toBeNull();
  });

  it('returns null when current time is before event window', () => {
    writeCalendar({ events: [makeEvent({ date: '2026-06-12' })] });
    // 18:59 — 1 minute before start
    const now = zurichEpoch('2026-06-12', '18:59');
    expect(currentEvent(GROUP, now)).toBeNull();
  });

  it('returns null when current time is after event window', () => {
    writeCalendar({ events: [makeEvent({ date: '2026-06-12' })] });
    // 21:01 — 1 minute after end
    const now = zurichEpoch('2026-06-12', '21:01');
    expect(currentEvent(GROUP, now)).toBeNull();
  });

  it('returns the event when current time is inside its window', () => {
    const ev = makeEvent({ date: '2026-06-12' });
    writeCalendar({ events: [ev] });
    // 20:00 — in the middle of 19:00–21:00
    const now = zurichEpoch('2026-06-12', '20:00');
    const result = currentEvent(GROUP, now);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('evt-001');
  });

  it('returns event whose window starts exactly at now', () => {
    const ev = makeEvent({ date: '2026-06-12' });
    writeCalendar({ events: [ev] });
    const now = zurichEpoch('2026-06-12', '19:00');
    const result = currentEvent(GROUP, now);
    expect(result).not.toBeNull();
  });

  it('does NOT return event when current time equals end (exclusive upper bound)', () => {
    const ev = makeEvent({ date: '2026-06-12' });
    writeCalendar({ events: [ev] });
    const now = zurichEpoch('2026-06-12', '21:00');
    expect(currentEvent(GROUP, now)).toBeNull();
  });

  it('ignores cancelled events', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-12', status: 'cancelled' })],
    });
    const now = zurichEpoch('2026-06-12', '20:00');
    expect(currentEvent(GROUP, now)).toBeNull();
  });

  it('ignores done events', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-12', status: 'done' })],
    });
    const now = zurichEpoch('2026-06-12', '20:00');
    expect(currentEvent(GROUP, now)).toBeNull();
  });

  it('returns planned events (not just confirmed)', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-12', status: 'planned' })],
    });
    const now = zurichEpoch('2026-06-12', '20:00');
    const result = currentEvent(GROUP, now);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upcomingEvents
// ---------------------------------------------------------------------------

describe('upcomingEvents', () => {
  it('returns empty array when no events exist', () => {
    expect(upcomingEvents(GROUP)).toEqual([]);
  });

  it('excludes events in the past', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-12', start: '10:00', end: '12:00' })],
    });
    // now is after the event
    const now = zurichEpoch('2026-06-12', '13:00');
    expect(upcomingEvents(GROUP, now)).toEqual([]);
  });

  it('excludes currently-running events (start <= now)', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-12' })],
    });
    const now = zurichEpoch('2026-06-12', '20:00');
    expect(upcomingEvents(GROUP, now)).toEqual([]);
  });

  it('excludes cancelled events', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-13', status: 'cancelled' })],
    });
    const now = zurichEpoch('2026-06-12', '10:00');
    expect(upcomingEvents(GROUP, now)).toEqual([]);
  });

  it('excludes done events', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-13', status: 'done' })],
    });
    const now = zurichEpoch('2026-06-12', '10:00');
    expect(upcomingEvents(GROUP, now)).toEqual([]);
  });

  it('excludes events beyond the horizon', () => {
    // horizon is 36h; event is 48h away
    writeCalendar({
      events: [makeEvent({ date: '2026-06-14', start: '10:00', end: '12:00' })],
    });
    const now = zurichEpoch('2026-06-12', '10:00'); // 48h before event
    expect(upcomingEvents(GROUP, now, 36)).toEqual([]);
  });

  it('includes events within the default 36h horizon', () => {
    writeCalendar({
      events: [makeEvent({ date: '2026-06-13', start: '10:00', end: '12:00' })],
    });
    const now = zurichEpoch('2026-06-12', '10:00'); // 24h before event
    const result = upcomingEvents(GROUP, now);
    expect(result).toHaveLength(1);
  });

  it('returns events sorted ascending by start time', () => {
    writeCalendar({
      events: [
        makeEvent({
          id: 'later',
          date: '2026-06-13',
          start: '20:00',
          end: '22:00',
        }),
        makeEvent({
          id: 'earlier',
          date: '2026-06-13',
          start: '10:00',
          end: '12:00',
        }),
      ],
    });
    const now = zurichEpoch('2026-06-12', '10:00');
    const result = upcomingEvents(GROUP, now);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe('earlier');
    expect(result[1]!.id).toBe('later');
  });

  it('custom horizon works', () => {
    writeCalendar({
      events: [
        makeEvent({
          id: 'close',
          date: '2026-06-12',
          start: '15:00',
          end: '16:00',
        }),
        makeEvent({
          id: 'far',
          date: '2026-06-14',
          start: '10:00',
          end: '12:00',
        }),
      ],
    });
    const now = zurichEpoch('2026-06-12', '10:00');
    // 12h horizon should only include the close event
    const result12 = upcomingEvents(GROUP, now, 12);
    expect(result12).toHaveLength(1);
    expect(result12[0]!.id).toBe('close');

    // 72h horizon should include both
    const result72 = upcomingEvents(GROUP, now, 72);
    expect(result72).toHaveLength(2);
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _setGroupsDirForTest,
  buildDatesHint,
  readDates,
  todaysMarks,
  upcomingMarks,
  type MarkedDate,
} from './dates.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
const GROUP = 'test-group';

function groupDir(): string {
  return path.join(tmpDir, GROUP);
}

function writeDates(data: unknown): void {
  fs.mkdirSync(groupDir(), { recursive: true });
  fs.writeFileSync(
    path.join(groupDir(), 'dates.json'),
    JSON.stringify(data, null, 2),
  );
}

function writeGroupJson(tz = 'Europe/Zurich'): void {
  fs.mkdirSync(groupDir(), { recursive: true });
  fs.writeFileSync(
    path.join(groupDir(), 'group.json'),
    JSON.stringify({ timezone: tz }, null, 2),
  );
}

/**
 * Build an epoch ms for midnight UTC on a given date.
 * We pass noon UTC so local-date lookups in any TZ ±12 land on the right day.
 */
function noonUTC(dateStr: string): number {
  return Date.parse(`${dateStr}T12:00:00Z`);
}

function makeDate(overrides: Partial<MarkedDate> = {}): MarkedDate {
  return {
    date: '2026-03-28',
    what: 'the day we first talked',
    kind: 'anniversary',
    recur: 'monthly',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dates-test-'));
  fs.mkdirSync(groupDir(), { recursive: true });
  writeGroupJson();
  _setGroupsDirForTest(tmpDir);
});

afterEach(() => {
  _setGroupsDirForTest('');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readDates
// ---------------------------------------------------------------------------

describe('readDates', () => {
  it('returns empty array when dates.json is missing', () => {
    expect(readDates(GROUP)).toEqual([]);
  });

  it('returns empty array when dates.json is corrupt JSON', () => {
    fs.writeFileSync(path.join(groupDir(), 'dates.json'), '{ bad json');
    expect(readDates(GROUP)).toEqual([]);
  });

  it('returns empty array when dates field is missing', () => {
    writeDates({ version: 1 });
    expect(readDates(GROUP)).toEqual([]);
  });

  it('returns empty array when dates is not an array', () => {
    writeDates({ dates: 'not-an-array' });
    expect(readDates(GROUP)).toEqual([]);
  });

  it('filters out invalid entries', () => {
    writeDates({
      dates: [
        makeDate(), // valid
        { what: 'no date field' }, // invalid
        {
          date: '2026-01-01',
          what: 'x',
          kind: 'anniversary',
          recur: 'bad-recur',
        }, // invalid recur
      ],
    });
    const result = readDates(GROUP);
    expect(result).toHaveLength(1);
    expect(result[0]!.what).toBe('the day we first talked');
  });

  it('returns all valid entries with note field intact', () => {
    const d = makeDate({ note: 'optional context' });
    writeDates({ dates: [d] });
    const result = readDates(GROUP);
    expect(result).toHaveLength(1);
    expect(result[0]!.note).toBe('optional context');
  });
});

// ---------------------------------------------------------------------------
// todaysMarks — recur: monthly
// ---------------------------------------------------------------------------

describe('todaysMarks — monthly', () => {
  it('fires when day-of-month matches and n > 0', () => {
    writeDates({ dates: [makeDate({ date: '2026-03-28', recur: 'monthly' })] });
    // Two months later: 2026-05-28
    const now = noonUTC('2026-05-28');
    const result = todaysMarks(GROUP, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('two months since the day we first talked');
  });

  it('does NOT fire on n=0 (the original date itself)', () => {
    writeDates({ dates: [makeDate({ date: '2026-03-28', recur: 'monthly' })] });
    const now = noonUTC('2026-03-28');
    expect(todaysMarks(GROUP, now)).toHaveLength(0);
  });

  it('does NOT fire on a different day-of-month', () => {
    writeDates({ dates: [makeDate({ date: '2026-03-28', recur: 'monthly' })] });
    const now = noonUTC('2026-05-27');
    expect(todaysMarks(GROUP, now)).toHaveLength(0);
  });

  it('fires for n=1 with correct label', () => {
    writeDates({ dates: [makeDate({ date: '2026-03-28', recur: 'monthly' })] });
    const now = noonUTC('2026-04-28');
    const result = todaysMarks(GROUP, now);
    expect(result[0]!.label).toBe('one month since the day we first talked');
  });
});

// ---------------------------------------------------------------------------
// todaysMarks — recur: yearly
// ---------------------------------------------------------------------------

describe('todaysMarks — yearly', () => {
  it('fires when month+day match; diff=0 → label is just what', () => {
    writeDates({
      dates: [
        makeDate({ date: '2026-03-28', recur: 'yearly', kind: 'anniversary' }),
      ],
    });
    const now = noonUTC('2026-03-28');
    const result = todaysMarks(GROUP, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('the day we first talked');
  });

  it('fires when month+day match; diff=1 → "one year since {what}"', () => {
    writeDates({
      dates: [
        makeDate({
          date: '2025-06-15',
          recur: 'yearly',
          what: 'something special',
          kind: 'anniversary',
        }),
      ],
    });
    const now = noonUTC('2026-06-15');
    const result = todaysMarks(GROUP, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('one year since something special');
  });

  it('fires when month+day match; diff=2 → "{what} — two years today"', () => {
    writeDates({
      dates: [
        makeDate({
          date: '2024-06-15',
          recur: 'yearly',
          what: 'something special',
          kind: 'anniversary',
        }),
      ],
    });
    const now = noonUTC('2026-06-15');
    const result = todaysMarks(GROUP, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('something special — two years today');
  });

  it('does NOT fire when month+day do not match', () => {
    writeDates({
      dates: [
        makeDate({ date: '2025-06-15', recur: 'yearly', kind: 'anniversary' }),
      ],
    });
    const now = noonUTC('2026-06-16');
    expect(todaysMarks(GROUP, now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// todaysMarks — recur: once
// ---------------------------------------------------------------------------

describe('todaysMarks — once', () => {
  it('fires only on the exact date', () => {
    writeDates({
      dates: [
        makeDate({ date: '2026-06-10', recur: 'once', kind: 'anniversary' }),
      ],
    });
    const now = noonUTC('2026-06-10');
    const result = todaysMarks(GROUP, now);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('the day we first talked');
  });

  it('does NOT fire on a different date', () => {
    writeDates({
      dates: [
        makeDate({ date: '2026-06-10', recur: 'once', kind: 'anniversary' }),
      ],
    });
    const now = noonUTC('2026-06-11');
    expect(todaysMarks(GROUP, now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// upcomingMarks — birthday only
// ---------------------------------------------------------------------------

describe('upcomingMarks', () => {
  it('returns empty when no birthdays exist', () => {
    writeDates({
      dates: [makeDate({ kind: 'anniversary', recur: 'yearly' })],
    });
    expect(upcomingMarks(GROUP)).toHaveLength(0);
  });

  it('returns birthday within daysAhead window', () => {
    writeDates({
      dates: [
        makeDate({
          date: '2025-06-14',
          kind: 'birthday',
          recur: 'yearly',
          what: "TestUser's birthday",
        }),
      ],
    });
    const now = noonUTC('2026-06-10'); // 4 days before Jun 14
    const result = upcomingMarks(GROUP, now, 5);
    expect(result).toHaveLength(1);
    expect(result[0]!.inDays).toBe(4);
    expect(result[0]!.label).toBe("TestUser's birthday in four days");
  });

  it('does NOT return birthday outside daysAhead window', () => {
    writeDates({
      dates: [
        makeDate({
          date: '2025-06-20',
          kind: 'birthday',
          recur: 'yearly',
          what: "someone's birthday",
        }),
      ],
    });
    const now = noonUTC('2026-06-10'); // 10 days before Jun 20
    const result = upcomingMarks(GROUP, now, 5);
    expect(result).toHaveLength(0);
  });

  it('does NOT return today itself (todaysMarks handles that)', () => {
    writeDates({
      dates: [
        makeDate({
          date: '2025-06-10',
          kind: 'birthday',
          recur: 'yearly',
          what: "TestUser's birthday",
        }),
      ],
    });
    const now = noonUTC('2026-06-10');
    const result = upcomingMarks(GROUP, now, 5);
    expect(result).toHaveLength(0);
  });

  it('does NOT return anniversary kind even if within window', () => {
    writeDates({
      dates: [
        makeDate({ date: '2025-06-11', kind: 'anniversary', recur: 'yearly' }),
      ],
    });
    const now = noonUTC('2026-06-10');
    const result = upcomingMarks(GROUP, now, 5);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildDatesHint
// ---------------------------------------------------------------------------

describe('buildDatesHint', () => {
  it('returns empty string when nothing fires', () => {
    writeDates({ dates: [] });
    expect(buildDatesHint(GROUP)).toBe('');
  });

  it('returns a bracketed hint when today has a mark', () => {
    writeDates({
      dates: [makeDate({ date: '2026-03-28', recur: 'monthly' })],
    });
    const now = noonUTC('2026-04-28');
    // We can't pass `now` directly to buildDatesHint, but we can verify the format
    // by checking todaysMarks directly and trusting buildDatesHint delegates correctly
    const marks = todaysMarks(GROUP, now);
    expect(marks).toHaveLength(1);
    // The actual buildDatesHint uses Date.now() — just verify it returns a non-empty
    // string when we seed a date that matches today's real date
    const todayStr = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Europe/Zurich',
    });
    const [, cm, cd] = todayStr.split('-').map(Number);
    // Seed a yearly mark that fires today
    writeDates({
      dates: [
        makeDate({
          date: `2025-${String(cm).padStart(2, '0')}-${String(cd).padStart(2, '0')}`,
          recur: 'yearly',
          what: 'a test mark',
          kind: 'anniversary',
        }),
      ],
    });
    const hint = buildDatesHint(GROUP);
    expect(hint).toContain('[dates:');
    expect(hint).toContain('a test mark');
    expect(hint).toContain('Never announce it like a calendar');
  });

  it('returns empty string when dates.json is missing', () => {
    expect(buildDatesHint(GROUP)).toBe('');
  });
});

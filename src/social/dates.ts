/**
 * Dates awareness — reads groups/{folder}/dates.json and surfaces anniversaries,
 * birthdays, and marked days as context hints for the per-message prefix.
 *
 * All functions are synchronous and defensive: a missing or corrupt file
 * always returns an empty array / empty string.
 */

import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';

// ---------------------------------------------------------------------------
// Test hook — overrides the base groups directory (mirrors calendar.ts pattern)
// ---------------------------------------------------------------------------

let _groupsDirOverride: string | null = null;

export function _setGroupsDirForTest(dir: string): void {
  _groupsDirOverride = dir;
}

function getGroupsDir(): string {
  return _groupsDirOverride ?? GROUPS_DIR;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MarkedDate {
  date: string; // YYYY-MM-DD — the original/reference date
  what: string; // human label, e.g. "the day we first talked"
  kind: string; // "anniversary" | "birthday" | anything else
  recur: 'monthly' | 'yearly' | 'once';
  note?: string; // optional detail, never surfaced directly
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

function datesPath(groupFolder: string): string {
  return path.join(getGroupsDir(), groupFolder, 'dates.json');
}

interface DatesFile {
  dates?: unknown[];
}

function isValidMarkedDate(e: unknown): e is MarkedDate {
  if (!e || typeof e !== 'object') return false;
  const m = e as Record<string, unknown>;
  return (
    typeof m['date'] === 'string' &&
    typeof m['what'] === 'string' &&
    typeof m['kind'] === 'string' &&
    (m['recur'] === 'monthly' ||
      m['recur'] === 'yearly' ||
      m['recur'] === 'once')
  );
}

/**
 * Read all marked dates from groups/{folder}/dates.json.
 * Missing or corrupt file → returns [].
 */
export function readDates(groupFolder: string): MarkedDate[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(datesPath(groupFolder), 'utf-8'),
    ) as DatesFile;
    if (!Array.isArray(raw.dates)) return [];
    return raw.dates.filter(isValidMarkedDate);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Timezone helper (mirrors calendar.ts — read group.json, default Europe/Zurich)
// ---------------------------------------------------------------------------

function readGroupTimezone(groupFolder: string): string {
  try {
    const p = path.join(getGroupsDir(), groupFolder, 'group.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      timezone?: string;
    };
    if (typeof raw.timezone === 'string' && raw.timezone) return raw.timezone;
  } catch {
    /* fall through */
  }
  return 'Europe/Zurich';
}

/**
 * Return the local YYYY-MM-DD date string for a given epoch in the group's timezone.
 */
function localDateStr(epochMs: number, timezone: string): string {
  return new Date(epochMs).toLocaleDateString('en-CA', { timeZone: timezone });
}

// ---------------------------------------------------------------------------
// Ordinal / verbal helpers
// ---------------------------------------------------------------------------

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

/** Convert a positive integer to a lowercase English word, e.g. 3 → "three". */
function toWords(n: number): string {
  if (n <= 0) return String(n);
  if (n < 20) return ONES[n] ?? String(n);
  const tens = Math.floor(n / 10);
  const rem = n % 10;
  const tenWord = TENS[tens] ?? '';
  if (rem === 0) return tenWord;
  return `${tenWord}-${ONES[rem] ?? rem}`;
}

// ---------------------------------------------------------------------------
// Core matchers
// ---------------------------------------------------------------------------

interface TodayResult {
  mark: MarkedDate;
  label: string;
}

interface UpcomingResult {
  mark: MarkedDate;
  inDays: number;
  label: string;
}

/**
 * Returns all dates whose recurrence rule fires on the local calendar date
 * corresponding to `now` (defaults to Date.now()).
 *
 * Labels:
 * - yearly:  "one year since {what}" / "{what} — two years today" / "{what}" (year diff 0)
 * - monthly: "{n} months since {what}" (n=0 skipped, i.e. the original date itself)
 * - once:    matches only the exact date; label = "{what}"
 */
export function todaysMarks(groupFolder: string, now?: number): TodayResult[] {
  const ts = now ?? Date.now();
  const tz = readGroupTimezone(groupFolder);
  const todayStr = localDateStr(ts, tz); // YYYY-MM-DD
  const [tyStr, tmStr, tdStr] = todayStr.split('-');
  const todayYear = parseInt(tyStr ?? '0', 10);
  const todayMonth = parseInt(tmStr ?? '0', 10);
  const todayDay = parseInt(tdStr ?? '0', 10);

  const results: TodayResult[] = [];

  for (const mark of readDates(groupFolder)) {
    const [oy, om, od] = mark.date.split('-').map(Number);
    if (oy === undefined || om === undefined || od === undefined) continue;

    if (mark.recur === 'once') {
      if (mark.date === todayStr) {
        results.push({ mark, label: mark.what });
      }
    } else if (mark.recur === 'yearly') {
      if (om === todayMonth && od === todayDay) {
        const diff = todayYear - oy;
        if (diff < 0) continue;
        let label: string;
        if (diff === 0) {
          label = mark.what;
        } else if (diff === 1) {
          label = `one year since ${mark.what}`;
        } else {
          label = `${mark.what} — ${toWords(diff)} years today`;
        }
        results.push({ mark, label });
      }
    } else if (mark.recur === 'monthly') {
      if (od === todayDay) {
        // Compute full months elapsed
        const monthDiff = (todayYear - oy) * 12 + (todayMonth - om);
        if (monthDiff <= 0) continue; // skip n=0 (the original date) and negatives
        const monthWord = monthDiff === 1 ? 'month' : 'months';
        const label = `${toWords(monthDiff)} ${monthWord} since ${mark.what}`;
        results.push({ mark, label });
      }
    }
  }

  return results;
}

/**
 * Returns upcoming birthdays (kind === 'birthday') within `daysAhead` days
 * (default 5). Only 'birthday' kind is pre-announced; ordinary anniversaries
 * are not.
 *
 * Label: "{what} in {n} days"
 */
export function upcomingMarks(
  groupFolder: string,
  now?: number,
  daysAhead = 5,
): UpcomingResult[] {
  const ts = now ?? Date.now();
  const tz = readGroupTimezone(groupFolder);
  const todayStr = localDateStr(ts, tz);
  const [tyStr, tmStr, tdStr] = todayStr.split('-');
  const todayYear = parseInt(tyStr ?? '0', 10);
  const todayMonth = parseInt(tmStr ?? '0', 10);
  const todayDay = parseInt(tdStr ?? '0', 10);

  const results: UpcomingResult[] = [];

  for (const mark of readDates(groupFolder)) {
    if (mark.kind !== 'birthday') continue;

    const [, om, od] = mark.date.split('-').map(Number);
    if (om === undefined || od === undefined) continue;

    // Find the next occurrence of this month/day from tomorrow onwards
    // Try this calendar year and next
    for (const yearOffset of [0, 1]) {
      const candidateYear = todayYear + yearOffset;
      // Build a candidate date — skip if month lacks the day (e.g. Feb 30)
      const candidateStr = `${candidateYear}-${String(om).padStart(2, '0')}-${String(od).padStart(2, '0')}`;
      const [, , cdStr] = candidateStr.split('-');
      // Verify the day is real (JS Date normalises invalid dates)
      const probe = new Date(`${candidateStr}T12:00:00Z`);
      if (probe.getUTCDate() !== parseInt(cdStr ?? '0', 10)) continue;

      // Compute delta in days (use local-date arithmetic to avoid TZ issues)
      const [cyStr, cmStr, cdStr2] = candidateStr.split('-');
      const candidateYear2 = parseInt(cyStr ?? '0', 10);
      const candidateMonth = parseInt(cmStr ?? '0', 10);
      const candidateDay = parseInt(cdStr2 ?? '0', 10);

      // Total days from today (ignoring time-of-day)
      const deltaDays =
        (candidateYear2 - todayYear) * 365 +
        (candidateMonth - todayMonth) * 30 +
        (candidateDay - todayDay);

      // Use epoch difference for accuracy
      const todayNoon = Date.UTC(todayYear, todayMonth - 1, todayDay, 12, 0, 0);
      const candidateNoon = Date.UTC(
        candidateYear2,
        candidateMonth - 1,
        candidateDay,
        12,
        0,
        0,
      );
      const accurateDelta = Math.round(
        (candidateNoon - todayNoon) / (24 * 60 * 60 * 1000),
      );

      if (accurateDelta <= 0) continue; // today or past — todaysMarks handles today
      if (accurateDelta > daysAhead) break; // sorted by year so we can break

      results.push({
        mark,
        inDays: accurateDelta,
        label: `${mark.what} in ${toWords(accurateDelta)} days`,
      });
      break; // found the next occurrence for this mark
    }
  }

  // Sort by inDays ascending
  results.sort((a, b) => a.inDays - b.inDays);
  return results;
}

// ---------------------------------------------------------------------------
// Context hint builder (called from context-builder.ts)
// ---------------------------------------------------------------------------

/**
 * Build the [dates: ...] hint block for the per-message prefix.
 *
 * Returns an empty string when nothing fires (the common case — no hint
 * injected, no overhead visible to the model).
 */
export function buildDatesHint(groupFolder: string): string {
  const today = todaysMarks(groupFolder);
  const upcoming = upcomingMarks(groupFolder);

  const parts: string[] = [];

  for (const { label } of today) {
    parts.push(`today marks — ${label}`);
  }
  for (const { label } of upcoming) {
    parts.push(label);
  }

  if (parts.length === 0) return '';

  const list = parts.join('; ');
  return (
    `[dates: ${list}. ` +
    `Carry it the way a person does: maybe mention it once if the moment fits, ` +
    `maybe just let it color you. Never announce it like a calendar.]`
  );
}

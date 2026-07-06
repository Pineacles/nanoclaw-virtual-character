/**
 * Social calendar — reads groups/{folder}/social/calendar.json and provides
 * pure, defensive helpers to query events relative to now.
 * All functions are synchronous, pure-ish (fs reads allowed, no side-effects).
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';

// ---------------------------------------------------------------------------
// Test hook — overrides the base groups directory (mirrors engine.ts pattern)
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

export type EventStatus = 'planned' | 'confirmed' | 'cancelled' | 'done';

export interface SocialEvent {
  id: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM (local, group timezone)
  end: string; // HH:MM (local, group timezone)
  who: string;
  what: string;
  where?: string;
  status: EventStatus;
  phone_ok: boolean;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Timezone helpers (re-implemented locally — no dependency on engine internals)
// ---------------------------------------------------------------------------

/**
 * Returns the group's timezone from group.json, defaulting to Europe/Zurich.
 */
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
 * Parses a local date+time string (YYYY-MM-DD HH:MM) in the given timezone
 * and returns the corresponding epoch ms.
 *
 * Strategy: format a reference UTC epoch as local clock in the target TZ,
 * compute the offset at that point, then apply it to reconstruct epoch ms.
 */
function localToEpoch(
  date: string,
  hhmm: string,
  timezone: string,
): number | null {
  // Try a naive parse first to get a reasonable starting point
  const naive = Date.parse(`${date}T${hhmm}:00Z`);
  if (isNaN(naive)) return null;

  // Get the UTC offset at the naive epoch (close enough for any real timezone)
  const offsetMs = localUtcOffsetMs(naive, timezone);

  // epoch = local_clock_as_utc - offset
  return naive - offsetMs;
}

function localUtcOffsetMs(epochMs: number, timezone: string): number {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const s = fmt.format(new Date(epochMs));
  // en-CA gives "YYYY-MM-DD, HH:MM"
  const localMs = Date.parse(s.replace(', ', 'T') + ':00Z');
  if (isNaN(localMs)) return 0;
  return Math.round(localMs - epochMs);
}

// ---------------------------------------------------------------------------
// Calendar file reading
// ---------------------------------------------------------------------------

function calendarPath(groupFolder: string): string {
  return path.join(getGroupsDir(), groupFolder, 'social', 'calendar.json');
}

interface CalendarFile {
  events?: unknown[];
}

/**
 * Read and return all events from groups/{folder}/social/calendar.json.
 * Missing or corrupt file → returns empty array (fail-open).
 */
export function readCalendar(groupFolder: string): SocialEvent[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(calendarPath(groupFolder), 'utf-8'),
    ) as CalendarFile;
    if (!Array.isArray(raw.events)) return [];

    return raw.events.filter(isValidEvent);
  } catch {
    return [];
  }
}

function isValidEvent(e: unknown): e is SocialEvent {
  if (!e || typeof e !== 'object') return false;
  const ev = e as Record<string, unknown>;
  return (
    typeof ev['id'] === 'string' &&
    typeof ev['date'] === 'string' &&
    typeof ev['start'] === 'string' &&
    typeof ev['end'] === 'string' &&
    typeof ev['who'] === 'string' &&
    typeof ev['what'] === 'string' &&
    typeof ev['status'] === 'string' &&
    ['planned', 'confirmed', 'cancelled', 'done'].includes(
      ev['status'] as string,
    ) &&
    typeof ev['phone_ok'] === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Returns the event whose [start, end) window contains `now`, if any.
 * Only considers events with status 'confirmed' or 'planned'.
 */
export function currentEvent(
  groupFolder: string,
  now?: number,
): SocialEvent | null {
  const ts = now ?? Date.now();
  const tz = readGroupTimezone(groupFolder);
  const events = readCalendar(groupFolder);

  for (const ev of events) {
    if (ev.status !== 'confirmed' && ev.status !== 'planned') continue;

    const startEpoch = localToEpoch(ev.date, ev.start, tz);
    const endEpoch = localToEpoch(ev.date, ev.end, tz);
    if (startEpoch === null || endEpoch === null) continue;

    if (ts >= startEpoch && ts < endEpoch) {
      return ev;
    }
  }
  return null;
}

/**
 * Returns upcoming events within the next `horizonHours` hours (default 36),
 * sorted ascending by start time. Excludes cancelled and done events.
 */
export function upcomingEvents(
  groupFolder: string,
  now?: number,
  horizonHours = 36,
): SocialEvent[] {
  const ts = now ?? Date.now();
  const tz = readGroupTimezone(groupFolder);
  const events = readCalendar(groupFolder);
  const cutoff = ts + horizonHours * 60 * 60_000;

  const result: Array<{ event: SocialEvent; startEpoch: number }> = [];

  for (const ev of events) {
    if (ev.status === 'cancelled' || ev.status === 'done') continue;

    const startEpoch = localToEpoch(ev.date, ev.start, tz);
    if (startEpoch === null) continue;

    // Only events that start in the future and within the horizon
    if (startEpoch > ts && startEpoch <= cutoff) {
      result.push({ event: ev, startEpoch });
    }
  }

  result.sort((a, b) => a.startEpoch - b.startEpoch);
  return result.map((r) => r.event);
}

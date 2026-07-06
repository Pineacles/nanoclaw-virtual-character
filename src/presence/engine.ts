/**
 * Presence engine — pure-ish computation of the assistant's current online state.
 * All randomness is deterministic (same inputs → same outputs).
 * fs reads are allowed; no timers or side-effects.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { currentEvent } from '../social/calendar.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PresenceState = 'online' | 'away' | 'sleeping' | 'offline';

export interface Presence {
  state: PresenceState;
  /** ISO string of when she was last "online", null if unknown. Equal to now when state==='online'. */
  lastSeenAt: string | null;
  /** epoch ms of the next moment she'd plausibly be online; null if online now */
  nextOnlineAt: number | null;
  /** Why she is away/offline: 'schedule' = mood-slot-based, 'event' = social calendar event */
  reason?: 'schedule' | 'event';
  /** Short human-readable activity hint (e.g. "out — dinner with Mia") */
  activityHint?: string;
}

// ---------------------------------------------------------------------------
// Test hook — overrides the base groups directory
// ---------------------------------------------------------------------------

let _groupsDirOverride: string | null = null;

export function _setGroupsDirForTest(dir: string): void {
  _groupsDirOverride = dir;
  // Flush caches so tests get a clean slate
  _groupJsonCache.clear();
  _moodJsonCache.clear();
}

function getGroupsDir(): string {
  return _groupsDirOverride ?? GROUPS_DIR;
}

// ---------------------------------------------------------------------------
// group.json reading + feature flag cache
// ---------------------------------------------------------------------------

interface GroupJson {
  timezone?: string;
  features?: Record<string, boolean>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const _groupJsonCache = new Map<string, CacheEntry<GroupJson>>();
const _moodJsonCache = new Map<string, CacheEntry<MoodJson | null>>();

const GROUP_JSON_TTL_MS = 60_000;

function readGroupJson(groupFolder: string): GroupJson {
  const now = Date.now();
  const cached = _groupJsonCache.get(groupFolder);
  if (cached && now < cached.expiresAt) return cached.value;

  let value: GroupJson = {};
  try {
    const p = path.join(getGroupsDir(), groupFolder, 'group.json');
    value = JSON.parse(fs.readFileSync(p, 'utf-8')) as GroupJson;
  } catch {
    /* missing or corrupt → empty */
  }
  _groupJsonCache.set(groupFolder, {
    value,
    expiresAt: now + GROUP_JSON_TTL_MS,
  });
  return value;
}

export function readGroupFeature(
  groupFolder: string,
  feature: string,
): boolean {
  try {
    const gj = readGroupJson(groupFolder);
    return gj?.features?.[feature] === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// mood.json reading (no cache — callers pass `now` for determinism)
// ---------------------------------------------------------------------------

interface MoodSlot {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  primary: string;
  distribution?: Record<string, number>;
  energy?: number;
  notes?: string;
}

interface MoodJson {
  date?: string;
  slots?: MoodSlot[];
}

function readMoodJson(groupFolder: string): MoodJson | null {
  try {
    const p = path.join(getGroupsDir(), groupFolder, 'mood.json');
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MoodJson;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

function getGroupTimezone(groupFolder: string): string {
  try {
    const gj = readGroupJson(groupFolder);
    if (typeof gj.timezone === 'string' && gj.timezone) return gj.timezone;
  } catch {
    /* fall through */
  }
  return 'Europe/Zurich';
}

/**
 * Returns { localDate, localHHMM, epochMinutesLocal, windowOfDay } for a given
 * epoch ms in the given timezone.
 * - epochMinutesLocal: absolute local minutes (used for backward/forward walks)
 * - windowOfDay: 0–95, which 15-min window within the local day this falls into
 *   (used as the windowIndex seed so that seeds differ meaningfully across windows)
 */
function localTimeParts(
  epochMs: number,
  timezone: string,
): {
  localDate: string;
  localHHMM: string;
  epochMinutesLocal: number;
  windowOfDay: number;
} {
  // Use Intl.DateTimeFormat to extract components reliably
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(new Date(epochMs));
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');

  const localDate = `${year}-${month}-${day}`;
  const localHHMM = `${hour}:${minute}`;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  // 0–95: which 15-min window of the day (gives good hash diversity)
  const windowOfDay = Math.floor((h * 60 + m) / 15);

  // epochMinutesLocal: absolute local minutes since epoch start
  const totalLocalMinutes =
    Math.floor(epochMs / 60_000) + localUtcOffsetMinutes(epochMs, timezone);

  return {
    localDate,
    localHHMM,
    epochMinutesLocal: totalLocalMinutes,
    windowOfDay,
  };
}

/**
 * Approximate UTC offset in minutes for a timezone at a given epoch.
 * We derive this by comparing a UTC reference to a local-clock reference.
 */
function localUtcOffsetMinutes(epochMs: number, timezone: string): number {
  // Format just year+month+day+hour+minute in the target TZ, then reconstruct
  // as if it were UTC → difference = offset
  const localFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const localStr = localFmt.format(new Date(epochMs));
  // en-CA gives "YYYY-MM-DD, HH:MM" or similar — parse it
  const localMs = Date.parse(localStr.replace(', ', 'T') + ':00Z');
  if (isNaN(localMs)) return 0;
  return Math.round((localMs - epochMs) / 60_000);
}

/**
 * Convert a local date (YYYY-MM-DD) + time (HH:MM) in the given timezone to
 * epoch ms.  Returns null if the inputs are unparseable.
 *
 * Uses the same offset trick as calendar.ts — works for any IANA timezone.
 */
function localDateTimeToEpoch(
  date: string,
  hhmm: string,
  timezone: string,
): number | null {
  const naive = Date.parse(`${date}T${hhmm}:00Z`);
  if (isNaN(naive)) return null;
  const offsetMs = localUtcOffsetMinutes(naive, timezone) * 60_000;
  return naive - offsetMs;
}

// ---------------------------------------------------------------------------
// Slot matching
// ---------------------------------------------------------------------------

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function findSlot(slots: MoodSlot[], localHHMM: string): MoodSlot | null {
  const nowMin = timeToMinutes(localHHMM);
  let best: MoodSlot | null = null;
  for (const slot of slots) {
    const startMin = timeToMinutes(slot.start);
    // treat "23:59" end as end-of-day inclusive (i.e., 23:59 counts as covering 23:59)
    const endMin = slot.end === '23:59' ? 24 * 60 : timeToMinutes(slot.end);
    if (nowMin >= startMin && nowMin < endMin) {
      best = slot;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Deterministic hash (FNV-1a 32-bit) → fraction [0, 1)
// FNV-1a has strong avalanche: changing one bit in input changes ~half output bits.
// ---------------------------------------------------------------------------

function fnv1a32(s: string): number {
  // FNV-1a 32-bit: prime=16777619, offset=2166136261
  let h = 2166136261; // FNV offset basis (unsigned)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // multiply by FNV prime, keep unsigned 32-bit
  }
  return h;
}

function windowFraction(
  groupFolder: string,
  localDate: string,
  windowIndex: number,
): number {
  const seed = `${groupFolder}|${localDate}|${windowIndex}`;
  return fnv1a32(seed) / 0x100000000; // [0, 1)
}

// ---------------------------------------------------------------------------
// Window-level state evaluation
// ---------------------------------------------------------------------------

type WindowState = 'online' | 'away' | 'sleeping';

/**
 * Evaluate the state for a single 15-minute window.
 * windowOfDay: 0–95 (which window within the local day — provides good hash diversity).
 */
function evalWindow(
  groupFolder: string,
  localDate: string,
  windowOfDay: number,
  slot: MoodSlot,
): WindowState {
  const frac = windowFraction(groupFolder, localDate, windowOfDay);
  const sleepShare = slot.distribution?.['sleeping'] ?? 0;

  if (sleepShare >= 50) {
    // Late-night phone scroll / insomnia probability
    return frac < 0.12 ? 'online' : 'sleeping';
  }

  // Awake slot — use energy to determine away probability
  const energy = slot.energy ?? 5;
  let awayProb: number;
  if (energy >= 7) awayProb = 0.12;
  else if (energy >= 5) awayProb = 0.22;
  else if (energy >= 3) awayProb = 0.35;
  else awayProb = 0.5;

  return frac < awayProb ? 'away' : 'online';
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

const WINDOW_MS = 15 * 60_000; // 15 minutes
const RECENT_ACTIVITY_WINDOW_MS = 4 * 60_000; // 4 minutes

export function computePresence(
  groupFolder: string,
  opts?: { now?: number; recentActivityAt?: number | null },
): Presence {
  const now = opts?.now ?? Date.now();

  // Recent activity → forced online
  if (
    opts?.recentActivityAt != null &&
    now - opts.recentActivityAt <= RECENT_ACTIVITY_WINDOW_MS
  ) {
    return {
      state: 'online',
      lastSeenAt: new Date(now).toISOString(),
      nextOnlineAt: null,
    };
  }

  // Social calendar event — if social_sim is enabled and there is a current
  // confirmed/planned event, she is away for the duration of that event.
  // Events only make her LESS available — they never force online.
  if (readGroupFeature(groupFolder, 'social_sim')) {
    try {
      const ev = currentEvent(groupFolder, now);
      if (ev) {
        // Compute event end epoch so we can set nextOnlineAt
        const tz = getGroupTimezone(groupFolder);
        const endEpoch = localDateTimeToEpoch(ev.date, ev.end, tz);

        // Deterministic jitter 5–15 min after event end (seed: groupFolder+date+start)
        const jitterSeed = `${groupFolder}|event-end|${ev.date}|${ev.start}`;
        const jitterFrac = fnv1a32(jitterSeed) / 0x100000000;
        const jitterMs = Math.floor(5 * 60_000 + jitterFrac * 10 * 60_000);
        const nextOnlineAt =
          endEpoch !== null ? endEpoch + jitterMs : now + 90 * 60_000;

        // lastSeenAt: if phone_ok, a deterministic point within the last 45 min
        // (she glanced at her phone); otherwise the event start time.
        let lastSeenAt: string | null;
        if (ev.phone_ok) {
          const glanceSeed = `${groupFolder}|event-glance|${ev.date}|${ev.start}`;
          const glanceFrac = fnv1a32(glanceSeed) / 0x100000000;
          const glanceOffsetMs = Math.floor(glanceFrac * 45 * 60_000);
          lastSeenAt = new Date(now - glanceOffsetMs).toISOString();
        } else {
          const startEpoch = localDateTimeToEpoch(ev.date, ev.start, tz);
          lastSeenAt =
            startEpoch !== null
              ? new Date(startEpoch).toISOString()
              : new Date(now).toISOString();
        }

        return {
          state: 'away',
          lastSeenAt,
          nextOnlineAt,
          reason: 'event',
          activityHint: `out — ${ev.what} with ${ev.who}`,
        };
      }
    } catch {
      /* calendar unreadable — fall through to mood-slot logic */
    }
  }

  // Load mood.json — fail open
  const mood = readMoodJson(groupFolder);
  if (!mood || !Array.isArray(mood.slots) || mood.slots.length === 0) {
    return {
      state: 'online',
      lastSeenAt: new Date(now).toISOString(),
      nextOnlineAt: null,
    };
  }

  const timezone = getGroupTimezone(groupFolder);
  const { localDate, localHHMM, epochMinutesLocal, windowOfDay } =
    localTimeParts(now, timezone);

  // Find current slot
  const currentSlot = findSlot(mood.slots, localHHMM);
  if (!currentSlot) {
    // No slot matches → fail open
    return {
      state: 'online',
      lastSeenAt: new Date(now).toISOString(),
      nextOnlineAt: null,
    };
  }

  const currentWindowState = evalWindow(
    groupFolder,
    localDate,
    windowOfDay,
    currentSlot,
  );

  // Map to PresenceState
  const state: PresenceState =
    currentWindowState === 'sleeping'
      ? 'sleeping'
      : currentWindowState === 'away'
        ? 'away'
        : 'online';

  if (state === 'online') {
    return {
      state: 'online',
      lastSeenAt: new Date(now).toISOString(),
      nextOnlineAt: null,
    };
  }

  // suppress unused variable (epochMinutesLocal only used for absolute walk math)
  void epochMinutesLocal;

  // --- lastSeenAt: walk backward up to 48h ---
  const MAX_BACK_WINDOWS = (48 * 60) / 15; // 192 windows
  let lastSeenAt: string | null = null;

  for (let i = 1; i <= MAX_BACK_WINDOWS; i++) {
    const pastEpochMs = now - i * WINDOW_MS;
    const pastParts = localTimeParts(pastEpochMs, timezone);
    const pastSlot = findSlot(mood.slots, pastParts.localHHMM);
    if (!pastSlot) continue;
    const pastState = evalWindow(
      groupFolder,
      pastParts.localDate,
      pastParts.windowOfDay,
      pastSlot,
    );
    if (pastState === 'online') {
      // lastSeenAt = end of that window, clamped to <= now
      const endOfWindow = Math.min(pastEpochMs + WINDOW_MS, now);
      lastSeenAt = new Date(endOfWindow).toISOString();
      break;
    }
  }

  // --- nextOnlineAt: walk forward up to 24h ---
  const MAX_FWD_WINDOWS = (24 * 60) / 15; // 96 windows
  let nextOnlineAt: number | null = null;

  for (let i = 1; i <= MAX_FWD_WINDOWS; i++) {
    const futureEpochMs = now + i * WINDOW_MS;
    const futureParts = localTimeParts(futureEpochMs, timezone);
    const futureSlot = findSlot(mood.slots, futureParts.localHHMM);
    if (!futureSlot) continue;
    const futureState = evalWindow(
      groupFolder,
      futureParts.localDate,
      futureParts.windowOfDay,
      futureSlot,
    );
    if (futureState === 'online') {
      // Start of that window + deterministic jitter 0–5 min
      const startMs = now + (i - 1) * WINDOW_MS;
      const jitterFrac = windowFraction(
        groupFolder,
        futureParts.localDate,
        futureParts.windowOfDay + 1000,
      );
      const jitterMs = Math.floor(jitterFrac * 5 * 60_000); // 0–5 min
      nextOnlineAt = startMs + jitterMs;
      break;
    }
  }

  if (nextOnlineAt === null) {
    nextOnlineAt = now + 60 * 60_000; // fallback: 1h from now
  }

  return { state, lastSeenAt, nextOnlineAt, reason: 'schedule' };
}

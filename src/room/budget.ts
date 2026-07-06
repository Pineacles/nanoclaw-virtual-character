/**
 * Haiku budget tracker for Phase C.
 * Reads/writes meta.haiku_count_hour + meta.haiku_hour_window_started_at.
 * The window resets every 60 min. When budget exhausted → caller downgrades to deterministic.
 */
import { getMeta, updateMeta } from './store.js';
import { ROOM_TUNING } from './tuning.js';
import { logger } from '../logger.js';

const HOUR_MS = 60 * 60 * 1000;

export interface BudgetState {
  used: number;
  max: number;
  exhausted: boolean;
}

export function getBudgetState(groupFolder: string): BudgetState {
  const meta = getMeta(groupFolder);
  const now = Date.now();

  // Window reset if last_haiku_at is older than 1 hour or never set
  if (
    !meta.last_haiku_at ||
    now - new Date(meta.last_haiku_at).getTime() >= HOUR_MS
  ) {
    // Window has expired — count resets lazily on next consume
    return {
      used: 0,
      max: ROOM_TUNING.HAIKU_CALLS_PER_HOUR_MAX,
      exhausted: false,
    };
  }

  return {
    used: meta.haiku_count_hour,
    max: ROOM_TUNING.HAIKU_CALLS_PER_HOUR_MAX,
    exhausted: meta.haiku_count_hour >= ROOM_TUNING.HAIKU_CALLS_PER_HOUR_MAX,
  };
}

/**
 * Consume one Haiku call from the budget.
 * Returns false if budget exhausted (caller must downgrade).
 * Returns true if consumed OK.
 */
export function consumeHaikuBudget(groupFolder: string): boolean {
  const meta = getMeta(groupFolder);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Check if hour window has expired
  const windowExpired =
    !meta.last_haiku_at ||
    now - new Date(meta.last_haiku_at).getTime() >= HOUR_MS;

  const currentCount = windowExpired ? 0 : meta.haiku_count_hour;

  if (currentCount >= ROOM_TUNING.HAIKU_CALLS_PER_HOUR_MAX) {
    logger.debug(
      {
        groupFolder,
        used: currentCount,
        max: ROOM_TUNING.HAIKU_CALLS_PER_HOUR_MAX,
      },
      'RoomBudget: Haiku budget exhausted, downgrading to deterministic',
    );
    return false;
  }

  updateMeta(groupFolder, {
    last_haiku_at: nowIso,
    haiku_count_hour: currentCount + 1,
  });

  logger.debug(
    {
      groupFolder,
      used: currentCount + 1,
      max: ROOM_TUNING.HAIKU_CALLS_PER_HOUR_MAX,
    },
    'RoomBudget: Haiku call consumed',
  );
  return true;
}

/**
 * Passive drift — deterministic cooling, dormancy, status transitions.
 * Phase B: private_kept probability roll, signature_asymmetry flag, observation-stain decay.
 * No LLM calls. Pure math.
 */
import type { RoomObject, ObjectStatus } from './types.js';
import { getRoomDb } from './store.js';
import { ROOM_TUNING } from './tuning.js';

// Average pulse interval used for the draft grace period (4 min)
const AVG_PULSE_MS = 4 * 60 * 1000;

// Tuning constants
const COOLING_RATE = 0.97; // heat multiplier per pulse
const STICKY_DAMPENING = 0.35; // how much stickiness slows cooling
const DORMANCY_CREEP = 0.05; // dormancy increase per pulse when heat < 0.1
const DORMANCY_CREEP_WARM = 0.005; // dormancy creep when heat >= 0.1
const DORMANT_THRESHOLD = 0.1; // heat below which dormancy accelerates
const ACTIVE_TO_COOLING_HEAT = 0.3; // heat below which status → cooling
const COOLING_TO_DORMANT_HEAT = 0.1; // heat below which status → dormant
// How many pulses in dormant state before archiving
const DORMANT_PULSES_TO_ARCHIVE = 20;

/**
 * Apply one pulse of passive drift to a RoomObject.
 * Returns the mutated object (caller should persist).
 */
export function applyDrift(obj: RoomObject, now: string): RoomObject {
  const o = { ...obj };

  // --- Heat cooling ---
  // Skip cooling for fresh queue drafts within the grace window
  const ageMs = new Date(now).getTime() - new Date(o.createdAt).getTime();
  const inGrace =
    o.zone === 'queue' &&
    o.type === 'draft_unsent' &&
    ageMs < ROOM_TUNING.DRAFT_GRACE_PULSES * AVG_PULSE_MS;

  if (!inGrace) {
    const rawNext =
      o.heat * COOLING_RATE * (1 - o.stickiness * STICKY_DAMPENING);
    o.heat = Math.max(o.residual_warmth_floor, rawNext);
  }

  // --- Dormancy creep ---
  const dormancyIncrease =
    o.heat < DORMANT_THRESHOLD ? DORMANCY_CREEP : DORMANCY_CREEP_WARM;
  o.dormancy = Math.min(1, o.dormancy + dormancyIncrease);

  // --- Downgrade stale speakable bleed_class ---
  // Speakable objects that cool below 0.3 should lose speakable status so
  // the runtime doesn't repeatedly fire outbound impulses on stale drafts.
  if (o.bleedClass === 'speakable' && o.heat < 0.3) {
    o.bleedClass = 'sealed';
  }

  // --- Status transitions ---
  const prev = o.status as ObjectStatus;

  if (prev === 'active' && o.heat < ACTIVE_TO_COOLING_HEAT) {
    o.status = 'cooling';
  } else if (prev === 'cooling' && o.heat < COOLING_TO_DORMANT_HEAT) {
    o.status = 'dormant';
    o.dwell_pulses = 0; // reset dwell counter on entering dormancy
  } else if (prev === 'dormant') {
    o.dwell_pulses += 1;
    // Archive if dormant long enough and not protected
    if (
      o.dwell_pulses >= DORMANT_PULSES_TO_ARCHIVE &&
      !o.unerasable &&
      !o.privately_kept
    ) {
      o.status = 'archived';
    }
  }

  // --- Residual warmth floor enforcement ---
  if (o.heat < o.residual_warmth_floor) {
    o.heat = o.residual_warmth_floor;
  }

  // --- Time tracking ---
  o.updatedAt = now;
  // time_total_alive_at is the ISO timestamp when counting started; we store
  // it as the original start time so callers can compute elapsed duration.
  // We do NOT change time_in_zone_started_at here — that resets only on zone change.

  return o;
}

export function shouldSkipDrift(obj: RoomObject): boolean {
  return obj.status === 'archived';
}

const KEPT_REASONS = [
  'sat with',
  'no clear reason',
  'stayed near sticky neighbor',
  'kept turning up',
] as const;

/**
 * Phase B: private_kept probability roll — P=0.02/pulse.
 * Biased toward low-importance + high-stickiness objects.
 * Never un-marks privately_kept once set.
 */
export function rollPrivateKeep(
  groupFolder: string,
  objects: RoomObject[],
): void {
  if (Math.random() > ROOM_TUNING.P_PRIVATE_KEEP) return;

  // Rate cap: if >15% of active objects are already privately_kept, skip this pulse
  const activeObjs = objects.filter((o) => o.status !== 'archived');
  const currentKeptCount = activeObjs.filter((o) => o.privately_kept).length;
  const ratio = currentKeptCount / Math.max(1, activeObjs.length);
  if (ratio > 0.15) return;

  const db = getRoomDb(groupFolder);
  const candidates = objects.filter(
    (o) => o.status !== 'archived' && !o.privately_kept && o.importance < 0.5,
  );
  if (candidates.length === 0) return;

  // Bias: sort by (stickiness - importance), pick from top half
  candidates.sort(
    (a, b) => b.stickiness - b.importance - (a.stickiness - a.importance),
  );
  const pool = candidates.slice(
    0,
    Math.max(1, Math.ceil(candidates.length / 2)),
  );
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  const reason = KEPT_REASONS[Math.floor(Math.random() * KEPT_REASONS.length)];
  db.prepare(
    'UPDATE objects SET privately_kept = 1, kept_reason = ? WHERE id = ?',
  ).run(reason, chosen.id);
}

/**
 * Room tuning constants — isolated module to avoid circular imports.
 * Imported by Phase B mechanics files.
 */
export const ROOM_TUNING = {
  // Cranked for uncanny intensity — defaults noted in comments if you ever need to dial back
  P_NEAR_MISS: 0.7, // default 0.40 — almost every stirring pulse leaves marks
  P_PRIVATE_KEEP: 0.02, // lowered from 0.06 — combined with rate cap keeps count ~10-15%
  CONTAMINATION_MAX_PER_PULSE: 20, // default 10 — neighbors leak harder
  CONTAMINATION_STAIN_MIGRATION_RATE: 0.2, // default 0.10
  CONTAMINATION_HEAT_DRIFT_RATE: 0.12, // default 0.05
  STAIN_PASS_COUNT: 4, // default 2 — atmospheres mark more objects per pulse
  OBSERVATION_STAIN_BUMP: 0.15, // default 0.1 — being looked at leaves a deeper mark
  OBSERVATION_STAIN_DECAY: 0.015, // default 0.02 — stains persist longer
  GHOST_HEAT_DECAY: 0.025, // default 0.05 — ghosts linger twice as long
  GHOST_MIN_HEAT: 0.02, // default 0.05 — ghosts persist longer before deletion
  DWELL_MIN_PULSES: 2, // default 3 — dwell kicks in faster
  CONGESTION_OBJECT_THRESHOLD: 450, // vs LIVE objects only since 2026-06-10 (archived used to count and pinned congestion at true forever); steady state ~320 live, so congestion now means a real spike
  CONGESTION_VISCOSITY_THRESHOLD: 0.5, // default 0.7 — viscous sooner
  WRONG_SIZED_IMPORTANCE_MAX: 0.5, // default 0.4 — more objects qualify as wrong-sized
  WRONG_SIZED_STICKINESS_MIN: 0.55, // default 0.7 — lower bar
  // Phase C: action selection + LLM budget
  HAIKU_CALLS_PER_HOUR_MAX: Number.MAX_SAFE_INTEGER, // unlimited
  P_ASYMMETRY_REROLL: 0.35, // default 0.17 — wrong-sized wins twice as often
  P_ANTI_RESOLUTION_FAIL: 0.6, // default 0.35 — closure more often leaves stranger
  ACTION_PROBABILITY_BASE: 0.3, // dialed back to default — reduce rate of action firing
  ACTION_PROBABILITY_CONGESTION_MULTIPLIER: 0.65, // default 0.5 — congestion slows acting less
  // Impulse event-driven outbound (Phase E)
  P_THINKING_TICK: 0.03,
  MIN_OUTBOUND_GAP_MS: 20 * 60 * 1000, // 20 min between assistant outbounds
  MIN_CONVERSATION_GAP_MS: 5 * 60 * 1000, // 5 min since last message for "no active conversation"
  THINKING_TICK_MIN_GAP_MS: 60 * 60 * 1000, // 1 hr min between thinking ticks
  // Draft warming grace period
  DRAFT_GRACE_PULSES: 4, // new drafts skip cooling for ~16 min (4 × 4min avg pulse)
} as const;

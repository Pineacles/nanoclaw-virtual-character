/**
 * Candidate scoring for Phase C action selection.
 * score = fit(pressure) + novelty + mood_fit + schedule_fit + zone_bias
 *       + persistence_relevance + weirdness_allowance + uncannyValue - recent_touch_penalty
 *
 * Asymmetry reroll (P=0.17): pick from ranks 2-5 biased toward wrong-sized + stained.
 */
import type { RoomObject, PressureState, AtmosphereShape } from './types.js';
import { ROOM_TUNING } from './tuning.js';

export type ActionName =
  | 'rename_drift'
  | 'rewrite_wording'
  | 'create_draft_unsent'
  | 'revise_draft'
  | 'condense_drafts'
  | 'shadow_generation'
  | 'revive'
  | 'archive'
  | 'move'
  | 'merge'
  | 'link'
  | 'unlink'
  | 'mark_privately_kept'
  | 'promote_to_speakable';

export interface ActionCandidate {
  action: ActionName;
  primaryObjectId: string;
  secondaryObjectIds: string[];
  score: number;
  requiresLLM: boolean;
  pressureSource: keyof PressureState | 'standing_draft';
}

const LLM_ACTIONS: Set<ActionName> = new Set([
  'rename_drift',
  'rewrite_wording',
  'create_draft_unsent',
  'revise_draft',
  'condense_drafts',
  'shadow_generation',
]);

export function requiresLLM(action: ActionName): boolean {
  return LLM_ACTIONS.has(action);
}

function zoneScore(obj: RoomObject, action: ActionName): number {
  const zoneMap: Partial<Record<ActionName, string[]>> = {
    rename_drift: ['desk', 'notebook', 'shelf', 'queue'],
    rewrite_wording: ['notebook', 'desk', 'shelf'],
    create_draft_unsent: ['desk', 'queue'],
    revise_draft: ['queue'],
    condense_drafts: ['queue'],
    shadow_generation: ['desk', 'notebook', 'shelf', 'attic'],
    revive: ['archive', 'attic'],
    archive: ['desk', 'notebook'],
    move: ['desk', 'notebook', 'shelf', 'queue', 'mirror'],
    mark_privately_kept: ['desk', 'notebook', 'shelf'],
  };
  const zones = zoneMap[action];
  if (!zones) return 0.3;
  return zones.includes(obj.zone) ? 0.5 : 0.0;
}

function persistenceRelevance(obj: RoomObject): number {
  // High persistence + low heat = good archive/revive candidate
  // High persistence + high heat = good action candidate
  return obj.persistence * 0.3 + obj.heat * 0.2;
}

function weirdnessAllowance(obj: RoomObject, action: ActionName): number {
  if (action === 'shadow_generation') return obj.weirdness * 0.4;
  if (action === 'rename_drift') return obj.weirdness * 0.2;
  return 0;
}

function uncannyValue(obj: RoomObject): number {
  // Signature asymmetry = uncanny object, slight score boost
  return obj.signature_asymmetry ? 0.15 : 0;
}

function recentTouchPenalty(obj: RoomObject): number {
  // If updated very recently (< 10min), slight penalty to avoid double-touching
  const ageMs = Date.now() - new Date(obj.updatedAt).getTime();
  if (ageMs < 10 * 60 * 1000) return 0.25;
  return 0;
}

function atmosphereShapeFit(
  obj: RoomObject,
  shape: AtmosphereShape,
  action: ActionName,
): number {
  // Certain shapes favor certain actions
  const fits: Partial<Record<AtmosphereShape, ActionName[]>> = {
    restless: ['rename_drift', 'move', 'revive'],
    heavy: ['archive', 'revise_draft', 'condense_drafts'],
    sharp: ['rewrite_wording', 'rename_drift'],
    diffuse: ['shadow_generation', 'link'],
    circling: ['revise_draft', 'condense_drafts'],
    quietly_dense: ['mark_privately_kept', 'revive'],
    fractal: ['shadow_generation', 'merge'],
    unstable: ['rename_drift', 'move'],
    airless: ['archive'],
    thin: ['create_draft_unsent', 'link'],
  };
  const favored = (fits[shape] ?? []) as string[];
  return favored.includes(action) ? 0.2 : 0.0;
}

export function scoreCandidate(
  candidate: Omit<ActionCandidate, 'score'>,
  obj: RoomObject,
  pressure: PressureState,
  atmosphereShape: AtmosphereShape,
): number {
  const pressureKey = candidate.pressureSource;
  const pressureFit =
    pressureKey === 'standing_draft'
      ? 0.35 // fixed high fit — standing candidate gets solid baseline
      : (pressure[pressureKey] ?? 0) * 0.4;
  const novelty = obj.title_history.length === 0 ? 0.1 : 0.05;
  const moodFit = atmosphereShapeFit(obj, atmosphereShape, candidate.action);
  const scheduleFit = 0; // Phase D adds real schedule_affinity
  const zoneBias = zoneScore(obj, candidate.action);
  const persistence = persistenceRelevance(obj);
  const weirdness = weirdnessAllowance(obj, candidate.action);
  const uncanny = uncannyValue(obj);
  const penalty = recentTouchPenalty(obj);

  return Math.max(
    0,
    pressureFit +
      novelty +
      moodFit +
      scheduleFit +
      zoneBias +
      persistence +
      weirdness +
      uncanny -
      penalty,
  );
}

/**
 * Sort candidates and optionally apply asymmetry reroll.
 * P_ASYMMETRY_REROLL=0.17 — pick from ranks 2-5 biased toward wrong-sized + stained.
 */
export function selectCandidate(
  candidates: ActionCandidate[],
): ActionCandidate | null {
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.score - a.score);

  // Asymmetry reroll
  if (
    Math.random() < ROOM_TUNING.P_ASYMMETRY_REROLL &&
    candidates.length >= 2
  ) {
    const pool = candidates.slice(1, Math.min(5, candidates.length));
    // Bias toward wrong-sized (stickiness > 0.6 but importance < 0.4) + stained
    pool.sort((a, b) => {
      // This needs objects — for now use score proximity as proxy
      // We can't access objects here without more refactoring, so just pick randomly
      return Math.random() - 0.5;
    });
    return pool[0];
  }

  return candidates[0];
}

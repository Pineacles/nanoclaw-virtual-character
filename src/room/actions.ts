/**
 * Action type registry — common execution scaffolding.
 * Phase C: routes to actions_llm.ts or actions_struct.ts based on action type.
 * Never blocks pulse on Haiku timeout (capped at 10s, falls through to deterministic).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import type { RoomObject, PressureState, AtmosphereShape } from './types.js';
import type { ActionCandidate, ActionName } from './scoring.js';
import { requiresLLM, scoreCandidate, selectCandidate } from './scoring.js';
import { consumeHaikuBudget } from './budget.js';
import { getActiveObjects, insertTrace, getRoomDb } from './store.js';
import { ROOM_TUNING } from './tuning.js';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { ThickAtmosphere } from './weather.js';

/** BleedHint written to meta.pending_bleed_hints for Phase D */
export interface BleedHint {
  action_type: string;
  primary_object_id: string;
  shape_shift: string | null;
  title_change: { old: string; new: string } | null;
  bleed_eligibility: string;
}

function readGroupFeatures(groupFolder: string): Record<string, boolean> {
  try {
    const p = path.join(GROUPS_DIR, groupFolder, 'group.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      features?: Record<string, boolean>;
    };
    return raw.features ?? {};
  } catch {
    return {};
  }
}

/**
 * Generate action candidates from current pressure + object state.
 */
function generateCandidates(
  objects: RoomObject[],
  pressure: PressureState,
  atmosphereShape: AtmosphereShape,
): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  const nonArchived = objects.filter((o) => o.status !== 'archived');
  const THRESHOLD = 0.25;

  // renamePressure → rename_drift on highest-heat object
  if (pressure.renamePressure > THRESHOLD && nonArchived.length > 0) {
    const target = nonArchived.reduce(
      (best, o) => (o.heat > best.heat ? o : best),
      nonArchived[0],
    );
    const base: Omit<ActionCandidate, 'score'> = {
      action: 'rename_drift',
      primaryObjectId: target.id,
      secondaryObjectIds: [],
      requiresLLM: true,
      pressureSource: 'renamePressure',
    };
    candidates.push({
      ...base,
      score: scoreCandidate(base, target, pressure, atmosphereShape),
    });
  }

  // draftPressure → revise_draft on existing queue drafts
  if (pressure.draftPressure > THRESHOLD) {
    const existingDrafts = nonArchived.filter(
      (o) => o.type === 'draft_unsent' && o.zone === 'queue',
    );
    if (existingDrafts.length > 0) {
      const target = existingDrafts[0];
      const base: Omit<ActionCandidate, 'score'> = {
        action: 'revise_draft',
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: true,
        pressureSource: 'draftPressure',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape),
      });
    }
  }

  // create_draft_unsent — standing candidate whenever material exists.
  // Fires when: no active queue drafts with heat > 0.5.
  // Target: highest-heat non-archive/non-queue object — or if everything is cold,
  // pick from stickiest/most-weirdness objects so the room speaks from what IT kept,
  // not from what has surface heat.
  const activeDrafts = nonArchived.filter(
    (o) => o.type === 'draft_unsent' && o.zone === 'queue' && o.heat > 0.5,
  );
  if (activeDrafts.length === 0) {
    const candidateObjs = nonArchived.filter(
      (o) => o.zone !== 'queue' && o.zone !== 'archive',
    );
    if (candidateObjs.length > 0) {
      // Score by heat + stickiness + weirdness + signature_asymmetry — room-material, not pure heat
      const scored = candidateObjs
        .map((o) => ({
          obj: o,
          pseudoHeat:
            o.heat +
            o.stickiness * 0.3 +
            o.weirdness * 0.2 +
            (o.signature_asymmetry ? 0.2 : 0) +
            o.privateSignificance * 0.15,
        }))
        .sort((a, b) => b.pseudoHeat - a.pseudoHeat);
      const target = scored[0].obj;
      const base: Omit<ActionCandidate, 'score'> = {
        action: 'create_draft_unsent',
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: true,
        pressureSource: 'standing_draft',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape) + 0.15,
      });
    }
  }

  // promote_to_speakable — standing candidate for any Queue draft that's ready.
  // This is what actually writes the intent file that triggers outbound impulse.
  const promotable = nonArchived.filter(
    (o) =>
      o.zone === 'queue' &&
      o.type === 'draft_unsent' &&
      o.heat > 0.7 &&
      (o.bleedClass === 'sealed' || o.bleedClass === 'ambient'),
  );
  if (promotable.length > 0) {
    const target = promotable[0];
    const base: Omit<ActionCandidate, 'score'> = {
      action: 'promote_to_speakable',
      primaryObjectId: target.id,
      secondaryObjectIds: [],
      requiresLLM: false,
      pressureSource: 'draftPressure',
    };
    // High baseline + target's heat as bonus — this should outcompete most alternatives when ready
    candidates.push({
      ...base,
      score:
        scoreCandidate(base, target, pressure, atmosphereShape) +
        0.35 +
        target.heat * 0.2,
    });
  }

  // archivePressure → archive on oldest cooling non-unerasable
  if (pressure.archivePressure > THRESHOLD) {
    const archivable = nonArchived
      .filter(
        (o) =>
          (o.status === 'cooling' || o.status === 'dormant') &&
          o.heat < 0.15 &&
          !o.unerasable &&
          !o.privately_kept,
      )
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    if (archivable.length > 0) {
      const target = archivable[0];
      const base: Omit<ActionCandidate, 'score'> = {
        action: 'archive',
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: false,
        pressureSource: 'archivePressure',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape),
      });
    }
  }

  // relinkPressure → link 2 stain-matched non-linked objects
  if (pressure.relinkPressure > THRESHOLD) {
    const pool = nonArchived.filter((o) => o.atmosphere_stains.length > 0);
    if (pool.length >= 2) {
      const a = pool[0];
      const b = pool.find((o) => o.id !== a.id && !a.links.includes(o.id));
      if (b) {
        const base: Omit<ActionCandidate, 'score'> = {
          action: 'link',
          primaryObjectId: a.id,
          secondaryObjectIds: [b.id],
          requiresLLM: false,
          pressureSource: 'relinkPressure',
        };
        candidates.push({
          ...base,
          score: scoreCandidate(base, a, pressure, atmosphereShape),
        });
      }
    }
  }

  // revisitPressure → revive dormant sticky
  if (pressure.revisitPressure > THRESHOLD) {
    const dormantSticky = objects.filter(
      (o) => o.status === 'dormant' && o.stickiness > 0.4,
    );
    if (dormantSticky.length > 0) {
      const target = dormantSticky[0];
      const base: Omit<ActionCandidate, 'score'> = {
        action: 'revive',
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: false,
        pressureSource: 'revisitPressure',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape),
      });
    }
  }

  // residuePressure → mark_privately_kept OR shadow_generation
  if (pressure.residuePressure > THRESHOLD) {
    const residueObjs = nonArchived.filter(
      (o) => !o.privately_kept && o.importance < 0.5,
    );
    if (residueObjs.length > 0) {
      const target =
        residueObjs[Math.floor(Math.random() * residueObjs.length)];
      const useShadow = target.weirdness > 0.5 && target.dwell_pulses > 3;
      const action: ActionName = useShadow
        ? 'shadow_generation'
        : 'mark_privately_kept';
      const base: Omit<ActionCandidate, 'score'> = {
        action,
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: useShadow,
        pressureSource: 'residuePressure',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape),
      });
    }
  }

  // clarifyPressure → rewrite_wording on high-uncertainty notebook
  if (pressure.clarifyPressure > THRESHOLD) {
    const uncertain = nonArchived
      .filter((o) => o.zone === 'notebook' && o.confidence < 0.5)
      .sort((a, b) => a.confidence - b.confidence);
    if (uncertain.length > 0) {
      const target = uncertain[0];
      const base: Omit<ActionCandidate, 'score'> = {
        action: 'rewrite_wording',
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: true,
        pressureSource: 'clarifyPressure',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape),
      });
    }
  }

  // Additional: high-heat signature_asymmetry objects → rename_drift boost
  const asymmetryObjs = nonArchived.filter(
    (o) => o.signature_asymmetry && o.heat > 0.5,
  );
  for (const obj of asymmetryObjs.slice(0, 2)) {
    const base: Omit<ActionCandidate, 'score'> = {
      action: 'rename_drift',
      primaryObjectId: obj.id,
      secondaryObjectIds: [],
      requiresLLM: true,
      pressureSource: 'renamePressure',
    };
    candidates.push({
      ...base,
      score: scoreCandidate(base, obj, pressure, atmosphereShape) * 1.1,
    });
  }

  // shelfPressure → promote notebook candidate to shelf (deterministic move)
  if (pressure.shelfPressure > THRESHOLD) {
    const notebookCandidates = nonArchived.filter(
      (o) => o.zone === 'notebook' && o.privateSignificance > 0.5,
    );
    if (notebookCandidates.length > 0) {
      const target = notebookCandidates[0];
      const base: Omit<ActionCandidate, 'score'> = {
        action: 'move',
        primaryObjectId: target.id,
        secondaryObjectIds: [],
        requiresLLM: false,
        pressureSource: 'shelfPressure',
      };
      candidates.push({
        ...base,
        score: scoreCandidate(base, target, pressure, atmosphereShape),
      });
    }
  }

  return candidates;
}

/**
 * Deterministic downgrade map — when LLM budget exhausted.
 */
function downgradeAction(action: ActionName): ActionName {
  const map: Partial<Record<ActionName, ActionName>> = {
    rename_drift: 'mark_privately_kept',
    rewrite_wording: 'archive',
    create_draft_unsent: 'mark_privately_kept',
    revise_draft: 'mark_privately_kept',
    condense_drafts: 'archive',
    shadow_generation: 'move',
  };
  return map[action] ?? 'mark_privately_kept';
}

export interface DreamActionOpts {
  actionProbOverride?: number;
  preferLLM?: boolean;
}

/**
 * Main action execution entry point — called from runtime.ts step 18.
 */
export async function executeActionStep(
  groupFolder: string,
  pulseId: string,
  pressure: PressureState,
  thick: ThickAtmosphere,
  dreamOpts?: DreamActionOpts,
): Promise<void> {
  const features = readGroupFeatures(groupFolder);
  const llmEnabled = features['room_llm_actions'] === true;

  // Compute action probability (dream window may override)
  let actionProb =
    dreamOpts?.actionProbOverride ?? ROOM_TUNING.ACTION_PROBABILITY_BASE;
  if (!dreamOpts?.actionProbOverride && thick.congestion) {
    actionProb *= ROOM_TUNING.ACTION_PROBABILITY_CONGESTION_MULTIPLIER;
  }

  // Roll — if skip, log stillness
  if (Math.random() > actionProb) {
    insertTrace(groupFolder, pulseId, 'stillness', [], 'action_roll_miss');
    logger.debug(
      { groupFolder, pulseId },
      'RoomAction: stillness — no action this pulse',
    );
    return;
  }

  // Partial-only path (P=0.25): log near_misses instead of committing
  if (Math.random() < 0.25) {
    const nonArchived = getActiveObjects(groupFolder);
    if (nonArchived.length > 0) {
      const count = 1 + Math.floor(Math.random() * 2);
      const chosen = [...nonArchived]
        .sort(() => Math.random() - 0.5)
        .slice(0, count);
      for (const obj of chosen) {
        insertTrace(
          groupFolder,
          pulseId,
          'near_miss',
          [obj.id],
          'partial_only_path',
        );
      }
    }
    return;
  }

  const objects = getActiveObjects(groupFolder);
  const candidates = generateCandidates(objects, pressure, thick.shape);

  if (candidates.length === 0) {
    insertTrace(groupFolder, pulseId, 'stillness', [], 'no_candidates');
    return;
  }

  // Dream window: prefer LLM candidates — bump their scores
  if (dreamOpts?.preferLLM) {
    for (const c of candidates) {
      if (c.requiresLLM) c.score *= 1.3;
    }
    // Force at least one LLM candidate if available
    const llmCandidates = candidates.filter((c) => c.requiresLLM);
    if (llmCandidates.length > 0) {
      // Sort so the highest-scored LLM candidate wins
      llmCandidates.sort((a, b) => b.score - a.score);
    }
  }

  let selected = selectCandidate(candidates);
  if (!selected) return;

  // Near-miss companion (P=0.40): log for a different close-ranked candidate
  if (Math.random() < 0.4 && candidates.length >= 2) {
    const others = candidates.filter(
      (c) => c.primaryObjectId !== selected!.primaryObjectId,
    );
    if (others.length > 0) {
      const nearMiss = others[0];
      insertTrace(
        groupFolder,
        pulseId,
        'near_miss',
        [nearMiss.primaryObjectId],
        `close_candidate: ${nearMiss.action}`,
      );
    }
  }

  // Budget check + downgrade
  let finalAction = selected.action;
  if (
    requiresLLM(finalAction) &&
    (!llmEnabled || !consumeHaikuBudget(groupFolder))
  ) {
    const downgraded = downgradeAction(finalAction);
    logger.debug(
      { groupFolder, original: finalAction, downgraded },
      'RoomAction: LLM unavailable or budget exhausted, downgrading action',
    );
    finalAction = downgraded;
    selected = { ...selected, action: finalAction, requiresLLM: false };
  }

  const primaryObj = objects.find((o) => o.id === selected!.primaryObjectId);
  if (!primaryObj) {
    insertTrace(
      groupFolder,
      pulseId,
      'action_skipped',
      [],
      'primary_object_not_found',
    );
    return;
  }

  logger.info(
    {
      groupFolder,
      pulseId,
      action: finalAction,
      objectId: selected.primaryObjectId,
    },
    'RoomAction: executing',
  );

  let bleedHint: BleedHint | null = null;

  if (requiresLLM(selected.action)) {
    const { executeLLMAction } = await import('./actions_llm.js');
    bleedHint = await executeLLMAction(
      groupFolder,
      pulseId,
      selected,
      primaryObj,
      objects,
      thick,
    );
  } else {
    const { executeStructAction } = await import('./actions_struct.js');
    bleedHint = executeStructAction(
      groupFolder,
      pulseId,
      selected,
      primaryObj,
      objects,
      thick,
    );
  }

  // Write bleed hints to meta (JSON array capped at 10)
  if (bleedHint) {
    const db = getRoomDb(groupFolder);
    // Ensure column exists
    try {
      db.exec(
        "ALTER TABLE meta ADD COLUMN pending_bleed_hints TEXT DEFAULT '[]'",
      );
    } catch {
      /* already exists */
    }

    const metaRow = db
      .prepare('SELECT pending_bleed_hints FROM meta WHERE id = 1')
      .get() as { pending_bleed_hints: string | null } | undefined;
    let hints: BleedHint[] = [];
    try {
      hints = JSON.parse(metaRow?.pending_bleed_hints ?? '[]') as BleedHint[];
    } catch {
      /* empty */
    }
    hints.push(bleedHint);
    if (hints.length > 10) hints = hints.slice(-10);
    db.prepare('UPDATE meta SET pending_bleed_hints = ? WHERE id = 1').run(
      JSON.stringify(hints),
    );
  }
}

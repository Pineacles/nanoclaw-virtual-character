/**
 * Deterministic actions — no Haiku, no LLM.
 * Phase C: revive (with drift), archive, move, merge, link/unlink, mark_privately_kept.
 * Phase D: promote_to_speakable (write intent file for draft watcher).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { RoomObject, Zone } from './types.js';
import type { ActionCandidate } from './scoring.js';
import type { BleedHint } from './actions.js';
import type { ThickAtmosphere } from './weather.js';
import { updateObject, insertObject, insertTrace, getRoomDb } from './store.js';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

const KEPT_REASONS = [
  'sat with',
  'no clear reason',
  'stayed near sticky neighbor',
  'kept turning up',
] as const;

// ── revive ───────────────────────────────────────────────────────────────────

function actionRevive(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  objects: RoomObject[],
  thick: ThickAtmosphere,
): BleedHint | null {
  const now = nowIso();

  // Lose 1 random old link
  let newLinks = [...obj.links];
  if (newLinks.length > 0) {
    const dropIdx = Math.floor(Math.random() * newLinks.length);
    newLinks.splice(dropIdx, 1);
  }

  // Gain 1 link from current cluster members
  const clusterMembers = objects.filter(
    (o) =>
      o.cluster_id &&
      o.cluster_id === obj.cluster_id &&
      o.id !== obj.id &&
      o.status !== 'archived',
  );
  if (clusterMembers.length > 0) {
    const gained =
      clusterMembers[Math.floor(Math.random() * clusterMembers.length)];
    if (!newLinks.includes(gained.id)) newLinks.push(gained.id);
  }

  // Inherit current atmosphere as a new stain
  const newStain = {
    atmosphere_id: `atm-${Date.now()}`,
    strength: 0.6,
    when: now,
    shape: thick.shape,
  };
  const newStains = [...obj.atmosphere_stains, newStain].slice(-10);

  // Push existing title to history with reason 'revived_altered'
  const newTitle = obj.title.startsWith('(rev)')
    ? obj.title
    : `(rev) ${obj.title}`;
  const updatedHistory = [
    ...obj.title_history,
    {
      title: obj.title,
      valid_from: obj.createdAt,
      valid_to: now,
      renamed_reason: 'revived_altered',
    },
  ];

  const updated: RoomObject = {
    ...obj,
    status: 'revived',
    heat: 0.6,
    dormancy: 0.1,
    title: newTitle,
    title_history: updatedHistory,
    links: newLinks,
    atmosphere_stains: newStains,
    updatedAt: now,
  };

  updateObject(groupFolder, updated);
  insertTrace(
    groupFolder,
    pulseId,
    'revive',
    [obj.id],
    `revived with drift, title: "${obj.title}" → "${newTitle}"`,
  );
  logger.info({ groupFolder, id: obj.id, newTitle }, 'RoomStruct: revive');

  return {
    action_type: 'revive',
    primary_object_id: obj.id,
    shape_shift: String(thick.shape),
    title_change: { old: obj.title, new: newTitle },
    bleed_eligibility: obj.bleedClass,
  };
}

// ── archive ──────────────────────────────────────────────────────────────────

function actionArchive(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
): BleedHint | null {
  if (obj.unerasable || obj.privately_kept) {
    insertTrace(
      groupFolder,
      pulseId,
      'archive_blocked',
      [obj.id],
      'unerasable_or_privately_kept',
    );
    return null;
  }

  // Anti-resolution interference: probabilistic fail
  if (obj.anti_resolution > 0.5 && Math.random() < 0.35) {
    const now = nowIso();
    const strangeTitle = `almost let go of: ${obj.title}`;
    const updated: RoomObject = {
      ...obj,
      title: strangeTitle,
      updatedAt: now,
    };
    updateObject(groupFolder, updated);
    insertTrace(
      groupFolder,
      pulseId,
      'archive_anti_resolution',
      [obj.id],
      `left stranger: "${strangeTitle}"`,
    );
    logger.info(
      { groupFolder, id: obj.id },
      'RoomStruct: archive failed by anti_resolution',
    );
    return {
      action_type: 'archive_anti_resolution',
      primary_object_id: obj.id,
      shape_shift: null,
      title_change: { old: obj.title, new: strangeTitle },
      bleed_eligibility: obj.bleedClass,
    };
  }

  const now = nowIso();
  const updated: RoomObject = {
    ...obj,
    status: 'archived',
    zone: 'archive',
    dormancy: 1.0,
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'archive',
    [obj.id],
    `archived: "${obj.title}"`,
  );
  logger.info({ groupFolder, id: obj.id }, 'RoomStruct: archive');

  return {
    action_type: 'archive',
    primary_object_id: obj.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: 'absence',
  };
}

// ── move ─────────────────────────────────────────────────────────────────────

function actionMove(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  objects: RoomObject[],
): BleedHint | null {
  const zones: Zone[] = [
    'desk',
    'notebook',
    'shelf',
    'queue',
    'mirror',
    'attic',
  ];
  const targetZone = zones.filter((z) => z !== obj.zone)[
    Math.floor(Math.random() * (zones.length - 1))
  ];

  const now = nowIso();

  // Leave ghost if in zone > 3 pulses
  if (obj.dwell_pulses > 3) {
    const db = getRoomDb(groupFolder);
    const ghostId = makeId('ghost');
    try {
      db.prepare(
        `
        INSERT INTO zone_ghosts (id, original_object_id, zone, ghost_heat, resonance_contribution, left_at, last_touched)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(ghostId, obj.id, obj.zone, 0.3, 0.2, now, now);
    } catch {
      // Table may have different schema — ignore
    }
  }

  const updated: RoomObject = {
    ...obj,
    zone: targetZone,
    time_in_zone_started_at: now,
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'move',
    [obj.id],
    `moved: ${obj.zone} → ${targetZone}`,
  );
  logger.info(
    { groupFolder, id: obj.id, from: obj.zone, to: targetZone },
    'RoomStruct: move',
  );

  return {
    action_type: 'move',
    primary_object_id: obj.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: obj.bleedClass,
  };
}

// ── link / unlink ────────────────────────────────────────────────────────────

function actionLink(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  secondaryIds: string[],
  objects: RoomObject[],
): BleedHint | null {
  if (secondaryIds.length === 0) return null;

  const targetId = secondaryIds[0];
  const target = objects.find((o) => o.id === targetId);
  if (!target) return null;

  const now = nowIso();
  const updatedA = {
    ...obj,
    links: [...new Set([...obj.links, targetId])],
    updatedAt: now,
  };
  const updatedB = {
    ...target,
    links: [...new Set([...target.links, obj.id])],
    updatedAt: now,
  };

  updateObject(groupFolder, updatedA);
  updateObject(groupFolder, updatedB);

  insertTrace(
    groupFolder,
    pulseId,
    'link',
    [obj.id, targetId],
    `linked: ${obj.id} ↔ ${targetId}`,
  );

  return {
    action_type: 'link',
    primary_object_id: obj.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: obj.bleedClass,
  };
}

function actionUnlink(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  secondaryIds: string[],
  objects: RoomObject[],
): BleedHint | null {
  if (obj.links.length === 0) return null;

  const now = nowIso();
  const dropId = obj.links[Math.floor(Math.random() * obj.links.length)];
  const updatedLinks = obj.links.filter((l) => l !== dropId);
  const updated = { ...obj, links: updatedLinks, updatedAt: now };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'unlink',
    [obj.id],
    `unlinked: ${obj.id} ↛ ${dropId}`,
  );

  return {
    action_type: 'unlink',
    primary_object_id: obj.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: obj.bleedClass,
  };
}

// ── mark_privately_kept ──────────────────────────────────────────────────────

function actionMarkPrivatelyKept(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
): BleedHint | null {
  const reason = KEPT_REASONS[Math.floor(Math.random() * KEPT_REASONS.length)];
  const now = nowIso();
  const updated: RoomObject = {
    ...obj,
    privately_kept: true,
    kept_reason: reason,
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'mark_privately_kept',
    [obj.id],
    `reason: ${reason}`,
  );
  logger.info(
    { groupFolder, id: obj.id, reason },
    'RoomStruct: mark_privately_kept',
  );

  return {
    action_type: 'mark_privately_kept',
    primary_object_id: obj.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: obj.bleedClass,
  };
}

// ── merge ────────────────────────────────────────────────────────────────────

function actionMerge(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  objects: RoomObject[],
): BleedHint | null {
  // Find 1-2 other objects with shared stains or links
  const candidates = objects
    .filter((o) => o.id !== obj.id && o.status !== 'archived')
    .filter(
      (o) =>
        o.links.includes(obj.id) ||
        o.atmosphere_stains.some((s) =>
          obj.atmosphere_stains.some((os) => os.shape === s.shape),
        ),
    )
    .slice(0, 2);

  if (candidates.length === 0) return null;

  const toMerge = [obj, ...candidates];
  const now = nowIso();
  const originalIds = toMerge.map((o) => o.id);

  const highestStickiness = Math.max(...toMerge.map((o) => o.stickiness));
  const unionStains = toMerge.flatMap((o) => o.atmosphere_stains);
  const unionLinks = [
    ...new Set(
      toMerge.flatMap((o) => o.links).filter((l) => !originalIds.includes(l)),
    ),
  ];

  const merged: RoomObject = {
    id: makeId('obj'),
    type: obj.type,
    zone: obj.zone,
    title: `merged: ${toMerge
      .map((o) => o.title)
      .join(' / ')
      .slice(0, 60)}`,
    body: toMerge.map((o) => o.body).join('\n---\n'),
    createdAt: now,
    updatedAt: now,
    status: 'active',
    confidence: Math.min(
      1,
      toMerge.reduce((a, o) => a + o.confidence, 0) / toMerge.length,
    ),
    importance: Math.max(...toMerge.map((o) => o.importance)),
    heat: Math.max(...toMerge.map((o) => o.heat)),
    resonance: Math.max(...toMerge.map((o) => o.resonance)),
    dormancy: Math.min(...toMerge.map((o) => o.dormancy)),
    persistence: Math.max(...toMerge.map((o) => o.persistence)),
    weirdness: Math.max(...toMerge.map((o) => o.weirdness)),
    privateSignificance: Math.max(...toMerge.map((o) => o.privateSignificance)),
    bleedClass: obj.bleedClass,
    sourceRefs: originalIds,
    links: unionLinks,
    stickiness: highestStickiness,
    residual_warmth_floor: Math.max(
      ...toMerge.map((o) => o.residual_warmth_floor),
    ),
    title_history: [],
    time_in_zone_started_at: now,
    time_total_alive_at: now,
    atmosphere_stains: unionStains.slice(0, 8),
    near_miss_counts: {
      almost_drafted: 0,
      almost_revived: 0,
      touched_then_left: 0,
      weak_relinks_loosened: 0,
      heat_lifted_then_dropped: 0,
      wording_disturbed: 0,
      title_almost_changed: 0,
    },
    failed_forms: [],
    fracture_seam: {
      original_ids: originalIds,
      reunion_strength: 0.3 + Math.random() * 0.4,
      merged_at: now,
    },
    observation_stain: 0,
    deep_presence: false,
    shadow_of: null,
    anti_resolution: Math.max(...toMerge.map((o) => o.anti_resolution)),
    signature_asymmetry: toMerge.some((o) => o.signature_asymmetry),
    latent_influence: Math.max(...toMerge.map((o) => o.latent_influence)),
    unerasable: toMerge.some((o) => o.unerasable),
    privately_kept: toMerge.some((o) => o.privately_kept),
    kept_reason: toMerge.find((o) => o.kept_reason)?.kept_reason ?? null,
    sitting_with_since: null,
    dwell_pulses: 0,
    cluster_id: obj.cluster_id,
    contamination_log: [],
    mood_affinity: {},
    schedule_affinity: {},
  };

  insertObject(groupFolder, merged);

  // Archive originals
  for (const o of toMerge) {
    updateObject(groupFolder, {
      ...o,
      status: 'archived',
      zone: 'archive',
      updatedAt: now,
    });
  }

  insertTrace(
    groupFolder,
    pulseId,
    'merge',
    [merged.id, ...originalIds],
    `merged ${toMerge.length} objects`,
  );

  return {
    action_type: 'merge',
    primary_object_id: merged.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: merged.bleedClass,
  };
}

// ── promote_to_speakable ─────────────────────────────────────────────────────

function actionPromoteToSpeakable(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  thick: ThickAtmosphere,
): BleedHint | null {
  // Candidate gates: heat > 0.7, bleedClass sealed or ambient (not already speakable+)
  if (obj.heat <= 0.7) return null;
  const allowedBleed = ['sealed', 'ambient'];
  if (!allowedBleed.includes(obj.bleedClass)) return null;

  const now = nowIso();
  const queueDir = path.join(GROUPS_DIR, groupFolder, 'queue');
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    const intentPath = path.join(queueDir, `intent_${obj.id}.json`);
    const intentData = {
      id: obj.id,
      body: obj.body,
      title: obj.title,
      generated_at: now,
      atmosphere_shape: String(thick.shape),
    };
    fs.writeFileSync(intentPath, JSON.stringify(intentData, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(
      { groupFolder, id: obj.id, err },
      'RoomStruct: failed to write intent file',
    );
    return null;
  }

  // Update bleedClass to speakable
  const updated: RoomObject = {
    ...obj,
    bleedClass: 'speakable',
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'promote_to_speakable',
    [obj.id],
    `promoted to speakable, intent written`,
  );
  logger.info(
    { groupFolder, id: obj.id, title: obj.title },
    'RoomStruct: promote_to_speakable',
  );

  return {
    action_type: 'promote_to_speakable',
    primary_object_id: obj.id,
    shape_shift: String(thick.shape),
    title_change: null,
    bleed_eligibility: 'speakable',
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export function executeStructAction(
  groupFolder: string,
  pulseId: string,
  candidate: ActionCandidate,
  primaryObj: RoomObject,
  objects: RoomObject[],
  thick: ThickAtmosphere,
): BleedHint | null {
  switch (candidate.action) {
    case 'revive':
      return actionRevive(groupFolder, pulseId, primaryObj, objects, thick);
    case 'archive':
      return actionArchive(groupFolder, pulseId, primaryObj);
    case 'move':
      return actionMove(groupFolder, pulseId, primaryObj, objects);
    case 'link':
      return actionLink(
        groupFolder,
        pulseId,
        primaryObj,
        candidate.secondaryObjectIds,
        objects,
      );
    case 'unlink':
      return actionUnlink(
        groupFolder,
        pulseId,
        primaryObj,
        candidate.secondaryObjectIds,
        objects,
      );
    case 'mark_privately_kept':
      return actionMarkPrivatelyKept(groupFolder, pulseId, primaryObj);
    case 'merge':
      return actionMerge(groupFolder, pulseId, primaryObj, objects);
    case 'promote_to_speakable':
      return actionPromoteToSpeakable(groupFolder, pulseId, primaryObj, thick);
    default:
      logger.warn(
        { groupFolder, action: candidate.action },
        'RoomStruct: unknown action',
      );
      return null;
  }
}

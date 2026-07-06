/**
 * Near-miss emission — partial_motion action logging + failed_forms recording.
 * Deterministic. No LLM calls.
 */
import type { RoomObject, NearMissCounts, FailedForm } from './types.js';
import { getRoomDb, insertTrace } from './store.js';
import { logger } from '../logger.js';
import { ROOM_TUNING } from './tuning.js';

type NearMissSubtype =
  | 'almost_drafted'
  | 'almost_revived'
  | 'touched_then_left'
  | 'weak_relink_formed_then_loosened'
  | 'heat_lifted_then_dropped'
  | 'wording_disturbed'
  | 'title_almost_changed';

const TITLE_TEMPLATES = [
  'maybe {title}?',
  '{title} (revisited)',
  'the {title} thing',
  'something about {title}',
  'not quite {title}',
  '{title} — or not',
];

function candidateTitle(original: string): string {
  const template =
    TITLE_TEMPLATES[Math.floor(Math.random() * TITLE_TEMPLATES.length)];
  return template.replace('{title}', original);
}

function pickCandidates(objects: RoomObject[], count: number): RoomObject[] {
  const nonArchived = objects.filter((o) => o.status !== 'archived');
  if (nonArchived.length === 0) return [];
  const shuffled = [...nonArchived].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function incrementNearMiss(
  counts: NearMissCounts,
  subtype: NearMissSubtype,
): NearMissCounts {
  const updated = { ...counts };
  switch (subtype) {
    case 'almost_drafted':
      updated.almost_drafted++;
      break;
    case 'almost_revived':
      updated.almost_revived++;
      break;
    case 'touched_then_left':
      updated.touched_then_left++;
      break;
    case 'weak_relink_formed_then_loosened':
      updated.weak_relinks_loosened++;
      break;
    case 'heat_lifted_then_dropped':
      updated.heat_lifted_then_dropped++;
      break;
    case 'wording_disturbed':
      updated.wording_disturbed++;
      break;
    case 'title_almost_changed':
      updated.title_almost_changed++;
      break;
  }
  return updated;
}

function eligibleForSubtype(
  obj: RoomObject,
  subtype: NearMissSubtype,
): boolean {
  switch (subtype) {
    case 'almost_drafted':
      return obj.zone === 'queue' && obj.heat > 0.3;
    case 'almost_revived':
      return obj.status === 'dormant' && obj.stickiness > 0.4;
    case 'touched_then_left':
      return true; // any
    case 'weak_relink_formed_then_loosened':
      return obj.atmosphere_stains.length > 0;
    case 'heat_lifted_then_dropped':
      return true;
    case 'wording_disturbed':
      return obj.body.length > 20;
    case 'title_almost_changed':
      return obj.title.length > 3;
  }
}

export function emitNearMisses(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
  probabilityMultiplier = 1.0,
): void {
  const db = getRoomDb(groupFolder);
  const effectiveProbability = ROOM_TUNING.P_NEAR_MISS * probabilityMultiplier;

  if (Math.random() > effectiveProbability) return;

  const count = 1 + Math.floor(Math.random() * 3); // 1-3
  const candidates = pickCandidates(objects, count);

  const subtypes: NearMissSubtype[] = [
    'almost_drafted',
    'almost_revived',
    'touched_then_left',
    'weak_relink_formed_then_loosened',
    'heat_lifted_then_dropped',
    'wording_disturbed',
    'title_almost_changed',
  ];

  const now = new Date().toISOString();

  for (const obj of candidates) {
    // Pick a random eligible subtype
    const eligible = subtypes.filter((s) => eligibleForSubtype(obj, s));
    if (eligible.length === 0) continue;
    const subtype = eligible[Math.floor(Math.random() * eligible.length)];

    const updatedCounts = incrementNearMiss(obj.near_miss_counts, subtype);

    const newFailedForms: FailedForm[] = [...obj.failed_forms];

    // For title_almost_changed: compute candidate title and store in failed_forms
    if (subtype === 'title_almost_changed') {
      const form: FailedForm = {
        type: 'rename',
        shape: candidateTitle(obj.title),
        when: now,
        strength: 0.3 + Math.random() * 0.4,
      };
      newFailedForms.push(form);
    }

    // For almost_drafted: add draft failed form
    if (subtype === 'almost_drafted') {
      const form: FailedForm = {
        type: 'draft',
        shape: `${obj.title} (almost)`,
        when: now,
        strength: 0.2 + Math.random() * 0.3,
      };
      newFailedForms.push(form);
    }

    // For weak_relink: add link failed form
    if (subtype === 'weak_relink_formed_then_loosened') {
      const form: FailedForm = {
        type: 'link',
        shape: `${obj.id}~loosened`,
        when: now,
        strength: 0.1 + Math.random() * 0.2,
      };
      newFailedForms.push(form);
    }

    db.prepare(
      `
      UPDATE objects SET near_miss_counts = ?, failed_forms = ? WHERE id = ?
    `,
    ).run(
      JSON.stringify(updatedCounts),
      JSON.stringify(newFailedForms),
      obj.id,
    );

    insertTrace(groupFolder, pulseId, 'partial_motion', [obj.id], subtype);
  }

  if (candidates.length > 0) {
    logger.debug(
      { groupFolder, emitted: candidates.length },
      'Near-miss emissions complete',
    );
  }
}

export function computeUnfinishedPressure(objects: RoomObject[]): number {
  let total = 0;
  for (const obj of objects) {
    const counts = obj.near_miss_counts;
    const sum =
      counts.almost_drafted +
      counts.almost_revived +
      counts.touched_then_left +
      counts.weak_relinks_loosened +
      counts.heat_lifted_then_dropped +
      counts.wording_disturbed +
      counts.title_almost_changed;
    total += sum * 0.01;
  }
  return Math.min(1, total);
}

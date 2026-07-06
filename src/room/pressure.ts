/**
 * Pressure channels — deterministic computation from current object state.
 * Phase B: real namelessness_pressure (from clusters) + real unfinishedPressure (near_miss totals).
 */
import type { RoomObject, PressureState } from './types.js';

const TITLE_BODY_OVERLAP_THRESHOLD = 0.4;
const ZONE_AGE_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 2 days in zone

/** Simple keyword overlap: fraction of title words present in body words */
function titleBodyOverlap(title: string, body: string): number {
  const titleWords = new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  if (titleWords.size === 0) return 1; // nothing to check

  const bodyText = body.toLowerCase();
  let matches = 0;
  for (const w of titleWords) {
    if (bodyText.includes(w)) matches++;
  }
  return matches / titleWords.size;
}

/** Time an object has been in its current zone (ms) */
function timeInZoneMs(obj: RoomObject, now: number): number {
  try {
    return now - new Date(obj.time_in_zone_started_at).getTime();
  } catch {
    return 0;
  }
}

/** Normalize a value to 0..1 clamped */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function computePressure(
  objects: RoomObject[],
  namelessness_pressure_override?: number,
): PressureState {
  const now = Date.now();
  const nonArchived = objects.filter((o) => o.status !== 'archived');
  const active = objects.filter(
    (o) => o.status === 'active' || o.status === 'cooling',
  );

  // --- revisitPressure ---
  // avg dormancy of high-importance objects weighted by time_in_zone
  const highImportance = nonArchived.filter((o) => o.importance > 0.6);
  let revisitPressure = 0;
  if (highImportance.length > 0) {
    const weighted = highImportance.map((o) => {
      const zoneAge = timeInZoneMs(o, now);
      const weight = 1 + Math.log1p(zoneAge / (24 * 60 * 60 * 1000)); // log(days+1)
      return o.dormancy * weight;
    });
    const totalWeight = highImportance.reduce((acc, o) => {
      return acc + 1 + Math.log1p(timeInZoneMs(o, now) / (24 * 60 * 60 * 1000));
    }, 0);
    revisitPressure = clamp01(
      weighted.reduce((a, v) => a + v, 0) / totalWeight,
    );
  }

  // --- relinkPressure ---
  // density of objects sharing sourceRefs but not yet linked
  // Phase A: simple heuristic — shared sourceRefs pairs not in each other's links
  let relinkPressure = 0;
  {
    let unlinkedShared = 0;
    for (let i = 0; i < nonArchived.length; i++) {
      for (let j = i + 1; j < nonArchived.length; j++) {
        const a = nonArchived[i];
        const b = nonArchived[j];
        const aRefs = new Set(a.sourceRefs);
        const sharedRefs = b.sourceRefs.filter((r) => aRefs.has(r));
        if (sharedRefs.length > 0) {
          const alreadyLinked =
            a.links.includes(b.id) || b.links.includes(a.id);
          if (!alreadyLinked) unlinkedShared++;
        }
      }
    }
    relinkPressure = clamp01(unlinkedShared / Math.max(1, nonArchived.length));
  }

  // --- renamePressure ---
  // count objects where title-body keyword overlap < threshold AND long in zone
  const renameCandidates = nonArchived.filter((o) => {
    const overlap = titleBodyOverlap(o.title, o.body);
    const age = timeInZoneMs(o, now);
    return (
      overlap < TITLE_BODY_OVERLAP_THRESHOLD && age > ZONE_AGE_THRESHOLD_MS
    );
  });
  const renamePressure = clamp01(
    renameCandidates.length / Math.max(1, nonArchived.length),
  );

  // --- draftPressure ---
  // Queue objects with heat > 0.5
  const hotQueue = nonArchived.filter(
    (o) => o.zone === 'queue' && o.heat > 0.5,
  );
  const draftPressure = clamp01(hotQueue.length / Math.max(1, 3)); // cap at 3 for full pressure

  // --- archivePressure ---
  // cooling + low-heat objects
  const archiveCandidates = nonArchived.filter(
    (o) => (o.status === 'cooling' || o.status === 'dormant') && o.heat < 0.15,
  );
  const archivePressure = clamp01(
    archiveCandidates.length / Math.max(1, nonArchived.length),
  );

  // --- clarifyPressure ---
  // avg (1 - confidence) on notebook items
  const notebookItems = active.filter((o) => o.zone === 'notebook');
  let clarifyPressure = 0;
  if (notebookItems.length > 0) {
    const sum = notebookItems.reduce((acc, o) => acc + (1 - o.confidence), 0);
    clarifyPressure = clamp01(sum / notebookItems.length);
  }

  // --- mirrorPressure ---
  // based on self-revision types in current objects (Phase A: count mirror zone objects)
  const mirrorItems = active.filter(
    (o) => o.zone === 'mirror' || o.type === 'self_revision',
  );
  const mirrorPressure = clamp01(mirrorItems.length / Math.max(1, 2));

  // --- residuePressure ---
  // total unresolved/unfinished fragments (persistent_trace, archived_fragment not yet archived)
  const residueItems = nonArchived.filter(
    (o) => o.type === 'persistent_trace' || o.type === 'archived_fragment',
  );
  const residuePressure = clamp01(residueItems.length / Math.max(1, 5));

  // --- shelfPressure ---
  // active private-label candidates
  const shelfCandidates = active.filter(
    (o) => o.zone === 'shelf' && o.privateSignificance > 0.5,
  );
  const shelfPressure = clamp01(shelfCandidates.length / Math.max(1, 3));

  // --- unfinishedPressure --- Phase B: sum of near_miss_counts totals * 0.01
  let unfinishedPressure = 0;
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
    unfinishedPressure += sum * 0.01;
  }
  unfinishedPressure = clamp01(unfinishedPressure);

  // --- namelessness_pressure --- Phase B: real value passed in from cluster discovery
  const namelessness_pressure = clamp01(namelessness_pressure_override ?? 0);

  return {
    revisitPressure,
    relinkPressure,
    renamePressure,
    draftPressure,
    archivePressure,
    clarifyPressure,
    mirrorPressure,
    residuePressure,
    shelfPressure,
    unfinishedPressure,
    namelessness_pressure,
  };
}

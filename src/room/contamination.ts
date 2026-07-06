/**
 * Cross-contamination pass — stain migration + proximity stain inheritance.
 * Deterministic. No LLM calls.
 */
import type { RoomObject, AtmosphereStain, AtmosphereShape } from './types.js';
import { getRoomDb, updateObject, insertTrace } from './store.js';
import { logger } from '../logger.js';
import { ROOM_TUNING } from './tuning.js';

function shareCluster(a: RoomObject, b: RoomObject): boolean {
  return !!a.cluster_id && a.cluster_id === b.cluster_id;
}

function shareMutualLink(a: RoomObject, b: RoomObject): boolean {
  const aLinks = new Set(a.links);
  const bLinks = new Set(b.links);
  return (
    aLinks.has(b.id) ||
    bLinks.has(a.id) ||
    [...aLinks].some((l) => bLinks.has(l))
  );
}

function sharedStainCount(a: RoomObject, b: RoomObject): number {
  const bShapes = new Set(b.atmosphere_stains.map((s) => s.shape));
  return a.atmosphere_stains.filter((s) => bShapes.has(s.shape)).length;
}

function isPair(a: RoomObject, b: RoomObject): boolean {
  return (
    shareCluster(a, b) || shareMutualLink(a, b) || sharedStainCount(a, b) >= 2
  );
}

function migrateStain(source: AtmosphereStain, rate: number): AtmosphereStain {
  return {
    ...source,
    strength: source.strength * rate,
  };
}

function mergeStains(
  existing: AtmosphereStain[],
  incoming: AtmosphereStain[],
): AtmosphereStain[] {
  const result = [...existing];
  for (const inc of incoming) {
    const found = result.find((s) => s.atmosphere_id === inc.atmosphere_id);
    if (found) {
      found.strength = Math.min(1, found.strength + inc.strength);
    } else {
      result.push({ ...inc });
    }
  }
  return result;
}

export function runContaminationPass(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
): RoomObject[] {
  const nonArchived = objects.filter((o) => o.status !== 'archived');
  const objectMap = new Map(
    nonArchived.map((o) => [
      o.id,
      { ...o, contamination_log: [...o.contamination_log] },
    ]),
  );

  let eventCount = 0;
  const now = new Date().toISOString();

  outer: for (let i = 0; i < nonArchived.length; i++) {
    for (let j = i + 1; j < nonArchived.length; j++) {
      if (eventCount >= ROOM_TUNING.CONTAMINATION_MAX_PER_PULSE) break outer;

      const a = nonArchived[i];
      const b = nonArchived[j];
      if (!isPair(a, b)) continue;
      if (a.atmosphere_stains.length === 0 && b.atmosphere_stains.length === 0)
        continue;

      const rate = ROOM_TUNING.CONTAMINATION_STAIN_MIGRATION_RATE;
      const heatRate = ROOM_TUNING.CONTAMINATION_HEAT_DRIFT_RATE;

      const objA = objectMap.get(a.id)!;
      const objB = objectMap.get(b.id)!;

      // Migrate stains: each gives some fraction to neighbor
      if (a.atmosphere_stains.length > 0) {
        const migrated = a.atmosphere_stains.map((s) => migrateStain(s, rate));
        objB.atmosphere_stains = mergeStains(objB.atmosphere_stains, migrated);
        objB.contamination_log.push({
          from_id: a.id,
          when: now,
          kind: 'stain_migration',
        });
      }
      if (b.atmosphere_stains.length > 0) {
        const migrated = b.atmosphere_stains.map((s) => migrateStain(s, rate));
        objA.atmosphere_stains = mergeStains(objA.atmosphere_stains, migrated);
        objA.contamination_log.push({
          from_id: b.id,
          when: now,
          kind: 'stain_migration',
        });
      }

      // Heat drift toward neighbor
      const heatDiffAB = objB.heat - objA.heat;
      const heatDiffBA = objA.heat - objB.heat;
      objA.heat = Math.max(0, Math.min(1, objA.heat + heatDiffAB * heatRate));
      objB.heat = Math.max(0, Math.min(1, objB.heat + heatDiffBA * heatRate));

      eventCount++;
    }
  }

  const updated: RoomObject[] = [];
  for (const obj of objectMap.values()) {
    updateObject(groupFolder, obj);
    updated.push(obj);
  }

  if (eventCount > 0) {
    insertTrace(
      groupFolder,
      pulseId,
      'contamination_pass',
      [],
      `events=${eventCount}`,
    );
    logger.debug({ groupFolder, eventCount }, 'Contamination pass complete');
  }

  return updated;
}

export function runProximityStainInheritance(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
): void {
  const nonArchived = objects.filter((o) => o.status !== 'archived');
  const db = getRoomDb(groupFolder);

  // Find heavily-stained objects (stain_count > 5)
  const heavilyStained = nonArchived.filter(
    (o) => o.atmosphere_stains.length > 5,
  );
  if (heavilyStained.length === 0) return;

  let inheritCount = 0;
  const now = new Date().toISOString();

  for (const source of heavilyStained) {
    if (!source.cluster_id) continue;
    // Find cluster members
    const clusterMembers = nonArchived.filter(
      (o) => o.cluster_id === source.cluster_id && o.id !== source.id,
    );

    for (const member of clusterMembers) {
      const dilutedStains = source.atmosphere_stains.map((s) => ({
        ...s,
        strength: s.strength * 0.1, // 1/10 strength
      }));
      const merged = mergeStains(member.atmosphere_stains, dilutedStains);
      const logEntry = {
        from_id: source.id,
        when: now,
        kind: 'proximity_inheritance',
      };
      db.prepare(
        `
        UPDATE objects SET atmosphere_stains = ?, contamination_log = ? WHERE id = ?
      `,
      ).run(
        JSON.stringify(merged),
        JSON.stringify([...member.contamination_log, logEntry]),
        member.id,
      );
      inheritCount++;
    }
  }

  if (inheritCount > 0) {
    insertTrace(
      groupFolder,
      pulseId,
      'proximity_stain_inheritance',
      [],
      `inherited_to=${inheritCount}`,
    );
  }
}

export function runAtmosphereStainingPass(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
  atmosphereId: string,
  atmosphereShape: AtmosphereShape,
  count: number,
): void {
  const now = new Date().toISOString();
  const candidates = objects
    .filter((o) => o.status !== 'archived' && o.heat > 0.3)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, count);

  for (const obj of candidates) {
    const strength = 0.3 + Math.random() * 0.4; // 0.3-0.7
    const newStain: AtmosphereStain = {
      atmosphere_id: atmosphereId,
      strength,
      when: now,
      shape: atmosphereShape,
    };
    const merged = mergeStains(obj.atmosphere_stains, [newStain]);
    getRoomDb(groupFolder)
      .prepare('UPDATE objects SET atmosphere_stains = ? WHERE id = ?')
      .run(JSON.stringify(merged), obj.id);
  }

  if (candidates.length > 0) {
    insertTrace(
      groupFolder,
      pulseId,
      'atmosphere_staining',
      candidates.map((o) => o.id),
      `atmosphere=${atmosphereId} shape=${atmosphereShape} strength_range=0.3-0.7`,
    );
  }
}

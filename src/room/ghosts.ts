/**
 * Zone ghosts — table, creation on move, fading, pull-back effect.
 * Ghosts persist as resonance traces of objects that have left a zone.
 */
import crypto from 'crypto';
import type { RoomObject } from './types.js';
import { getRoomDb, insertTrace } from './store.js';
import { logger } from '../logger.js';
import { ROOM_TUNING } from './tuning.js';

export interface ZoneGhost {
  id: string;
  original_object_id: string;
  zone: string;
  ghost_heat: number;
  resonance_contribution: number;
  left_at: string;
  last_touched: string;
}

export function createGhost(
  groupFolder: string,
  pulseId: string,
  objectId: string,
  zone: string,
): void {
  const db = getRoomDb(groupFolder);
  const now = new Date().toISOString();
  const id = `gh-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  db.prepare(
    `
    INSERT INTO zone_ghosts (id, original_object_id, zone, ghost_heat, resonance_contribution, left_at, last_touched)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(id, objectId, zone, 0.15, 0.2, now, now);

  insertTrace(
    groupFolder,
    pulseId,
    'ghost_created',
    [objectId],
    `zone=${zone}`,
  );
  logger.debug({ groupFolder, objectId, zone }, 'Zone ghost created');
}

export function fadeGhosts(groupFolder: string, pulseId: string): void {
  const db = getRoomDb(groupFolder);
  const now = new Date().toISOString();
  const decay = ROOM_TUNING.GHOST_HEAT_DECAY;
  const minHeat = ROOM_TUNING.GHOST_MIN_HEAT;

  const ghosts = db.prepare('SELECT * FROM zone_ghosts').all() as Array<{
    id: string;
    ghost_heat: number;
    original_object_id: string;
    zone: string;
  }>;

  let deletedCount = 0;
  let fadedCount = 0;

  for (const ghost of ghosts) {
    const newHeat = ghost.ghost_heat * (1 - decay);
    if (newHeat < minHeat) {
      db.prepare('DELETE FROM zone_ghosts WHERE id = ?').run(ghost.id);
      deletedCount++;
    } else {
      db.prepare(
        'UPDATE zone_ghosts SET ghost_heat = ?, last_touched = ? WHERE id = ?',
      ).run(newHeat, now, ghost.id);
      fadedCount++;
    }
  }

  if (deletedCount > 0 || fadedCount > 0) {
    logger.debug(
      { groupFolder, fadedCount, deletedCount },
      'Ghost fade pass complete',
    );
    if (deletedCount > 0) {
      insertTrace(
        groupFolder,
        pulseId,
        'ghost_fade',
        [],
        `deleted=${deletedCount} faded=${fadedCount}`,
      );
    }
  }
}

export function computeGhostResonanceBumps(
  groupFolder: string,
  objects: RoomObject[],
): Map<string, number> {
  const db = getRoomDb(groupFolder);
  const ghosts = db.prepare('SELECT * FROM zone_ghosts').all() as Array<{
    id: string;
    original_object_id: string;
    zone: string;
    ghost_heat: number;
    resonance_contribution: number;
  }>;

  // For each ghost, if there's a similar (same type or shared links) object in that zone,
  // bump its resonance slightly — used in Phase C action evaluation
  const resonanceBumps = new Map<string, number>();

  for (const ghost of ghosts) {
    const zoneObjects = objects.filter(
      (o) => o.zone === ghost.zone && o.status !== 'archived',
    );
    const originalObj = objects.find((o) => o.id === ghost.original_object_id);
    if (!originalObj) continue;

    for (const obj of zoneObjects) {
      // Similar = same type OR shared links
      const similar =
        obj.type === originalObj.type ||
        obj.links.some((l) => originalObj.links.includes(l));
      if (similar) {
        const existing = resonanceBumps.get(obj.id) ?? 0;
        resonanceBumps.set(
          obj.id,
          existing + ghost.resonance_contribution * ghost.ghost_heat,
        );
      }
    }
  }

  return resonanceBumps;
}

export function getAllGhosts(groupFolder: string): ZoneGhost[] {
  const db = getRoomDb(groupFolder);
  const rows = db.prepare('SELECT * FROM zone_ghosts').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as string,
    original_object_id: r.original_object_id as string,
    zone: r.zone as string,
    ghost_heat: r.ghost_heat as number,
    resonance_contribution: r.resonance_contribution as number,
    left_at: r.left_at as string,
    last_touched: r.last_touched as string,
  }));
}

export function countGhosts(groupFolder: string): number {
  const db = getRoomDb(groupFolder);
  const row = db.prepare('SELECT COUNT(*) as n FROM zone_ghosts').get() as {
    n: number;
  };
  return row.n;
}

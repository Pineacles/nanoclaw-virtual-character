/**
 * Signature asymmetry discovery — wrong-sized bias tracking.
 * Objects that are low-importance but high heat+stickiness and old.
 */
import type { RoomObject } from './types.js';
import { getRoomDb, insertTrace } from './store.js';
import { logger } from '../logger.js';
import { ROOM_TUNING } from './tuning.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function runSignatureAsymmetryPass(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
): void {
  const db = getRoomDb(groupFolder);
  const now = Date.now();

  let flagged = 0;
  let unflagged = 0;

  for (const obj of objects) {
    if (obj.status === 'archived') continue;

    const aliveMs = now - new Date(obj.time_total_alive_at).getTime();
    const meetsConditions =
      obj.importance < ROOM_TUNING.WRONG_SIZED_IMPORTANCE_MAX &&
      obj.heat + obj.stickiness >
        ROOM_TUNING.WRONG_SIZED_STICKINESS_MIN + 0.5 &&
      aliveMs > SEVEN_DAYS_MS;

    if (meetsConditions && !obj.signature_asymmetry) {
      db.prepare('UPDATE objects SET signature_asymmetry = 1 WHERE id = ?').run(
        obj.id,
      );
      flagged++;
      insertTrace(
        groupFolder,
        pulseId,
        'signature_asymmetry_flagged',
        [obj.id],
        `importance=${obj.importance.toFixed(2)} heat=${obj.heat.toFixed(2)} stickiness=${obj.stickiness.toFixed(2)}`,
      );
    } else if (!meetsConditions && obj.signature_asymmetry) {
      db.prepare('UPDATE objects SET signature_asymmetry = 0 WHERE id = ?').run(
        obj.id,
      );
      unflagged++;
    }
  }

  if (flagged > 0 || unflagged > 0) {
    logger.debug(
      { groupFolder, flagged, unflagged },
      'Signature asymmetry pass complete',
    );
  }
}

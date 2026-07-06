/**
 * Observation stain mechanism + inspect() event recording.
 */
import crypto from 'crypto';
import { getRoomDb, insertTrace } from './store.js';
import { logger } from '../logger.js';
import { ROOM_TUNING } from './tuning.js';

export function recordObservationEvent(
  groupFolder: string,
  inspectedIds: string[],
  source: string,
): void {
  const db = getRoomDb(groupFolder);
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO observation_events (when_at, inspected_object_ids, source)
    VALUES (?, ?, ?)
  `,
  ).run(now, JSON.stringify(inspectedIds), source);

  // Bump observation_stain on each inspected object
  const bump = ROOM_TUNING.OBSERVATION_STAIN_BUMP;
  for (const id of inspectedIds) {
    db.prepare(
      `
      UPDATE objects SET observation_stain = MIN(1.0, observation_stain + ?) WHERE id = ?
    `,
    ).run(bump, id);
  }

  logger.debug(
    { groupFolder, inspectedIds, source },
    'Observation event recorded',
  );
}

export function decayObservationStains(
  groupFolder: string,
  pulseId: string,
): void {
  const db = getRoomDb(groupFolder);
  const decay = ROOM_TUNING.OBSERVATION_STAIN_DECAY;

  db.prepare(
    `
    UPDATE objects SET observation_stain = MAX(0.0, observation_stain - ?)
    WHERE observation_stain > 0
  `,
  ).run(decay);

  insertTrace(
    groupFolder,
    pulseId,
    'observation_stain_decay',
    [],
    `decay=${decay}`,
  );
}

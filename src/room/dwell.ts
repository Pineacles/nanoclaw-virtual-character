/**
 * Dwell accumulation — sitting-with state for dormant/cooling objects.
 * Low-energy mood or heavy weather → dwell increments.
 * High-energy mood → dwell reset.
 */
import type { RoomObject, AtmosphereShape } from './types.js';
import { getRoomDb } from './store.js';
import { logger } from '../logger.js';

const LOW_ENERGY_THRESHOLD = 4.0; // 0-10 scale
const HIGH_ENERGY_THRESHOLD = 7.0;
const AIRLESS_SHAPES: AtmosphereShape[] = ['airless', 'heavy', 'quietly_dense'];

function isLowEnergyOrAirless(energy: number, shape: AtmosphereShape): boolean {
  return energy < LOW_ENERGY_THRESHOLD || AIRLESS_SHAPES.includes(shape);
}

function isHighEnergy(energy: number): boolean {
  return energy > HIGH_ENERGY_THRESHOLD;
}

export function applyDwellAccumulation(
  groupFolder: string,
  objects: RoomObject[],
  atmosphereEnergy: number,
  atmosphereShape: AtmosphereShape,
): void {
  const db = getRoomDb(groupFolder);
  const now = new Date().toISOString();

  if (isHighEnergy(atmosphereEnergy)) {
    // High energy: reset dwell on objects with dwell_pulses > 3
    const resetCandidates = objects.filter(
      (o) => o.dwell_pulses > 3 && o.status !== 'archived',
    );
    for (const obj of resetCandidates) {
      db.prepare(
        'UPDATE objects SET dwell_pulses = 0, sitting_with_since = NULL WHERE id = ?',
      ).run(obj.id);
    }
    if (resetCandidates.length > 0) {
      logger.debug(
        { groupFolder, reset: resetCandidates.length },
        'Dwell reset (high energy)',
      );
    }
    return;
  }

  if (!isLowEnergyOrAirless(atmosphereEnergy, atmosphereShape)) return;

  // Low energy or airless: increment dwell on 1-3 high-heat dormant/cooling objects
  const candidates = objects
    .filter(
      (o) =>
        (o.status === 'dormant' || o.status === 'cooling') && o.heat > 0.15,
    )
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 1 + Math.floor(Math.random() * 3)); // 1-3

  for (const obj of candidates) {
    const newDwellPulses = obj.dwell_pulses + 1;
    const sittingWith = obj.sitting_with_since ?? now;
    db.prepare(
      'UPDATE objects SET dwell_pulses = ?, sitting_with_since = ? WHERE id = ?',
    ).run(newDwellPulses, sittingWith, obj.id);
  }

  if (candidates.length > 0) {
    logger.debug(
      { groupFolder, incremented: candidates.length },
      'Dwell pulses incremented',
    );
  }
}

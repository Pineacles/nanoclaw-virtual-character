/**
 * Room Runtime — module entry point.
 * Re-exports the public surface for src/index.ts integration.
 */
export type {
  RoomObject,
  PressureState,
  AtmosphereSnapshot,
  RoomMeta,
  Zone,
  BleedClass,
  ObjectStatus,
  AtmosphereShape,
  TitleChange,
  AtmosphereStain,
  NearMissCounts,
  FailedForm,
  FractureSeam,
} from './types.js';

export {
  getRoomDb,
  closeRoomDb,
  getMeta,
  updateMeta,
  insertObject,
  updateObject,
  getAllObjects,
  getObjectsByStatus,
  countObjects,
  insertPressure,
  insertAtmosphereSnapshot,
  insertTrace,
} from './store.js';

export { applyDrift, shouldSkipDrift } from './drift.js';
export { computePressure } from './pressure.js';
export { captureAtmosphere } from './atmosphere.js';
export { runBootstrap } from './bootstrap.js';
export {
  RoomRuntime,
  getOrCreateRoomRuntime,
  stopAllRoomRuntimes,
} from './runtime.js';
export type { RoomRuntimeDeps, RoomSnapshot } from './runtime.js';

// Phase B tuning knobs — re-exported from tuning.ts
export { ROOM_TUNING } from './tuning.js';

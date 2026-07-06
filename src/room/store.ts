/**
 * Room SQLite store — WAL-mode, per-group room.db.
 * Tables: objects, pressures, atmosphere_snapshots, traces, meta, memory_overlay
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type {
  RoomObject,
  PressureState,
  AtmosphereSnapshot,
  RoomMeta,
} from './types.js';

// Lazy-init per-group DB connections
const dbs = new Map<string, Database.Database>();

export function getRoomDb(groupFolder: string): Database.Database {
  let db = dbs.get(groupFolder);
  if (db) return db;

  const dir = path.join(GROUPS_DIR, groupFolder, 'room');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'room.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrateSchema(db);

  dbs.set(groupFolder, db);
  logger.info({ groupFolder, dbPath }, 'Room DB opened');
  return db;
}

export function closeRoomDb(groupFolder: string): void {
  const db = dbs.get(groupFolder);
  if (db) {
    db.close();
    dbs.delete(groupFolder);
  }
}

function migrateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      zone TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',

      -- Core dynamics
      confidence REAL NOT NULL DEFAULT 0.7,
      importance REAL NOT NULL DEFAULT 0.5,
      heat REAL NOT NULL DEFAULT 0.5,
      resonance REAL NOT NULL DEFAULT 0.0,
      dormancy REAL NOT NULL DEFAULT 0.0,
      persistence REAL NOT NULL DEFAULT 0.5,
      weirdness REAL NOT NULL DEFAULT 0.0,
      private_significance REAL NOT NULL DEFAULT 0.0,

      -- Bleed + references
      bleed_class TEXT NOT NULL DEFAULT 'sealed',
      source_refs TEXT NOT NULL DEFAULT '[]',
      links TEXT NOT NULL DEFAULT '[]',

      -- Phase A scaffolding
      stickiness REAL NOT NULL DEFAULT 0.3,
      residual_warmth_floor REAL NOT NULL DEFAULT 0.0,
      title_history TEXT NOT NULL DEFAULT '[]',
      time_in_zone_started_at TEXT NOT NULL,
      time_total_alive_at TEXT NOT NULL,

      -- Phase B/C stubs (JSON)
      atmosphere_stains TEXT NOT NULL DEFAULT '[]',
      near_miss_counts TEXT NOT NULL DEFAULT '{"almost_drafted":0,"almost_revived":0,"touched_then_left":0,"weak_relinks_loosened":0,"heat_lifted_then_dropped":0,"wording_disturbed":0,"title_almost_changed":0}',
      failed_forms TEXT NOT NULL DEFAULT '[]',
      fracture_seam TEXT DEFAULT NULL,
      observation_stain REAL NOT NULL DEFAULT 0.0,
      deep_presence INTEGER NOT NULL DEFAULT 0,
      shadow_of TEXT DEFAULT NULL,
      anti_resolution REAL NOT NULL DEFAULT 0.0,
      signature_asymmetry INTEGER NOT NULL DEFAULT 0,
      latent_influence REAL NOT NULL DEFAULT 0.0,
      unerasable INTEGER NOT NULL DEFAULT 0,
      privately_kept INTEGER NOT NULL DEFAULT 0,
      kept_reason TEXT DEFAULT NULL,
      sitting_with_since TEXT DEFAULT NULL,
      dwell_pulses INTEGER NOT NULL DEFAULT 0,
      cluster_id TEXT DEFAULT NULL,
      contamination_log TEXT NOT NULL DEFAULT '[]',
      mood_affinity TEXT NOT NULL DEFAULT '{}',
      schedule_affinity TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_objects_zone ON objects(zone);
    CREATE INDEX IF NOT EXISTS idx_objects_status ON objects(status);
    CREATE INDEX IF NOT EXISTS idx_objects_heat ON objects(heat);
    CREATE INDEX IF NOT EXISTS idx_objects_importance ON objects(importance);

    CREATE TABLE IF NOT EXISTS pressures (
      id TEXT PRIMARY KEY,
      pulse_count INTEGER NOT NULL,
      when_recorded TEXT NOT NULL,
      revisit_pressure REAL NOT NULL DEFAULT 0.0,
      relink_pressure REAL NOT NULL DEFAULT 0.0,
      rename_pressure REAL NOT NULL DEFAULT 0.0,
      draft_pressure REAL NOT NULL DEFAULT 0.0,
      archive_pressure REAL NOT NULL DEFAULT 0.0,
      clarify_pressure REAL NOT NULL DEFAULT 0.0,
      mirror_pressure REAL NOT NULL DEFAULT 0.0,
      residue_pressure REAL NOT NULL DEFAULT 0.0,
      shelf_pressure REAL NOT NULL DEFAULT 0.0,
      unfinished_pressure REAL NOT NULL DEFAULT 0.0,
      namelessness_pressure REAL NOT NULL DEFAULT 0.0
    );

    CREATE INDEX IF NOT EXISTS idx_pressures_when ON pressures(when_recorded);

    CREATE TABLE IF NOT EXISTS atmosphere_snapshots (
      id TEXT PRIMARY KEY,
      when_recorded TEXT NOT NULL,
      mood_blend TEXT NOT NULL DEFAULT '{}',
      energy REAL NOT NULL DEFAULT 5.0,
      emotional_undercurrent TEXT DEFAULT NULL,
      schedule_phase TEXT DEFAULT NULL,
      shape TEXT NOT NULL DEFAULT 'diffuse',
      weather TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_atm_when ON atmosphere_snapshots(when_recorded);

    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      pulse_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      affected_object_ids TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      when_recorded TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_traces_pulse ON traces(pulse_id);
    CREATE INDEX IF NOT EXISTS idx_traces_action ON traces(action_type);

    CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      room_initialized_at TEXT DEFAULT NULL,
      last_pulse_at TEXT DEFAULT NULL,
      pulse_count INTEGER NOT NULL DEFAULT 0,
      last_haiku_at TEXT DEFAULT NULL,
      haiku_count_hour INTEGER NOT NULL DEFAULT 0,
      privately_kept_cleanup_v1_done INTEGER DEFAULT 0
    );

    INSERT OR IGNORE INTO meta (id) VALUES (1);

    -- Phase B: ensure weather column exists on atmosphere_snapshots (for existing DBs)
    -- Note: SQLite does not support IF NOT EXISTS on ALTER TABLE; handled below.

    CREATE TABLE IF NOT EXISTS memory_overlay (
      memory_id TEXT PRIMARY KEY,
      room_resonance REAL NOT NULL DEFAULT 0.0,
      room_last_touched TEXT DEFAULT NULL,
      room_significance_delta REAL NOT NULL DEFAULT 0.0
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY,
      discovered_at TEXT NOT NULL,
      atmosphere_fingerprint TEXT NOT NULL,
      shape TEXT NOT NULL,
      member_ids TEXT NOT NULL,
      current_name TEXT,
      namelessness_pressure REAL DEFAULT 0,
      stability REAL DEFAULT 0.3,
      last_updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS zone_ghosts (
      id TEXT PRIMARY KEY,
      original_object_id TEXT NOT NULL,
      zone TEXT NOT NULL,
      ghost_heat REAL DEFAULT 0.15,
      resonance_contribution REAL DEFAULT 0.2,
      left_at TEXT NOT NULL,
      last_touched TEXT NOT NULL,
      FOREIGN KEY (original_object_id) REFERENCES objects(id)
    );

    CREATE TABLE IF NOT EXISTS observation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      when_at TEXT NOT NULL,
      inspected_object_ids TEXT NOT NULL,
      source TEXT
    );
  `);

  // Add weather column to existing atmosphere_snapshots tables (safe no-op if already present)
  try {
    db.prepare(
      'ALTER TABLE atmosphere_snapshots ADD COLUMN weather TEXT DEFAULT NULL',
    ).run();
  } catch {
    // Column already exists — ignore
  }

  // Add privately_kept_cleanup_v1_done to meta (safe no-op if already present)
  try {
    db.prepare(
      'ALTER TABLE meta ADD COLUMN privately_kept_cleanup_v1_done INTEGER DEFAULT 0',
    ).run();
  } catch {
    // Column already exists — ignore
  }

  // One-shot cleanup: reset over-marked privately_kept objects, keep top 15 by stickiness+weirdness+heat
  const cleanupFlag = (
    db
      .prepare('SELECT privately_kept_cleanup_v1_done FROM meta WHERE id = 1')
      .get() as { privately_kept_cleanup_v1_done: number | null } | undefined
  )?.privately_kept_cleanup_v1_done;
  if (!cleanupFlag) {
    db.prepare(
      `
      UPDATE objects SET privately_kept = 0 WHERE id NOT IN (
        SELECT id FROM objects
        WHERE privately_kept = 1 AND status != 'archived'
        ORDER BY (stickiness + weirdness + heat) DESC
        LIMIT 15
      ) AND privately_kept = 1
    `,
    ).run();
    db.prepare(
      'UPDATE meta SET privately_kept_cleanup_v1_done = 1 WHERE id = 1',
    ).run();
    logger.info(
      'Room DB: privately_kept_cleanup_v1 applied — reset over-marked objects, kept top 15',
    );
  }
}

// --- Meta ---

export function getMeta(groupFolder: string): RoomMeta {
  const db = getRoomDb(groupFolder);
  const row = db.prepare('SELECT * FROM meta WHERE id = 1').get() as {
    room_initialized_at: string | null;
    last_pulse_at: string | null;
    pulse_count: number;
    last_haiku_at: string | null;
    haiku_count_hour: number;
  };
  return {
    room_initialized_at: row.room_initialized_at,
    last_pulse_at: row.last_pulse_at,
    pulse_count: row.pulse_count,
    last_haiku_at: row.last_haiku_at,
    haiku_count_hour: row.haiku_count_hour,
  };
}

export function updateMeta(
  groupFolder: string,
  updates: Partial<RoomMeta>,
): void {
  const db = getRoomDb(groupFolder);
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.room_initialized_at !== undefined) {
    fields.push('room_initialized_at = ?');
    values.push(updates.room_initialized_at);
  }
  if (updates.last_pulse_at !== undefined) {
    fields.push('last_pulse_at = ?');
    values.push(updates.last_pulse_at);
  }
  if (updates.pulse_count !== undefined) {
    fields.push('pulse_count = ?');
    values.push(updates.pulse_count);
  }
  if (updates.last_haiku_at !== undefined) {
    fields.push('last_haiku_at = ?');
    values.push(updates.last_haiku_at);
  }
  if (updates.haiku_count_hour !== undefined) {
    fields.push('haiku_count_hour = ?');
    values.push(updates.haiku_count_hour);
  }

  if (fields.length === 0) return;

  db.prepare(`UPDATE meta SET ${fields.join(', ')} WHERE id = 1`).run(
    ...values,
  );
}

// --- Objects ---

function rowToObject(row: Record<string, unknown>): RoomObject {
  return {
    id: row.id as string,
    type: row.type as string,
    zone: row.zone as RoomObject['zone'],
    title: row.title as string,
    body: row.body as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    status: row.status as RoomObject['status'],
    confidence: row.confidence as number,
    importance: row.importance as number,
    heat: row.heat as number,
    resonance: row.resonance as number,
    dormancy: row.dormancy as number,
    persistence: row.persistence as number,
    weirdness: row.weirdness as number,
    privateSignificance: row.private_significance as number,
    bleedClass: row.bleed_class as RoomObject['bleedClass'],
    sourceRefs: JSON.parse(row.source_refs as string),
    links: JSON.parse(row.links as string),
    stickiness: row.stickiness as number,
    residual_warmth_floor: row.residual_warmth_floor as number,
    title_history: JSON.parse(row.title_history as string),
    time_in_zone_started_at: row.time_in_zone_started_at as string,
    time_total_alive_at: row.time_total_alive_at as string,
    atmosphere_stains: JSON.parse(row.atmosphere_stains as string),
    near_miss_counts: JSON.parse(row.near_miss_counts as string),
    failed_forms: JSON.parse(row.failed_forms as string),
    fracture_seam: row.fracture_seam
      ? JSON.parse(row.fracture_seam as string)
      : null,
    observation_stain: row.observation_stain as number,
    deep_presence: Boolean(row.deep_presence),
    shadow_of: row.shadow_of as string | null,
    anti_resolution: row.anti_resolution as number,
    signature_asymmetry: Boolean(row.signature_asymmetry),
    latent_influence: row.latent_influence as number,
    unerasable: Boolean(row.unerasable),
    privately_kept: Boolean(row.privately_kept),
    kept_reason: row.kept_reason as string | null,
    sitting_with_since: row.sitting_with_since as string | null,
    dwell_pulses: row.dwell_pulses as number,
    cluster_id: row.cluster_id as string | null,
    contamination_log: JSON.parse(row.contamination_log as string),
    mood_affinity: JSON.parse(row.mood_affinity as string),
    schedule_affinity: JSON.parse(row.schedule_affinity as string),
  };
}

export function insertObject(groupFolder: string, obj: RoomObject): void {
  const db = getRoomDb(groupFolder);
  db.prepare(
    `
    INSERT INTO objects (
      id, type, zone, title, body, created_at, updated_at, status,
      confidence, importance, heat, resonance, dormancy, persistence, weirdness, private_significance,
      bleed_class, source_refs, links,
      stickiness, residual_warmth_floor, title_history, time_in_zone_started_at, time_total_alive_at,
      atmosphere_stains, near_miss_counts, failed_forms, fracture_seam,
      observation_stain, deep_presence, shadow_of, anti_resolution, signature_asymmetry,
      latent_influence, unerasable, privately_kept, kept_reason, sitting_with_since,
      dwell_pulses, cluster_id, contamination_log, mood_affinity, schedule_affinity
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `,
  ).run(
    obj.id,
    obj.type,
    obj.zone,
    obj.title,
    obj.body,
    obj.createdAt,
    obj.updatedAt,
    obj.status,
    obj.confidence,
    obj.importance,
    obj.heat,
    obj.resonance,
    obj.dormancy,
    obj.persistence,
    obj.weirdness,
    obj.privateSignificance,
    obj.bleedClass,
    JSON.stringify(obj.sourceRefs),
    JSON.stringify(obj.links),
    obj.stickiness,
    obj.residual_warmth_floor,
    JSON.stringify(obj.title_history),
    obj.time_in_zone_started_at,
    obj.time_total_alive_at,
    JSON.stringify(obj.atmosphere_stains),
    JSON.stringify(obj.near_miss_counts),
    JSON.stringify(obj.failed_forms),
    obj.fracture_seam ? JSON.stringify(obj.fracture_seam) : null,
    obj.observation_stain,
    obj.deep_presence ? 1 : 0,
    obj.shadow_of,
    obj.anti_resolution,
    obj.signature_asymmetry ? 1 : 0,
    obj.latent_influence,
    obj.unerasable ? 1 : 0,
    obj.privately_kept ? 1 : 0,
    obj.kept_reason,
    obj.sitting_with_since,
    obj.dwell_pulses,
    obj.cluster_id,
    JSON.stringify(obj.contamination_log),
    JSON.stringify(obj.mood_affinity),
    JSON.stringify(obj.schedule_affinity),
  );
}

export function updateObject(groupFolder: string, obj: RoomObject): void {
  const db = getRoomDb(groupFolder);
  db.prepare(
    `
    UPDATE objects SET
      type = ?, zone = ?, title = ?, body = ?, updated_at = ?, status = ?,
      confidence = ?, importance = ?, heat = ?, resonance = ?, dormancy = ?,
      persistence = ?, weirdness = ?, private_significance = ?,
      bleed_class = ?, source_refs = ?, links = ?,
      stickiness = ?, residual_warmth_floor = ?, title_history = ?,
      time_in_zone_started_at = ?, time_total_alive_at = ?,
      atmosphere_stains = ?, near_miss_counts = ?, failed_forms = ?,
      fracture_seam = ?, observation_stain = ?, deep_presence = ?,
      shadow_of = ?, anti_resolution = ?, signature_asymmetry = ?,
      latent_influence = ?, unerasable = ?, privately_kept = ?,
      kept_reason = ?, sitting_with_since = ?, dwell_pulses = ?,
      cluster_id = ?, contamination_log = ?, mood_affinity = ?, schedule_affinity = ?
    WHERE id = ?
  `,
  ).run(
    obj.type,
    obj.zone,
    obj.title,
    obj.body,
    obj.updatedAt,
    obj.status,
    obj.confidence,
    obj.importance,
    obj.heat,
    obj.resonance,
    obj.dormancy,
    obj.persistence,
    obj.weirdness,
    obj.privateSignificance,
    obj.bleedClass,
    JSON.stringify(obj.sourceRefs),
    JSON.stringify(obj.links),
    obj.stickiness,
    obj.residual_warmth_floor,
    JSON.stringify(obj.title_history),
    obj.time_in_zone_started_at,
    obj.time_total_alive_at,
    JSON.stringify(obj.atmosphere_stains),
    JSON.stringify(obj.near_miss_counts),
    JSON.stringify(obj.failed_forms),
    obj.fracture_seam ? JSON.stringify(obj.fracture_seam) : null,
    obj.observation_stain,
    obj.deep_presence ? 1 : 0,
    obj.shadow_of,
    obj.anti_resolution,
    obj.signature_asymmetry ? 1 : 0,
    obj.latent_influence,
    obj.unerasable ? 1 : 0,
    obj.privately_kept ? 1 : 0,
    obj.kept_reason,
    obj.sitting_with_since,
    obj.dwell_pulses,
    obj.cluster_id,
    JSON.stringify(obj.contamination_log),
    JSON.stringify(obj.mood_affinity),
    JSON.stringify(obj.schedule_affinity),
    obj.id,
  );
}

export function getAllObjects(groupFolder: string): RoomObject[] {
  const db = getRoomDb(groupFolder);
  const rows = db.prepare('SELECT * FROM objects').all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToObject);
}

/**
 * Non-archived objects only. Archived objects outnumber live ones ~17:1 in a
 * mature room, and every pulse pass filters them out anyway — loading them
 * just to discard them dominated pulse cost (each row JSON-parses several
 * columns). Use this in pulse passes; getAllObjects remains for consumers
 * that genuinely need archive history (cluster pruning, inspect API).
 */
export function getActiveObjects(groupFolder: string): RoomObject[] {
  const db = getRoomDb(groupFolder);
  const rows = db
    .prepare(`SELECT * FROM objects WHERE status != 'archived'`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToObject);
}

export function getObjectsByStatus(
  groupFolder: string,
  status: string,
): RoomObject[] {
  const db = getRoomDb(groupFolder);
  const rows = db
    .prepare('SELECT * FROM objects WHERE status = ?')
    .all(status) as Record<string, unknown>[];
  return rows.map(rowToObject);
}

export function countObjects(groupFolder: string): number {
  const db = getRoomDb(groupFolder);
  const row = db.prepare('SELECT COUNT(*) as n FROM objects').get() as {
    n: number;
  };
  return row.n;
}

// --- Pressures ---

export function insertPressure(
  groupFolder: string,
  pulseCount: number,
  pressure: PressureState,
): void {
  const db = getRoomDb(groupFolder);
  const id = `p-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO pressures (
      id, pulse_count, when_recorded,
      revisit_pressure, relink_pressure, rename_pressure, draft_pressure,
      archive_pressure, clarify_pressure, mirror_pressure, residue_pressure,
      shelf_pressure, unfinished_pressure, namelessness_pressure
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    pulseCount,
    now,
    pressure.revisitPressure,
    pressure.relinkPressure,
    pressure.renamePressure,
    pressure.draftPressure,
    pressure.archivePressure,
    pressure.clarifyPressure,
    pressure.mirrorPressure,
    pressure.residuePressure,
    pressure.shelfPressure,
    pressure.unfinishedPressure,
    pressure.namelessness_pressure,
  );
}

// --- Atmosphere Snapshots ---

export function insertAtmosphereSnapshot(
  groupFolder: string,
  snap: AtmosphereSnapshot,
): void {
  const db = getRoomDb(groupFolder);
  db.prepare(
    `
    INSERT INTO atmosphere_snapshots (id, when_recorded, mood_blend, energy, emotional_undercurrent, schedule_phase, shape)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    snap.id,
    snap.when,
    JSON.stringify(snap.mood_blend),
    snap.energy,
    snap.emotional_undercurrent,
    snap.schedule_phase,
    snap.shape,
  );
}

// --- Traces ---

export function insertTrace(
  groupFolder: string,
  pulseId: string,
  actionType: string,
  affectedObjectIds: string[],
  reason?: string,
): void {
  const db = getRoomDb(groupFolder);
  const id = `t-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  db.prepare(
    `
    INSERT INTO traces (id, pulse_id, action_type, affected_object_ids, reason, when_recorded)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    pulseId,
    actionType,
    JSON.stringify(affectedObjectIds),
    reason ?? null,
    new Date().toISOString(),
  );
}

// Retention caps for telemetry tables. These are pulse-by-pulse logs the
// roleplay never reads back beyond recent history; without caps they grow
// forever (observed: 154k traces / 18k snapshots in a 2-month-old room).
const MAX_TRACES = 20000;
const MAX_PRESSURES = 5000;
const MAX_ATMOSPHERE_SNAPSHOTS = 5000;
const MAX_OBSERVATION_EVENTS = 5000;

/**
 * Periodic maintenance: prune telemetry tables and checkpoint the WAL so it
 * does not grow unbounded between restarts (observed at 40 MB). Cheap when
 * there is nothing to do; intended to run every Nth pulse.
 */
export function runRoomMaintenance(groupFolder: string): void {
  const db = getRoomDb(groupFolder);
  const prune = (table: string, keep: number): void => {
    // rowid order == insertion order for these append-only tables
    db.prepare(
      `DELETE FROM ${table} WHERE rowid NOT IN (
         SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT ?
       )`,
    ).run(keep);
  };
  prune('traces', MAX_TRACES);
  prune('pressures', MAX_PRESSURES);
  prune('atmosphere_snapshots', MAX_ATMOSPHERE_SNAPSHOTS);
  prune('observation_events', MAX_OBSERVATION_EVENTS);
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/**
 * Conversation fragment ingestion — Phase D.
 * Picks random lines from new conversations/*.md files and inserts them as
 * archived_fragment room objects in the attic.
 * Called every 10th pulse from runtime.ts when room_ingest flag is on.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { GROUPS_DIR, ASSISTANT_NAME } from '../config.js';
import { getRoomDb, insertObject } from './store.js';
import { logger } from '../logger.js';
import type { RoomObject, AtmosphereShape } from './types.js';

interface WeatherRow {
  id: string;
  shape: string;
}

function readCurrentAtmosphere(groupFolder: string): WeatherRow | null {
  try {
    const db = getRoomDb(groupFolder);
    const row = db
      .prepare(
        `SELECT id, shape FROM atmosphere_snapshots ORDER BY when_recorded DESC LIMIT 1`,
      )
      .get() as WeatherRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function getLastIngestAt(groupFolder: string): number {
  try {
    const db = getRoomDb(groupFolder);
    const row = db.prepare(`SELECT * FROM meta WHERE id = 1`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return 0;
    // stored as ISO string in a JSON blob or directly; try last_conversations_ingest_at column
    const raw = row['last_conversations_ingest_at'];
    if (typeof raw === 'string' && raw) {
      return new Date(raw).getTime();
    }
    return 0;
  } catch {
    return 0;
  }
}

function setLastIngestAt(groupFolder: string, isoTime: string): void {
  try {
    const db = getRoomDb(groupFolder);
    // Ensure column exists (safe no-op if already present)
    try {
      db.prepare(
        `ALTER TABLE meta ADD COLUMN last_conversations_ingest_at TEXT DEFAULT NULL`,
      ).run();
    } catch {
      /* already exists */
    }
    db.prepare(
      `UPDATE meta SET last_conversations_ingest_at = ? WHERE id = 1`,
    ).run(isoTime);
  } catch (err) {
    logger.warn(
      { err, groupFolder },
      'conversations-ingest: failed to update last_conversations_ingest_at',
    );
  }
}

function sanitizeLine(line: string): string {
  return line
    .replace(new RegExp(`^\\*\\*(User|${ASSISTANT_NAME})\\*\\*:\\s*`, 'i'), '')
    .replace(/\*\[mood:[^\]]+\]/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\[.*\]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBoilerplate(line: string): boolean {
  const lower = line.toLowerCase();
  if (!line || line.length < 24) return true;
  return (
    lower.startsWith('[scheduled task') ||
    lower.startsWith('[current date/time') ||
    lower.startsWith('[interior moment') ||
    lower.startsWith('[respond in character') ||
    lower.startsWith('<action>') ||
    lower.startsWith('<reason>') ||
    lower.startsWith('<internal>') ||
    lower.includes('task-notification') ||
    lower.includes('tool-use-id') ||
    lower.includes('output-file') ||
    lower.includes('respond directly') ||
    lower.includes('no preamble') ||
    lower.includes('as an ai') ||
    lower.includes('you must end with') ||
    lower.includes('never write anything that performs') ||
    lower.includes('all output must be wrapped')
  );
}

function scoreLine(line: string): number {
  const lower = line.toLowerCase();
  let score = 0;
  if (lower.includes('?')) score += 2;
  if (/\bi\b/.test(lower)) score += 1;
  if (
    /\b(feel|felt|think|keeps|still|maybe|miss|want|love|weird|wrong|quiet|room|today|tonight)\b/.test(
      lower,
    )
  )
    score += 3;
  if (lower.length > 40 && lower.length < 180) score += 2;
  return score;
}

function pickRandomLine(content: string): string | null {
  const lines = content
    .split('\n')
    .map((l) => sanitizeLine(l))
    .filter((l) => !isBoilerplate(l));
  if (lines.length === 0) return null;

  const ranked = lines
    .map((line) => ({ line, score: scoreLine(line) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const pool =
    ranked.length > 0
      ? ranked.slice(0, 8).map((r) => r.line)
      : lines.slice(0, 8);
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return chosen.slice(0, 160);
}

function firstNWords(text: string, n: number): string {
  return text.split(/\s+/).slice(0, n).join(' ');
}

function classifyFragment(line: string): {
  type: string;
  zone: RoomObject['zone'];
  bleedClass: RoomObject['bleedClass'];
  heat: number;
  title: string;
  privateSignificance: number;
  weirdness: number;
} {
  const lower = line.toLowerCase();
  if (/\b(i don't know|not sure|maybe|can't tell|unsure|idk)\b/.test(lower)) {
    return {
      type: 'uncertainty',
      zone: 'notebook',
      bleedClass: 'referencable',
      heat: 0.34,
      title: `uncertainty: ${firstNWords(line, 6)}`,
      privateSignificance: 0.58,
      weirdness: 0.42,
    };
  }
  if (/\b(always|keeps|again|same|every time)\b/.test(lower)) {
    return {
      type: 'pattern',
      zone: 'desk',
      bleedClass: 'referencable',
      heat: 0.38,
      title: `pattern: ${firstNWords(line, 5)}`,
      privateSignificance: 0.62,
      weirdness: 0.5,
    };
  }
  if (/\b(miss|love|girlfriend|lonely|warm|hurt|ache|care)\b/.test(lower)) {
    return {
      type: 'persistent_trace',
      zone: 'shelf',
      bleedClass: 'ambient',
      heat: 0.42,
      title: firstNWords(line, 6),
      privateSignificance: 0.72,
      weirdness: 0.36,
    };
  }
  return {
    type: 'archived_fragment',
    zone: 'attic',
    bleedClass: 'ambient',
    heat: 0.18,
    title: `fragment: ${firstNWords(line, 5)}`,
    privateSignificance: 0.46,
    weirdness: 0.8,
  };
}

/**
 * Ingest conversation fragments from groups/<group>/conversations/*.md.
 * Returns count of new fragments inserted.
 */
export function ingestConversationFragments(groupFolder: string): number {
  const convsDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  if (!fs.existsSync(convsDir)) return 0;

  const lastIngest = getLastIngestAt(groupFolder);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  let files: string[];
  try {
    files = fs.readdirSync(convsDir).filter((f) => f.endsWith('.md'));
  } catch {
    return 0;
  }

  // Filter to files newer than last ingest. Cap a single pass so a bulk
  // backfill (or first run on a populated dir) cannot flood one pulse with
  // hundreds of fragment objects — newest files win, the rest are picked up
  // implicitly by future content.
  const MAX_FILES_PER_INGEST = 50;
  const newFiles = files
    .map((f) => {
      try {
        return { f, mtime: fs.statSync(path.join(convsDir, f)).mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    })
    .filter((e) => e.mtime > lastIngest)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES_PER_INGEST)
    .map((e) => e.f);

  if (newFiles.length === 0) {
    // Still update timestamp so we don't re-scan old files repeatedly
    setLastIngestAt(groupFolder, nowIso);
    return 0;
  }

  const atm = readCurrentAtmosphere(groupFolder);
  let count = 0;

  for (const file of newFiles) {
    try {
      const content = fs.readFileSync(path.join(convsDir, file), 'utf-8');
      const line = pickRandomLine(content);
      if (!line) continue;

      const nowIsoObj = new Date().toISOString();
      const classified = classifyFragment(line);
      const obj: RoomObject = {
        id: `frag-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        type: classified.type,
        zone: classified.zone,
        title: classified.title,
        body: line,
        createdAt: nowIsoObj,
        updatedAt: nowIsoObj,
        status: 'active',
        confidence: 0.7,
        importance: 0.3,
        heat: classified.heat,
        resonance: 0.0,
        dormancy: 0.0,
        persistence: 0.6,
        weirdness: classified.weirdness,
        privateSignificance: classified.privateSignificance,
        bleedClass: classified.bleedClass,
        sourceRefs: [file],
        links: [],
        stickiness: 0.7,
        residual_warmth_floor: 0.1,
        title_history: [],
        time_in_zone_started_at: nowIsoObj,
        time_total_alive_at: nowIsoObj,
        atmosphere_stains: atm
          ? [
              {
                atmosphere_id: atm.id,
                strength: 0.6,
                when: nowIsoObj,
                shape: atm.shape as AtmosphereShape,
              },
            ]
          : [],
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
        fracture_seam: null,
        observation_stain: 0.0,
        deep_presence: false,
        shadow_of: null,
        anti_resolution: 0.0,
        signature_asymmetry: false,
        latent_influence: 0.0,
        unerasable: false,
        privately_kept: true,
        kept_reason: 'preserved from before',
        sitting_with_since: null,
        dwell_pulses: 0,
        cluster_id: null,
        contamination_log: [],
        mood_affinity: {},
        schedule_affinity: {},
      };

      insertObject(groupFolder, obj);
      count++;
      logger.debug(
        { groupFolder, file, objectId: obj.id },
        'conversations-ingest: fragment inserted',
      );
    } catch (err) {
      logger.warn(
        { err, groupFolder, file },
        'conversations-ingest: failed to process file',
      );
    }
  }

  setLastIngestAt(groupFolder, nowIso);
  return count;
}

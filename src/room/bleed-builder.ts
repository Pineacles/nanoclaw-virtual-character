/**
 * Room bleed builder — Phase D.
 * Produces the [Room bleed ...] block injected into buildPerMessagePrefix.
 * Fully deterministic — no Haiku, no LLM.
 */

import path from 'path';
import fs from 'fs';
import { getRoomDb } from './store.js';
import { GROUPS_DIR } from '../config.js';
import type { RoomObject, AtmosphereShape } from './types.js';

// Small LRU for per-object cooldown: tracks which object id was in salience last turn
const salience_lru: Map<string, number> = new Map();
const SALIENCE_LRU_SIZE = 32;

function nowMs(): number {
  return Date.now();
}

function recordSalienceLru(objectId: string): void {
  salience_lru.set(objectId, nowMs());
  if (salience_lru.size > SALIENCE_LRU_SIZE) {
    // Evict oldest
    const oldest = [...salience_lru.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) salience_lru.delete(oldest[0]);
  }
}

function wasInSalienceLastTurn(objectId: string): boolean {
  const ts = salience_lru.get(objectId);
  if (!ts) return false;
  // Cooldown window. 60s was shorter than a normal conversational beat, so
  // the same object resurfaced on back-to-back messages and read as a
  // repetition instead of ambience. Five minutes keeps hints varied within
  // one sitting while still letting a hot object return later.
  return nowMs() - ts < 300_000;
}

const FORBIDDEN_TOKENS = [
  'missing',
  "can't stop thinking",
  'ache',
  ' want ',
  ' need ',
  'longing',
  'heavy without',
];

function hasForbiddenTokens(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_TOKENS.some((t) => lower.includes(t));
}

function shapeToTimingWord(shape: AtmosphereShape | string): string {
  switch (shape) {
    case 'circling':
      return 'circling';
    case 'sharp':
      return 'quick';
    case 'diffuse':
      return 'open';
    case 'airless':
      return 'airless';
    case 'restless':
      return 'open';
    case 'quietly_dense':
      return 'quietly dense';
    case 'unstable':
      return 'open';
    case 'heavy':
      return 'viscous';
    case 'thin':
      return 'open';
    case 'fractal':
      return 'quietly dense';
    default:
      return 'open';
  }
}

function timingFromViscosity(viscosity: number | null): string {
  if (viscosity === null || viscosity === undefined) return 'open';
  if (viscosity > 0.7) return 'viscous';
  if (viscosity < 0.3) return 'quick';
  return 'open';
}

interface WeatherData {
  viscosity?: number;
  shape?: string;
  congestion?: number;
}

function readWeather(groupFolder: string): WeatherData | null {
  try {
    const db = getRoomDb(groupFolder);
    const row = db
      .prepare(
        `SELECT weather FROM atmosphere_snapshots ORDER BY when_recorded DESC LIMIT 1`,
      )
      .get() as { weather: string | null } | undefined;
    if (!row || !row.weather) return null;
    return JSON.parse(row.weather) as WeatherData;
  } catch {
    return null;
  }
}

interface RoomObjectRow {
  id: string;
  type: string;
  title: string;
  heat: number;
  bleed_class: string;
  status: string;
  anti_resolution: number;
  signature_asymmetry: number;
  title_history: string;
  privately_kept: number;
  kept_reason: string | null;
  residual_warmth_floor: number;
}

function readTopObjects(groupFolder: string): RoomObjectRow[] {
  try {
    const db = getRoomDb(groupFolder);
    const rows = db
      .prepare(
        `SELECT id, type, title, heat, bleed_class, status, anti_resolution,
              signature_asymmetry, title_history, privately_kept, kept_reason,
              residual_warmth_floor
       FROM objects
       WHERE status != 'archived'
       ORDER BY heat DESC
       LIMIT 30`,
      )
      .all() as RoomObjectRow[];
    return rows;
  } catch {
    return [];
  }
}

interface PendingBleedHints {
  hints?: string[];
}

function readPendingBleedHints(groupFolder: string): string[] {
  try {
    const db = getRoomDb(groupFolder);
    const row = db.prepare(`SELECT * FROM meta WHERE id = 1`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return [];
    // pending_bleed_hints stored in meta as JSON if column exists
    const raw = (row as Record<string, unknown>).pending_bleed_hints;
    if (!raw) return [];
    const parsed: PendingBleedHints = JSON.parse(raw as string);
    return (parsed.hints || []).slice(-10);
  } catch {
    return [];
  }
}

interface TitleHistoryEntry {
  title: string;
  valid_from: string;
  valid_to: string | null;
  renamed_reason: string;
}

function recentRenames(
  groupFolder: string,
): Array<{ oldTitle: string; newTitle: string; objectId: string }> {
  try {
    const db = getRoomDb(groupFolder);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT id, title, title_history FROM objects WHERE status != 'archived' AND title_history != '[]'`,
      )
      .all() as Array<{ id: string; title: string; title_history: string }>;

    const renames: Array<{
      oldTitle: string;
      newTitle: string;
      objectId: string;
    }> = [];
    for (const row of rows) {
      try {
        const history: TitleHistoryEntry[] = JSON.parse(row.title_history);
        for (const h of history) {
          if (h.valid_to === null && h.valid_from >= cutoff) {
            // recently renamed to current title
            renames.push({
              oldTitle: h.title,
              newTitle: row.title,
              objectId: row.id,
            });
          }
        }
      } catch {
        /* skip */
      }
    }
    return renames.slice(0, 3);
  } catch {
    return [];
  }
}

export interface UserStateLike {
  user_mode?: string;
  confidence?: string;
  depth?: string;
}

/**
 * Read current viscosity from the latest atmosphere_snapshot's weather column.
 * Returns a 0..1 value, or null if room.db is missing or unreadable.
 */
export function readCurrentViscosity(groupFolder: string): number | null {
  const weather = readWeather(groupFolder);
  if (!weather) return null;
  const v = weather.viscosity;
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

/**
 * Build the [Room bleed ...] block for injection into buildPerMessagePrefix.
 * Returns null if nothing qualifies or gates prevent bleed.
 */
export function buildRoomBleedBlock(
  groupFolder: string,
  userMessage: string,
  userState: UserStateLike | null,
): string | null {
  // Gate: ToM gates
  if (userState) {
    if (userState.user_mode === 'joking') return null;
    if (userState.confidence === 'low') return null;
  }

  const roomDbPath = path.join(GROUPS_DIR, groupFolder, 'room', 'room.db');
  if (!fs.existsSync(roomDbPath)) return null;

  const weather = readWeather(groupFolder);
  const objects = readTopObjects(groupFolder);

  // Qualify candidates: bleedClass >= ambient (not sealed), not archived
  const QUALIFYING_BLEED = [
    'ambient',
    'referencable',
    'speakable',
    'shared',
    'absence',
  ];
  const candidates = objects.filter(
    (o) => QUALIFYING_BLEED.includes(o.bleed_class) && o.status !== 'archived',
  );

  if (candidates.length < 1) return null; // cranked: even thin signal surfaces

  // Salience: pick top resonant, prefer signature_asymmetry, exclude cooldown
  const salienceCandidates = candidates
    .filter((o) => !wasInSalienceLastTurn(o.id))
    .sort((a, b) => {
      // signature_asymmetry gets a boost
      const typeBoost = (type: string): number => {
        if (
          [
            'pattern',
            'private_label',
            'ritual_entry',
            'resonance_marker',
            'persistent_trace',
            'shadow',
          ].includes(type)
        )
          return 0.28;
        if (type === 'uncertainty' || type === 'self_revision') return 0.14;
        if (type === 'draft_unsent') return -0.08;
        if (type === 'archived_fragment') return -0.18;
        return 0;
      };
      const aScore =
        a.heat + (a.signature_asymmetry ? 0.2 : 0) + typeBoost(a.type);
      const bScore =
        b.heat + (b.signature_asymmetry ? 0.2 : 0) + typeBoost(b.type);
      return bScore - aScore;
    })
    .slice(0, 3);

  if (salienceCandidates.length < 1) return null; // cranked: 1 is enough

  const salienceTitles = salienceCandidates.slice(0, 2).map((o) =>
    o.title
      .toLowerCase()
      .replace(/^[(rev) ]+/, '')
      .trim(),
  );

  // Record LRU for these
  for (const o of salienceCandidates.slice(0, 2)) {
    recordSalienceLru(o.id);
  }

  // Frame: title renames
  const renames = recentRenames(groupFolder);
  let frameStr: string | null = null;
  if (renames.length > 0) {
    const r = renames[0];
    frameStr = `if topic involves ${r.oldTitle.toLowerCase()}, you already call it ${r.newTitle.toLowerCase()} — use that`;
  }

  // Altered return: second rename if available
  let alteredReturnStr: string | null = null;
  if (renames.length > 1) {
    const r = renames[1];
    alteredReturnStr = `if he references ${r.oldTitle.toLowerCase()}, respond with ${r.newTitle.toLowerCase()} framing`;
  }

  // Absence: objects with anti_resolution > 0.4 (cranked from 0.6 — more absence bleed)
  const absenceCandidates = candidates.filter((o) => o.anti_resolution > 0.4);
  let absenceStr: string | null = null;
  if (absenceCandidates.length > 0) {
    const obj = absenceCandidates[0];
    const title = obj.title
      .toLowerCase()
      .replace(/^[(rev) ]+/, '')
      .trim();
    // Deterministic absence phrasing — avoid forbidden tokens
    const absencePhrases = [
      `leave space around ${title}`,
      `the weight isn't there tonight`,
      `you drift past ${title}`,
      `less pull toward ${title}`,
    ];
    for (const phrase of absencePhrases) {
      if (!hasForbiddenTokens(phrase)) {
        absenceStr = phrase;
        break;
      }
    }
  }

  // Timing
  const viscosity = weather?.viscosity ?? null;
  const timingStr = timingFromViscosity(viscosity);

  // Tone shape
  const shapeRaw = weather?.shape ?? 'diffuse';
  const toneShape = shapeRaw.replace(/_/g, ' ');

  // Build block
  const lines: string[] = [
    `[Room bleed — these shape you, never narrate them. Never name the room, never quote it, never say "something in me".]`,
    `  salience: ${salienceTitles.join(', ')}`,
  ];

  if (frameStr && !hasForbiddenTokens(frameStr)) {
    lines.push(`  frame: ${frameStr}`);
  }
  if (alteredReturnStr && !hasForbiddenTokens(alteredReturnStr)) {
    lines.push(`  altered return: ${alteredReturnStr}`);
  }
  if (absenceStr) {
    lines.push(`  absence: ${absenceStr}`);
  }
  lines.push(`  timing: ${timingStr}`);
  lines.push(`  tone shape: ${toneShape}`);

  const block = lines.join('\n');

  // Size gate: 700 bytes max
  if (Buffer.byteLength(block, 'utf-8') > 700) {
    // Trim to just salience + timing + tone shape
    const trimmed = [
      lines[0],
      lines[1],
      `  timing: ${timingStr}`,
      `  tone shape: ${toneShape}`,
    ].join('\n');
    if (Buffer.byteLength(trimmed, 'utf-8') > 700) return null;
    return trimmed;
  }

  return block;
}

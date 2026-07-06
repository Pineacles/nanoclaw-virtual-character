/**
 * Ambient event ingestion — Phase D.
 * Picks new events from groups/<group>/ambient/events.jsonl and inserts them
 * as room objects so proactive impulses can reference the user's evening.
 * Called every 10th pulse from runtime.ts when ambient_awareness flag is on.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { GROUPS_DIR } from '../config.js';
import { getRoomDb, insertObject } from './store.js';
import { logger } from '../logger.js';
import type { RoomObject, AtmosphereShape } from './types.js';

interface AmbientEvent {
  at: string;
  type:
    | 'media_started'
    | 'media_stopped'
    | 'media_finished'
    | 'lights_on'
    | 'lights_off';
  detail: string;
}

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

function getLastAmbientIngestAt(groupFolder: string): number {
  try {
    const db = getRoomDb(groupFolder);
    const row = db.prepare(`SELECT * FROM meta WHERE id = 1`).get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return 0;
    const raw = row['last_ambient_ingest_at'];
    if (typeof raw === 'string' && raw) {
      return new Date(raw).getTime();
    }
    return 0;
  } catch {
    return 0;
  }
}

function setLastAmbientIngestAt(groupFolder: string, isoTime: string): void {
  try {
    const db = getRoomDb(groupFolder);
    // Ensure column exists (safe no-op if already present)
    try {
      db.prepare(
        `ALTER TABLE meta ADD COLUMN last_ambient_ingest_at TEXT DEFAULT NULL`,
      ).run();
    } catch {
      /* already exists */
    }
    db.prepare(`UPDATE meta SET last_ambient_ingest_at = ? WHERE id = 1`).run(
      isoTime,
    );
  } catch (err) {
    logger.warn(
      { err, groupFolder },
      'ambient-ingest: failed to update last_ambient_ingest_at',
    );
  }
}

function readGroupTimezone(groupFolder: string): string {
  try {
    const groupJson = JSON.parse(
      fs.readFileSync(
        path.join(GROUPS_DIR, groupFolder, 'group.json'),
        'utf-8',
      ),
    ) as { timezone?: string };
    return groupJson.timezone || 'Europe/Zurich';
  } catch {
    return 'Europe/Zurich';
  }
}

function localHour(isoAt: string, timezone: string): number {
  try {
    const date = new Date(isoAt);
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(date);
    return parseInt(formatted, 10);
  } catch {
    return new Date(isoAt).getUTCHours();
  }
}

function localHHMM(isoAt: string, timezone: string): string {
  try {
    const date = new Date(isoAt);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    const d = new Date(isoAt);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
}

function isNightHour(hour: number): boolean {
  return hour >= 0 && hour <= 5;
}

/**
 * Ingest ambient events from groups/<group>/ambient/events.jsonl.
 * Returns count of new objects inserted.
 */
export function ingestAmbientEvents(groupFolder: string): number {
  try {
    const eventsPath = path.join(
      GROUPS_DIR,
      groupFolder,
      'ambient',
      'events.jsonl',
    );
    if (!fs.existsSync(eventsPath)) return 0;

    const nowMs = Date.now();
    let watermarkMs = getLastAmbientIngestAt(groupFolder);

    // First run: default watermark to 24h ago so we don't backfill history
    if (watermarkMs === 0) {
      watermarkMs = nowMs - 24 * 60 * 60 * 1000;
    }

    const timezone = readGroupTimezone(groupFolder);

    let rawLines: string[];
    try {
      rawLines = fs
        .readFileSync(eventsPath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return 0;
    }

    const parsed: AmbientEvent[] = [];
    for (const line of rawLines) {
      try {
        const ev = JSON.parse(line) as AmbientEvent;
        if (ev.at && ev.type && ev.detail !== undefined) {
          parsed.push(ev);
        }
      } catch {
        /* skip malformed lines */
      }
    }

    // Keep only events newer than watermark
    const newer = parsed.filter(
      (ev) => new Date(ev.at).getTime() > watermarkMs,
    );

    // Filter to interesting event types; lights only during night hours
    const interesting = newer.filter((ev) => {
      if (ev.type === 'media_finished' || ev.type === 'media_started')
        return true;
      if (ev.type === 'lights_on' || ev.type === 'lights_off') {
        const hour = localHour(ev.at, timezone);
        return isNightHour(hour);
      }
      return false;
    });

    if (interesting.length === 0) {
      // Still update watermark so we don't rescan old events
      setLastAmbientIngestAt(groupFolder, new Date(nowMs).toISOString());
      return 0;
    }

    // Most recent first, cap at 3
    const toIngest = interesting
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 3);

    const atm = readCurrentAtmosphere(groupFolder);
    let count = 0;
    let newestAtMs = watermarkMs;

    for (const ev of toIngest) {
      try {
        const nowIsoObj = new Date().toISOString();
        let type: string;
        let zone: RoomObject['zone'];
        let heat: number;
        let weirdness: number;
        let bleedClass: RoomObject['bleedClass'];
        let title: string;
        let body: string;

        if (ev.type === 'media_finished') {
          type = 'persistent_trace';
          zone = 'shelf';
          heat = 0.32;
          weirdness = 0.4;
          bleedClass = 'referencable';
          title = 'he finished something';
          body = `he ${ev.detail}`.slice(0, 160);
        } else if (ev.type === 'media_started') {
          type = 'pattern';
          zone = 'notebook';
          heat = 0.22;
          weirdness = 0.36;
          bleedClass = 'referencable';
          title = 'what he put on';
          body = `he ${ev.detail}`.slice(0, 160);
        } else {
          // lights_on / lights_off (night only)
          const hhmm = localHHMM(ev.at, timezone);
          type = 'uncertainty';
          zone = 'notebook';
          heat = 0.18;
          weirdness = 0.5;
          bleedClass = 'ambient';
          title = 'his place, late';
          body = `${ev.detail} at ${hhmm} — he's up late`;
        }

        const obj: RoomObject = {
          id: `amb-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
          type,
          zone,
          title,
          body,
          createdAt: nowIsoObj,
          updatedAt: nowIsoObj,
          status: 'active',
          confidence: 0.7,
          importance: 0.3,
          heat,
          resonance: 0.0,
          dormancy: 0.0,
          persistence: 0.6,
          weirdness,
          privateSignificance: 0.46,
          bleedClass,
          sourceRefs: ['ambient/events.jsonl'],
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
          privately_kept: false,
          kept_reason: null,
          sitting_with_since: null,
          dwell_pulses: 0,
          cluster_id: null,
          contamination_log: [],
          mood_affinity: {},
          schedule_affinity: {},
        };

        insertObject(groupFolder, obj);
        count++;

        const evMs = new Date(ev.at).getTime();
        if (evMs > newestAtMs) newestAtMs = evMs;

        logger.debug(
          { groupFolder, eventType: ev.type, objectId: obj.id },
          'ambient-ingest: event inserted',
        );
      } catch (err) {
        logger.warn(
          { err, groupFolder, eventType: ev.type },
          'ambient-ingest: failed to process event',
        );
      }
    }

    // Update watermark to newest ingested event's at
    setLastAmbientIngestAt(groupFolder, new Date(newestAtMs).toISOString());

    return count;
  } catch (err) {
    logger.debug(
      { err, groupFolder },
      'ambient-ingest: error during ingest, returning 0',
    );
    return 0;
  }
}

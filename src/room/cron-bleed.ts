/**
 * Room cron bleed — Phase D.
 * Builds room context blocks for scheduled tasks based on room_read_level.
 */

import path from 'path';
import fs from 'fs';
import { getRoomDb } from './store.js';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

interface WeatherData {
  viscosity?: number;
  shape?: string;
  congestion?: number;
  cluster_density?: number;
}

function readLatestWeather(groupFolder: string): WeatherData | null {
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

function readRecentShape(groupFolder: string, limit = 20): string {
  try {
    const db = getRoomDb(groupFolder);
    const rows = db
      .prepare(
        `SELECT shape FROM atmosphere_snapshots ORDER BY when_recorded DESC LIMIT ?`,
      )
      .all(limit) as Array<{ shape: string }>;
    if (rows.length === 0) return 'diffuse';
    // Most common shape
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.shape, (counts.get(r.shape) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0]?.replace(/_/g, ' ') || 'diffuse';
  } catch {
    return 'diffuse';
  }
}

interface ObjectRow {
  id: string;
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
  zone: string;
  cluster_id: string | null;
  updated_at: string;
}

function readObjects(groupFolder: string): ObjectRow[] {
  try {
    const db = getRoomDb(groupFolder);
    return db
      .prepare(
        `SELECT id, title, heat, bleed_class, status, anti_resolution,
              signature_asymmetry, title_history, privately_kept, kept_reason,
              residual_warmth_floor, zone, cluster_id, updated_at
       FROM objects ORDER BY heat DESC`,
      )
      .all() as ObjectRow[];
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

function buildStrongBlock(groupFolder: string): string {
  const objects = readObjects(groupFolder);
  const active = objects.filter((o) => o.status !== 'archived');
  const weather = readLatestWeather(groupFolder);

  // Top 5 high-heat
  const topHeat = active
    .slice(0, 5)
    .map((o) => o.title)
    .join(', ');

  // Signature asymmetry flagged, up to 3
  const asymmetry =
    active
      .filter((o) => o.signature_asymmetry)
      .slice(0, 3)
      .map((o) => o.title)
      .join(', ') || 'none';

  // Revived in last 7 days (title_history with renamed_reason=revived_altered in last 7d)
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const revived: string[] = [];
  for (const obj of active) {
    try {
      const history: TitleHistoryEntry[] = JSON.parse(obj.title_history);
      if (
        history.some(
          (h) =>
            h.renamed_reason === 'revived_altered' && h.valid_from >= cutoff7d,
        )
      ) {
        revived.push(obj.title);
      }
    } catch {
      /* skip */
    }
  }
  const revivedStr = revived.slice(0, 3).join(', ') || 'none';

  // Privately kept, up to 3
  const privatelyKept =
    active
      .filter((o) => o.privately_kept)
      .slice(0, 3)
      .map((o) => `${o.title}${o.kept_reason ? ` (${o.kept_reason})` : ''}`)
      .join(', ') || 'none';

  // Recent renames (title_history with valid_to null, valid_from recent)
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const recentRenamesList: string[] = [];
  for (const obj of active) {
    try {
      const history: TitleHistoryEntry[] = JSON.parse(obj.title_history);
      for (const h of history) {
        if (h.valid_to === null && h.valid_from >= cutoff48h) {
          recentRenamesList.push(`${h.title} → ${obj.title}`);
        }
      }
    } catch {
      /* skip */
    }
  }
  const recentRenames = recentRenamesList.slice(0, 3).join('; ') || 'none';

  // Never fully cooled: residual_warmth_floor > 0.3
  const neverCooled =
    active
      .filter((o) => o.residual_warmth_floor > 0.3)
      .slice(0, 3)
      .map((o) => o.title)
      .join(', ') || 'none';

  // Weather summary
  let weatherStr = 'no data';
  if (weather) {
    const parts: string[] = [];
    if (weather.viscosity !== undefined)
      parts.push(`viscosity ${weather.viscosity.toFixed(2)}`);
    if (weather.shape) parts.push(`shape ${weather.shape.replace(/_/g, ' ')}`);
    if (weather.congestion !== undefined)
      parts.push(`congestion ${weather.congestion.toFixed(2)}`);
    if (weather.cluster_density !== undefined)
      parts.push(`cluster density ${weather.cluster_density.toFixed(2)}`);
    weatherStr = parts.join(', ') || 'no data';
  }

  // Anti-resolution objects
  const antiRes =
    active
      .filter((o) => o.anti_resolution > 0.6)
      .slice(0, 2)
      .map((o) => `${o.title} (anti_res ${o.anti_resolution.toFixed(2)})`)
      .join('; ') || 'none';

  return [
    '--- Room state (strong read) ---',
    `What stayed warm: ${topHeat}`,
    `What lingered: ${asymmetry}`,
    `What kept returning: ${revivedStr}`,
    `What felt privately kept: ${privatelyKept}`,
    `What changed shape: ${recentRenames}`,
    `What never fully cooled: ${neverCooled}`,
    `Current room weather: ${weatherStr}`,
    `Omission / absence pressure: ${antiRes}`,
  ].join('\n');
}

function buildLightBlock(groupFolder: string): string {
  const weather = readLatestWeather(groupFolder);
  const recentShape = readRecentShape(groupFolder);
  const objects = readObjects(groupFolder).filter(
    (o) => o.status !== 'archived',
  );

  const weatherStr = weather
    ? [
        weather.shape ? `shape ${weather.shape.replace(/_/g, ' ')}` : null,
        weather.viscosity !== undefined
          ? `viscosity ${weather.viscosity.toFixed(2)}`
          : null,
      ]
        .filter(Boolean)
        .join(', ')
    : 'no data';

  // Top 2 zones by object count + heat
  const zoneMap = new Map<string, { count: number; heat: number }>();
  for (const o of objects) {
    const z = zoneMap.get(o.zone) || { count: 0, heat: 0 };
    z.count++;
    z.heat += o.heat;
    zoneMap.set(o.zone, z);
  }
  const topZones =
    [...zoneMap.entries()]
      .sort((a, b) => b[1].heat - a[1].heat)
      .slice(0, 2)
      .map(([zone, info]) => `${zone} (${info.count} objects)`)
      .join(', ') || 'none';

  // Top cluster names if any — just use cluster_id as proxy
  const clusterCounts = new Map<string, number>();
  for (const o of objects) {
    if (o.cluster_id)
      clusterCounts.set(
        o.cluster_id,
        (clusterCounts.get(o.cluster_id) || 0) + 1,
      );
  }
  const topClusters =
    [...clusterCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id)
      .join(', ') || 'none';

  return [
    '--- Room stain (light read) ---',
    `Weather: ${weatherStr}`,
    `Active zones: ${topZones}`,
    `Lingering themes: ${topClusters}`,
    `Recent room shape: ${recentShape}`,
  ].join('\n');
}

function buildGateBlock(groupFolder: string): string {
  const queueDir = path.join(GROUPS_DIR, groupFolder, 'queue');
  let intentCount = 0;
  try {
    if (fs.existsSync(queueDir)) {
      intentCount = fs
        .readdirSync(queueDir)
        .filter((f) => f.startsWith('intent_') && f.endsWith('.json')).length;
    }
  } catch {
    /* ignore */
  }

  return [
    '--- Room gate ---',
    `Ready drafts: ${intentCount}`,
    `Anti-double-text: check ./tools/query_chats.sh --limit 5 --source whatsapp for recent outbound`,
  ].join('\n');
}

interface AmbientState {
  updated_at?: string;
  media_ok?: boolean;
  lights_ok?: boolean;
  watching?: Array<{
    user?: string;
    device?: string;
    title?: string;
    progress?: number;
    paused?: boolean;
  }>;
  lights?: Record<string, { on?: boolean; brightness?: number }>;
}

interface AmbientEvent {
  at: string;
  type: string;
  detail: string;
}

function readGroupTimezoneForCron(groupFolder: string): string {
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

function formatRelativeTime(isoAt: string, nowMs: number): string {
  const diffMs = nowMs - new Date(isoAt).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  return `${diffH}h ago`;
}

/**
 * Build a compact ambient block describing the user's current evening context.
 * Returns '' if state.json is missing or older than 10 minutes.
 */
export function buildAmbientBlock(groupFolder: string): string {
  try {
    const statePath = path.join(
      GROUPS_DIR,
      groupFolder,
      'ambient',
      'state.json',
    );
    if (!fs.existsSync(statePath)) return '';

    const state = JSON.parse(
      fs.readFileSync(statePath, 'utf-8'),
    ) as AmbientState;

    const nowMs = Date.now();

    // Stale guard: if state is older than 10 minutes, skip
    if (state.updated_at) {
      const staleMs = nowMs - new Date(state.updated_at).getTime();
      if (staleMs > 10 * 60 * 1000) return '';
    } else {
      return '';
    }

    // Build "right now" line
    const watching = state.watching ?? [];
    const activePlaying = watching.filter((w) => !w.paused);
    const paused = watching.filter((w) => w.paused);

    let nowLine: string;
    if (activePlaying.length > 0) {
      const titles = activePlaying
        .map((w) => w.title || 'something')
        .join(', ');
      nowLine = `right now: watching ${titles}`;
    } else if (paused.length > 0) {
      const titles = paused.map((w) => w.title || 'something').join(', ');
      nowLine = `right now: ${titles} paused`;
    } else {
      nowLine = 'right now: nothing playing';
    }

    // Append lights summary (compact, no exact names)
    const lights = state.lights ?? {};
    const lightEntries = Object.entries(lights);
    if (lightEntries.length > 0) {
      const anyOn = lightEntries.some(([, v]) => v.on);
      nowLine += anyOn ? '; lights on' : '; lights off';
    }

    // Append PC/presence hint if something is playing or paused (soft proxy)
    if (watching.length === 0 && lightEntries.length > 0) {
      const anyOn = lightEntries.some(([, v]) => v.on);
      nowLine += anyOn ? ', PC likely on' : ', PC on';
    } else if (watching.length > 0) {
      nowLine += ', PC on';
    }

    // Build "earlier" lines from recent events (within 6h, max 4)
    const eventsPath = path.join(
      GROUPS_DIR,
      groupFolder,
      'ambient',
      'events.jsonl',
    );
    const recentLines: string[] = [];
    if (fs.existsSync(eventsPath)) {
      try {
        const cutoff6h = nowMs - 6 * 60 * 60 * 1000;
        const rawLines = fs
          .readFileSync(eventsPath, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        const recent: AmbientEvent[] = [];
        for (const line of rawLines) {
          try {
            const ev = JSON.parse(line) as AmbientEvent;
            if (ev.at && ev.type && new Date(ev.at).getTime() >= cutoff6h) {
              recent.push(ev);
            }
          } catch {
            /* skip malformed */
          }
        }

        // Sort newest first
        recent.sort(
          (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
        );

        for (const ev of recent.slice(0, 4)) {
          const rel = formatRelativeTime(ev.at, nowMs);
          if (ev.type === 'media_finished') {
            recentLines.push(`earlier: ${ev.detail} (${rel})`);
          } else if (ev.type === 'media_started') {
            recentLines.push(`earlier: put on ${ev.detail} (${rel})`);
          }
          // lights events omitted from cron block per instruction
        }
      } catch {
        /* ignore events read failure */
      }
    }

    const lines = [
      '--- What you can sense of his evening (ambient) ---',
      nowLine,
      ...recentLines,
      '(media = shared account, mentionable casually once if it fits. lights/presence = NEVER state as fact — timing and soft guesses only. never name systems.)',
    ];

    return lines.join('\n');
  } catch (err) {
    logger.debug({ err, groupFolder }, 'cron-bleed: buildAmbientBlock error');
    return '';
  }
}

function readGroupFeaturesForCron(
  groupFolder: string,
): Record<string, boolean> {
  try {
    const groupJson = JSON.parse(
      fs.readFileSync(
        path.join(GROUPS_DIR, groupFolder, 'group.json'),
        'utf-8',
      ),
    ) as { features?: Record<string, boolean> };
    return groupJson.features ?? {};
  } catch {
    return {};
  }
}

/**
 * Build the room context block for a scheduled task based on its read level.
 */
export function buildCronRoomContext(
  groupFolder: string,
  level: 'strong' | 'light' | 'gate',
): string {
  const roomDbPath = path.join(GROUPS_DIR, groupFolder, 'room', 'room.db');
  if (!fs.existsSync(roomDbPath)) return '';

  if (level === 'strong' || level === 'light') {
    const features = readGroupFeaturesForCron(groupFolder);
    const baseBlock =
      level === 'strong'
        ? buildStrongBlock(groupFolder)
        : buildLightBlock(groupFolder);

    if (features['ambient_awareness']) {
      const ambBlock = buildAmbientBlock(groupFolder);
      if (ambBlock) return baseBlock + '\n\n' + ambBlock;
    }
    return baseBlock;
  }

  switch (level) {
    case 'gate':
      return buildGateBlock(groupFolder);
    default:
      return '';
  }
}

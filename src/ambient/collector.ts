/**
 * Ambient awareness collector — gives a persona passive senses for the
 * user's real environment: what's playing on the media server (Jellyfin)
 * and whether the lights are on (Hue bridge).
 *
 * Host-side only. Credentials live in data/ambient/{group}.json, which is
 * NEVER mounted into agent containers. The collector writes only derived,
 * secret-free state into groups/{group}/ambient/ (state.json + events.jsonl)
 * so the agent — and the per-message context hint — can read it.
 *
 * Feature-gated per group via features.ambient_awareness (default false),
 * so instances without the flag never start this.
 */
import fs from 'fs';
import https from 'https';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';

interface AmbientConfig {
  poll_interval_ms?: number;
  jellyfin?: {
    url: string;
    api_key: string;
    /** Jellyfin user names whose activity counts as "him" (filter out housemates/friends). */
    users: string[];
  };
  hue?: {
    bridge_ip: string;
    app_key: string;
    /** Optional: only track these room names (default: all rooms). */
    rooms?: string[];
  };
}

interface MediaPlaying {
  user: string;
  device: string;
  title: string;
  /** 0..1 playback progress, if known */
  progress: number | null;
  paused: boolean;
}

interface AmbientEvent {
  at: string; // ISO timestamp
  type:
    | 'media_started'
    | 'media_stopped'
    | 'media_finished'
    | 'lights_on'
    | 'lights_off';
  detail: string;
}

interface AmbientState {
  updated_at: string;
  media_ok: boolean;
  lights_ok: boolean;
  watching: MediaPlaying[];
  lights: Record<string, { on: boolean; brightness: number }>;
}

const DEFAULT_POLL_MS = 120_000;
const EVENT_LOG_MAX_LINES = 600;
const EVENT_LOG_TRIM_TO = 400;

const running = new Set<string>();

function configPath(groupFolder: string): string {
  return path.join(DATA_DIR, 'ambient', `${groupFolder}.json`);
}

function ambientDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'ambient');
}

function loadConfig(groupFolder: string): AmbientConfig | null {
  try {
    const raw = fs.readFileSync(configPath(groupFolder), 'utf-8');
    return JSON.parse(raw) as AmbientConfig;
  } catch {
    return null;
  }
}

/** GET over https with self-signed certs allowed (Hue bridges use them). */
function httpsGetInsecure(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers, rejectUnauthorized: false, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
            resolve(body);
          else reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
  });
}

async function fetchJellyfin(
  cfg: NonNullable<AmbientConfig['jellyfin']>,
): Promise<MediaPlaying[]> {
  const res = await fetch(`${cfg.url}/Sessions?activeWithinSeconds=960`, {
    headers: { 'X-Emby-Token': cfg.api_key },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  const sessions = (await res.json()) as Array<{
    UserName?: string;
    DeviceName?: string;
    NowPlayingItem?: {
      Name?: string;
      SeriesName?: string;
      ParentIndexNumber?: number;
      IndexNumber?: number;
      RunTimeTicks?: number;
    };
    PlayState?: { PositionTicks?: number; IsPaused?: boolean };
  }>;
  const wanted = new Set(cfg.users.map((u) => u.toLowerCase()));
  const out: MediaPlaying[] = [];
  for (const s of sessions) {
    if (!s.NowPlayingItem) continue;
    if (!s.UserName || !wanted.has(s.UserName.toLowerCase())) continue;
    const item = s.NowPlayingItem;
    let title = item.Name ?? 'something';
    if (item.SeriesName) {
      const ep =
        item.ParentIndexNumber != null && item.IndexNumber != null
          ? ` S${item.ParentIndexNumber}E${item.IndexNumber}`
          : '';
      title = `${item.SeriesName}${ep}${item.Name ? ` — ${item.Name}` : ''}`;
    }
    const runtime = item.RunTimeTicks ?? 0;
    const pos = s.PlayState?.PositionTicks ?? 0;
    out.push({
      user: s.UserName,
      device: s.DeviceName ?? 'unknown device',
      title,
      progress: runtime > 0 ? Math.min(1, pos / runtime) : null,
      paused: s.PlayState?.IsPaused ?? false,
    });
  }
  return out;
}

async function fetchHue(
  cfg: NonNullable<AmbientConfig['hue']>,
): Promise<Record<string, { on: boolean; brightness: number }>> {
  const headers = { 'hue-application-key': cfg.app_key };
  const base = `https://${cfg.bridge_ip}/clip/v2/resource`;
  const roomsRaw = JSON.parse(
    await httpsGetInsecure(`${base}/room`, headers),
  ) as {
    data: Array<{
      metadata?: { name?: string };
      services?: Array<{ rid: string; rtype: string }>;
    }>;
  };
  const groupedToRoom = new Map<string, string>();
  for (const room of roomsRaw.data ?? []) {
    const name = room.metadata?.name;
    if (!name) continue;
    if (cfg.rooms && !cfg.rooms.includes(name)) continue;
    const svc = (room.services ?? []).find((s) => s.rtype === 'grouped_light');
    if (svc) groupedToRoom.set(svc.rid, name);
  }
  const lightsRaw = JSON.parse(
    await httpsGetInsecure(`${base}/grouped_light`, headers),
  ) as {
    data: Array<{
      id: string;
      on?: { on?: boolean };
      dimming?: { brightness?: number };
    }>;
  };
  const out: Record<string, { on: boolean; brightness: number }> = {};
  for (const gl of lightsRaw.data ?? []) {
    const room = groupedToRoom.get(gl.id);
    if (!room) continue;
    out[room] = {
      on: gl.on?.on ?? false,
      brightness: Math.round(gl.dimming?.brightness ?? 0),
    };
  }
  return out;
}

function appendEvents(groupFolder: string, events: AmbientEvent[]): void {
  if (events.length === 0) return;
  const file = path.join(ambientDir(groupFolder), 'events.jsonl');
  fs.appendFileSync(
    file,
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  // Trim occasionally so the log never grows unbounded
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > EVENT_LOG_MAX_LINES) {
      fs.writeFileSync(file, lines.slice(-EVENT_LOG_TRIM_TO).join('\n') + '\n');
    }
  } catch {
    /* trim is best-effort */
  }
}

function mediaKey(m: MediaPlaying): string {
  return `${m.user}|${m.device}|${m.title}`;
}

/**
 * Diff two snapshots into human-readable events. First poll after boot
 * passes prev=null and emits nothing (we can't tell "already on" from
 * "just turned on").
 */
function diffSnapshots(
  prev: AmbientState | null,
  next: AmbientState,
): AmbientEvent[] {
  if (!prev) return [];
  const at = next.updated_at;
  const events: AmbientEvent[] = [];

  if (prev.media_ok && next.media_ok) {
    const prevByKey = new Map(prev.watching.map((m) => [mediaKey(m), m]));
    const nextKeys = new Set(next.watching.map((m) => mediaKey(m)));
    for (const m of next.watching) {
      if (!prevByKey.has(mediaKey(m))) {
        events.push({
          at,
          type: 'media_started',
          detail: `started ${m.title} (${m.device})`,
        });
      }
    }
    for (const [key, m] of prevByKey) {
      if (!nextKeys.has(key)) {
        const finished = (m.progress ?? 0) >= 0.85;
        events.push({
          at,
          type: finished ? 'media_finished' : 'media_stopped',
          detail: finished
            ? `finished ${m.title}`
            : `stopped ${m.title} partway (${Math.round((m.progress ?? 0) * 100)}%)`,
        });
      }
    }
  }

  if (prev.lights_ok && next.lights_ok) {
    for (const [room, state] of Object.entries(next.lights)) {
      const before = prev.lights[room];
      if (before && before.on !== state.on) {
        events.push({
          at,
          type: state.on ? 'lights_on' : 'lights_off',
          detail: `${room} lights ${state.on ? 'on' : 'off'}`,
        });
      }
    }
  }

  return events;
}

async function pollOnce(
  groupFolder: string,
  cfg: AmbientConfig,
  prev: AmbientState | null,
): Promise<AmbientState> {
  const state: AmbientState = {
    updated_at: new Date().toISOString(),
    media_ok: false,
    lights_ok: false,
    watching: [],
    lights: {},
  };

  if (cfg.jellyfin) {
    try {
      state.watching = await fetchJellyfin(cfg.jellyfin);
      state.media_ok = true;
    } catch (err) {
      logger.debug({ err, groupFolder }, 'ambient: jellyfin poll failed');
      // carry forward nothing — media_ok=false suppresses diff events
    }
  }

  if (cfg.hue) {
    try {
      state.lights = await fetchHue(cfg.hue);
      state.lights_ok = true;
    } catch (err) {
      logger.debug({ err, groupFolder }, 'ambient: hue poll failed');
    }
  }

  const dir = ambientDir(groupFolder);
  fs.mkdirSync(dir, { recursive: true });
  appendEvents(groupFolder, diffSnapshots(prev, state));
  // Atomic-ish write so readers never see a torn file
  const tmp = path.join(dir, 'state.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, path.join(dir, 'state.json'));
  return state;
}

/**
 * Start the ambient collector for a group. No-op when already running or
 * when data/ambient/{group}.json doesn't exist (feature is configured per
 * deployment, not per repo — credentials never live in the codebase).
 */
export function startAmbientCollector(groupFolder: string): void {
  if (running.has(groupFolder)) return;
  const cfg = loadConfig(groupFolder);
  if (!cfg || (!cfg.jellyfin && !cfg.hue)) {
    logger.info(
      { groupFolder, expected: configPath(groupFolder) },
      'ambient_awareness enabled but no collector config found — not starting',
    );
    return;
  }
  running.add(groupFolder);
  const interval = cfg.poll_interval_ms ?? DEFAULT_POLL_MS;
  let prev: AmbientState | null = null;

  const tick = async () => {
    try {
      prev = await pollOnce(groupFolder, cfg, prev);
    } catch (err) {
      logger.warn({ err, groupFolder }, 'ambient: poll cycle failed');
    }
    // small jitter so polls don't beat against other periodic loops
    const jitter = Math.floor(interval * 0.1 * (Math.random() * 2 - 1));
    setTimeout(tick, interval + jitter).unref();
  };
  void tick();
  logger.info({ groupFolder, interval }, 'Ambient collector started');
}

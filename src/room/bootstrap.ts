/**
 * Bootstrap seeding — one-time init from existing systems.
 * No LLM calls. Deterministic extractions only.
 * Runs once: if meta.room_initialized_at is set, skip entirely.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type {
  RoomObject,
  AtmosphereStain,
  AtmosphereShape,
  Zone,
} from './types.js';
import { DEFAULT_NEAR_MISS_COUNTS } from './types.js';
import {
  getMeta,
  updateMeta,
  insertObject,
  insertTrace,
  getRoomDb,
} from './store.js';
import { captureAtmosphere } from './atmosphere.js';

/** Create a minimal base RoomObject with required fields filled */
function makeObj(overrides: Partial<RoomObject> & { zone: Zone }): RoomObject {
  const now = new Date().toISOString();
  const base: RoomObject = {
    id: `obj-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    type: 'open_loop',
    zone: 'desk',
    title: 'untitled',
    body: '',
    createdAt: now,
    updatedAt: now,
    status: 'active',
    confidence: 0.7,
    importance: 0.5,
    heat: 0.5,
    resonance: 0.0,
    dormancy: 0.0,
    persistence: 0.5,
    weirdness: 0.0,
    privateSignificance: 0.0,
    bleedClass: 'sealed',
    sourceRefs: [],
    links: [],
    stickiness: 0.3,
    residual_warmth_floor: 0.0,
    title_history: [],
    time_in_zone_started_at: now,
    time_total_alive_at: now,
    atmosphere_stains: [],
    near_miss_counts: { ...DEFAULT_NEAR_MISS_COUNTS },
    failed_forms: [],
    fracture_seam: null,
    observation_stain: 0,
    deep_presence: false,
    shadow_of: null,
    anti_resolution: 0,
    signature_asymmetry: false,
    latent_influence: 0,
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
  return { ...base, ...overrides };
}

/** Shuffle array in place (Fisher-Yates) */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function readJsonSafe<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Read memories DB directly for bootstrap (no agent context needed) */
function readTopMemories(groupFolder: string): Array<{
  id: string;
  content: string;
  importance: number;
  category: string;
  created_at: string;
}> {
  const dbPath = path.join(GROUPS_DIR, groupFolder, 'memories', 'memories.db');
  if (!fs.existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        'SELECT id, content, importance, category, created_at FROM memories WHERE archived = 0 ORDER BY importance DESC, last_accessed DESC LIMIT 20',
      )
      .all() as Array<{
      id: string;
      content: string;
      importance: number;
      category: string;
      created_at: string;
    }>;
    db.close();
    return rows;
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Bootstrap: failed to read memories.db');
    return [];
  }
}

/** Scan diary files for unresolved-marker sentences */
function extractDiaryFragments(
  groupFolder: string,
  withinDays: number,
): string[] {
  const diaryDir = path.join(GROUPS_DIR, groupFolder, 'diary');
  if (!fs.existsSync(diaryDir)) return [];

  const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const markerRe =
    /\b(still|keeps|didn['']t|haven['']t|maybe|not sure|unsure|but)\b/i;
  const fragments: string[] = [];

  for (const file of fs.readdirSync(diaryDir).sort().reverse()) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(diaryDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length < 20 || trimmed.length > 300) continue;
        if (
          markerRe.test(trimmed) ||
          trimmed.endsWith('...') ||
          trimmed.endsWith('?')
        ) {
          fragments.push(trimmed.slice(0, 200));
          if (fragments.length >= 3) break;
        }
      }
    } catch {
      /* skip */
    }
    if (fragments.length >= 3) break;
  }
  return fragments;
}

/** Get oldest diary file content (>14 days) for archive seeds */
function extractOldDiaryFragments(groupFolder: string): string[] {
  const diaryDir = path.join(GROUPS_DIR, groupFolder, 'diary');
  if (!fs.existsSync(diaryDir)) return [];
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const result: string[] = [];
  for (const file of fs.readdirSync(diaryDir).sort()) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(diaryDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > cutoff) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const first = lines.find((l) => l.trim().length > 30);
      if (first) result.push(first.trim().slice(0, 200));
      if (result.length >= 2) break;
    } catch {
      /* skip */
    }
  }
  return result;
}

/** Get last short reply from conversations (proxy for "was quiet about something") */
function extractQueueShadow(groupFolder: string): string {
  // We look for the most recent short bot response (< 20 chars after stripping tags)
  // from conversation logs. If none, use a placeholder.
  const convDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  if (!fs.existsSync(convDir)) return 'a moment where less was said than felt';

  const files = fs.readdirSync(convDir).sort().reverse();
  for (const f of files.slice(0, 5)) {
    if (!f.endsWith('.md') && !f.endsWith('.txt')) continue;
    const filePath = path.join(convDir, f);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const cleaned = line
          .replace(/\*\[mood:[^\]]+\]/g, '')
          .replace(/[*_]/g, '')
          .trim();
        if (
          cleaned.length > 0 &&
          cleaned.length < 20 &&
          !cleaned.startsWith('#')
        ) {
          return cleaned;
        }
      }
    } catch {
      /* skip */
    }
  }
  return 'a moment where less was said than felt';
}

/** Apply atmosphere stain to an object */
function applyAtmosphereStain(
  obj: RoomObject,
  stainId: string,
  shape: AtmosphereShape,
  strength: number,
): RoomObject {
  const stain: AtmosphereStain = {
    atmosphere_id: stainId,
    strength,
    when: new Date().toISOString(),
    shape,
  };
  return { ...obj, atmosphere_stains: [...obj.atmosphere_stains, stain] };
}

export function runBootstrap(groupFolder: string): void {
  const meta = getMeta(groupFolder);

  if (meta.room_initialized_at !== null) {
    logger.debug({ groupFolder }, 'Bootstrap: already initialized, skipping');
    return;
  }

  logger.info({ groupFolder }, 'Bootstrap: starting room initialization');

  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const now = new Date().toISOString();
  const pulseId = `bootstrap-${Date.now()}`;

  // Capture current atmosphere for initial stains
  const atmosphere = captureAtmosphere(groupFolder);
  const atmShape = atmosphere.shape;
  const atmId = atmosphere.id;

  const objects: RoomObject[] = [];

  // ---- 1. Memory seeds (Desk + Shelf) ----
  const allMemories = readTopMemories(groupFolder);
  const topMems = allMemories.slice(0, 2);
  const midMem =
    allMemories.length > 6
      ? allMemories[Math.floor(allMemories.length / 2)]
      : null;

  for (let i = 0; i < topMems.length; i++) {
    const mem = topMems[i];
    const obj = makeObj({
      zone: 'desk',
      type: 'persistent_trace',
      title: mem.content.slice(0, 60).replace(/\n/g, ' '),
      body: mem.content,
      importance: Math.min(1, mem.importance / 10),
      confidence: 0.8,
      heat: 0.55 + (i === 0 ? 0.1 : 0),
      stickiness: 0.4,
      bleedClass: 'referencable',
      sourceRefs: [`memory:${mem.id}`],
    });
    objects.push(obj);
  }

  if (midMem) {
    const wrongSized = makeObj({
      zone: 'shelf',
      type: 'persistent_trace',
      title: midMem.content.slice(0, 60).replace(/\n/g, ' '),
      body: midMem.content,
      importance: 0.3, // wrong-sized pull — below significance threshold
      stickiness: 0.75, // but sticky
      heat: 0.4,
      bleedClass: 'ambient',
      sourceRefs: [`memory:${midMem.id}`],
    });
    objects.push(wrongSized);
  }

  // ---- 2. Diary fragments (Notebook) ----
  const diaryFragments = extractDiaryFragments(groupFolder, 7);
  for (let i = 0; i < Math.min(2, diaryFragments.length); i++) {
    const frag = diaryFragments[i];
    const obj = makeObj({
      zone: 'notebook',
      type: 'uncertainty',
      title: frag.length > 50 ? frag.slice(0, 50) + '...' : frag,
      body: frag,
      importance: 0.45,
      confidence: 0.5,
      heat: 0.35,
      stickiness: 0.5,
      bleedClass: 'sealed',
      sourceRefs: ['diary:recent'],
    });
    objects.push(obj);
    if (i === 0) break; // one diary fragment for now
  }

  // ---- 3. Shared refs (Shelf) ----
  const sharedRefsPath = path.join(groupDir, 'shared_refs.md');
  if (fs.existsSync(sharedRefsPath)) {
    const content = fs.readFileSync(sharedRefsPath, 'utf-8');
    const entryRe = /^-\s+(.+?)\s+→\s+(.+)$/gm;
    let match;
    while ((match = entryRe.exec(content)) !== null) {
      const label = match[1].trim();
      const meaning = match[2].trim();
      const obj = makeObj({
        zone: 'shelf',
        type: 'private_label',
        title: label,
        body: meaning,
        importance: 0.5,
        heat: 0.25,
        persistence: 0.8,
        stickiness: 0.45,
        bleedClass: 'speakable',
        sourceRefs: ['shared_refs.md'],
      });
      objects.push(obj);
    }
  }

  // ---- 4. Reflection seed (Desk or Archive) ----
  const reflDir = path.join(groupDir, 'reflections');
  if (fs.existsSync(reflDir)) {
    const reflFiles = fs
      .readdirSync(reflDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .reverse();
    if (reflFiles.length > 0) {
      const reflPath = path.join(reflDir, reflFiles[0]);
      try {
        const content = fs.readFileSync(reflPath, 'utf-8');
        // Take first paragraph or first bullet list
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        const paragraphLines: string[] = [];
        for (const line of lines.slice(0, 8)) {
          if (line.startsWith('#')) continue;
          paragraphLines.push(line.trim());
          if (paragraphLines.join(' ').length > 150) break;
        }
        const body = paragraphLines.join(' ').slice(0, 250);
        const fileStat = fs.statSync(reflPath);
        const ageMs = Date.now() - fileStat.mtimeMs;
        const zone: Zone =
          ageMs > 14 * 24 * 60 * 60 * 1000 ? 'archive' : 'desk';

        if (body.length > 20) {
          const obj = makeObj({
            zone,
            type: 'self_revision',
            title: `reflection ${reflFiles[0].replace('.md', '')}`,
            body,
            importance: 0.6,
            heat: zone === 'archive' ? 0.2 : 0.45,
            confidence: 0.75,
            stickiness: 0.35,
            bleedClass: 'referencable',
            sourceRefs: [`reflections:${reflFiles[0]}`],
          });
          objects.push(obj);
        }
      } catch {
        /* skip */
      }
    }
  }

  // ---- 5. Personality drift seed (Mirror) ----
  const personality = readJsonSafe<{
    history?: Array<{
      date: string;
      reason: string;
      changes: Record<string, string>;
    }>;
  }>(path.join(groupDir, 'personality.json'));

  if (personality?.history && personality.history.length > 0) {
    const latestDrift = personality.history[personality.history.length - 1];
    const obj = makeObj({
      zone: 'mirror',
      type: 'self_revision',
      title: `self-shift noted ${latestDrift.date}`,
      body: latestDrift.reason,
      importance: 0.6,
      heat: 0.4,
      confidence: 0.85,
      stickiness: 0.4,
      bleedClass: 'sealed',
      sourceRefs: ['personality.json'],
    });
    objects.push(obj);
  }

  // ---- 6. Anomaly slot — Attic (always) ----
  const anomaly = makeObj({
    zone: 'attic',
    type: 'archived_fragment',
    title: 'unknown — it was here when the lights came on',
    body: 'fragment retained from prior to room existence — origin unclear',
    importance: 0.2, // wrong-sized (below 0.4)
    stickiness: 0.7, // high stickiness
    heat: 0.3 + Math.random() * 0.1,
    weirdness: 0.8,
    bleedClass: 'ambient',
    privately_kept: true,
    kept_reason: 'unclear',
    sourceRefs: [],
  });
  objects.push(anomaly);

  // ---- 7. Queue shadow — draft_unsent (always) ----
  const shadowBody = extractQueueShadow(groupFolder);
  const queueShadow = makeObj({
    zone: 'queue',
    type: 'draft_unsent',
    title: 'unsent tendency',
    body: shadowBody,
    importance: 0.35, // wrong-sized
    stickiness: 0.72, // high stickiness
    heat: 0.2,
    bleedClass: 'sealed',
    privateSignificance: 0.6,
    sourceRefs: ['conversations:recent'],
  });
  objects.push(queueShadow);

  // ---- 8. Archive traces from old diary ----
  const oldFrags = extractOldDiaryFragments(groupFolder);
  for (const frag of oldFrags.slice(0, 2)) {
    const obj = makeObj({
      zone: 'archive',
      type: 'archived_fragment',
      title: frag.slice(0, 50),
      body: frag,
      importance: 0.4,
      heat: 0.2,
      residual_warmth_floor: 0.15, // stays faintly warm
      stickiness: 0.3,
      bleedClass: 'ambient',
      sourceRefs: ['diary:old'],
    });
    objects.push(obj);
  }

  // ---- Enforce wrong-sized bias: at least 2 must have importance < 0.4 AND stickiness > 0.7 ----
  const wrongSizedCount = objects.filter(
    (o) => o.importance < 0.4 && o.stickiness > 0.7,
  ).length;
  if (wrongSizedCount < 2) {
    // Nudge the anomaly + queue shadow if not already qualifying
    for (const obj of objects) {
      const current = objects.filter(
        (o) => o.importance < 0.4 && o.stickiness > 0.7,
      ).length;
      if (current >= 2) break;
      if (obj.importance >= 0.4) {
        obj.importance = 0.35;
      }
      if (obj.stickiness <= 0.7) {
        obj.stickiness = 0.72;
      }
    }
  }

  // ---- Apply initial atmosphere stains (4-5 randomly selected, not all) ----
  const stainTargetCount = Math.min(
    5,
    Math.max(4, Math.floor(objects.length * 0.5)),
  );
  const stainTargets = shuffle([...objects]).slice(0, stainTargetCount);
  const stainIds = new Set(stainTargets.map((o) => o.id));
  for (let i = 0; i < objects.length; i++) {
    if (stainIds.has(objects[i].id)) {
      objects[i] = applyAtmosphereStain(
        objects[i],
        atmId,
        atmShape,
        0.3 + Math.random() * 0.4,
      );
    }
  }

  // ---- Create initial links (3-5 weak, at least 1 cross-cluster) ----
  const linkCount = 3 + Math.floor(Math.random() * 3); // 3-5
  const linkPairs: Array<[string, string]> = [];

  // At least 1 cross-cluster: link objects from different source categories
  const memObjs = objects.filter((o) =>
    o.sourceRefs.some((r) => r.startsWith('memory:')),
  );
  const diaryObjs = objects.filter((o) =>
    o.sourceRefs.some((r) => r.startsWith('diary:')),
  );
  const otherObjs = objects.filter(
    (o) =>
      !o.sourceRefs.some(
        (r) => r.startsWith('memory:') || r.startsWith('diary:'),
      ),
  );

  if (memObjs.length > 0 && (diaryObjs.length > 0 || otherObjs.length > 0)) {
    const a = memObjs[0];
    const b = diaryObjs.length > 0 ? diaryObjs[0] : otherObjs[0];
    linkPairs.push([a.id, b.id]);
    a.links.push(b.id);
    b.links.push(a.id);
  }

  // Fill remaining links randomly
  while (linkPairs.length < linkCount && objects.length >= 2) {
    const idxA = Math.floor(Math.random() * objects.length);
    let idxB = Math.floor(Math.random() * objects.length);
    if (idxA === idxB) continue;
    const a = objects[idxA];
    const b = objects[idxB];
    const already = linkPairs.some(
      ([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id),
    );
    if (already) continue;
    linkPairs.push([a.id, b.id]);
    if (!a.links.includes(b.id)) a.links.push(b.id);
    if (!b.links.includes(a.id)) b.links.push(a.id);
  }

  // ---- Persist everything in a transaction ----
  const db = getRoomDb(groupFolder);
  const insertAll = db.transaction(() => {
    for (const obj of objects) {
      insertObject(groupFolder, obj);
    }
    insertTrace(
      groupFolder,
      pulseId,
      'bootstrap_complete',
      objects.map((o) => o.id),
      `object_count=${objects.length} links_count=${linkPairs.length} wrong_sized_count=${objects.filter((o) => o.importance < 0.4 && o.stickiness > 0.7).length}`,
    );
  });

  try {
    insertAll();
  } catch (err) {
    logger.error({ err, groupFolder }, 'Bootstrap: transaction failed');
    throw err;
  }

  const finalWrongSized = objects.filter(
    (o) => o.importance < 0.4 && o.stickiness > 0.7,
  ).length;

  updateMeta(groupFolder, {
    room_initialized_at: now,
    last_pulse_at: null,
    pulse_count: 0,
  });

  logger.info(
    {
      groupFolder,
      objectCount: objects.length,
      linksCount: linkPairs.length,
      wrongSizedCount: finalWrongSized,
    },
    'Bootstrap: room initialized',
  );
}

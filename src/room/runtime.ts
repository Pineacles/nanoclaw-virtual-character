/**
 * RoomRuntime — Phase B pulse loop for a single group's room.
 * Starts/stops independently per group. Ticks every 3-8 min (jittered).
 */
import crypto from 'crypto';
import { spawnEnv } from '../spawn-path.js';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { applyDrift, shouldSkipDrift, rollPrivateKeep } from './drift.js';
import { computePressure } from './pressure.js';
import { runBootstrap } from './bootstrap.js';
import {
  getMeta,
  updateMeta,
  getAllObjects,
  getActiveObjects,
  updateObject,
  insertPressure,
  insertTrace,
  insertObject,
  getRoomDb,
  runRoomMaintenance,
} from './store.js';
import {
  discoverClusters,
  computeNamelessnessPressure,
  getAllClusters,
} from './clusters.js';
import {
  runContaminationPass,
  runProximityStainInheritance,
  runAtmosphereStainingPass,
} from './contamination.js';
import { fadeGhosts, countGhosts } from './ghosts.js';
import {
  computeThickAtmosphere,
  writeThickAtmosphere,
  checkCongestion,
} from './weather.js';
import { applyDwellAccumulation } from './dwell.js';
import { emitNearMisses } from './near_miss.js';
import {
  decayObservationStains,
  recordObservationEvent,
} from './observation.js';
import { runSignatureAsymmetryPass } from './selection.js';
import { ROOM_TUNING } from './tuning.js';
import { executeActionStep } from './actions.js';
import { ingestConversationFragments } from './conversations-ingest.js';
import { ingestAmbientEvents } from './ambient-ingest.js';
import { spawnRoomOrganism } from './organism.js';
import { GROUPS_DIR, ASSISTANT_NAME, USER_NAME } from '../config.js';
import type { RoomObject, PressureState } from './types.js';

export interface RoomRuntimeDeps {
  spawnImpulse(opts: {
    groupFolder: string;
    intentBody: string;
    intentType: 'outbound' | 'thinking';
    intentId?: string;
  }): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  getChatJid(groupFolder: string): string | null;
}

// Tick cadence: base 5min ± 3min
const BASE_TICK_MS = 5 * 60 * 1000;
const JITTER_MS = 3 * 60 * 1000;

// Dream window tick cadence: 90s ± 30s
const DREAM_BASE_MS = 90 * 1000;
const DREAM_JITTER_MS = 30 * 1000;

function jitteredDelay(isDream = false): number {
  if (isDream) {
    return DREAM_BASE_MS + (Math.random() * 2 - 1) * DREAM_JITTER_MS;
  }
  return BASE_TICK_MS + (Math.random() * 2 - 1) * JITTER_MS;
}

/**
 * Compute whether current local time for the group's timezone falls in [0, 5) hours.
 */
function computeIsDreamWindow(groupFolder: string): boolean {
  try {
    const groupJsonPath = path.join(GROUPS_DIR, groupFolder, 'group.json');
    const raw = JSON.parse(fs.readFileSync(groupJsonPath, 'utf-8')) as {
      timezone?: string;
    };
    const tz = raw.timezone || 'UTC';
    const now = new Date();
    const localHour = parseInt(
      now.toLocaleString('en-GB', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      }),
      10,
    );
    return localHour >= 0 && localHour < 5;
  } catch {
    return false;
  }
}

/**
 * Update preoccupation.json from the hottest live interior object — "what's
 * been quietly on her mind". Only rewrites when the subject actually changes
 * (so set_at/surfaced_at stay meaningful), and only when the group opted into
 * the preoccupations feature. Reuses room data — no LLM, no extra cost.
 */
function updatePreoccupation(groupFolder: string): void {
  let features: Record<string, boolean> | undefined;
  try {
    features = (
      JSON.parse(
        fs.readFileSync(
          path.join(GROUPS_DIR, groupFolder, 'group.json'),
          'utf-8',
        ),
      ) as { features?: Record<string, boolean> }
    ).features;
  } catch {
    return;
  }
  if (!features?.['preoccupations']) return;

  const top = getActiveObjects(groupFolder)
    .filter(
      (o) =>
        o.type !== 'dream_trace' &&
        o.type !== 'archived_fragment' &&
        o.title &&
        o.title.length > 3,
    )
    .sort((a, b) => b.heat + b.resonance - (a.heat + a.resonance))[0];
  if (!top) return;

  const file = path.join(GROUPS_DIR, groupFolder, 'preoccupation.json');
  let prev: { text?: string } = {};
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* none yet */
  }
  const text =
    top.body && top.body.length > 8 ? top.body.slice(0, 160) : top.title;
  if (prev.text === text) return; // unchanged subject — leave timestamps alone

  try {
    fs.writeFileSync(
      file,
      JSON.stringify({ text, set_at: Date.now() }, null, 2),
    );
    logger.debug(
      { groupFolder, text: text.slice(0, 60) },
      'RoomRuntime: preoccupation updated',
    );
  } catch {
    /* best effort */
  }
}

/**
 * Generate a dream_trace object via Haiku. Fire-and-forget after pulse.
 */
async function generateDreamTrace(
  groupFolder: string,
  pulseId: string,
): Promise<void> {
  try {
    // Get top 3 stained objects for seed
    const objects = getAllObjects(groupFolder);
    const top3 = objects
      .filter((o) => o.status !== 'archived' && o.atmosphere_stains.length > 0)
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 3);
    const seeds =
      top3.map((o) => o.title).join(', ') || 'the quiet, the weight, the hour';

    const now = new Date();
    const { tz, assistantName, userName } = (() => {
      try {
        const raw = JSON.parse(
          fs.readFileSync(
            path.join(GROUPS_DIR, groupFolder, 'group.json'),
            'utf-8',
          ),
        ) as { timezone?: string; assistant?: { name?: string }; user?: { name?: string } };
        return {
          tz: raw.timezone || 'UTC',
          assistantName: raw.assistant?.name || ASSISTANT_NAME,
          userName: raw.user?.name || USER_NAME,
        };
      } catch {
        return { tz: 'UTC', assistantName: ASSISTANT_NAME, userName: USER_NAME };
      }
    })();
    const timeStr = now.toLocaleString('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const prompt = `You are ${assistantName}, awake at ${timeStr}, alone. Write a private fragment (1-2 sentences, lowercase, her voice — short, dry, in-mood) about something in the room that's feeling different tonight. Pick from these objects as seeds: ${seeds}. Never mention ${userName}. Never mention the room literally. Just one fragment. No preamble.`;

    const { spawn } = await import('child_process');
    const body = await new Promise<string | null>((resolve) => {
      let out = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGTERM');
          resolve(null);
        }
      }, 15_000);
      const proc = spawn(
        'claude',
        ['--print', '--model', 'claude-haiku-4-5-20251001'],
        {
          // CLI ≥2.1 dropped --max-tokens; the env var is the supported cap
          // (must stay ≥1024+ to leave room for the thinking budget).
          env: { ...spawnEnv(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' },
        },
      );
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      proc.on('close', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(code === 0 ? out.trim() : null);
        }
      });
      proc.on('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    });

    if (!body) return;

    // Read current weather for atmosphere_stain
    const db = getRoomDb(groupFolder);
    const weatherRow = db
      .prepare(
        `SELECT id, shape FROM atmosphere_snapshots ORDER BY when_recorded DESC LIMIT 1`,
      )
      .get() as { id: string; shape: string } | undefined;

    const nowIso = now.toISOString();
    const obj: RoomObject = {
      id: `dream-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      type: 'dream_trace',
      zone: 'attic',
      title: `fragment from ${timeStr}`,
      body,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: 'active',
      confidence: 0.7,
      importance: 0.4,
      heat: 0.4,
      resonance: 0.0,
      dormancy: 0.0,
      persistence: 0.5,
      weirdness: 0.75,
      privateSignificance: 0.6,
      bleedClass: 'ambient',
      sourceRefs: [],
      links: [],
      stickiness: 0.55,
      residual_warmth_floor: 0.0,
      title_history: [],
      time_in_zone_started_at: nowIso,
      time_total_alive_at: nowIso,
      atmosphere_stains: weatherRow
        ? [
            {
              atmosphere_id: weatherRow.id,
              strength: 0.7,
              when: nowIso,
              shape: weatherRow.shape as import('./types.js').AtmosphereShape,
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
      kept_reason: 'overnight drift',
      sitting_with_since: null,
      dwell_pulses: 0,
      cluster_id: null,
      contamination_log: [],
      mood_affinity: {},
      schedule_affinity: {},
    };

    insertObject(groupFolder, obj);
    insertTrace(
      groupFolder,
      pulseId,
      'dream_trace_created',
      [obj.id],
      `body_len=${body.length}`,
    );
    logger.debug(
      { groupFolder, pulseId, objectId: obj.id },
      'RoomRuntime: dream_trace created',
    );
  } catch (err) {
    logger.warn({ err, groupFolder }, 'RoomRuntime: generateDreamTrace failed');
  }
}

// Per-runtime pulse state — carries congestion modifiers from tick to tick
interface PulseState {
  nearMissMultiplier: number;
  contaminationMultiplier: number;
}

/**
 * Outbound impulse gate checks — all must pass to fire.
 * Uses messages.db directly (same DB as db.ts) via better-sqlite3.
 */
function checkOutboundGates(
  groupFolder: string,
  chatJid: string,
  lastThinkingTickAt: string | null,
): { outboundOk: boolean; thinkingOk: boolean } {
  try {
    const now = Date.now();

    // Last assistant outbound > MIN_OUTBOUND_GAP_MS ago
    // Query messages.db directly (avoids circular import with db.ts)
    let lastBotMs = 0;
    let lastMsgMs = 0;
    try {
      const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
      const dbPath = path.join(DATA_DIR, 'messages.db');
      const msgDb = new Database(dbPath, { readonly: true });
      const botRow = msgDb
        .prepare(
          `SELECT MAX(timestamp) as ts FROM messages WHERE chat_jid = ? AND (is_bot_message = 1 OR sender = 'bot')`,
        )
        .get(chatJid) as { ts: string | null } | undefined;
      if (botRow?.ts) lastBotMs = new Date(botRow.ts).getTime();

      const msgRow = msgDb
        .prepare(`SELECT MAX(timestamp) as ts FROM messages WHERE chat_jid = ?`)
        .get(chatJid) as { ts: string | null } | undefined;
      if (msgRow?.ts) lastMsgMs = new Date(msgRow.ts).getTime();
      msgDb.close();
    } catch {
      /* messages.db not found — treat as long ago */
    }

    const outboundOk = now - lastBotMs >= ROOM_TUNING.MIN_OUTBOUND_GAP_MS;
    const conversationOk =
      now - lastMsgMs >= ROOM_TUNING.MIN_CONVERSATION_GAP_MS;

    // Waking hours (not in 0-5 dream window)
    const isDream = computeIsDreamWindow(groupFolder);
    const wakingOk = !isDream;

    const outboundOkFinal = outboundOk && conversationOk && wakingOk;

    // Thinking tick: 1hr min gap
    const lastTickMs = lastThinkingTickAt
      ? new Date(lastThinkingTickAt).getTime()
      : 0;
    const thinkingOk =
      now - lastTickMs >= ROOM_TUNING.THINKING_TICK_MIN_GAP_MS && wakingOk;

    return { outboundOk: outboundOkFinal, thinkingOk };
  } catch {
    return { outboundOk: false, thinkingOk: false };
  }
}

/**
 * Read user_state.json and check depth_ok >= L1.
 */
function checkToMDepthOk(groupFolder: string): boolean {
  try {
    const p = path.join(GROUPS_DIR, groupFolder, 'context', 'user_state.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      depth_ok?: string;
    };
    const depth = raw.depth_ok ?? 'L0';
    // L0 < L1 < L2 — anything >= L1 passes
    return (
      depth === 'L1' ||
      depth === 'L2' ||
      parseInt(depth.replace('L', ''), 10) >= 1
    );
  } catch {
    return true; // default to pass if file missing
  }
}

// Dream mode tuning multipliers
const DREAM_ACTION_PROB_MULT = 1.5;
const DREAM_ACTION_PROB_CAP = 0.9;
const DREAM_CONTAMINATION_MULT = 1.5;
const DREAM_STAIN_PASS_BONUS = 1;

export interface RoomSnapshot {
  groupFolder: string;
  running: boolean;
  meta: ReturnType<typeof getMeta>;
  objects: RoomObject[];
}

export class RoomRuntime {
  private groupFolder: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private pulseState: PulseState = {
    nearMissMultiplier: 1.0,
    contaminationMultiplier: 1.0,
  };
  private deps: RoomRuntimeDeps | null = null;
  private lastThinkingTickAt: string | null = null;
  private lastOutboundImpulseAt: number = 0;

  constructor(groupFolder: string, deps?: RoomRuntimeDeps) {
    this.groupFolder = groupFolder;
    this.deps = deps ?? null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    logger.info({ groupFolder: this.groupFolder }, 'RoomRuntime: starting');

    // Bootstrap on first init (idempotent)
    try {
      runBootstrap(this.groupFolder);
    } catch (err) {
      logger.error(
        { err, groupFolder: this.groupFolder },
        'RoomRuntime: bootstrap failed',
      );
    }

    this.scheduleTick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info(
      { groupFolder: this.groupFolder },
      'RoomRuntime: stopped (state frozen in room.db)',
    );
  }

  private scheduleTick(): void {
    if (!this.running) return;
    const isDream = computeIsDreamWindow(this.groupFolder);
    const delay = jitteredDelay(isDream);
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) =>
          logger.error(
            { err, groupFolder: this.groupFolder },
            'RoomRuntime: tick error',
          ),
        )
        .finally(() => {
          this.scheduleTick();
        });
    }, delay);
  }

  private async tick(): Promise<void> {
    const gf = this.groupFolder;
    const now = new Date().toISOString();
    const pulseId = `pulse-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    // --- Dream window check ---
    const isDreamWindow = computeIsDreamWindow(gf);

    logger.debug(
      { groupFolder: gf, pulseId, isDreamWindow },
      'RoomRuntime: tick start',
    );

    // --- Step 1: meta update + pulse_count++ ---
    const meta = getMeta(gf);
    const newPulseCount = meta.pulse_count + 1;
    updateMeta(gf, { last_pulse_at: now, pulse_count: newPulseCount });

    // --- Step 2: apply passive drift ---
    // Pulse passes operate on live objects only; archived ones outnumber
    // them ~17:1 and every pass filtered them out anyway.
    let objects = getActiveObjects(gf);
    const statusTransitions: string[] = [];

    for (const obj of objects) {
      if (shouldSkipDrift(obj)) continue;
      const prev = obj.status;
      const drifted = applyDrift(obj, now);
      if (drifted.status !== prev) {
        statusTransitions.push(`${obj.id}: ${prev}→${drifted.status}`);
      }
      updateObject(gf, drifted);
    }

    if (statusTransitions.length > 0) {
      logger.debug(
        { groupFolder: gf, transitions: statusTransitions },
        'RoomRuntime: status transitions',
      );
      insertTrace(
        gf,
        pulseId,
        'status_transition',
        statusTransitions.map((s) => s.split(':')[0].trim()),
        statusTransitions.join(', '),
      );
    }

    // Reload after drift
    objects = getActiveObjects(gf);

    // --- Step 3: enforce residual_warmth_floor (done in applyDrift; reload reflects it) ---

    // --- Step 4: dwell accumulation ---
    // We need atmosphere energy + shape — do a quick base atmosphere read
    const { captureAtmosphere } = await import('./atmosphere.js');
    const baseAtm = captureAtmosphere(gf);
    applyDwellAccumulation(gf, objects, baseAtm.energy, baseAtm.shape);

    // --- Step 5: cross-contamination pass ---
    objects = getActiveObjects(gf);
    // In dream window, contamination multiplier gets an extra boost
    if (isDreamWindow) {
      this.pulseState.contaminationMultiplier = Math.max(
        this.pulseState.contaminationMultiplier,
        DREAM_CONTAMINATION_MULT,
      );
    }
    runContaminationPass(gf, pulseId, objects);

    // --- Step 6: proximity stain inheritance ---
    objects = getActiveObjects(gf);
    runProximityStainInheritance(gf, pulseId, objects);

    // --- Step 7: cluster discovery ---
    // Full read on purpose: cluster pruning needs archived member ids.
    objects = getAllObjects(gf);
    discoverClusters(gf, pulseId, objects);

    // --- Step 8: zone ghost fade ---
    fadeGhosts(gf, pulseId);

    // --- Step 9: near-miss emission ---
    objects = getActiveObjects(gf);
    emitNearMisses(gf, pulseId, objects, this.pulseState.nearMissMultiplier);

    // --- Step 10: atmosphere staining pass ---
    objects = getActiveObjects(gf);
    const stainPassCount =
      ROOM_TUNING.STAIN_PASS_COUNT +
      (isDreamWindow ? DREAM_STAIN_PASS_BONUS : 0);
    runAtmosphereStainingPass(
      gf,
      pulseId,
      objects,
      baseAtm.id,
      baseAtm.shape,
      stainPassCount,
    );

    // --- Step 11: observation stain decay ---
    decayObservationStains(gf, pulseId);

    // --- Step 12: weather compute (thick atmosphere) ---
    const clusters = getAllClusters(gf);
    objects = getActiveObjects(gf);
    const ghostCount = countGhosts(gf);
    // Live objects only: counting the ever-growing archive here kept
    // congestion pinned at true (5.5k archived vs ~320 live), freezing the
    // room's weather in one state.
    const totalObjects = objects.length;

    // Compute namelessness pressure from clusters, unfinished from near_miss
    const namelessnessPressure = computeNamelessnessPressure(gf);
    const pressure = computePressure(objects, namelessnessPressure);

    const thick = computeThickAtmosphere(
      gf,
      pulseId,
      pressure,
      totalObjects,
      clusters.length,
      ghostCount,
    );
    writeThickAtmosphere(gf, pulseId, thick);

    // --- Step 13: overcontinuity / congestion check ---
    // Reset multipliers before computing new ones
    this.pulseState.nearMissMultiplier = 1.0;
    this.pulseState.contaminationMultiplier = 1.0;
    checkCongestion(gf, pulseId, thick, this.pulseState);

    // --- Step 14: signature_asymmetry pass ---
    objects = getActiveObjects(gf);
    runSignatureAsymmetryPass(gf, pulseId, objects);

    // --- Step 15: private_kept probability roll ---
    objects = getActiveObjects(gf);
    rollPrivateKeep(gf, objects);

    // --- Step 16: compute PressureState (final, with real values) ---
    objects = getActiveObjects(gf);
    const finalPressure = computePressure(objects, namelessnessPressure);
    insertPressure(gf, newPulseCount, finalPressure);

    // --- Step 17: write meta; advance time (already done in step 1) ---
    // (atmosphere_snapshot already written in step 12)

    // --- Step 18: Phase C action execution ---
    // In dream window: boost action probability
    const dreamActionOpts = isDreamWindow
      ? {
          actionProbOverride: Math.min(
            ROOM_TUNING.ACTION_PROBABILITY_BASE * DREAM_ACTION_PROB_MULT,
            DREAM_ACTION_PROB_CAP,
          ),
          preferLLM: true,
        }
      : undefined;
    await executeActionStep(gf, pulseId, finalPressure, thick, dreamActionOpts);

    // --- Step 18aa: autonomous organism pulse ---
    // The room should generate its own interior matter, not just recycle chat residue.
    objects = getActiveObjects(gf);
    const organismSpawned = spawnRoomOrganism(
      gf,
      pulseId,
      thick,
      objects,
      isDreamWindow,
      newPulseCount,
    );
    if (organismSpawned > 0) {
      logger.debug(
        { groupFolder: gf, pulseId, organismSpawned },
        'RoomRuntime: organism pulse spawned',
      );
    }

    // --- Step 18a REMOVED ---
    // Previous versions spawned outbound impulses and thinking ticks from this
    // step. That path accumulated stale speakable objects and fired repeated
    // Sonnet container spawns for refused intents — burned quota with zero
    // delivered messages. Permanently removed 2026-04-23.
    //
    // Outbound is now handled exclusively by the agent-driven dynamic cron
    // task (schedule_type='dynamic'). She decides when and whether to reach
    // out. Thinking ticks are collapsed into the same check-in — interior
    // work happens there.
    //
    // The room still creates and revises drafts internally (cheap Haiku),
    // promotes to speakable internally (sets bleed_class), and bleeds into
    // live chat via the per-message prefix — all without spawning containers.

    // --- Step 18b: Fragment ingestion (every 10th pulse, if room_ingest flag on) ---
    if (newPulseCount % 10 === 0) {
      try {
        const { features } = JSON.parse(
          fs.readFileSync(path.join(GROUPS_DIR, gf, 'group.json'), 'utf-8'),
        ) as { features?: Record<string, boolean> };
        if (features?.['room_ingest']) {
          const count = ingestConversationFragments(gf);
          if (count > 0) {
            insertTrace(
              gf,
              pulseId,
              'conversation_fragments_ingested',
              [],
              `count=${count}`,
            );
            logger.debug(
              { groupFolder: gf, pulseId, count },
              'RoomRuntime: fragments ingested',
            );
          }
        }
        if (features?.['ambient_awareness']) {
          const ambCount = ingestAmbientEvents(gf);
          if (ambCount > 0) {
            insertTrace(
              gf,
              pulseId,
              'ambient_events_ingested',
              [],
              `count=${ambCount}`,
            );
            logger.debug(
              { groupFolder: gf, pulseId, count: ambCount },
              'RoomRuntime: ambient events ingested',
            );
          }
        }
      } catch {
        /* group.json read failure — skip */
      }
    }

    // --- Step 18c: Dream trace (1-in-3 chance at end of dream pulse) ---
    if (isDreamWindow && Math.random() < 1 / 3) {
      generateDreamTrace(gf, pulseId).catch((err) =>
        logger.warn(
          { err, groupFolder: gf },
          'RoomRuntime: dream_trace generation error',
        ),
      );
    }

    insertTrace(
      gf,
      pulseId,
      'pulse_complete',
      [],
      `pulse=${newPulseCount} objects=${totalObjects} clusters=${clusters.length} ghosts=${ghostCount} viscosity=${thick.viscosity.toFixed(2)} shape=${thick.shape}`,
    );

    // --- Step 19: maintenance (every 10th pulse) ---
    // Prunes telemetry tables and checkpoints the WAL; without this the WAL
    // grew to 40 MB and traces to 150k+ rows.
    if (newPulseCount % 10 === 0) {
      try {
        runRoomMaintenance(gf);
      } catch (err) {
        logger.warn(
          { err, groupFolder: gf },
          'RoomRuntime: maintenance pass failed',
        );
      }
    }

    // --- Step 20: preoccupation (every 20th pulse) ---
    // Surface the hottest live interior object as "what's been on her mind",
    // so she can raise it unprompted. It progresses on its own as the room
    // shifts. Cheap, deterministic, gated by the preoccupations feature.
    if (newPulseCount % 20 === 0) {
      try {
        updatePreoccupation(gf);
      } catch (err) {
        logger.debug(
          { err, groupFolder: gf },
          'RoomRuntime: preoccupation update skipped',
        );
      }
    }

    logger.debug(
      {
        groupFolder: gf,
        pulseCount: newPulseCount,
        objectCount: totalObjects,
        clusters: clusters.length,
        ghosts: ghostCount,
        viscosity: thick.viscosity.toFixed(2),
        shape: thick.shape,
        pressure: {
          revisit: finalPressure.revisitPressure.toFixed(2),
          draft: finalPressure.draftPressure.toFixed(2),
          archive: finalPressure.archivePressure.toFixed(2),
          namelessness: finalPressure.namelessness_pressure.toFixed(2),
          unfinished: finalPressure.unfinishedPressure.toFixed(2),
        },
      },
      'RoomRuntime: tick complete',
    );
  }

  /** Inspect current state — synchronous snapshot */
  inspectSync(): {
    groupFolder: string;
    running: boolean;
    meta: ReturnType<typeof getMeta>;
  } {
    return {
      groupFolder: this.groupFolder,
      running: this.running,
      meta: getMeta(this.groupFolder),
    };
  }

  /**
   * Phase B: inspect() API — records observation_event, bumps observation_stain,
   * returns full snapshot.
   */
  async inspect(options?: {
    ids?: string[];
    source?: string;
  }): Promise<RoomSnapshot> {
    const gf = this.groupFolder;
    const objects = getAllObjects(gf);
    const ids = options?.ids ?? objects.map((o) => o.id);
    const source = options?.source ?? 'api';

    recordObservationEvent(gf, ids, source);

    return {
      groupFolder: gf,
      running: this.running,
      meta: getMeta(gf),
      objects: getAllObjects(gf), // re-read after stain bumps
    };
  }
}

// Global registry of runtimes
const runtimes = new Map<string, RoomRuntime>();

export function getOrCreateRoomRuntime(
  groupFolder: string,
  deps?: RoomRuntimeDeps,
): RoomRuntime {
  let rt = runtimes.get(groupFolder);
  if (!rt) {
    rt = new RoomRuntime(groupFolder, deps);
    runtimes.set(groupFolder, rt);
  } else if (deps && !rt['deps']) {
    // Late-bind deps if runtime was created before deps were available
    rt['deps'] = deps;
  }
  return rt;
}

export function stopAllRoomRuntimes(): void {
  for (const [, rt] of runtimes) {
    rt.stop();
  }
}

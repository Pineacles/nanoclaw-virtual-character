/**
 * LLM-using actions (Phase C). All gated by Haiku budget + room_llm_actions flag.
 * Mirror mood-style.ts pattern: spawn claude --print --model claude-haiku-4-5-20251001.
 * Temperature 0.3. Max tokens 200. Cap at 10s. Fall through on timeout.
 */
import { spawn } from 'child_process';
import { spawnEnv } from '../spawn-path.js';
import crypto from 'crypto';
import type { RoomObject, AtmosphereShape } from './types.js';
import type { ActionCandidate } from './scoring.js';
import type { BleedHint } from './actions.js';
import type { ThickAtmosphere } from './weather.js';
import { updateObject, insertObject, insertTrace } from './store.js';
import { logger } from '../logger.js';
import { ASSISTANT_NAME } from '../config.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS = 10_000;
const MAX_TOKENS = 200;

/**
 * Spawn Haiku with a prompt, return trimmed output or null on timeout/error.
 */
async function callHaiku(prompt: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let out = '';
    let err = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        resolve(null);
      }
    }, HAIKU_TIMEOUT_MS);

    const proc = spawn('claude', ['--print', '--model', HAIKU_MODEL], {
      env: spawnEnv(),
    });

    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });

    proc.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stripMarkdownFences(out.trim()));
        } else {
          logger.warn(
            { code, err: err.slice(0, 200) },
            'RoomLLM: Haiku exit non-zero',
          );
          resolve(null);
        }
      }
    });

    proc.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        logger.warn({ err: String(e) }, 'RoomLLM: Haiku spawn error');
        resolve(null);
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function stripMarkdownFences(s: string): string {
  return s
    .replace(/^```[^\n]*\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// ── 1. rename_drift ──────────────────────────────────────────────────────────

async function actionRenameDrift(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
): Promise<BleedHint | null> {
  const recentStains = obj.atmosphere_stains
    .slice(-3)
    .map((s) => s.shape)
    .join(', ');
  const prompt =
    `You are naming an emotional object in someone's inner room system.\n` +
    `Current title: "${obj.title}"\n` +
    `Body (first 500 chars): "${obj.body.slice(0, 500)}"\n` +
    `Recent atmosphere shapes: ${recentStains || 'none'}\n` +
    `Cluster: ${obj.cluster_id ?? 'none'}\n\n` +
    `Return ONE new title only, ≤60 characters. No quotes. No explanation.`;

  const result = await callHaiku(prompt);
  if (!result || result.length > 60 || result === obj.title) {
    insertTrace(
      groupFolder,
      pulseId,
      'rename_drift_failed',
      [obj.id],
      'haiku_null_or_same',
    );
    return null;
  }

  const oldTitle = obj.title;
  const now = nowIso();

  const titleHistory = [
    ...obj.title_history,
    {
      title: oldTitle,
      valid_from: obj.createdAt,
      valid_to: now,
      renamed_reason: 'rename_drift',
    },
  ];

  const updated: RoomObject = {
    ...obj,
    title: result,
    title_history: titleHistory,
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'rename_drift',
    [obj.id],
    `"${oldTitle}" → "${result}"`,
  );
  logger.info(
    { groupFolder, id: obj.id, old: oldTitle, new: result },
    'RoomLLM: rename_drift',
  );

  return {
    action_type: 'rename_drift',
    primary_object_id: obj.id,
    shape_shift: null,
    title_change: { old: oldTitle, new: result },
    bleed_eligibility: obj.bleedClass,
  };
}

// ── 2. rewrite_wording ───────────────────────────────────────────────────────

async function actionRewriteWording(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  atmosphereShape: AtmosphereShape,
): Promise<BleedHint | null> {
  const dominantStain =
    obj.atmosphere_stains.slice(-1)[0]?.shape ?? atmosphereShape;
  const prompt =
    `Rewrite this personal note very subtly — same length (±20%), same voice (lowercase, short, dry-warm). ` +
    `Do NOT make it analytical or report-like. She is writing to herself.\n` +
    `Atmosphere: ${dominantStain}\n` +
    `Note: "${obj.body}"\n\n` +
    `Return ONLY the rewritten note. No explanation.`;

  const result = await callHaiku(prompt);
  if (!result) {
    insertTrace(
      groupFolder,
      pulseId,
      'rewrite_wording_failed',
      [obj.id],
      'haiku_null',
    );
    return null;
  }

  // Check length within ±20%
  const ratio = result.length / Math.max(1, obj.body.length);
  if (ratio < 0.8 || ratio > 1.2) {
    insertTrace(
      groupFolder,
      pulseId,
      'rewrite_wording_skipped',
      [obj.id],
      'length_drift',
    );
    return null;
  }

  const now = nowIso();
  const updatedFailedForms = [
    ...obj.failed_forms,
    {
      type: 'draft' as const,
      shape: 'wording_disturbed → rewritten',
      when: now,
      strength: 0.5,
    },
  ];

  const updated: RoomObject = {
    ...obj,
    body: result,
    failed_forms: updatedFailedForms,
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'rewrite_wording',
    [obj.id],
    `wording_disturbed → rewritten`,
  );
  logger.info({ groupFolder, id: obj.id }, 'RoomLLM: rewrite_wording');

  return {
    action_type: 'rewrite_wording',
    primary_object_id: obj.id,
    shape_shift: String(dominantStain),
    title_change: null,
    bleed_eligibility: obj.bleedClass,
  };
}

// ── 3. create_draft_unsent ───────────────────────────────────────────────────

async function actionCreateDraftUnsent(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
  objects: RoomObject[],
  thick: ThickAtmosphere,
): Promise<BleedHint | null> {
  const deskTitles = objects
    .filter((o) => o.zone === 'desk' && o.status !== 'archived')
    .slice(0, 5)
    .map((o) => o.title)
    .join(', ');

  const moodBlend = Object.entries(thick.mood_blend ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}(${Math.round(v)}%)`)
    .join(' ');

  const prompt =
    `Write a 1-2 sentence unsent draft in ${ASSISTANT_NAME}'s voice. She is a young Korean woman writing to herself.\n` +
    `Voice: lowercase, short, dry-warm, honest. NOT analytical.\n` +
    `Current desk objects: ${deskTitles || 'nothing specific'}\n` +
    `Atmosphere: ${thick.shape}, mood: ${moodBlend || 'unclear'}\n\n` +
    `Return ONLY the draft text. No quotes. No explanation.`;

  const result = await callHaiku(prompt);
  if (!result) {
    insertTrace(
      groupFolder,
      pulseId,
      'create_draft_failed',
      [obj.id],
      'haiku_null',
    );
    return null;
  }

  const now = nowIso();
  const newObj: RoomObject = {
    id: makeId('obj'),
    type: 'draft_unsent',
    zone: 'queue',
    title: 'draft',
    body: result,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    confidence: 0.4,
    importance: 0.4,
    heat: 0.9, // created hot — grace period keeps it warm for ~16 min before cooling starts
    resonance: 0.2,
    dormancy: 0.0,
    persistence: 0.3,
    weirdness: 0.1,
    privateSignificance: 0.5,
    bleedClass: 'sealed',
    sourceRefs: [obj.id],
    links: [],
    stickiness: 0.4,
    residual_warmth_floor: 0.1,
    title_history: [],
    time_in_zone_started_at: now,
    time_total_alive_at: now,
    atmosphere_stains: [],
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

  insertObject(groupFolder, newObj);
  insertTrace(
    groupFolder,
    pulseId,
    'create_draft_unsent',
    [newObj.id],
    `sealed draft created from ${obj.id}`,
  );
  logger.info(
    { groupFolder, newId: newObj.id },
    'RoomLLM: create_draft_unsent',
  );

  return {
    action_type: 'create_draft_unsent',
    primary_object_id: newObj.id,
    shape_shift: String(thick.shape),
    title_change: null,
    bleed_eligibility: 'sealed',
  };
}

// ── 4. revise_draft ──────────────────────────────────────────────────────────

async function actionReviseDraft(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
): Promise<BleedHint | null> {
  const extraStain = obj.atmosphere_stains.slice(-1)[0];
  const prompt =
    `Gently revise this draft — minor changes only (not reformed). Voice: lowercase, dry-warm, honest.\n` +
    `Atmosphere stain: ${extraStain?.shape ?? 'none'}\n` +
    `Draft: "${obj.body}"\n\n` +
    `Return ONLY the revised text. No explanation.`;

  const result = await callHaiku(prompt);
  if (!result) {
    insertTrace(
      groupFolder,
      pulseId,
      'revise_draft_failed',
      [obj.id],
      'haiku_null',
    );
    return null;
  }

  const now = nowIso();
  const updatedFailedForms = [
    ...obj.failed_forms,
    {
      type: 'draft' as const,
      shape: extraStain?.shape ?? 'none',
      when: now,
      strength: 0.3,
    },
  ];

  const updated: RoomObject = {
    ...obj,
    body: result,
    heat: Math.max(obj.heat, 0.85), // revising re-heats the draft so it can reach promote_to_speakable
    failed_forms: updatedFailedForms,
    updatedAt: now,
  };
  updateObject(groupFolder, updated);

  insertTrace(
    groupFolder,
    pulseId,
    'revise_draft',
    [obj.id],
    `draft gently revised`,
  );

  return {
    action_type: 'revise_draft',
    primary_object_id: obj.id,
    shape_shift: extraStain?.shape ?? null,
    title_change: null,
    bleed_eligibility: obj.bleedClass,
  };
}

// ── 5. condense_drafts ───────────────────────────────────────────────────────

async function actionCondenseDrafts(
  groupFolder: string,
  pulseId: string,
  objects: RoomObject[],
  primaryObj: RoomObject,
): Promise<BleedHint | null> {
  const drafts = objects
    .filter(
      (o) =>
        o.type === 'draft_unsent' &&
        o.zone === 'queue' &&
        o.status !== 'archived',
    )
    .slice(0, 3);

  if (drafts.length < 2) {
    insertTrace(
      groupFolder,
      pulseId,
      'condense_drafts_skipped',
      [primaryObj.id],
      'insufficient_drafts',
    );
    return null;
  }

  const bodies = drafts.map((d, i) => `Draft ${i + 1}: "${d.body}"`).join('\n');
  const prompt =
    `Condense these related drafts into one quieter form. Voice: lowercase, dry-warm, honest.\n` +
    `${bodies}\n\n` +
    `Return ONLY the condensed text. No explanation.`;

  const result = await callHaiku(prompt);
  if (!result) {
    insertTrace(
      groupFolder,
      pulseId,
      'condense_drafts_failed',
      [],
      'haiku_null',
    );
    return null;
  }

  const now = nowIso();
  const highestStickiness = Math.max(...drafts.map((d) => d.stickiness));
  const unionStains = drafts.flatMap((d) => d.atmosphere_stains);
  const unionLinks = [...new Set(drafts.flatMap((d) => d.links))];
  const originalIds = drafts.map((d) => d.id);

  const newObj: RoomObject = {
    id: makeId('obj'),
    type: 'draft_unsent',
    zone: 'queue',
    title: 'condensed draft',
    body: result,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    confidence: 0.5,
    importance: Math.max(...drafts.map((d) => d.importance)),
    heat: 0.4,
    resonance: 0.3,
    dormancy: 0.0,
    persistence: 0.4,
    weirdness: 0.1,
    privateSignificance: 0.5,
    bleedClass: 'sealed',
    sourceRefs: originalIds,
    links: unionLinks,
    stickiness: highestStickiness,
    residual_warmth_floor: 0.1,
    title_history: [],
    time_in_zone_started_at: now,
    time_total_alive_at: now,
    atmosphere_stains: unionStains.slice(0, 5),
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
    fracture_seam: {
      original_ids: originalIds,
      reunion_strength: 0.3 + Math.random() * 0.4,
      merged_at: now,
    },
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

  insertObject(groupFolder, newObj);

  // Archive originals
  for (const draft of drafts) {
    const archived: RoomObject = {
      ...draft,
      status: 'archived',
      zone: 'archive',
      updatedAt: now,
    };
    updateObject(groupFolder, archived);
  }

  insertTrace(
    groupFolder,
    pulseId,
    'condense_drafts',
    [newObj.id, ...originalIds],
    `condensed ${drafts.length} drafts`,
  );

  return {
    action_type: 'condense_drafts',
    primary_object_id: newObj.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: 'sealed',
  };
}

// ── 6. shadow_generation ────────────────────────────────────────────────────

async function actionShadowGeneration(
  groupFolder: string,
  pulseId: string,
  obj: RoomObject,
): Promise<BleedHint | null> {
  const targetZone = obj.zone === 'desk' ? 'attic' : 'desk';
  const prompt =
    `Create a differently-framed partial echo of this note (NOT a copy — an echo, a shadow).\n` +
    `It should suggest the same theme from another angle, shorter, stranger.\n` +
    `Original: "${obj.body.slice(0, 300)}"\n\n` +
    `Return ONLY the shadow text (1-2 sentences). No explanation.`;

  const result = await callHaiku(prompt);
  if (!result) {
    insertTrace(
      groupFolder,
      pulseId,
      'shadow_generation_failed',
      [obj.id],
      'haiku_null',
    );
    return null;
  }

  const now = nowIso();
  const shadow: RoomObject = {
    id: makeId('obj'),
    type: 'shadow',
    zone: targetZone as RoomObject['zone'],
    title: `shadow of: ${obj.title.slice(0, 40)}`,
    body: result,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    confidence: 0.4,
    importance: obj.importance * 0.6,
    heat: 0.35,
    resonance: obj.resonance * 0.5,
    dormancy: 0.0,
    persistence: 0.3,
    weirdness: obj.weirdness + 0.15,
    privateSignificance: obj.privateSignificance * 0.7,
    bleedClass: 'ambient',
    sourceRefs: [obj.id],
    links: [obj.id],
    stickiness: 0.3,
    residual_warmth_floor: 0.0,
    title_history: [],
    time_in_zone_started_at: now,
    time_total_alive_at: now,
    atmosphere_stains: obj.atmosphere_stains.slice(-2),
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
    observation_stain: 0,
    deep_presence: false,
    shadow_of: obj.id,
    anti_resolution: 0.1,
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

  insertObject(groupFolder, shadow);
  insertTrace(
    groupFolder,
    pulseId,
    'shadow_generation',
    [shadow.id, obj.id],
    `shadow spawned in ${targetZone}`,
  );
  logger.info(
    { groupFolder, parentId: obj.id, shadowId: shadow.id, targetZone },
    'RoomLLM: shadow_generation',
  );

  return {
    action_type: 'shadow_generation',
    primary_object_id: shadow.id,
    shape_shift: null,
    title_change: null,
    bleed_eligibility: 'ambient',
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export async function executeLLMAction(
  groupFolder: string,
  pulseId: string,
  candidate: ActionCandidate,
  primaryObj: RoomObject,
  objects: RoomObject[],
  thick: ThickAtmosphere,
): Promise<BleedHint | null> {
  switch (candidate.action) {
    case 'rename_drift':
      return actionRenameDrift(groupFolder, pulseId, primaryObj);
    case 'rewrite_wording':
      return actionRewriteWording(
        groupFolder,
        pulseId,
        primaryObj,
        thick.shape,
      );
    case 'create_draft_unsent':
      return actionCreateDraftUnsent(
        groupFolder,
        pulseId,
        primaryObj,
        objects,
        thick,
      );
    case 'revise_draft':
      return actionReviseDraft(groupFolder, pulseId, primaryObj);
    case 'condense_drafts':
      return actionCondenseDrafts(groupFolder, pulseId, objects, primaryObj);
    case 'shadow_generation':
      return actionShadowGeneration(groupFolder, pulseId, primaryObj);
    default:
      logger.warn(
        { groupFolder, action: candidate.action },
        'RoomLLM: unknown LLM action',
      );
      return null;
  }
}

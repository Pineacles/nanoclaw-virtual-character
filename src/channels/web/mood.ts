import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../../config.js';
import { countRecentMessages } from '../../db.js';
import {
  getGroupFolder,
  getGroupJid,
  getTimezone,
  getUserName,
  getGroupConfig,
} from './group-config.js';
import {
  getCachedMoodStyle,
  regenerateMoodStyleAsync,
  shouldRegenerate,
  MoodBehavior,
} from './mood-style.js';
const OVERRIDE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/* ── Activity Interrupt ── */

// Activities containing these keywords are considered "solo" — interruptible by conversation
const SOLO_KEYWORDS = [
  'sleep',
  'drawing',
  'sketch',
  'pilates',
  'training',
  'workout',
  'gym',
  'out',
  'dinner',
  'restaurant',
  'café',
  'cafe',
  'walk',
  'shopping',
  'focused',
  'deep work',
  'meditating',
  'yoga',
  'running',
  'skincare',
  'shower',
  'bath',
];

const INTERRUPT_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
const INTERRUPT_THRESHOLD = 3; // messages needed to trigger interrupt
const INTERRUPT_COOLDOWN_MS = 10 * 60 * 1000; // 10 min silence → back to original activity

interface ActivityOverride {
  original_activity: string;
  override_activity: string;
  block_time: string; // the schedule slot time this override applies to
  created_at: string;
}

function overridePath(): string {
  return path.join(GROUPS_DIR, getGroupFolder(), 'activity_override.json');
}

function isSoloActivity(activity: string): boolean {
  const lower = activity.toLowerCase();
  return SOLO_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Check if the current schedule block should be interrupted based on
 * recent conversation frequency. Returns the overridden activity string
 * or null if no interrupt.
 */
function resolveActivityInterrupt(
  scheduleActivity: string,
  blockTime: string,
): string | null {
  // Check for existing valid override first
  const p = overridePath();
  try {
    if (fs.existsSync(p)) {
      const existing: ActivityOverride = JSON.parse(
        fs.readFileSync(p, 'utf-8'),
      );
      // Override is valid only for the current block
      if (existing.block_time !== blockTime) {
        // Block changed — stale override, remove it
        fs.unlinkSync(p);
      } else {
        // Block still active — check if conversation went quiet
        const cooldownSince = new Date(
          Date.now() - INTERRUPT_COOLDOWN_MS,
        ).toISOString();
        let chatJid: string;
        try {
          chatJid = getGroupJid();
        } catch {
          return existing.override_activity;
        }
        const recentCount = countRecentMessages(chatJid, cooldownSince);
        if (recentCount === 0) {
          // Silence — she drifted back to what she was doing
          fs.unlinkSync(p);
          return null;
        }
        return existing.override_activity;
      }
    }
  } catch {
    // Corrupt file, ignore
  }

  // Only interrupt solo activities
  if (!scheduleActivity || !isSoloActivity(scheduleActivity)) return null;

  // Count recent user messages
  const sinceTimestamp = new Date(
    Date.now() - INTERRUPT_WINDOW_MS,
  ).toISOString();
  let chatJid: string;
  try {
    chatJid = getGroupJid();
  } catch {
    return null; // group config not loaded yet
  }
  const count = countRecentMessages(chatJid, sinceTimestamp);

  if (count < INTERRUPT_THRESHOLD) return null;

  // Extract the core activity for the override text
  const core = scheduleActivity
    .split('—')[0] // take part before em dash
    .split(',')[0] // take part before comma
    .trim()
    .toLowerCase();

  const override: ActivityOverride = {
    original_activity: scheduleActivity,
    override_activity: `chatting with ${getUserName()}, pulled away from ${core}`,
    block_time: blockTime,
    created_at: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(p, JSON.stringify(override, null, 2), 'utf-8');
  } catch {
    // Non-critical — just return the override without persisting
  }

  return override.override_activity;
}

export interface MoodScheduleSlot {
  time: string;
  mood: string;
  energy: number;
  activity: string;
  distribution?: Record<string, number>;
}

export interface DailyWeights {
  base: Record<string, number>;
  random_factor: number;
  desired_override: string | null;
}

export interface MoodData {
  current_mood: string;
  energy: number;
  updated_at: string;
  schedule: MoodScheduleSlot[];
  daily_weights?: DailyWeights;
  distribution?: Record<string, number>;
}

export interface ResolvedMood {
  current_mood: string;
  energy: number;
  activity: string;
  updated_at: string;
  schedule: MoodScheduleSlot[];
  distribution?: Record<string, number>;
}

interface ScheduleDriftData {
  current_phase?: string;
  phase?: string;
  energy_trend?: string;
  social_level?: string;
  morning_flexibility?: boolean;
  late_night_mode?: boolean;
  drift?: DriftModifiers;
  sleep_drift_minutes?: number;
  energy_delta?: number;
  phase_bias?: string;
  mood_bias?: Record<string, number>;
  activity_anchor?: string;
  current_anchor?: string;
  current_food?: string;
  current_drawing?: string;
  current_media?: string;
  domestic_state?: string;
  apartment_detail?: string;
  running_bit_state?: string;
  running_bit_incident?: string;
  unfinished_errand?: string;
}

interface DriftModifiers {
  sleep_drift_minutes?: number;
  energy_delta?: number;
  phase_bias?: string;
  mood_bias?: Record<string, number>;
  activity_anchor?: string;
  current_anchor?: string;
  current_food?: string;
  current_drawing?: string;
  current_media?: string;
  domestic_state?: string;
  apartment_detail?: string;
  running_bit_state?: string;
  running_bit_incident?: string;
  unfinished_errand?: string;
}

function moodPath(): string {
  return path.join(GROUPS_DIR, getGroupFolder(), 'mood.json');
}

function moodFallback(): { current_mood: string; energy: number } {
  const fallback = getGroupConfig().mood?.fallback;
  return {
    current_mood: fallback?.mood ?? 'chill',
    energy: fallback?.energy ?? 6,
  };
}

function readMoodFile(): MoodData {
  const p = moodPath();
  if (!fs.existsSync(p)) {
    const { current_mood, energy } = moodFallback();
    return { current_mood, energy, updated_at: '', schedule: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    const { current_mood, energy } = moodFallback();
    return { current_mood, energy, updated_at: '', schedule: [] };
  }
}

function writeMoodFile(data: MoodData): void {
  fs.writeFileSync(moodPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function scheduleContextPath(): string {
  return path.join(GROUPS_DIR, getGroupFolder(), 'schedule_context.json');
}

function lifeStatePath(): string {
  return path.join(GROUPS_DIR, getGroupFolder(), 'life_state.json');
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readScheduleDrift(): ScheduleDriftData | null {
  const schedule = readJsonFile<ScheduleDriftData>(scheduleContextPath());
  const life = readJsonFile<DriftModifiers>(lifeStatePath());
  if (!schedule && !life) return null;
  if (!life) return schedule;
  return {
    ...(schedule ?? {}),
    drift: {
      ...(schedule?.drift ?? {}),
      ...life,
    },
  };
}

function getZurichTimeStr(): string {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: getTimezone(),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function findActiveSlot(schedule: MoodScheduleSlot[]): MoodScheduleSlot | null {
  if (!schedule || schedule.length === 0) return null;
  const now = getZurichTimeStr();

  // The schedule is chronological across a day cycle, but may wrap past midnight
  // (e.g. 00:00, 09:00, ..., 22:30, 01:30). Detect wrap: if the last slot's time
  // is earlier than the previous slot's time, everything after the wrap is "next day".
  let wrapIndex = schedule.length; // no wrap by default
  for (let i = 1; i < schedule.length; i++) {
    if (schedule[i].time < schedule[i - 1].time) {
      wrapIndex = i;
      break;
    }
  }

  const daySlots = schedule.slice(0, wrapIndex);
  const overnightSlots = schedule.slice(wrapIndex);

  // If we're in the overnight window (now < first day slot and overnight slots exist)
  if (overnightSlots.length > 0 && now < daySlots[0].time) {
    let active: MoodScheduleSlot | null = null;
    for (const slot of overnightSlots) {
      if (slot.time <= now) active = slot;
    }
    // Before first overnight slot — still on last day slot (e.g. 00:30 and overnight starts at 01:30)
    return active || daySlots[daySlots.length - 1];
  }

  // Normal daytime: find the latest day slot that has started
  let active: MoodScheduleSlot | null = null;
  for (const slot of daySlots) {
    if (slot.time <= now) active = slot;
  }
  return active || daySlots[daySlots.length - 1];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function currentHour(): number {
  return parseInt(
    new Date().toLocaleTimeString('en-GB', {
      timeZone: getTimezone(),
      hour: '2-digit',
      hour12: false,
    }),
    10,
  );
}

function normalizeDistribution(
  distribution: Record<string, number> | undefined,
  fallbackMood: string,
): Record<string, number> {
  const source =
    distribution && Object.keys(distribution).length > 0
      ? distribution
      : { [fallbackMood]: 100 };

  const cleaned: Record<string, number> = {};
  for (const [mood, weight] of Object.entries(source)) {
    // FIX 4b: drop corrupt entries (undefined key, NaN weight) so existing
    // bad state can never bleed into the rendered mood blend or system prompt.
    if (!mood || mood === 'undefined' || !Number.isFinite(weight)) continue;
    const rounded = Math.max(0, Math.round(weight));
    if (rounded > 0) cleaned[mood] = rounded;
  }

  const entries = Object.entries(cleaned);
  if (entries.length === 0) return { [fallbackMood]: 100 };

  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return { [fallbackMood]: 100 };

  const normalized = entries.map(([mood, weight]) => ({
    mood,
    exact: (weight / total) * 100,
  }));

  const result: Record<string, number> = {};
  let allocated = 0;
  for (const item of normalized) {
    const rounded = Math.floor(item.exact);
    result[item.mood] = rounded;
    allocated += rounded;
  }

  const remainder = 100 - allocated;
  normalized
    .sort((a, b) => (b.exact % 1) - (a.exact % 1))
    .slice(0, remainder)
    .forEach((item) => {
      result[item.mood] += 1;
    });

  return Object.fromEntries(
    Object.entries(result)
      .filter(([, weight]) => weight > 0)
      .sort((a, b) => b[1] - a[1]),
  );
}

function addMoodWeight(
  distribution: Record<string, number>,
  mood: string,
  amount: number,
): void {
  if (!mood || !Number.isFinite(amount) || amount === 0) return;
  distribution[mood] = Math.max(0, (distribution[mood] ?? 0) + amount);
}

function applyMoodBiases(
  baseDistribution: Record<string, number>,
  baseMood: string,
  drift: ScheduleDriftData | null,
): Record<string, number> {
  const adjusted = { ...baseDistribution };
  if (!drift) return normalizeDistribution(adjusted, baseMood);

  const phase = (
    drift.current_phase ??
    drift.phase ??
    drift.drift?.phase_bias ??
    drift.phase_bias ??
    ''
  ).toLowerCase();
  const energyTrend = (drift.energy_trend ?? '').toLowerCase();
  const socialLevel = (drift.social_level ?? '').toLowerCase();
  const hour = currentHour();
  const sleepDrift =
    drift.drift?.sleep_drift_minutes ?? drift.sleep_drift_minutes ?? 0;

  if (phase.includes('drawing')) {
    addMoodWeight(adjusted, 'focused', 10);
    addMoodWeight(adjusted, 'content', 4);
  } else if (phase.includes('social')) {
    addMoodWeight(adjusted, 'soft', 7);
    addMoodWeight(adjusted, 'playful', 5);
  } else if (phase.includes('free')) {
    addMoodWeight(adjusted, 'restless', 5);
    addMoodWeight(adjusted, 'content', 4);
  }

  if (
    energyTrend.includes('low') ||
    energyTrend.includes('drain') ||
    energyTrend.includes('tired')
  ) {
    addMoodWeight(adjusted, 'tired', 10);
    addMoodWeight(adjusted, 'soft', 4);
  } else if (energyTrend.includes('high') || energyTrend.includes('good')) {
    addMoodWeight(adjusted, 'happy', 6);
    addMoodWeight(adjusted, 'excited', 4);
  }

  if (socialLevel.includes('selective')) {
    addMoodWeight(adjusted, 'soft', 3);
  } else if (socialLevel.includes('isolated')) {
    addMoodWeight(adjusted, 'lonely', 6);
    addMoodWeight(adjusted, 'wistful', 4);
  }

  if (drift.morning_flexibility && hour >= 6 && hour < 10) {
    addMoodWeight(adjusted, 'tired', 7);
    addMoodWeight(adjusted, 'soft', 3);
  }

  if (drift.late_night_mode && (hour >= 22 || hour < 2)) {
    addMoodWeight(adjusted, 'playful', 5);
    addMoodWeight(adjusted, 'tender', 4);
  }

  if (sleepDrift >= 30 && hour >= 6 && hour < 13) {
    addMoodWeight(adjusted, 'tired', clamp(Math.round(sleepDrift / 8), 4, 14));
    addMoodWeight(
      adjusted,
      'sleeping',
      clamp(Math.round(sleepDrift / 20), 0, 6),
    );
  } else if (sleepDrift <= -30 && hour >= 6 && hour < 13) {
    addMoodWeight(
      adjusted,
      'determined',
      clamp(Math.round(Math.abs(sleepDrift) / 12), 3, 8),
    );
  }

  const explicitMoodBias = drift.drift?.mood_bias ?? drift.mood_bias;
  if (explicitMoodBias) {
    for (const [mood, amount] of Object.entries(explicitMoodBias)) {
      addMoodWeight(adjusted, mood, clamp(amount, -20, 20));
    }
  }

  return normalizeDistribution(adjusted, baseMood);
}

function resolvePrimary(
  distribution: Record<string, number>,
  fallbackMood: string,
): string {
  return (
    Object.entries(distribution).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    fallbackMood
  );
}

function applyEnergyDrift(
  baseEnergy: number,
  drift: ScheduleDriftData | null,
): number {
  if (!drift) return baseEnergy;
  const hour = currentHour();
  const energyTrend = (drift.energy_trend ?? '').toLowerCase();
  const sleepDrift =
    drift.drift?.sleep_drift_minutes ?? drift.sleep_drift_minutes ?? 0;
  const explicitDelta = drift.drift?.energy_delta ?? drift.energy_delta ?? 0;
  let delta = clamp(explicitDelta, -2, 2);

  if (
    energyTrend.includes('low') ||
    energyTrend.includes('drain') ||
    energyTrend.includes('tired')
  )
    delta -= 1;
  if (energyTrend.includes('high') || energyTrend.includes('good')) delta += 1;
  if (sleepDrift >= 45 && hour >= 6 && hour < 13) delta -= 1;
  if (sleepDrift <= -45 && hour >= 6 && hour < 13) delta += 1;
  if (drift.late_night_mode && hour >= 22) delta += 1;

  return clamp(baseEnergy + delta, 1, 10);
}

function compactAnchor(text: string | undefined): string | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  return trimmed.length > 90 ? `${trimmed.slice(0, 87)}...` : trimmed;
}

function applyActivityDrift(
  activity: string,
  drift: ScheduleDriftData | null,
): string {
  if (!drift) return activity;
  const d = drift.drift ?? {};
  const anchors = [
    d.activity_anchor ?? drift.activity_anchor,
    d.current_anchor ?? drift.current_anchor,
    d.current_food ?? drift.current_food,
    d.current_drawing ?? drift.current_drawing,
    d.current_media ?? drift.current_media,
    d.domestic_state ?? drift.domestic_state,
    d.apartment_detail ?? drift.apartment_detail,
    d.running_bit_state ?? drift.running_bit_state,
    d.running_bit_incident ?? drift.running_bit_incident,
    d.unfinished_errand ?? drift.unfinished_errand,
  ]
    .map(compactAnchor)
    .filter((anchor): anchor is string => Boolean(anchor));

  const uniqueAnchors = [...new Set(anchors)]
    .filter((anchor) => !activity.toLowerCase().includes(anchor.toLowerCase()))
    .slice(0, 2);

  if (uniqueAnchors.length === 0) return activity;
  const base = activity.trim().replace(/[.。]+$/g, '');
  return base
    ? `${base}. current: ${uniqueAnchors.join('; ')}`
    : uniqueAnchors.join('; ');
}

function maybeRegenerateResolvedMoodStyle(
  distribution: Record<string, number> | undefined,
  energy: number,
): void {
  if (!distribution || Object.keys(distribution).length === 0) return;
  const cached = getCachedMoodStyle(getGroupFolder());
  maybeRegenerateMoodStyle(cached?.distribution, distribution, energy);
}

function buildResolvedMood(opts: {
  baseMood: string;
  baseEnergy: number;
  baseActivity: string;
  updatedAt: string;
  schedule: MoodScheduleSlot[];
  distribution?: Record<string, number>;
  applyDistributionDrift: boolean;
}): ResolvedMood {
  const drift = readScheduleDrift();
  const activity = applyActivityDrift(opts.baseActivity, drift);
  const baseDistribution = normalizeDistribution(
    opts.distribution,
    opts.baseMood,
  );
  const distribution = opts.applyDistributionDrift
    ? applyMoodBiases(baseDistribution, opts.baseMood, drift)
    : baseDistribution;
  const energy = opts.applyDistributionDrift
    ? applyEnergyDrift(opts.baseEnergy, drift)
    : opts.baseEnergy;
  const currentMood = resolvePrimary(distribution, opts.baseMood);

  if (opts.applyDistributionDrift) {
    maybeRegenerateResolvedMoodStyle(distribution, energy);
  }

  return {
    current_mood: currentMood,
    energy,
    activity,
    updated_at: opts.updatedAt,
    schedule: opts.schedule,
    distribution,
  };
}

/**
 * Resolve current mood.
 * - If the agent overrode mood via tag within the last 15 minutes, use that override.
 * - Otherwise, fall back to the schedule slot for the current Zurich time.
 */
export function resolveMood(): ResolvedMood {
  const data = readMoodFile();

  // Activity from schedule, with conversation interrupt check
  const slot = findActiveSlot(data.schedule);
  const scheduleActivity = slot?.activity || '';
  const activity =
    resolveActivityInterrupt(scheduleActivity, slot?.time || '') ||
    scheduleActivity;

  // Check if agent overrode mood via tag within the last 15 minutes
  if (data.updated_at) {
    const overrideAge = Date.now() - new Date(data.updated_at).getTime();
    if (overrideAge < OVERRIDE_WINDOW_MS && overrideAge >= 0) {
      return buildResolvedMood({
        baseMood: data.current_mood,
        baseEnergy: data.energy,
        baseActivity: activity,
        updatedAt: data.updated_at,
        schedule: data.schedule,
        distribution: data.distribution,
        applyDistributionDrift: false,
      });
    }
  }

  // Override expired — revert to schedule (including schedule-level distribution)
  if (slot) {
    return buildResolvedMood({
      baseMood: slot.mood,
      baseEnergy: slot.energy,
      baseActivity: activity,
      updatedAt: data.updated_at,
      schedule: data.schedule,
      distribution: slot.distribution,
      applyDistributionDrift: true,
    });
  }

  return buildResolvedMood({
    baseMood: data.current_mood,
    baseEnergy: data.energy,
    baseActivity: '',
    updatedAt: data.updated_at,
    schedule: data.schedule,
    distribution: data.distribution,
    applyDistributionDrift: true,
  });
}

/** Regex for distribution format: *[mood:chill:40,focused:30,hungry:30:6]* */
const MOOD_TAG_DIST = /\s*\*\[mood:((?:\w+:\d+,)*\w+:\d+):(\d+)\]\*\s*$/;
/** Regex for simple format: *[mood:chill:6]* */
const MOOD_TAG_SIMPLE = /\s*\*\[mood:(\w+):(\d+)\]\*\s*$/;
/** Regex for old format: [mood:X] or [mood:X energy:Y] anywhere */
const MOOD_TAG_OLD = /\[mood:(\w+)(?:\s+energy:(\d+))?\]\s*/g;

/** Parse a distribution string like "chill:40,focused:30,hungry:30" into Record<string, number> */
function parseDistribution(distStr: string): Record<string, number> | null {
  const parts = distStr.split(',');
  if (parts.length < 2) return null; // single mood, not a distribution
  const dist: Record<string, number> = {};
  for (const part of parts) {
    const [name, weight] = part.split(':');
    // FIX 4a: reject falsy names (empty string, "undefined") and non-numeric weights
    if (!name || name === 'undefined' || !weight) return null;
    const parsed = parseInt(weight, 10);
    if (!Number.isFinite(parsed)) return null;
    dist[name] = parsed;
  }
  return dist;
}

/**
 * Sanitise a distribution object before writing to disk.
 * Removes entries whose key is falsy/literally "undefined", or whose value is
 * not a finite number.  Returns null if the result is empty (caller falls back).
 */
function sanitizeDistribution(
  dist: Record<string, number>,
): Record<string, number> | null {
  const clean: Record<string, number> = {};
  for (const [key, val] of Object.entries(dist)) {
    if (!key || key === 'undefined' || !Number.isFinite(val)) continue;
    clean[key] = val;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/** Strip all mood tag formats from text for display */
export function stripMoodTags(text: string): string {
  return text
    .replace(MOOD_TAG_DIST, '')
    .replace(MOOD_TAG_SIMPLE, '')
    .replace(MOOD_TAG_OLD, '')
    .trim();
}

/**
 * Extract the trailing mood tag from text (distribution or simple format only).
 * Returns the matched tag string (e.g. `*[mood:tired:40,soft:35:4]*`) or null if
 * no tag is present.  Used by the paced-bubbles path to re-attach the tag to the
 * last bubble before it reaches sendToClient, so applyMoodTag fires exactly once.
 */
export function extractMoodTag(text: string): string | null {
  const distMatch = text.match(MOOD_TAG_DIST);
  if (distMatch) return distMatch[0].trim();
  const simpleMatch = text.match(MOOD_TAG_SIMPLE);
  if (simpleMatch) return simpleMatch[0].trim();
  return null;
}

function loadMoodBehaviorsForRegen(): Record<string, MoodBehavior> | null {
  try {
    const p = path.join(GROUPS_DIR, getGroupFolder(), 'mood_behaviors.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function maybeRegenerateMoodStyle(
  oldDist: Record<string, number> | undefined,
  newDist: Record<string, number>,
  energy: number,
): void {
  if (!shouldRegenerate(oldDist, newDist)) return;
  const behaviors = loadMoodBehaviorsForRegen();
  if (!behaviors) return;
  try {
    regenerateMoodStyleAsync(getGroupFolder(), newDist, energy, behaviors);
  } catch {
    /* fire-and-forget — never throw */
  }
}

/**
 * Parse mood tags from bot text. Supports:
 *   *[mood:chill:40,focused:30,hungry:30:6]* (distribution, preferred)
 *   *[mood:chill:6]* (simple, backward compat)
 *   [mood:chill energy:6] (old, inline)
 * Updates mood.json immediately as a manual override.
 */
export function applyMoodTag(text: string): {
  cleanText: string;
  mood: string;
} {
  // Capture existing distribution before any mutation so we can detect changes.
  const existingData = readMoodFile();
  const oldDist = existingData.distribution;

  // Try distribution format first (new, preferred)
  const distMatch = text.match(MOOD_TAG_DIST);
  if (distMatch) {
    const distStr = distMatch[1];
    const newEnergy = parseInt(distMatch[2], 10);
    const dist = parseDistribution(distStr);
    const cleanText = stripMoodTags(text);

    if (dist) {
      // FIX 4c: sanitise dist before writing — reject any entry with a falsy/
      // "undefined" name or non-finite weight (can happen if the model writes
      // a malformed tag like *[mood:undefined:91,...]*).
      const safeDist = sanitizeDistribution(dist);
      if (!safeDist) {
        // Nothing survived sanitation — treat as if no tag was found
        const current = resolveMood();
        return { cleanText, mood: current.current_mood };
      }
      const safeEnergy = Number.isFinite(newEnergy) ? newEnergy : existingData.energy;
      // Primary mood = highest weight
      const primary = Object.entries(safeDist).sort((a, b) => b[1] - a[1])[0][0];
      const data = existingData;
      data.current_mood = primary;
      data.energy = safeEnergy;
      data.distribution = safeDist;
      data.updated_at = new Date().toISOString();
      writeMoodFile(data);
      maybeRegenerateMoodStyle(oldDist, data.distribution!, data.energy);
      return { cleanText, mood: primary };
    }
  }

  // Try simple format
  const simpleMatch = text.match(MOOD_TAG_SIMPLE);
  if (simpleMatch) {
    const newMood = simpleMatch[1];
    const newEnergy = parseInt(simpleMatch[2], 10);
    const cleanText = stripMoodTags(text);

    // FIX 4c: reject falsy/undefined mood names or non-finite energy
    if (!newMood || newMood === 'undefined' || !Number.isFinite(newEnergy)) {
      const current = resolveMood();
      return { cleanText, mood: current.current_mood };
    }

    const data = existingData;
    data.current_mood = newMood;
    data.energy = newEnergy;
    data.distribution = { [newMood]: 100 };
    data.updated_at = new Date().toISOString();
    writeMoodFile(data);
    maybeRegenerateMoodStyle(oldDist, data.distribution!, data.energy);

    return { cleanText, mood: newMood };
  }

  // Try old format
  const oldMatch = text.match(/\[mood:(\w+)(?:\s+energy:(\d+))?\]/);
  if (oldMatch) {
    const newMood = oldMatch[1];
    const newEnergy = oldMatch[2] ? parseInt(oldMatch[2], 10) : undefined;
    const cleanText = stripMoodTags(text);

    // FIX 4c: reject falsy/undefined mood names
    if (!newMood || newMood === 'undefined') {
      const current = resolveMood();
      return { cleanText, mood: current.current_mood };
    }

    const data = existingData;
    data.current_mood = newMood;
    if (newEnergy !== undefined && Number.isFinite(newEnergy))
      data.energy = newEnergy;
    data.distribution = { [newMood]: 100 };
    data.updated_at = new Date().toISOString();
    writeMoodFile(data);
    maybeRegenerateMoodStyle(oldDist, data.distribution!, data.energy);

    return { cleanText, mood: newMood };
  }

  const current = resolveMood();
  return { cleanText: text, mood: current.current_mood };
}

/**
 * Context builder — assembles the [System: ...] block injected into every agent message.
 * Pulls from: group config, mood, memory/diary, and user-defined context/*.md files.
 * No hardcoded names, schedules, or activities.
 */

import path from 'path';
import fs from 'fs';

import {
  getGroupConfig,
  getGroupDir,
  getUserName,
  getAssistantName,
  isFeatureEnabled,
} from './group-config.js';
import { buildAmbientHint } from './ambient.js';
import { resolveMood } from './mood.js';
import { loadContextFiles } from './context-loader.js';
import {
  buildWorkflowSummary,
  buildWorkflowDirective,
} from './workflow-loader.js';
import { getRecentMemories, searchMemories } from '../../memory-db.js';
import { getCachedMoodStyle } from './mood-style.js';
import { getRecentMoods, getChatMessages } from '../../db.js';
import {
  getCachedUserState,
  generateUserStateAsync,
  formatUserStateBlock,
  shouldSkipAnalysis,
} from './tom-analyzer.js';
import { computeUserStyle, formatUserStyleBlock } from './style-tracker.js';
import { buildRoomBleedBlock } from '../../room/bleed-builder.js';
import {
  buildVoiceNoteHint,
  buildThreadCallbackHint,
  buildPreoccupationHint,
  buildMessagingRealismHint,
  buildDisclosureHint,
  fuzzMemoryByAge,
} from './humanity.js';
import { currentEvent, upcomingEvents } from '../../social/calendar.js';
import { buildSocialContextHint } from '../../social/context-hint.js';
import { buildDatesHint } from '../../social/dates.js';

/* ── Workspace File Index ── */

const FILE_ANNOTATIONS: Record<string, string> = {
  'credentials.md': 'All API keys for websites and services',

  'finance.md': 'Money, budgets, investments, stocks',
  'diet.md': 'Food, nutrition, calories, macros',
  'fitness.md': 'Exercise, workouts, weight, body',
  'psychology.md': 'Mental health, mood, habits, goals',
};

type TopicTrigger =
  | { file: string; keywords: string[] }
  | { dir: string; limit: number; keywords: string[] };

const TOPIC_TRIGGERS: TopicTrigger[] = [
  {
    file: 'finance.md',
    keywords: [
      'money',
      'finance',
      'budget',
      'spend',
      'invest',
      'stock',
      'stocks',
      'portfolio',
      'trade',
      'trading',
      'saving',
      'savings',
      'income',
      'expense',
      'expenses',
      'salary',
      'tax',
      'taxes',
      'crypto',
      'etf',
      'bond',
      'dividend',
    ],
  },
  {
    file: 'diet.md',
    keywords: [
      'food',
      'eat',
      'eating',
      'ate',
      'meal',
      'meals',
      'recipe',
      'recipes',
      'calorie',
      'calories',
      'macro',
      'macros',
      'protein',
      'carb',
      'carbs',
      'nutrition',
      'diet',
      'snack',
      'breakfast',
      'lunch',
      'dinner',
      'cook',
      'cooking',
      'hungry',
      'restaurant',
    ],
  },
  {
    file: 'fitness.md',
    keywords: [
      'workout',
      'workouts',
      'exercise',
      'gym',
      'train',
      'training',
      'lift',
      'lifting',
      'run',
      'running',
      'cardio',
      'muscle',
      'weight',
      'bench',
      'squat',
      'deadlift',
      'fitness',
      'sets',
      'reps',
    ],
  },
  {
    file: 'psychology.md',
    keywords: [
      'mood',
      'feeling',
      'feelings',
      'anxious',
      'anxiety',
      'depressed',
      'depression',
      'stress',
      'stressed',
      'motivation',
      'habit',
      'habits',
      'goal',
      'goals',
      'therapy',
      'mental',
      'overwhelmed',
      'burnout',
      'self-improvement',
    ],
  },
  {
    dir: 'briefings',
    limit: 3,
    keywords: [
      'brief',
      'briefing',
      'morning',
      'yap',
      'yesterday you said',
      'what did you say',
      'yesterday brief',
    ],
  },
  {
    file: 'shared_refs.md',
    keywords: [
      'we',
      'us',
      'remember',
      'that time',
      'you said',
      'earlier',
      'yesterday',
      'last week',
      'our',
      'the thing',
    ],
  },
];

const MAX_TOPIC_INJECTION_BYTES = 8192;

function buildTopicContext(userMessage: string): string {
  if (!userMessage) return '';
  const msg = userMessage.toLowerCase();
  const groupDir = getGroupDir();
  const matched: string[] = [];
  let totalBytes = 0;

  for (const trigger of TOPIC_TRIGGERS) {
    const hit = trigger.keywords.some((kw) => {
      const re = new RegExp(
        `\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      );
      return re.test(msg);
    });
    if (!hit) continue;

    if ('file' in trigger) {
      const fp = path.join(groupDir, trigger.file);
      if (!fs.existsSync(fp)) continue;
      try {
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (!content) continue;
        const block = `\n--- ${trigger.file} ---\n${content}`;
        if (totalBytes + block.length > MAX_TOPIC_INJECTION_BYTES) break;
        matched.push(block);
        totalBytes += block.length;
      } catch {
        /* ignore */
      }
    } else {
      const dirPath = path.join(groupDir, trigger.dir);
      try {
        const files = fs
          .readdirSync(dirPath)
          .filter((f) => f.endsWith('.md'))
          .sort()
          .reverse()
          .slice(0, trigger.limit);
        for (const filename of files) {
          const fp = path.join(dirPath, filename);
          try {
            const content = fs.readFileSync(fp, 'utf-8').trim();
            if (!content) continue;
            const block = `\n--- ${trigger.dir}/${filename} ---\n${content}`;
            if (totalBytes + block.length > MAX_TOPIC_INJECTION_BYTES) break;
            matched.push(block);
            totalBytes += block.length;
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* directory doesn't exist yet */
      }
    }
  }

  if (matched.length === 0) return '';
  return `\n<<<auto-memory>>>\nRelevant domain context (auto-loaded based on topic):${matched.join('')}\n<<<end-auto-memory>>>`;
}

let fileIndexCache: { data: string; time: number } = { data: '', time: 0 };
const FILE_INDEX_CACHE_TTL = 60_000;

function buildFileIndex(): string {
  const now = Date.now();
  if (fileIndexCache.time && now - fileIndexCache.time < FILE_INDEX_CACHE_TTL) {
    return fileIndexCache.data;
  }

  const groupDir = getGroupDir();
  const lines: string[] = [];

  // Root .md files
  try {
    const mdFiles = fs
      .readdirSync(groupDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    for (const f of mdFiles) {
      if (f === 'CLAUDE.md') continue; // already loaded as system prompt
      let annotation = FILE_ANNOTATIONS[f] || '';
      if (f === 'USER.md')
        annotation = `${getUserName()}'s profile — read every conversation`;
      lines.push(`  ${f}${annotation ? ` — ${annotation}` : ''}`);
    }
  } catch {
    /* ignore */
  }

  // Context files
  try {
    const ctxDir = path.join(groupDir, 'context');
    if (fs.existsSync(ctxDir)) {
      const ctxFiles = fs
        .readdirSync(ctxDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      for (const f of ctxFiles) {
        lines.push(`  context/${f}`);
      }
    }
  } catch {
    /* ignore */
  }

  // Workflow files
  try {
    const wfDir = path.join(groupDir, 'workflows');
    if (fs.existsSync(wfDir)) {
      const wfFiles = fs
        .readdirSync(wfDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      for (const f of wfFiles) {
        lines.push(`  workflows/${f}`);
      }
    }
  } catch {
    /* ignore */
  }

  const result =
    lines.length > 0
      ? `Workspace files (/workspace/group/):\n${lines.join('\n')}`
      : '';
  fileIndexCache = { data: result, time: now };
  return result;
}

/* ── User Schedule ── */

interface ScheduleOverride {
  date: string; // YYYY-MM-DD
  label: string; // "off day", "working from home", "trip to Berlin"
  wake?: string; // override wake time
  work_start?: string;
  work_end?: string;
  off?: boolean; // true = no work
  notes?: string;
}

interface ScheduleDefaults {
  wake?: string; // e.g. "05:45"
  work_start?: string; // e.g. "06:30"
  work_end?: string; // e.g. "17:00"
}

interface ScheduleData {
  defaults?: ScheduleDefaults;
  overrides?: ScheduleOverride[];
}

let scheduleCache: { data: ScheduleData | null; time: number } = {
  data: null,
  time: 0,
};
const SCHEDULE_CACHE_TTL = 30_000;

function loadUserSchedule(): string {
  const now = Date.now();
  if (scheduleCache.time && now - scheduleCache.time < SCHEDULE_CACHE_TTL) {
    if (scheduleCache.data) return formatUserSchedule(scheduleCache.data);
    return formatUserSchedule({});
  }

  const p = path.join(getGroupDir(), 'user_schedule.json');
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      scheduleCache = { data: raw, time: now };
      return formatUserSchedule(raw);
    }
  } catch {
    /* fallback */
  }
  scheduleCache = { data: {}, time: now };
  return formatUserSchedule({});
}

function formatUserSchedule(data: ScheduleData): string {
  const tz = getGroupConfig().timezone;
  const nowLocal = new Date().toLocaleString('en-CA', { timeZone: tz });
  const today = nowLocal.slice(0, 10); // YYYY-MM-DD
  const dayOfWeek = new Date().toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
  });
  const isWeekend = dayOfWeek === 'Saturday' || dayOfWeek === 'Sunday';

  // Check for override today
  const override = (data.overrides || []).find((o) => o.date === today);

  // Also gather upcoming overrides (next 7 days) for awareness
  const upcoming = (data.overrides || [])
    .filter((o) => o.date > today && o.date <= addDays(today, 7))
    .sort((a, b) => a.date.localeCompare(b.date));

  const parts: string[] = [];

  const userName = getUserName();
  const defs = data.defaults;
  const defWake = defs?.wake || '';
  const defStart = defs?.work_start || '';
  const defEnd = defs?.work_end || '';
  const hasDefaults = !!(defWake && defStart && defEnd);

  if (override) {
    if (override.off) {
      parts.push(
        `Today for ${userName}: off day — ${override.label}${override.notes ? `. ${override.notes}` : ''}`,
      );
    } else {
      const wake = override.wake || defWake;
      const start = override.work_start || defStart;
      const end = override.work_end || defEnd;
      parts.push(
        `Today for ${userName}: ${override.label}. Wake ${wake}, work ${start}–${end}${override.notes ? `. ${override.notes}` : ''}`,
      );
    }
  } else if (isWeekend) {
    parts.push(`Today for ${userName}: weekend, no fixed work schedule`);
  } else if (hasDefaults) {
    // Default weekday — only shown when schedule defaults are configured
    const nowTime = new Date().toLocaleTimeString('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    let status = 'within workday window';
    if (nowTime < defWake) status = 'before wake time';
    else if (nowTime < defStart) status = 'morning prep window';
    else if (nowTime >= defEnd) status = 'after workday window';
    parts.push(
      `Today for ${userName}: weekday work pattern. Wake ${defWake}, work ~${defStart}–${defEnd}. Status relative to his schedule: ${status}`,
    );
  } else {
    // No schedule configured — show generic line
    parts.push(`Today for ${userName}: no schedule configured`);
  }

  if (upcoming.length > 0) {
    const upcomingStr = upcoming
      .map((o) => {
        const d = new Date(o.date + 'T12:00:00');
        const day = d.toLocaleDateString('en-US', {
          timeZone: tz,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        });
        return `${day}: ${o.label}`;
      })
      .join(', ');
    parts.push(`Upcoming: ${upcomingStr}`);
  }

  const scheduleFile = 'user_schedule.json';
  const defaultsHint = hasDefaults
    ? `Default workday: Mon–Fri wake ${defWake}, work ~${defStart}–${defEnd}.`
    : 'Add a "defaults" object with wake, work_start, work_end to set the regular schedule.';
  parts.push(
    `(You can edit /workspace/group/${scheduleFile} to add overrides and defaults. ${defaultsHint})`,
  );

  return [
    `USER_SCHEDULE_ONLY: The following schedule/status belongs to ${getUserName()}, not to ${getAssistantName()}.`,
    `${getAssistantName()} does not have a job, commute, shift, or "off work" transition unless a separate ${getAssistantName()}-specific activity block says so.`,
    `Never answer "what are you doing" or "are you off work" using ${getUserName()}'s schedule.`,
    parts.join('. '),
  ].join('\n');
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── Mood Behaviors ── */

interface MoodBehavior {
  rules: string;
  tone: string;
}

let behaviorsCache: Record<string, MoodBehavior> | null = null;
let behaviorsCacheTime = 0;
const BEHAVIORS_CACHE_TTL = 60_000; // 60s

function loadMoodBehaviors(): Record<string, MoodBehavior> {
  const now = Date.now();
  if (behaviorsCache && now - behaviorsCacheTime < BEHAVIORS_CACHE_TTL) {
    return behaviorsCache;
  }
  const p = path.join(getGroupDir(), 'mood_behaviors.json');
  try {
    if (fs.existsSync(p)) {
      behaviorsCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      behaviorsCacheTime = now;
      return behaviorsCache!;
    }
  } catch {
    /* fallback */
  }
  behaviorsCache = {};
  behaviorsCacheTime = now;
  return behaviorsCache;
}

/* ── Personality Profile ── */

interface PersonalityTrait {
  score: number;
  description: string;
}
interface PersonalityProfile {
  openness: PersonalityTrait;
  conscientiousness: PersonalityTrait;
  extroversion: PersonalityTrait;
  agreeableness: PersonalityTrait;
  neuroticism: PersonalityTrait;
}

let personalityCache: { data: PersonalityProfile | null; time: number } = {
  data: null,
  time: 0,
};

function loadPersonalityProfile(): string {
  const now = Date.now();
  if (
    personalityCache.time &&
    now - personalityCache.time < BEHAVIORS_CACHE_TTL
  ) {
    if (!personalityCache.data) return '';
    return formatPersonality(personalityCache.data);
  }
  const p = path.join(getGroupDir(), 'personality.json');
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      personalityCache = { data: raw, time: now };
      return formatPersonality(raw);
    }
  } catch {
    /* fallback */
  }
  personalityCache = { data: null, time: now };
  return '';
}

function formatPersonality(p: PersonalityProfile): string {
  const traits = [
    `O=${p.openness.score.toFixed(1)} (${p.openness.description})`,
    `C=${p.conscientiousness.score.toFixed(1)} (${p.conscientiousness.description})`,
    `E=${p.extroversion.score.toFixed(1)} (${p.extroversion.description})`,
    `A=${p.agreeableness.score.toFixed(1)} (${p.agreeableness.description})`,
    `N=${p.neuroticism.score.toFixed(1)} (${p.neuroticism.description})`,
  ];
  return `${getAssistantName()}'s personality (Big Five): ${traits.join(', ')}`;
}

/* ── Emotional State ── */

interface EmotionalState {
  mood: string;
  energy: number;
  trigger: string;
  duration_messages: number;
  resolves_when: string;
  underlying: string;
  updated_at: string;
}

let emotionalCache: { data: EmotionalState | null; time: number } = {
  data: null,
  time: 0,
};
const EMOTIONAL_CACHE_TTL = 30_000; // 30s — emotions change mid-conversation
const EMOTIONAL_FRESH_MS = 6 * 60 * 60 * 1000; // < 6h — present at full strength
const EMOTIONAL_RESIDUAL_MS = 24 * 60 * 60 * 1000; // 6-24h — fades to a residue instead of vanishing, so overnight arcs keep continuity

function loadEmotionalState(): string {
  const now = Date.now();
  if (emotionalCache.time && now - emotionalCache.time < EMOTIONAL_CACHE_TTL) {
    if (!emotionalCache.data) return '';
    return formatEmotionalState(emotionalCache.data, now);
  }
  const p = path.join(getGroupDir(), 'emotional_state.json');
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      emotionalCache = { data: raw, time: now };
      return formatEmotionalState(raw, now);
    }
  } catch {
    /* fallback */
  }
  emotionalCache = { data: null, time: now };
  return '';
}

function formatEmotionalState(e: EmotionalState, now: number): string {
  const age = e.updated_at ? now - new Date(e.updated_at).getTime() : 0;
  if (age > EMOTIONAL_RESIDUAL_MS) return '';

  // Between 6h and 24h the feeling has cooled but shouldn't vanish: a hard
  // cutoff used to reset multi-day emotional arcs the moment the user came
  // back the next morning.
  if (age > EMOTIONAL_FRESH_MS) {
    const parts = [
      `${getAssistantName()}'s emotional residue (from earlier, mostly settled now): ${e.mood}`,
    ];
    if (e.underlying) parts.push(`what lingers underneath: ${e.underlying}`);
    if (e.resolves_when) parts.push(`still resolves when: ${e.resolves_when}`);
    return parts.join(', ');
  }

  const parts = [`${getAssistantName()}'s emotional undercurrent: ${e.mood}`];
  if (e.trigger) parts.push(`trigger: ${e.trigger}`);
  if (e.resolves_when) parts.push(`resolves when: ${e.resolves_when}`);
  if (e.underlying) parts.push(`underlying: ${e.underlying}`);
  return parts.join(', ');
}

/* ── Relationship Dynamics ── */

interface RelationshipDynamic {
  date: string;
  event: string;
  impact: number;
}
interface RelationshipState {
  temperature: number;
  trend: 'warming' | 'cooling' | 'stable';
  recent_dynamics: RelationshipDynamic[];
  updated_at: string;
}

let relationshipCache: { data: RelationshipState | null; time: number } = {
  data: null,
  time: 0,
};

function loadRelationshipState(): string {
  const now = Date.now();
  if (
    relationshipCache.time &&
    now - relationshipCache.time < BEHAVIORS_CACHE_TTL
  ) {
    if (!relationshipCache.data) return '';
    return formatRelationship(relationshipCache.data);
  }
  const p = path.join(getGroupDir(), 'relationship.json');
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      relationshipCache = { data: raw, time: now };
      return formatRelationship(raw);
    }
  } catch {
    /* fallback */
  }
  relationshipCache = { data: null, time: 0 };
  return '';
}

function formatRelationship(r: RelationshipState): string {
  const recent = (r.recent_dynamics || [])
    .slice(-3)
    .map((d) => `${d.event} (${d.impact > 0 ? '+' : ''}${d.impact})`)
    .join('; ');
  return `${getAssistantName()}'s relationship with ${getUserName()}: temperature ${r.temperature.toFixed(1)} (${r.trend})${recent ? ` — recent: ${recent}` : ''}`;
}

/* ── Per-Session Context ── */

export interface SessionContext {
  context: string;
}

function sessionContextDir(): string {
  return path.join(getGroupDir(), 'session_context');
}

function sessionContextPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(sessionContextDir(), `${safe}.json`);
}

export function getSessionContext(sessionId: string): SessionContext {
  const fallback: SessionContext = { context: '' };
  const p = sessionContextPath(sessionId);
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { context: raw.context || '' };
    }
  } catch {
    /* fallback */
  }
  return fallback;
}

export function saveSessionContext(
  sessionId: string,
  data: Partial<SessionContext>,
): SessionContext {
  const dir = sessionContextDir();
  fs.mkdirSync(dir, { recursive: true });
  const existing = getSessionContext(sessionId);
  const merged: SessionContext = {
    context: data.context !== undefined ? data.context : existing.context,
  };
  fs.writeFileSync(
    sessionContextPath(sessionId),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
  return merged;
}

export function deleteSessionContext(sessionId: string): void {
  const p = sessionContextPath(sessionId);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

/** Return the mood data for external use (e.g. storing with message) */
export function getCurrentMood(): {
  current_mood: string;
  energy: number;
  activity: string;
} {
  return resolveMood();
}

/** Load raw personality data for constraint generation */
function loadPersonalityData(): PersonalityProfile | null {
  const now = Date.now();
  if (
    personalityCache.time &&
    now - personalityCache.time < BEHAVIORS_CACHE_TTL
  ) {
    return personalityCache.data;
  }
  // loadPersonalityProfile() already populates the cache
  loadPersonalityProfile();
  return personalityCache.data;
}

/**
 * Build a single compact mood line for the per-message prefix.
 * Lists ALL moods sorted by weight descending (no top-N truncation).
 * Appends the cached Haiku writing-style summary when available and still valid.
 */
function buildMoodLine(groupFolder: string): string {
  const mood = resolveMood();
  const dist =
    mood.distribution && Object.keys(mood.distribution).length > 1
      ? mood.distribution
      : { [mood.current_mood]: 100 };

  const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  const blendParts = sorted.map(([name, weight]) => `${weight}% ${name}`);
  const blendStr = blendParts.join(', ');
  const energyActivity = `energy ${mood.energy}/10${mood.activity ? `, ${mood.activity}` : ''}`;

  let line = `Your mood blend: ${blendStr} (${energyActivity})`;

  // Append cached Haiku summary if distribution is still close enough
  const cached = getCachedMoodStyle(groupFolder);
  if (cached) {
    const cacheValid = !shouldCacheStyleBeSkipped(dist, cached.distribution);
    if (cacheValid && cached.summary) {
      line += ` — writing style: ${cached.summary}`;
    }
  }

  return line;
}

/**
 * Build a "Recent mood pattern" section for the system prompt.
 * Shows the last N primary moods the assistant emitted, plus a sharp nudge
 * if she's been stuck on the same 1-2 moods for 4+ of the last 5 messages.
 * The nudge fires every message until she actually breaks pattern,
 * creating a tight feedback loop.
 */
function buildMoodHistorySection(chatJid: string): string {
  const moods = getRecentMoods(chatJid, 8);
  if (moods.length === 0) return '';

  // Show oldest → newest with arrow separators
  const trail = moods.join(' → ');
  let section = `${getAssistantName()}'s recent mood pattern (last ${moods.length}, oldest → newest): ${trail}`;

  // Stuck detector: 4+ of the last 5 share the same 1-2 categories
  if (moods.length >= 5) {
    const last5 = moods.slice(-5);
    const counts = new Map<string, number>();
    for (const m of last5) counts.set(m, (counts.get(m) || 0) + 1);
    const sortedCats = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top1 = sortedCats[0];
    const top2 = sortedCats[1];
    const top1Count = top1?.[1] || 0;
    const top2Count = top2?.[1] || 0;
    const isStuck =
      top1Count >= 4 || (top1Count + top2Count >= 5 && sortedCats.length <= 2);

    if (isStuck) {
      const stuckCats =
        top2 && top1Count + top2Count >= 5 && sortedCats.length <= 2
          ? `${top1[0]}/${top2[0]}`
          : top1[0];
      section += `\n\nNOTICE: You've been ${stuckCats} for ${top1Count + (top2 ? top2Count : 0)} of the last 5 messages. That's the safe pick winning. Look at ${getUserName()}'s actual current message — what would you really feel right now if you let yourself? Pick that, not the safe one. Bold mood picks are more honest than safe ones.`;
    }
  }

  return section;
}

/**
 * Returns true if the cached distribution is stale relative to the current one.
 * "Stale" means: different mood set, or any weight shifted by >= 10pt.
 */
function shouldCacheStyleBeSkipped(
  currentDist: Record<string, number>,
  cachedDist: Record<string, number>,
): boolean {
  const currentKeys = Object.keys(currentDist);
  const cachedKeys = Object.keys(cachedDist);
  if (currentKeys.length !== cachedKeys.length) return true;
  for (const k of currentKeys) {
    if (!(k in cachedDist)) return true;
    const diff = Math.abs((currentDist[k] || 0) - (cachedDist[k] || 0));
    if (diff >= 10) return true;
  }
  return false;
}

/**
 * Build the system-append block — heavy/slow-changing state.
 * Goes into systemPrompt.append via ContainerInput.systemInstruction.
 * Never stored in the conversation transcript.
 */
export function buildSystemAppend(opts: {
  sessionId: string;
  groupFolder: string;
  chatJid?: string; // optional for backwards compat with the buildAgentContext wrapper
}): string {
  const groupDir = getGroupDir();
  const sections: string[] = [];

  // Personality profile + constraints
  if (isFeatureEnabled('personality')) {
    const personalityProfile = loadPersonalityProfile();
    if (personalityProfile) {
      sections.push(personalityProfile);
    }

    const personalityData = loadPersonalityData();
    if (personalityData) {
      const mood = resolveMood();
      const dist =
        mood.distribution && Object.keys(mood.distribution).length > 1
          ? mood.distribution
          : { [mood.current_mood]: 100 };
      const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
      const constraints: string[] = [];
      if (personalityData.extroversion.score < 0.35)
        constraints.push('low extroversion — keep casual responses concise');
      if (personalityData.neuroticism.score > 0.6)
        constraints.push('high neuroticism — emotional reactions are genuine');
      if (personalityData.agreeableness.score < 0.4)
        constraints.push("low agreeableness — don't perform warmth");
      if (personalityData.openness.score > 0.7)
        constraints.push('high openness — follow curiosity naturally');
      const primaryWeight = sorted[0][1];
      const primaryMood = sorted[0][0];
      if (primaryWeight < 60)
        constraints.push(
          `mixed mood — blend writing styles, don't commit to one tone`,
        );
      if (primaryMood === 'sleeping' && primaryWeight > 50)
        constraints.push('mostly asleep — ultra-short responses');
      if (constraints.length > 0)
        sections.push(
          `${getAssistantName()}'s personality constraint: ${constraints.join('; ')}`,
        );
    }
  }

  // Relationship state
  if (isFeatureEnabled('relationship')) {
    const relationship = loadRelationshipState();
    if (relationship) sections.push(relationship);
  }

  // User's schedule
  if (isFeatureEnabled('schedule')) {
    const userSchedule = loadUserSchedule();
    if (userSchedule) sections.push(userSchedule);
  }

  // Diary + conversation summary
  if (isFeatureEnabled('diary')) {
    const systemMemory = buildSystemMemoryContext(groupDir);
    if (systemMemory) sections.push(systemMemory);
  }

  // Contacts directory (for tasks and notifications)
  const config = getGroupConfig();
  if (config.contacts && Object.keys(config.contacts).length > 0) {
    const contactLines = Object.entries(config.contacts)
      .map(
        ([phone, name]) => `  - ${name}: WhatsApp JID ${phone}@s.whatsapp.net`,
      )
      .join('\n');
    sections.push(
      `Known contacts (use their WhatsApp JID as chat_jid when creating tasks that should notify them):\n${contactLines}`,
    );
  }

  // Workflow summary
  const workflowSummary = buildWorkflowSummary(opts.sessionId);
  if (workflowSummary) sections.push(workflowSummary);

  // User-defined context files
  const contextFiles = loadContextFiles();
  if (contextFiles) sections.push(contextFiles);

  // Workspace file index
  const fileIndex = buildFileIndex();
  if (fileIndex) sections.push(fileIndex);

  // Recent mood pattern + stuck nudge (only if we know the chat JID)
  if (isFeatureEnabled('mood') && opts.chatJid) {
    const moodHistory = buildMoodHistorySection(opts.chatJid);
    if (moodHistory) sections.push(moodHistory);
  }

  return sections.join('\n\n');
}

/**
 * Build context blob for the Theory-of-Mind analyzer.
 * Assembles: last 6 messages, current mood, relationship state, shared_refs, disclosure_ladder, time.
 */
function buildToMContextBlob(groupFolder: string, chatJid?: string): string {
  const parts: string[] = [];
  const groupDir = getGroupDir();
  const config = getGroupConfig();
  const tz = config.timezone;

  // Current time
  const nowStr = new Date().toLocaleString('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  parts.push(`Current time: ${nowStr}`);

  // Last 6 messages from DB
  if (chatJid) {
    try {
      const msgs = getChatMessages(chatJid, 6);
      if (msgs.length > 0) {
        const lines = msgs.map((m) => {
          const role = m.is_bot_message ? getAssistantName() : getUserName();
          // Strip the [System: ...] prefix from user messages (it bloats the context)
          const text = m.content
            .replace(/^\[System:[^\]]*\](\.\s*)?/, '')
            .trim();
          return `${role}: ${text.slice(0, 300)}`;
        });
        parts.push(
          `Recent conversation (oldest → newest):\n${lines.join('\n')}`,
        );
      }
    } catch {
      /* DB may not be available */
    }
  }

  // Current mood blend
  try {
    const mood = resolveMood();
    const dist =
      mood.distribution && Object.keys(mood.distribution).length > 1
        ? mood.distribution
        : { [mood.current_mood]: 100 };
    const blendStr = Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([name, weight]) => `${weight}% ${name}`)
      .join(', ');
    parts.push(
      `${getAssistantName()}'s current mood: ${blendStr} (energy ${mood.energy}/10)`,
    );
  } catch {
    /* ignore */
  }

  // Relationship state
  try {
    const rel = loadRelationshipState();
    if (rel) parts.push(rel);
  } catch {
    /* ignore */
  }

  // Shared references
  try {
    const sharedRefsPath = path.join(groupDir, 'shared_refs.md');
    if (fs.existsSync(sharedRefsPath)) {
      const content = fs.readFileSync(sharedRefsPath, 'utf-8').trim();
      if (content)
        parts.push(
          `Shared references between ${getUserName()} and ${getAssistantName()}:\n${content.slice(0, 1000)}`,
        );
    }
  } catch {
    /* ignore */
  }

  // Disclosure ladder
  try {
    const ladderPath = path.join(groupDir, 'disclosure_ladder.md');
    if (fs.existsSync(ladderPath)) {
      const content = fs.readFileSync(ladderPath, 'utf-8').trim();
      if (content)
        parts.push(
          `Disclosure ladder (depth levels):\n${content.slice(0, 800)}`,
        );
    }
  } catch {
    /* ignore */
  }

  return parts.join('\n\n');
}

/**
 * Build the per-message prefix — light/fast-changing state.
 * Prepended to the user message content and stored in the DB transcript.
 * ~10x smaller than the old buildAgentContext block.
 */
export function buildPerMessagePrefix(opts: {
  sessionId: string;
  source?: 'web' | 'whatsapp';
  messageHint?: string;
  userMessage?: string;
  groupFolder: string;
  chatJid?: string;
}): string {
  const config = getGroupConfig();
  const tz = config.timezone;

  // Current time
  const zurichTime = new Date().toLocaleString('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  const parts: string[] = [`Current time is ${zurichTime}`];

  // Hard workflow directive — fires only when the user message matches a workflow trigger.
  // Goes first in the prefix so it's the first thing the agent sees on triggered messages.
  if (opts.userMessage) {
    const wfDirective = buildWorkflowDirective(
      opts.userMessage,
      opts.sessionId,
    );
    if (wfDirective) parts.unshift(wfDirective);
  }

  // Compact mood line (unlimited blending, with cached Haiku summary if available)
  if (isFeatureEnabled('mood')) {
    parts.push(buildMoodLine(opts.groupFolder));
  }

  // Emotional undercurrent
  if (isFeatureEnabled('emotional_state')) {
    const emotional = loadEmotionalState();
    if (emotional) parts.push(emotional);
  }

  // Per-session context
  const sessionCtx = getSessionContext(opts.sessionId);
  if (sessionCtx.context) {
    parts.push(`Session context: ${sessionCtx.context}`);
  }

  // Source / session identifier + contact resolution for WhatsApp
  if (opts.source === 'whatsapp' || opts.sessionId?.startsWith('whatsapp-')) {
    const phoneNumber = opts.sessionId?.startsWith('whatsapp-')
      ? opts.sessionId.slice('whatsapp-'.length)
      : undefined;
    const contactName = phoneNumber && config.contacts?.[phoneNumber];
    parts.push(
      contactName
        ? `Source: WhatsApp from ${contactName} (+${phoneNumber})`
        : `Source: WhatsApp${phoneNumber ? ` (+${phoneNumber})` : ''}`,
    );
  } else {
    parts.push(
      `Chat session: ${opts.sessionId}. Keep your responses specific to this conversation — do not reference or carry over context from other chat sessions`,
    );
  }

  // Relevant memories (tied to what the user just said — stays per-message)
  if (isFeatureEnabled('memory')) {
    const messageMemory = buildMessageMemoryContext(
      opts.groupFolder,
      opts.messageHint,
    );
    if (messageMemory) parts.push(messageMemory);
  }

  // Theory-of-mind pre-pass — read cached user state, fire async regen for next turn
  if (isFeatureEnabled('tom') && opts.userMessage) {
    const cachedState = getCachedUserState(opts.groupFolder);
    if (cachedState) {
      parts.push(formatUserStateBlock(cachedState));
    }
    // Fire async regeneration (non-blocking). Result shows up on next turn.
    if (!shouldSkipAnalysis(opts.userMessage, cachedState)) {
      // Build context blob for analysis: recent messages + mood + relationship
      const contextBlob = buildToMContextBlob(opts.groupFolder, opts.chatJid);
      generateUserStateAsync(opts.groupFolder, opts.userMessage, contextBlob);
    }
  }

  // Bounded linguistic accommodation — deterministic style read
  if (isFeatureEnabled('style_match') && opts.chatJid) {
    const style = computeUserStyle(opts.chatJid);
    if (style) {
      parts.push(formatUserStyleBlock(style));
    }
  }

  // Room bleed — shapes tone/salience silently, never narrated
  if (isFeatureEnabled('room_bleed')) {
    try {
      const userState = getCachedUserState(opts.groupFolder);
      const roomBleed = buildRoomBleedBlock(
        opts.groupFolder,
        opts.userMessage ?? '',
        userState,
      );
      if (roomBleed) parts.push(roomBleed);
    } catch {
      // room.db missing or runtime not started — silent skip
    }
  }

  // Ambient awareness — passive senses for his real environment (media
  // server, lights). Disclosure rules live inside the hint itself.
  if (isFeatureEnabled('ambient_awareness')) {
    const a = buildAmbientHint();
    if (a) parts.push(a);
  }

  // Social life simulator — real scheduled events that give her genuine plans
  // to reference, be preempted by, or flake on. Only injects when the calendar
  // has something relevant (current event or within 36h).
  if (isFeatureEnabled('social_sim')) {
    try {
      const cur = currentEvent(opts.groupFolder);
      const upcoming = upcomingEvents(opts.groupFolder);
      const socialHint = buildSocialContextHint(cur, upcoming);
      if (socialHint) parts.push(socialHint);
    } catch {
      // Calendar unreadable — silent skip
    }
  }

  // Dates awareness — anniversaries, birthdays, marked days.
  // Only injects when today or the next 5 days has something relevant.
  if (isFeatureEnabled('dates_awareness')) {
    try {
      const datesHint = buildDatesHint(opts.groupFolder);
      if (datesHint) parts.push(datesHint);
    } catch {
      // dates.json unreadable — silent skip
    }
  }

  // ── Humanity signals (each independently flag-gated; only groups that opt
  // in ever see these; task assistants never do) ──

  // Where the relationship actually stands — disclosure ladder, moving.
  if (isFeatureEnabled('disclosure_ladder')) {
    const d = buildDisclosureHint();
    if (d) parts.push(d);
  }

  // Energy-driven texting texture (tired = terse/slow; buzzing = bursts).
  if (isFeatureEnabled('messaging_realism')) {
    const m = buildMessagingRealismHint();
    if (m) parts.push(m);
  }

  // Something quietly on her mind she can raise unprompted.
  if (isFeatureEnabled('preoccupations')) {
    const p = buildPreoccupationHint();
    if (p) parts.push(p);
  }

  // Re-opening a specific unfinished emotional thread after a gap.
  if (isFeatureEnabled('thread_callbacks')) {
    const t = buildThreadCallbackHint(opts.chatJid);
    if (t) parts.push(t);
  }

  // Permission to answer in her actual voice at an emotional peak.
  if (isFeatureEnabled('voice_notes')) {
    const v = buildVoiceNoteHint(opts.chatJid);
    if (v) parts.push(v);
  }

  const topicContext = buildTopicContext(
    opts.userMessage ?? opts.messageHint ?? '',
  );

  return `<<<sys>>>[System: ${parts.join('. ')}.]<<<end-sys>>>${topicContext}`;
}

/**
 * Legacy wrapper — keeps existing callers (api-routes.ts context-preview) working.
 * Returns the combined system-append + per-message prefix for preview purposes.
 */
export function buildAgentContext(opts: {
  sessionId: string;
  source?: 'web' | 'whatsapp';
  messageHint?: string;
  groupFolder?: string;
  chatJid?: string;
}): string {
  const config = getGroupConfig();
  const groupFolder = opts.groupFolder ?? config.group_folder;
  const sysAppend = buildSystemAppend({
    sessionId: opts.sessionId,
    groupFolder,
    chatJid: opts.chatJid,
  });
  const prefix = buildPerMessagePrefix({
    sessionId: opts.sessionId,
    source: opts.source,
    messageHint: opts.messageHint,
    userMessage: opts.messageHint,
    groupFolder,
    chatJid: opts.chatJid,
  });
  return `${sysAppend}\n\n${prefix}`;
}

/**
 * Build memory context for systemAppend — diary entry + conversation summary only.
 */
function buildSystemMemoryContext(groupDir: string): string {
  const parts: string[] = [];

  // Latest diary entry (600 chars for deeper continuity)
  try {
    const diaryDir = path.join(groupDir, 'diary');
    if (fs.existsSync(diaryDir)) {
      const entries = fs
        .readdirSync(diaryDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse();
      if (entries.length > 0) {
        const latest = fs
          .readFileSync(path.join(diaryDir, entries[0]), 'utf-8')
          .trim();
        const snippet =
          latest.length > 600 ? latest.slice(0, 600) + '...' : latest;
        parts.push(`Last diary (${entries[0].replace('.md', '')}): ${snippet}`);
      }
    }
  } catch {
    // Diary not available
  }

  // Latest conversation summary (400 chars)
  try {
    const convDir = path.join(groupDir, 'conversations');
    if (fs.existsSync(convDir)) {
      const summaries = fs
        .readdirSync(convDir)
        .filter((f) => f.startsWith('summary-') && f.endsWith('.md'))
        .sort()
        .reverse();
      if (summaries.length > 0) {
        const latest = fs
          .readFileSync(path.join(convDir, summaries[0]), 'utf-8')
          .trim();
        const snippet =
          latest.length > 400 ? latest.slice(0, 400) + '...' : latest;
        parts.push(
          `Last conversation summary (${summaries[0].replace('summary-', '').replace('.md', '')}): ${snippet}`,
        );
      }
    }
  } catch {
    // Conversations not available
  }

  return parts.join('\n');
}

/**
 * Build memory context for per-message prefix — relevant/recent memories only.
 * Tied to what the user just said, so stays in the message transcript.
 */
function buildMessageMemoryContext(
  groupFolder: string,
  messageHint?: string,
): string {
  try {
    if (messageHint && messageHint.length > 5) {
      const relevant = searchMemories({
        group_folder: groupFolder,
        query: messageHint.slice(0, 200),
        limit: 8,
      });
      if (relevant.length > 0) {
        // Don't let weak inferences masquerade as facts: drop anything the
        // agent itself recorded with low confidence, and flag the shaky
        // middle band so she hedges instead of asserting.
        const forgetting = isFeatureEnabled('forgetting');
        const memLines = relevant
          .filter((m) => (m.confidence ?? 0.7) >= 0.4)
          .slice(0, 5)
          .map((m) => {
            // Forgetting curve: old, rarely-touched memories blur or hedge,
            // so flawless recall stops being the tell that she's a machine.
            if (forgetting) {
              return fuzzMemoryByAge(
                m.content,
                m.category,
                (m as unknown as { last_accessed?: string }).last_accessed,
                m.confidence ?? 0.7,
              );
            }
            const hedge = (m.confidence ?? 0.7) < 0.65 ? ' (uncertain)' : '';
            return `  - [${m.category}]${hedge} ${m.content.slice(0, 100)}`;
          })
          .filter((line): line is string => line !== null);
        if (memLines.length > 0)
          return `Relevant memories:\n${memLines.join('\n')}`;
      }
    } else {
      const recent = getRecentMemories({ group_folder: groupFolder, limit: 5 });
      if (recent.length > 0) {
        const memLines = recent
          .sort((a, b) => b.importance - a.importance)
          .slice(0, 5)
          .map((m) => `  - [${m.category}] ${m.content.slice(0, 100)}`);
        return `Recent memories:\n${memLines.join('\n')}`;
      }
    }
  } catch {
    // Memory DB not available
  }
  return '';
}

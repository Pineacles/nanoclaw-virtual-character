/**
 * Atmosphere snapshot — current room mood reading.
 * Phase A: simple read from mood.json + emotional_state.json + schedule_context.json.
 * Phase B will add viscosity, congestion, cluster density, ghost count.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { AtmosphereSnapshot, AtmosphereShape } from './types.js';

interface MoodJson {
  primary?: string;
  blend?: Record<string, number>;
  energy?: number;
}

interface EmotionalStateJson {
  mood?: string;
  energy?: number;
  underlying?: string;
  trigger?: string;
}

interface ScheduleContextJson {
  current_phase?: string;
  phase?: string;
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Heuristically derive shape from mood blend + undercurrent */
function deriveShape(
  mood: string | undefined,
  undercurrent: string | null,
  moodBlend: Record<string, number>,
): AtmosphereShape {
  const dominantMood = mood || Object.keys(moodBlend)[0] || '';
  const under = (undercurrent || '').toLowerCase();

  // Mapping dominant states to shapes
  const shapeMap: Record<string, AtmosphereShape> = {
    anxious: 'restless',
    restless: 'restless',
    overwhelmed: 'unstable',
    focused: 'sharp',
    determined: 'sharp',
    melancholy: 'heavy',
    lonely: 'heavy',
    sad: 'heavy',
    chill: 'diffuse',
    content: 'diffuse',
    tired: 'thin',
    sleeping: 'thin',
    playful: 'circling',
    giddy: 'circling',
    confused: 'fractal',
    uncertain: 'fractal',
    bored: 'airless',
  };

  if (dominantMood in shapeMap) return shapeMap[dominantMood];

  // Fallback from undercurrent keywords
  if (under.includes('unresolved') || under.includes('unsettled'))
    return 'quietly_dense';
  if (under.includes('loop') || under.includes('circling')) return 'circling';
  if (under.includes('flat') || under.includes('empty')) return 'airless';

  return 'diffuse';
}

export function captureAtmosphere(groupFolder: string): AtmosphereSnapshot {
  const groupDir = path.join(GROUPS_DIR, groupFolder);

  const mood = readJsonSafe<MoodJson>(path.join(groupDir, 'mood.json'));
  const emotionalState = readJsonSafe<EmotionalStateJson>(
    path.join(groupDir, 'emotional_state.json'),
  );
  const scheduleCtx = readJsonSafe<ScheduleContextJson>(
    path.join(groupDir, 'schedule_context.json'),
  );

  const moodBlend: Record<string, number> = mood?.blend || {};
  if (Object.keys(moodBlend).length === 0 && mood?.primary) {
    moodBlend[mood.primary] = 100;
  }

  const energy = emotionalState?.energy ?? mood?.energy ?? 5;
  const emotionalUndercurrent =
    emotionalState?.underlying ?? emotionalState?.trigger ?? null;
  const schedulePhase =
    scheduleCtx?.current_phase ?? scheduleCtx?.phase ?? null;

  const primaryMood = mood?.primary ?? Object.keys(moodBlend)[0];
  const shape = deriveShape(primaryMood, emotionalUndercurrent, moodBlend);

  const snap: AtmosphereSnapshot = {
    id: `atm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    when: new Date().toISOString(),
    mood_blend: moodBlend,
    energy,
    emotional_undercurrent: emotionalUndercurrent,
    schedule_phase: schedulePhase,
    shape,
  };

  logger.debug({ groupFolder, shape, energy }, 'Atmosphere snapshot captured');
  return snap;
}

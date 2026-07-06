/**
 * Thick atmosphere compute — replaces simple atmosphere.ts for Phase B+.
 * Composes on top of atmosphere.ts (calls captureAtmosphere for base fields).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AtmosphereSnapshot,
  AtmosphereShape,
  PressureState,
} from './types.js';
import { getRoomDb, insertTrace } from './store.js';
import { captureAtmosphere } from './atmosphere.js';
import { logger } from '../logger.js';
import { ROOM_TUNING } from './tuning.js';
import { GROUPS_DIR } from '../config.js';

export interface ThickAtmosphere extends AtmosphereSnapshot {
  recent_residue: AtmosphereShape | null;
  zone_congestion: Record<string, number>;
  unresolved_pressure_total: number;
  cluster_density: number;
  ghost_count: number;
  viscosity: number;
  congestion: boolean;
}

type Zone =
  | 'desk'
  | 'notebook'
  | 'shelf'
  | 'queue'
  | 'mirror'
  | 'archive'
  | 'attic';
const ALL_ZONES: Zone[] = [
  'desk',
  'notebook',
  'shelf',
  'queue',
  'mirror',
  'archive',
  'attic',
];

function getRecentResidue(groupFolder: string): AtmosphereShape | null {
  const db = getRoomDb(groupFolder);
  const rows = db
    .prepare(
      `
    SELECT shape FROM atmosphere_snapshots ORDER BY when_recorded DESC LIMIT 20
  `,
    )
    .all() as Array<{ shape: string }>;

  if (rows.length === 0) return null;
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.shape] = (counts[r.shape] ?? 0) + 1;
  }
  const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return winner ? (winner[0] as AtmosphereShape) : null;
}

function getZoneCongestion(groupFolder: string): Record<string, number> {
  const db = getRoomDb(groupFolder);
  const congestion: Record<string, number> = {};
  for (const zone of ALL_ZONES) {
    const row = db
      .prepare(
        `SELECT COUNT(*) as n FROM objects WHERE zone = ? AND status != 'archived'`,
      )
      .get(zone) as { n: number };
    congestion[zone] = row.n;
  }
  return congestion;
}

function sumPressures(p: PressureState): number {
  return (
    p.revisitPressure +
    p.relinkPressure +
    p.renamePressure +
    p.draftPressure +
    p.archivePressure +
    p.clarifyPressure +
    p.mirrorPressure +
    p.residuePressure +
    p.shelfPressure +
    p.unfinishedPressure +
    p.namelessness_pressure
  );
}

const MOOD_SHAPE_MAP: Record<string, AtmosphereShape> = {
  sleeping: 'heavy',
  tired: 'diffuse',
  chill: 'thin',
  focused: 'sharp',
  playful: 'sharp',
  soft: 'diffuse',
  annoyed: 'restless',
  excited: 'sharp',
  crying: 'heavy',
  restless: 'restless',
  nostalgic: 'circling',
  content: 'thin',
  proud: 'sharp',
  anxious: 'unstable',
  bored: 'airless',
  lonely: 'heavy',
  relieved: 'thin',
  grateful: 'diffuse',
  melancholy: 'heavy',
  giddy: 'sharp',
  tender: 'diffuse',
  irritated: 'restless',
  overwhelmed: 'fractal',
  determined: 'sharp',
  amused: 'sharp',
  wistful: 'circling',
  happy: 'thin',
  in_love: 'diffuse',
};

function getMoodBlend(groupFolder: string): Record<string, number> {
  try {
    const p = path.join(GROUPS_DIR, groupFolder, 'context', 'mood.json');
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      blend?: Record<string, number>;
    };
    return raw.blend ?? {};
  } catch {
    return {};
  }
}

const ALL_SHAPES: AtmosphereShape[] = [
  'thin',
  'diffuse',
  'sharp',
  'heavy',
  'quietly_dense',
  'airless',
  'restless',
  'unstable',
  'circling',
  'fractal',
];

function deriveThickShape(
  baseShape: AtmosphereShape,
  residue: AtmosphereShape | null,
  viscosity: number,
  congestion: boolean,
  ghostCount: number,
  unresolvedTotal: number,
  moodBlend: Record<string, number>,
): AtmosphereShape {
  const HIGH_PRESSURE = 7.0;
  const MED_PRESSURE = 4.0;

  const scores: Record<string, number> = {};
  for (const s of ALL_SHAPES) scores[s] = 0;

  // 1. Congestion weight (diminished vs old hard-return)
  if (congestion && viscosity > 0.6) scores['quietly_dense'] += 0.6;
  else if (congestion && viscosity < 0.3) scores['thin'] += 0.5;
  else if (congestion) scores['airless'] += 0.4;

  // 2. Viscosity weight
  if (viscosity > 0.7) scores['heavy'] += 0.5;
  if (viscosity < 0.2) scores['thin'] += 0.4;

  // 3. Ghost count
  if (ghostCount > 5) scores['circling'] += 0.5;

  // 4. Unresolved pressure
  if (unresolvedTotal > HIGH_PRESSURE) scores['restless'] += 0.5;
  if (unresolvedTotal > MED_PRESSURE) scores['unstable'] += 0.3;

  // 5. Mood blend shape mapping (top-2 moods, weighted)
  const moodEntries = Object.entries(moodBlend)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  for (const [mood, weight] of moodEntries) {
    const moodShape = MOOD_SHAPE_MAP[mood];
    if (moodShape) {
      scores[moodShape] += (weight / 100) * 0.6;
    }
  }

  // 6. Recent residue (mode of last 20 snapshots) — weighted at 0.25
  if (residue) {
    scores[residue] = (scores[residue] ?? 0) + 0.25;
  }

  // 7. Base shape from atmosphere.ts as a gentle prior
  scores[baseShape] = (scores[baseShape] ?? 0) + 0.1;

  // Pick winner; tie-break to 'diffuse'
  let winner: AtmosphereShape = 'diffuse';
  let best = -1;
  for (const [shape, score] of Object.entries(scores)) {
    if (score > best) {
      best = score;
      winner = shape as AtmosphereShape;
    }
  }

  // Debug: top-3 contributors
  const top3 = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s, v]) => `${s}=${v.toFixed(2)}`)
    .join(', ');
  logger.debug(
    { winner, top3, congestion, viscosity: viscosity.toFixed(2), ghostCount },
    'deriveThickShape scores',
  );

  return winner;
}

export function computeThickAtmosphere(
  groupFolder: string,
  pulseId: string,
  pressure: PressureState,
  totalObjects: number,
  clusterCount: number,
  ghostCount: number,
): ThickAtmosphere {
  // Base fields from existing atmosphere.ts
  const base = captureAtmosphere(groupFolder);

  const recentResidue = getRecentResidue(groupFolder);
  const zoneCongestion = getZoneCongestion(groupFolder);
  const unresolvedPressureTotal = sumPressures(pressure);
  const clusterDensity = totalObjects > 0 ? clusterCount / totalObjects : 0;

  // Viscosity: rises with pressure, density, ghosts
  const viscosity = Math.min(
    1,
    (unresolvedPressureTotal / 11) * 0.4 +
      clusterDensity * 0.3 +
      Math.min(ghostCount / 10, 1) * 0.3,
  );

  const congestion =
    totalObjects > ROOM_TUNING.CONGESTION_OBJECT_THRESHOLD ||
    clusterDensity > 0.4 ||
    viscosity > ROOM_TUNING.CONGESTION_VISCOSITY_THRESHOLD;

  const moodBlend = getMoodBlend(groupFolder);

  const shape = deriveThickShape(
    base.shape,
    recentResidue,
    viscosity,
    congestion,
    ghostCount,
    unresolvedPressureTotal,
    moodBlend,
  );

  const thick: ThickAtmosphere = {
    ...base,
    id: `atm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    shape,
    recent_residue: recentResidue,
    zone_congestion: zoneCongestion,
    unresolved_pressure_total: unresolvedPressureTotal,
    cluster_density: clusterDensity,
    ghost_count: ghostCount,
    viscosity,
    congestion,
  };

  logger.debug(
    {
      groupFolder,
      shape,
      viscosity: viscosity.toFixed(2),
      congestion,
      ghostCount,
    },
    'Thick atmosphere computed',
  );

  return thick;
}

export function writeThickAtmosphere(
  groupFolder: string,
  pulseId: string,
  thick: ThickAtmosphere,
): void {
  const db = getRoomDb(groupFolder);

  // Insert with weather JSON
  db.prepare(
    `
    INSERT INTO atmosphere_snapshots (id, when_recorded, mood_blend, energy, emotional_undercurrent, schedule_phase, shape, weather)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    thick.id,
    thick.when,
    JSON.stringify(thick.mood_blend),
    thick.energy,
    thick.emotional_undercurrent,
    thick.schedule_phase,
    thick.shape,
    JSON.stringify({
      recent_residue: thick.recent_residue,
      zone_congestion: thick.zone_congestion,
      unresolved_pressure_total: thick.unresolved_pressure_total,
      cluster_density: thick.cluster_density,
      ghost_count: thick.ghost_count,
      viscosity: thick.viscosity,
      congestion: thick.congestion,
    }),
  );
}

export function checkCongestion(
  groupFolder: string,
  pulseId: string,
  thick: ThickAtmosphere,
  state: { nearMissMultiplier: number; contaminationMultiplier: number },
): void {
  if (!thick.congestion) return;

  insertTrace(
    groupFolder,
    pulseId,
    'congestion',
    [],
    `viscosity=${thick.viscosity.toFixed(2)} objects=${thick.unresolved_pressure_total.toFixed(2)} density=${thick.cluster_density.toFixed(2)}`,
  );

  // Modify state for next pulse
  state.nearMissMultiplier = 2.0;
  state.contaminationMultiplier = 2.0;

  logger.debug(
    { groupFolder },
    'Congestion detected — near-miss and contamination multipliers set for next pulse',
  );
}

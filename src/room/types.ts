/**
 * Room Runtime — full schema (all phases).
 * Phase A populates core dynamics + pressure channels.
 * Phase B/C/D fields are stubs present for forward compat.
 */

export type Zone =
  | 'desk'
  | 'notebook'
  | 'shelf'
  | 'queue'
  | 'mirror'
  | 'archive'
  | 'attic';
export type BleedClass =
  | 'sealed'
  | 'ambient'
  | 'referencable'
  | 'speakable'
  | 'shared'
  | 'absence';
export type ObjectStatus =
  | 'active'
  | 'cooling'
  | 'dormant'
  | 'revived'
  | 'abandoned'
  | 'archived';
export type AtmosphereShape =
  | 'circling'
  | 'sharp'
  | 'diffuse'
  | 'airless'
  | 'restless'
  | 'quietly_dense'
  | 'unstable'
  | 'heavy'
  | 'thin'
  | 'fractal';

export interface TitleChange {
  title: string;
  valid_from: string;
  valid_to: string | null; // null = current
  renamed_reason: string;
}

export interface AtmosphereStain {
  atmosphere_id: string;
  strength: number; // 0..1
  when: string;
  shape: AtmosphereShape;
}

export interface NearMissCounts {
  almost_drafted: number;
  almost_revived: number;
  touched_then_left: number;
  weak_relinks_loosened: number;
  heat_lifted_then_dropped: number;
  wording_disturbed: number;
  title_almost_changed: number;
}

export interface FailedForm {
  type: 'rename' | 'draft' | 'link' | 'merge';
  shape: string; // the almost-shape (title/target/etc.)
  when: string;
  strength: number;
}

export interface FractureSeam {
  original_ids: string[];
  reunion_strength: number;
  merged_at: string;
}

export interface RoomObject {
  id: string;
  type: string; // open_loop | pattern | private_label | draft_unsent | uncertainty | self_revision | ritual_entry | archived_fragment | atmosphere_snapshot | resonance_marker | link | persistent_trace | shadow
  zone: Zone;
  title: string;
  body: string;

  createdAt: string;
  updatedAt: string;

  status: ObjectStatus;

  // Core dynamics
  confidence: number;
  importance: number;
  heat: number;
  resonance: number;
  dormancy: number;
  persistence: number;
  weirdness: number;
  privateSignificance: number;

  // Bleed + references
  bleedClass: BleedClass;
  sourceRefs: string[];
  links: string[];

  // Phase A uncanny scaffolding
  stickiness: number; // 0..1, biased-wrong-sized at creation
  residual_warmth_floor: number; // 0..1, heat can't drop below
  title_history: TitleChange[];
  time_in_zone_started_at: string;
  time_total_alive_at: string;

  // Phase B/C fields (stubs, not populated yet — schema present for forward compat)
  atmosphere_stains: AtmosphereStain[];
  near_miss_counts: NearMissCounts;
  failed_forms: FailedForm[];
  fracture_seam: FractureSeam | null;
  observation_stain: number;
  deep_presence: boolean;
  shadow_of: string | null;
  anti_resolution: number;
  signature_asymmetry: boolean;
  latent_influence: number;
  unerasable: boolean;
  privately_kept: boolean;
  kept_reason: string | null;
  sitting_with_since: string | null;
  dwell_pulses: number;
  cluster_id: string | null;
  contamination_log: Array<{ from_id: string; when: string; kind: string }>;
  mood_affinity: Record<string, number>;
  schedule_affinity: Record<string, number>;
}

export interface PressureState {
  revisitPressure: number;
  relinkPressure: number;
  renamePressure: number;
  draftPressure: number;
  archivePressure: number;
  clarifyPressure: number;
  mirrorPressure: number;
  residuePressure: number;
  shelfPressure: number;
  unfinishedPressure: number;
  namelessness_pressure: number; // Phase B
}

export interface AtmosphereSnapshot {
  id: string;
  when: string;
  mood_blend: Record<string, number>;
  energy: number;
  emotional_undercurrent: string | null;
  schedule_phase: string | null;
  shape: AtmosphereShape;
  // Phase B: add viscosity, congestion, recent_residue, zone_congestion, unresolved_pressure_total, cluster_density, ghost_count
}

export interface RoomMeta {
  room_initialized_at: string | null;
  last_pulse_at: string | null;
  pulse_count: number;
  last_haiku_at: string | null;
  haiku_count_hour: number; // for Phase C budget tracking
}

export const DEFAULT_NEAR_MISS_COUNTS: NearMissCounts = {
  almost_drafted: 0,
  almost_revived: 0,
  touched_then_left: 0,
  weak_relinks_loosened: 0,
  heat_lifted_then_dropped: 0,
  wording_disturbed: 0,
  title_almost_changed: 0,
};

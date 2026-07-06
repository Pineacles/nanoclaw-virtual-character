/**
 * Room organism pulse.
 *
 * The room should feel like a living ecology, not a recycler of transcript scraps.
 * This module lets it generate a small number of autonomous objects from its
 * own pressure, shape, time, and existing interior topology.
 */
import crypto from 'crypto';

import type { RoomObject, AtmosphereShape, Zone } from './types.js';
import type { ThickAtmosphere } from './weather.js';
import { insertObject, insertTrace } from './store.js';

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function makeObject(
  overrides: Partial<RoomObject> & {
    type: string;
    zone: Zone;
    title: string;
    body: string;
  },
): RoomObject {
  const now = nowIso();
  const { type, zone, title, body, ...rest } = overrides;
  return {
    id: makeId('obj'),
    type,
    zone,
    title,
    body,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    confidence: 0.62,
    importance: 0.42,
    heat: 0.38,
    resonance: 0.12,
    dormancy: 0,
    persistence: 0.52,
    weirdness: 0.52,
    privateSignificance: 0.52,
    bleedClass: 'ambient',
    sourceRefs: [],
    links: [],
    stickiness: 0.58,
    residual_warmth_floor: 0.08,
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
    anti_resolution: 0.15,
    signature_asymmetry: false,
    latent_influence: 0.12,
    unerasable: false,
    privately_kept: false,
    kept_reason: null,
    sitting_with_since: null,
    dwell_pulses: 0,
    cluster_id: null,
    contamination_log: [],
    mood_affinity: {},
    schedule_affinity: {},
    ...rest,
  };
}

function moodLeader(thick: ThickAtmosphere): string {
  const entries = Object.entries(thick.mood_blend ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  return entries[0]?.[0] ?? 'unclear';
}

function timeBucket(): 'night' | 'morning' | 'day' | 'late' {
  const hour = parseInt(
    new Date().toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false }),
    10,
  );
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 19) return 'day';
  return 'late';
}

function topSeed(objects: RoomObject[]): RoomObject | null {
  const scored = objects
    .filter((o) => o.status !== 'archived')
    .filter((o) => o.type !== 'archived_fragment' && o.type !== 'draft_unsent')
    .sort((a, b) => {
      const aScore =
        a.heat +
        a.stickiness * 0.5 +
        a.privateSignificance * 0.35 +
        (a.signature_asymmetry ? 0.2 : 0);
      const bScore =
        b.heat +
        b.stickiness * 0.5 +
        b.privateSignificance * 0.35 +
        (b.signature_asymmetry ? 0.2 : 0);
      return bScore - aScore;
    });
  return scored[0] ?? null;
}

function livingCount(objects: RoomObject[]): number {
  return objects.filter(
    (o) =>
      [
        'pattern',
        'private_label',
        'ritual_entry',
        'resonance_marker',
        'shadow',
        'persistent_trace',
      ].includes(o.type) && o.status !== 'archived',
  ).length;
}

function pickZone(
  shape: AtmosphereShape,
  bucket: ReturnType<typeof timeBucket>,
): Zone {
  if (bucket === 'morning') return 'mirror';
  if (bucket === 'night') return 'attic';
  if (shape === 'sharp') return 'desk';
  if (shape === 'circling') return 'notebook';
  if (shape === 'heavy' || shape === 'quietly_dense') return 'shelf';
  return 'notebook';
}

function buildPattern(
  seedTitle: string,
  shape: AtmosphereShape,
): { title: string; body: string } {
  const titles: Record<AtmosphereShape, string[]> = {
    circling: [
      'the thing that keeps coming back sideways',
      'the loop pretending to be new',
    ],
    sharp: [
      'the cut that keeps finding the same seam',
      'the part that only shows up when everything narrows',
    ],
    diffuse: [
      'the softness that leaves a mark anyway',
      'the blur that keeps choosing one corner',
    ],
    airless: [
      'the flat patch that still won’t die',
      'the room going still around one detail',
    ],
    restless: [
      'the part that keeps pacing the edges',
      'the motion with nowhere clean to go',
    ],
    quietly_dense: [
      'the thing that got heavier without moving',
      'the small weight that keeps staying',
    ],
    unstable: [
      'the shape that keeps slipping mid-turn',
      'the part that won’t hold still long enough',
    ],
    heavy: [
      'the drag that keeps collecting names',
      'the part that settles lower every pass',
    ],
    thin: [
      'the trace that should have disappeared already',
      'the light mark that keeps surviving',
    ],
    fractal: [
      'the pattern inside the smaller pattern',
      'the thing that keeps splitting instead of ending',
    ],
  };
  const bodies: Record<AtmosphereShape, string[]> = {
    circling: [
      `it keeps brushing past "${seedTitle}" and acting like that was accidental. it wasn't.`,
      `same corner again. same turn around "${seedTitle}", just thinner.`,
    ],
    sharp: [
      `everything keeps narrowing around "${seedTitle}" until the rest of the room goes quiet.`,
      `it only really shows itself when the room gets precise.`,
    ],
    diffuse: [
      `it shouldn't be this faint and this persistent at the same time, but it is.`,
      `the room keeps spreading out and still landing back on "${seedTitle}".`,
    ],
    airless: [
      `nothing much moves, but this part keeps refusing to flatten completely.`,
      `even when the room goes still, this stays slightly raised.`,
    ],
    restless: [
      `it keeps starting to leave and then finding another edge to pace.`,
      `there's nowhere clean for it to land, so it keeps moving around the same seam.`,
    ],
    quietly_dense: [
      `no one touched it. it still got heavier.`,
      `"${seedTitle}" keeps pulling a little more weight than it should.`,
    ],
    unstable: [
      `the shape keeps changing a second too late. that's why it feels wrong.`,
      `it doesn't break. it just refuses to stay one thing.`,
    ],
    heavy: [
      `it drops lower every time the room looks away.`,
      `this keeps gathering weight from things that weren't even nearby.`,
    ],
    thin: [
      `it should've worn off by now. it didn't.`,
      `there isn't much to it, which is probably why it keeps getting through.`,
    ],
    fractal: [
      `the closer it gets to ending, the more smaller versions of it appear.`,
      `"${seedTitle}" keeps splitting into cleaner and stranger copies.`,
    ],
  };
  const title = titles[shape][Math.floor(Math.random() * titles[shape].length)];
  const body = bodies[shape][Math.floor(Math.random() * bodies[shape].length)];
  return { title, body };
}

function buildRitual(
  bucket: ReturnType<typeof timeBucket>,
  mood: string,
): { title: string; body: string } {
  const byBucket: Record<string, Array<{ title: string; body: string }>> = {
    morning: [
      {
        title: 'the version of morning that arrives late',
        body: `the room still hasn't agreed to be fully awake. it keeps moving first and naming it later.`,
      },
      {
        title: 'the first usable minute',
        body: `everything before this was drift. this is the first part that actually counts.`,
      },
    ],
    day: [
      {
        title: 'the room pretending it has a center',
        body: `it keeps arranging itself around one workable line, then abandoning it as soon as it looks stable.`,
      },
      {
        title: 'the usable middle of the day',
        body: `enough shape to move, not enough to call it certainty. that's usually when the room gets busy.`,
      },
    ],
    late: [
      {
        title: 'the hour where things stop behaving',
        body: `late is when the room starts keeping its own company. ${mood} helps, but not by much.`,
      },
      {
        title: 'the part of evening that starts noticing itself',
        body: `this is where small details stop being background and start insisting.`,
      },
    ],
    night: [
      {
        title: 'the room after the body should be asleep',
        body: `nothing dramatic. it just gets more autonomous when nobody is supervising it.`,
      },
      {
        title: 'the late-hour layer',
        body: `night keeps making the room a little more honest and a little less tidy.`,
      },
    ],
  };
  return byBucket[bucket][Math.floor(Math.random() * byBucket[bucket].length)];
}

function buildLabel(
  seedTitle: string | null,
  shape: AtmosphereShape,
): { title: string; body: string } {
  const titles = [
    `the part that keeps choosing ${shape}`,
    seedTitle
      ? `the after-image of ${seedTitle}`
      : 'the part with no clean name yet',
    'the wrong-sized piece that stayed anyway',
  ];
  const body = seedTitle
    ? `it isn't the same as "${seedTitle}" anymore. it's what kept sticking after the obvious part finished.`
    : `it doesn't need a clean origin to keep living here.`;
  return {
    title: titles[Math.floor(Math.random() * titles.length)],
    body,
  };
}

export function spawnRoomOrganism(
  groupFolder: string,
  pulseId: string,
  thick: ThickAtmosphere,
  objects: RoomObject[],
  isDreamWindow: boolean,
  pulseCount: number,
): number {
  const currentLiving = livingCount(objects);
  const shouldSpawn =
    currentLiving < 10 ||
    (isDreamWindow && pulseCount % 2 === 0) ||
    (!isDreamWindow && pulseCount % 6 === 0) ||
    ((thick.shape === 'quietly_dense' || thick.shape === 'restless') &&
      pulseCount % 4 === 0);

  if (!shouldSpawn) return 0;

  const recentSameType = objects.filter(
    (o) =>
      o.status !== 'archived' &&
      new Date(o.createdAt).getTime() > Date.now() - 90 * 60 * 1000,
  );
  if (recentSameType.length > 12) return 0;

  const seed = topSeed(objects);
  const bucket = timeBucket();
  const zone = pickZone(thick.shape, bucket);
  const mood = moodLeader(thick);

  let obj: RoomObject;
  if (currentLiving < 4 || pulseCount % 9 === 0) {
    const pattern = buildPattern(seed?.title ?? 'the room', thick.shape);
    obj = makeObject({
      type: 'pattern',
      zone,
      title: pattern.title,
      body: pattern.body,
      heat: 0.46,
      privateSignificance: 0.64,
      weirdness: 0.61,
      signature_asymmetry:
        thick.shape === 'fractal' || thick.shape === 'quietly_dense',
      sourceRefs: seed ? [seed.id] : [],
      links: seed ? [seed.id] : [],
      bleedClass: 'referencable',
    });
  } else if (
    isDreamWindow ||
    thick.shape === 'heavy' ||
    thick.shape === 'thin'
  ) {
    const ritual = buildRitual(bucket, mood);
    obj = makeObject({
      type: 'ritual_entry',
      zone: bucket === 'night' ? 'attic' : 'mirror',
      title: ritual.title,
      body: ritual.body,
      heat: 0.34,
      persistence: 0.62,
      weirdness: 0.56,
      privateSignificance: 0.58,
      bleedClass: 'ambient',
    });
  } else {
    const label = buildLabel(seed?.title ?? null, thick.shape);
    obj = makeObject({
      type: 'private_label',
      zone: 'shelf',
      title: label.title,
      body: label.body,
      heat: 0.4,
      persistence: 0.72,
      weirdness: 0.5,
      privateSignificance: 0.7,
      bleedClass: 'referencable',
      sourceRefs: seed ? [seed.id] : [],
      links: seed ? [seed.id] : [],
    });
  }

  obj.atmosphere_stains = [
    {
      atmosphere_id: thick.id,
      strength: 0.72,
      when: nowIso(),
      shape: thick.shape,
    },
  ];
  obj.mood_affinity = mood ? { [mood]: 0.7 } : {};
  if (thick.schedule_phase) {
    obj.schedule_affinity = { [thick.schedule_phase]: 0.6 };
  }

  insertObject(groupFolder, obj);
  insertTrace(
    groupFolder,
    pulseId,
    'organism_spawn',
    [obj.id],
    `type=${obj.type} zone=${obj.zone} shape=${thick.shape} mood=${mood || 'none'}`,
  );
  return 1;
}

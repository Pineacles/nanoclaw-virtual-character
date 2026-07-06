/**
 * Group configuration loader — single source of truth for all group identity,
 * routing, and persona values. Replaces hardcoded constants across web channel files.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../logger.js';

export interface GroupConfig {
  group_name: string;
  group_folder: string;
  group_jid: string;
  timezone: string;
  assistant: {
    name: string;
    trigger: string;
  };
  user: {
    name: string;
    sender_id: string;
  };
  contacts?: Record<string, string>; // phone number → display name
  style?: {
    signature_markers?: string[];
    signature_note?: string;
  };
  mood?: {
    fallback?: { mood: string; energy: number };
  };
  features: {
    memory: boolean;
    diary: boolean;
    mood: boolean;
    emotional_state: boolean;
    schedule: boolean;
    personality: boolean;
    relationship: boolean;
    voice_call: boolean;
    tom: boolean;
    style_match: boolean;
    // Room Runtime feature flags (all default false — enable per-group)
    room_runtime: boolean; // master switch for pulse loop
    room_ingest: boolean; // pull from memories/diary/etc (Phase B)
    room_bleed: boolean; // whisper into chat (Phase D)
    room_outbound_queue: boolean; // allow queue→draft-watcher (Phase D)
    room_llm_actions: boolean; // enable Haiku actions (Phase C)
    // Humanity feature flags (all default false — enable per-group for
    // relationship-style personas; task assistants leave them off). Each is
    // an independent toggle so behaviour can be tuned one cue at a time.
    voice_notes: boolean; // offer a voice note at emotional peaks
    messaging_realism: boolean; // paced multi-bubble + energy-driven texture
    preoccupations: boolean; // a current thing on her mind she raises
    thread_callbacks: boolean; // reopen unfinished emotional threads
    disclosure_ladder: boolean; // intimacy level that actually moves
    forgetting: boolean; // old memories blur instead of perfect recall
    // Passive senses for the user's real environment (media server, lights).
    // Needs host-side collector config in data/ambient/{group}.json.
    ambient_awareness: boolean;
    // Presence & read-receipt features (default false; opt-in per group).
    // presence_indicator: push online/away/sleeping state over WS + /api/receipts.
    // delayed_replies: consumed elsewhere; declared here for gating.
    presence_indicator: boolean;
    delayed_replies: boolean;
    // Social life simulator — real scheduled events (friends, family, pilates)
    // that feed presence, deferral caps, and context hints. Default false;
    // enable per-group when the calendar is seeded and the persona supports it.
    social_sim: boolean;
    // Dates awareness — anniversaries, birthdays, marked days from dates.json.
    // Default false; enable per-group when dates.json is seeded.
    dates_awareness: boolean;
  };
}

const GROUPS_DIR = path.resolve(process.cwd(), 'groups');

let loaded: GroupConfig | null = null;

function resolveGroupFolder(): string {
  const folder = process.env.NANOCLAW_WEB_GROUP;
  if (!folder) {
    // Fail closed. A persona folder carries identity, memory, diary, and
    // relationship state — defaulting it to a fixed persona (the old
    // hardcoded default) meant any misconfigured instance silently became
    // that persona. Every instance MUST declare its own folder.
    throw new Error(
      'NANOCLAW_WEB_GROUP is not set — refusing to start. Each instance must ' +
        'explicitly declare its persona folder so it can never inherit another ' +
        "persona's identity or memory. Set NANOCLAW_WEB_GROUP in this instance's env file.",
    );
  }
  return folder;
}

export function loadGroupConfig(folder?: string): GroupConfig {
  const groupFolder = folder || resolveGroupFolder();
  const configPath = path.join(GROUPS_DIR, groupFolder, 'group.json');

  const defaultFeatures = {
    memory: true,
    diary: true,
    mood: true,
    emotional_state: true,
    schedule: true,
    personality: true,
    relationship: true,
    voice_call: true,
    tom: true,
    style_match: true,
    // Room Runtime — all default false, enable per-group when ready
    room_runtime: false,
    room_ingest: false,
    room_bleed: false,
    room_outbound_queue: false,
    room_llm_actions: false,
    // Humanity flags — opt-in per group
    voice_notes: false,
    messaging_realism: false,
    preoccupations: false,
    thread_callbacks: false,
    disclosure_ladder: false,
    forgetting: false,
    ambient_awareness: false,
    presence_indicator: false,
    delayed_replies: false,
    social_sim: false,
    // Dates awareness — off by default; enable per-group when dates.json is seeded
    dates_awareness: false,
  };

  const defaults: GroupConfig = {
    group_name: groupFolder,
    group_folder: groupFolder,
    group_jid: `web:${groupFolder}`,
    timezone: process.env.TZ || 'UTC',
    assistant: {
      name: groupFolder.charAt(0).toUpperCase() + groupFolder.slice(1),
      trigger: `@${groupFolder}`,
    },
    user: {
      name: 'User',
      sender_id: `web:user`,
    },
    features: { ...defaultFeatures },
  };

  if (!fs.existsSync(configPath)) {
    logger.warn({ configPath }, 'group.json not found, using defaults');
    loaded = { ...defaults };
    return loaded;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    loaded = {
      group_name: raw.group_name || defaults.group_name,
      group_folder: groupFolder,
      group_jid: raw.group_jid || defaults.group_jid,
      timezone: raw.timezone || defaults.timezone,
      assistant: {
        name: raw.assistant?.name || defaults.assistant.name,
        trigger: raw.assistant?.trigger || defaults.assistant.trigger,
      },
      user: {
        name: raw.user?.name || defaults.user.name,
        sender_id: raw.user?.sender_id || defaults.user.sender_id,
      },
      contacts: raw.contacts || undefined,
      style: raw.style || undefined,
      mood: raw.mood || undefined,
      features: { ...defaultFeatures, ...(raw.features || {}) },
    };
    logger.info(
      {
        group: loaded.group_folder,
        assistant: loaded.assistant.name,
        user: loaded.user.name,
      },
      'Group config loaded',
    );
    return loaded;
  } catch (err) {
    logger.error(
      { err, configPath },
      'Failed to parse group.json, using defaults',
    );
    loaded = { ...defaults };
    return loaded;
  }
}

/** Reload config from disk (for API updates) */
export function reloadGroupConfig(): GroupConfig {
  loaded = null;
  return loadGroupConfig();
}

/** Get the loaded config, loading it if necessary */
export function getGroupConfig(): GroupConfig {
  if (!loaded) return loadGroupConfig();
  return loaded;
}

// Convenience getters
export function getGroupFolder(): string {
  return getGroupConfig().group_folder;
}
export function getGroupJid(): string {
  return getGroupConfig().group_jid;
}
export function getTimezone(): string {
  return getGroupConfig().timezone;
}
export function getAssistantName(): string {
  return getGroupConfig().assistant.name;
}
export function getUserName(): string {
  return getGroupConfig().user.name;
}
export function getUserSenderId(): string {
  return getGroupConfig().user.sender_id;
}
export function getGroupDir(): string {
  return path.join(GROUPS_DIR, getGroupFolder());
}
export function isFeatureEnabled(
  feature: keyof GroupConfig['features'],
): boolean {
  return getGroupConfig().features[feature];
}

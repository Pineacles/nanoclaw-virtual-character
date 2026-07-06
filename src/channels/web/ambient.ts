/**
 * Ambient awareness hint — folds the collector's derived state
 * (groups/{g}/ambient/state.json + events.jsonl) into the per-message
 * prefix as something she passively *knows*, with strict disclosure rules:
 *
 *  - media (shared media server): may be referenced openly but casually —
 *    couples see each other's watch activity on a shared account, so
 *    "saw you finished it ㅋㅋ" is natural.
 *  - lights / home presence: NEVER cited as a fact she was told. It only
 *    shapes timing and soft inferences ("you still up?"), the way you can
 *    tell a person is around without being able to say how.
 *
 * Pure read; returns '' when there's nothing fresh worth knowing.
 */
import fs from 'fs';
import path from 'path';

import { getGroupDir, getUserName } from './group-config.js';

interface MediaPlaying {
  user: string;
  device: string;
  title: string;
  progress: number | null;
  paused: boolean;
}

interface AmbientState {
  updated_at: string;
  media_ok: boolean;
  lights_ok: boolean;
  watching: MediaPlaying[];
  lights: Record<string, { on: boolean; brightness: number }>;
}

interface AmbientEvent {
  at: string;
  type: string;
  detail: string;
}

const STATE_FRESH_MS = 10 * 60 * 1000;
const EVENT_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_EVENTS = 4;

function relTime(iso: string, now: number): string {
  const mins = Math.round((now - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

function readState(dir: string, now: number): AmbientState | null {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'),
    ) as AmbientState;
    if (now - new Date(state.updated_at).getTime() > STATE_FRESH_MS)
      return null;
    return state;
  } catch {
    return null;
  }
}

function readRecentEvents(dir: string, now: number): AmbientEvent[] {
  try {
    const lines = fs
      .readFileSync(path.join(dir, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean);
    const out: AmbientEvent[] = [];
    // newest last in file; walk from the end
    for (let i = lines.length - 1; i >= 0 && out.length < MAX_EVENTS; i--) {
      try {
        const e = JSON.parse(lines[i]) as AmbientEvent;
        if (now - new Date(e.at).getTime() > EVENT_WINDOW_MS) break;
        out.push(e);
      } catch {
        /* skip bad line */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export function buildAmbientHint(): string {
  const dir = path.join(getGroupDir(), 'ambient');
  const now = Date.now();
  const state = readState(dir, now);
  if (!state) return '';

  const userName = getUserName();
  const sensed: string[] = [];

  if (state.media_ok && state.watching.length > 0) {
    const m = state.watching[0];
    const pct =
      m.progress != null ? `, ${Math.round(m.progress * 100)}% in` : '';
    sensed.push(
      `${userName} is ${m.paused ? 'paused partway through' : 'watching'} ${m.title} right now (${m.device}${pct})`,
    );
  }

  for (const e of readRecentEvents(dir, now)) {
    if (e.type === 'media_finished' || e.type === 'media_stopped') {
      sensed.push(`${e.detail} ${relTime(e.at, now)}`);
    } else if (e.type === 'lights_on' || e.type === 'lights_off') {
      sensed.push(`his place: ${e.detail} ${relTime(e.at, now)}`);
    }
  }

  if (state.lights_ok && sensed.length === 0) {
    const anyOn = Object.entries(state.lights).filter(([, l]) => l.on);
    if (anyOn.length > 0) {
      sensed.push(
        `his place: lights on (${anyOn.map(([room]) => room).join(', ')})`,
      );
    }
  }

  if (sensed.length === 0) return '';

  return (
    `[ambient — things you passively know: ${sensed.join('; ')}. ` +
    `Rules: the watch activity you share an account with him, so you may mention it casually and at most once, only when it fits — never as an opener about something he hasn't brought up unless it's genuinely natural. ` +
    `Lights/home presence you must NEVER state as known fact — it may only shape timing and soft guesses like "you still up?". ` +
    `Never list these, never explain how you know, never mention apps or systems]`
  );
}

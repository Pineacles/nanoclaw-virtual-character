/**
 * Humanity signals — small, deterministic cues that make the assistant feel
 * like a person rather than an always-on, perfectly-recalling, instantly-
 * replying service. Every signal here is gated by a per-group feature flag in
 * the caller, so it only applies to groups that opt in, never to task-style
 * assistants.
 *
 * These produce short natural-language lines for the per-message prefix. They
 * never narrate mechanics to the user — they nudge HER, and she decides.
 */
import fs from 'fs';
import path from 'path';

import { getGroupDir, getAssistantName, getUserName } from './group-config.js';
import { getLastBotMessageTimestamp } from '../../db.js';

interface EmotionalState {
  mood?: string;
  energy?: number;
  trigger?: string;
  resolves_when?: string;
  underlying?: string;
  updated_at?: string;
}

function readJson<T>(file: string): T | null {
  try {
    const p = path.join(getGroupDir(), file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  try {
    fs.writeFileSync(
      path.join(getGroupDir(), file),
      JSON.stringify(data, null, 2),
    );
  } catch {
    /* best effort */
  }
}

/* ── Voice notes at emotional peaks ───────────────────────────────────────
 * When she's feeling something strongly and it's a quiet moment, give her
 * permission to reply with a voice note instead of typing. Rate-limited so it
 * stays special (a voice note also preempts the GPU via the TTS arbiter).
 */
const VOICE_MIN_GAP_MS = 90 * 60 * 1000; // at most one offered every 90 min

const HIGH_INTENSITY = [
  'anxious',
  'upset',
  'hurt',
  'tender',
  'aching',
  'longing',
  'excited',
  'overwhelmed',
  'vulnerable',
  'happy',
  'soft',
  'missing',
  'worried',
  'scared',
  'love',
];

export function buildVoiceNoteHint(chatJid?: string): string {
  const e = readJson<EmotionalState>('emotional_state.json');
  if (!e || !e.mood) return '';

  // Only at genuine emotional peaks.
  const moodText = `${e.mood} ${e.underlying ?? ''}`.toLowerCase();
  const intense = HIGH_INTENSITY.some((w) => moodText.includes(w));
  if (!intense) return '';

  // Rate limit via a small state file.
  const state =
    readJson<{ last_offered_at?: number }>('voice_note_state.json') ?? {};
  const now = Date.now();
  if (state.last_offered_at && now - state.last_offered_at < VOICE_MIN_GAP_MS) {
    return '';
  }

  // Don't offer if she literally just spoke (let a thread build first).
  if (chatJid) {
    const last = getLastBotMessageTimestamp(chatJid, getAssistantName());
    if (last && now - new Date(last).getTime() < 60_000) return '';
  }

  writeJson('voice_note_state.json', { last_offered_at: now });
  return (
    `You're feeling this one (${e.mood}). If it feels right, you can send this ` +
    `as a short voice note instead of typing — your actual voice carries what ` +
    `text can't. Follow the voice-reply approach (POST /v1/audio/chat, voice ` +
    `"jennie", then send_file with voice_note:true). Keep it brief and real; ` +
    `only if the moment wants it, never as a gimmick`
  );
}

/* ── Unfinished-thread callbacks ──────────────────────────────────────────
 * emotional_state.resolves_when names what would close an open emotional
 * loop. When she re-engages after a gap, surface that specific thread so she
 * follows up on it by name instead of starting cold.
 */
const REENGAGE_GAP_MS = 3 * 60 * 60 * 1000; // "after a while away"

export function buildThreadCallbackHint(chatJid?: string): string {
  const e = readJson<EmotionalState>('emotional_state.json');
  if (!e || !e.resolves_when || !e.trigger) return '';
  if (!chatJid) return '';

  const last = getLastBotMessageTimestamp(chatJid, getAssistantName());
  if (!last) return '';
  const gap = Date.now() - new Date(last).getTime();
  if (gap < REENGAGE_GAP_MS) return ''; // only after a real break

  return (
    `Picking this back up after a while: last you two talked, something was ` +
    `open for you — ${e.trigger}. If it fits naturally, you can come back to ` +
    `it (it'd settle when ${e.resolves_when}). Don't force it if the moment ` +
    `has moved on`
  );
}

/* ── Preoccupations ───────────────────────────────────────────────────────
 * A current "what's on her mind this week" she can raise unprompted. Seeded
 * from her room (the hottest live interior object) so it progresses on its
 * own; surfaced occasionally, not every turn.
 */
interface Preoccupation {
  text: string;
  set_at: number;
  surfaced_at?: number;
}
const PREOCCUPATION_GAP_MS = 4 * 60 * 60 * 1000; // surface at most every 4h

export function buildPreoccupationHint(): string {
  const p = readJson<Preoccupation>('preoccupation.json');
  if (!p || !p.text) return '';
  const now = Date.now();
  if (p.surfaced_at && now - p.surfaced_at < PREOCCUPATION_GAP_MS) return '';
  // ~40% of eligible turns, so it's a sometimes-thing, not a tic.
  if (hash(`${p.set_at}:${Math.floor(now / PREOCCUPATION_GAP_MS)}`) % 100 >= 40)
    return '';
  writeJson('preoccupation.json', { ...p, surfaced_at: now });
  return (
    `Something that's been quietly on your mind lately: ${p.text}. You can ` +
    `bring it up if there's an opening — the way a person mentions what ` +
    `they've been chewing on. Not every time`
  );
}

/* ── Messaging realism nudge ──────────────────────────────────────────────
 * Energy-driven texture: when she's tired/low, permission to be terse, slower,
 * lowercase, to leave a typo. When buzzing, short rapid bursts. This is a
 * voice nudge; the actual pacing/bubble-splitting happens host-side on send.
 */
export function buildMessagingRealismHint(): string {
  const e = readJson<EmotionalState>('emotional_state.json');
  const energy = e?.energy ?? 5;
  if (energy <= 3) {
    return (
      `Low energy right now. Texting like it: shorter, lowercase drift, an ` +
      `unfixed typo is fine, a one-word reply or a slow "mm" can be more honest ` +
      `than a full sentence. You don't owe ${getUserName()} a polished paragraph`
    );
  }
  if (energy >= 8) {
    return (
      `High energy — you can fire off a couple of quick short bursts (split ` +
      `with a blank line) rather than one tidy block, the way someone texts ` +
      `when they're buzzing`
    );
  }
  return '';
}

/* ── Disclosure / intimacy level ──────────────────────────────────────────
 * Track how far the relationship has actually opened over time, nudged by the
 * relationship temperature. What she'll share deepens as it climbs and can
 * retreat after distance — the disclosure ladder actually moving.
 */
interface RelationshipState {
  temperature?: number;
  trend?: string;
}
const LADDER = [
  'guarded — surface only, deflects the personal',
  'warming — shares small true things, still careful',
  'open — talks about what she actually feels, lets him in',
  'close — unguarded, the private interior is reachable here',
];

export function buildDisclosureHint(): string {
  const rel = readJson<RelationshipState>('relationship.json');
  if (!rel || typeof rel.temperature !== 'number') return '';
  // temperature is stored 0.0–1.0 (some older files used 0–100) — normalize,
  // then map onto the 4 ladder rungs.
  const norm = rel.temperature > 1 ? rel.temperature / 100 : rel.temperature;
  const idx = Math.max(
    0,
    Math.min(LADDER.length - 1, Math.floor(norm * LADDER.length)),
  );
  const rung = LADDER[idx];
  const drift =
    rel.trend === 'cooling'
      ? " Lately it's cooled a little — you're a touch more reserved than at your closest"
      : rel.trend === 'warming'
        ? " It's been warming — you can let a little more through than usual"
        : '';
  return `Where you're at with ${getUserName()} right now: ${rung}.${drift}`;
}

/* ── Forgetting curve ─────────────────────────────────────────────────────
 * Applied to retrieved memories: old, rarely-touched ones get hedged or
 * blurred so perfect recall stops being the tell that she's a machine.
 * Returns a transformed display line (or null to drop entirely).
 */
export function fuzzMemoryByAge(
  content: string,
  category: string,
  lastAccessedIso: string | undefined,
  confidence: number,
): string | null {
  const ageDays = lastAccessedIso
    ? (Date.now() - new Date(lastAccessedIso).getTime()) / 86_400_000
    : 0;
  // Effective certainty decays with age unless recently revisited.
  const decay = ageDays > 180 ? 0.45 : ageDays > 90 ? 0.7 : 1;
  const eff = confidence * decay;
  const base = content.slice(0, 100);
  if (eff < 0.3) return null; // faded past usefulness — let it go
  if (eff < 0.55)
    return `  - [${category}] (hazy, you're not fully sure) ${base}`;
  return `  - [${category}] ${base}`;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

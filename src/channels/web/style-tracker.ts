/**
 * style-tracker.ts — deterministic user style reader for bounded linguistic accommodation.
 * Pure computation: no LLM calls, no subprocesses. Reads recent user messages from DB.
 */

import { getRecentUserMessages } from '../../db.js';
import { getUserName, getGroupConfig } from './group-config.js';

// Generic placeholder fallback — real personas should set style.signature_markers
// in group.json (see the virtual-character skill) rather than relying on this.
const DEFAULT_SIGNATURE_MARKERS = [
  'short-line rhythm',
  'occasional emoji',
  'casual sentence fragments',
  'trailing ellipses',
];

export interface UserStyle {
  avg_length: number;
  length_band: 'short' | 'medium' | 'long';
  question_density: number; // 0 | 0.25 | 0.5 | 0.75 | 1.0
  emoji_density: 'none' | 'minimal' | 'moderate' | 'heavy';
  formality: 'casual' | 'mixed' | 'formal';
  confidence: 'low' | 'medium' | 'high';
  generated_at: string;
  sample_size: number;
}

// Matches most common emoji codepoint ranges + ZWJ sequences
const EMOJI_RE = /\p{Emoji}/gu;

// Contractions common in English casual speech
const CONTRACTION_RE =
  /\b(don't|doesn't|didn't|can't|won't|wouldn't|couldn't|shouldn't|isn't|aren't|wasn't|weren't|i'm|you're|he's|she's|it's|we're|they're|i've|you've|we've|they've|i'll|you'll|he'll|she'll|it'll|we'll|they'll|i'd|you'd|he'd|she'd|we'd|they'd|that's|what's|there's|here's|who's|how's)\b/i;

function countEmojis(text: string): number {
  return (text.match(EMOJI_RE) ?? []).length;
}

function classifyEmojiDensity(
  emojiCount: number,
  charCount: number,
): UserStyle['emoji_density'] {
  if (charCount === 0) return 'none';
  const per100 = (emojiCount / charCount) * 100;
  if (per100 === 0) return 'none';
  if (per100 < 2) return 'minimal';
  if (per100 < 5) return 'moderate';
  return 'heavy';
}

function classifyFormality(messages: string[]): UserStyle['formality'] {
  let formalSignals = 0;
  let casualSignals = 0;

  for (const msg of messages) {
    const trimmed = msg.trim();
    if (!trimmed) continue;

    // Capital first letter = formal signal
    if (/^[A-Z]/.test(trimmed)) formalSignals++;

    // Terminal punctuation (. ! ?) = formal signal
    if (/[.!?]$/.test(trimmed)) formalSignals++;

    // Contractions = casual signal
    if (CONTRACTION_RE.test(trimmed)) casualSignals += 2;

    // All-lowercase = casual signal
    if (trimmed === trimmed.toLowerCase() && /[a-z]/.test(trimmed))
      casualSignals++;
  }

  const total = formalSignals + casualSignals;
  if (total === 0) return 'mixed';
  const ratio = formalSignals / total;
  if (ratio > 0.65) return 'formal';
  if (ratio < 0.35) return 'casual';
  return 'mixed';
}

function roundToQuarter(value: number): number {
  return Math.round(value * 4) / 4;
}

/**
 * Compute style stats from the last 8 non-bot messages for a chat.
 * Returns null when fewer than 3 usable messages are available.
 */
export function computeUserStyle(chatJid: string): UserStyle | null {
  let rawTexts: string[];
  try {
    rawTexts = getRecentUserMessages(chatJid, 8);
  } catch {
    return null;
  }

  // Strip system prefix and filter to non-empty, non-image messages
  const texts = rawTexts
    .map((t) => t.replace(/^\[System:[^\]]*\](\.\s*)?/, '').trim())
    .filter((t) => t.length > 0);

  if (texts.length < 3) return null;

  const sample_size = texts.length;

  // avg_length
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  const avg_length = Math.round(totalChars / sample_size);

  // length_band
  const length_band: UserStyle['length_band'] =
    avg_length < 30 ? 'short' : avg_length <= 100 ? 'medium' : 'long';

  // question_density — fraction ending with ?
  const questionCount = texts.filter((t) => t.trimEnd().endsWith('?')).length;
  const question_density = roundToQuarter(questionCount / sample_size);

  // emoji_density
  const totalEmojis = texts.reduce((sum, t) => sum + countEmojis(t), 0);
  const totalCharCount = texts.reduce((sum, t) => sum + t.length, 0);
  const emoji_density = classifyEmojiDensity(totalEmojis, totalCharCount);

  // formality
  const formality = classifyFormality(texts);

  // confidence
  const confidence: UserStyle['confidence'] =
    sample_size < 5 ? 'low' : sample_size <= 7 ? 'medium' : 'high';

  return {
    avg_length,
    length_band,
    question_density,
    emoji_density,
    formality,
    confidence,
    generated_at: new Date().toISOString(),
    sample_size,
  };
}

/**
 * Format a compact calibration hint for the per-message prefix.
 */
export function formatUserStyleBlock(style: UserStyle): string {
  const densityDescription =
    {
      '0': 'none — no questions',
      '0.25': 'low — occasional question',
      '0.5': 'moderate — about half are questions',
      '0.75': 'high — mostly questions',
      '1': 'all questions',
    }[String(style.question_density)] ?? `${style.question_density}`;

  const styleConfig = getGroupConfig().style;
  const signatureSentence =
    styleConfig?.signature_note ??
    `(Your signature markers — ${(styleConfig?.signature_markers ?? DEFAULT_SIGNATURE_MARKERS).join(', ')} — NEVER bend based on his style. This is calibration, not mimicry.)`;

  return `${getUserName()}'s current style (calibrate within band — never mimic):
  - length: ${style.length_band} (avg ~${style.avg_length} chars) — your replies can vary but not paragraph-block when he's short
  - questions: ${densityDescription} — mirror loosely, not 1:1
  - emoji use: ${style.emoji_density} — don't over-emoji if he's sparse
  - formality: ${style.formality} — you already match most of the time

${signatureSentence}`;
}

import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock config + group-config before any imports that pull them transitively.
vi.mock('../../config.js', () => ({ GROUPS_DIR: '/tmp/test-groups' }));
vi.mock('./group-config.js', () => ({
  getGroupFolder: vi.fn(() => 'testgroup'),
  getGroupJid: vi.fn(() => 'test@s.whatsapp.net'),
  getTimezone: vi.fn(() => 'Europe/Zurich'),
  getUserName: vi.fn(() => 'TestUser'),
  getAssistantName: vi.fn(() => 'Assistant'),
  isFeatureEnabled: vi.fn(() => false),
  getGroupConfig: vi.fn(() => ({})),
}));
vi.mock('./mood-style.js', () => ({
  getCachedMoodStyle: vi.fn(() => null),
  regenerateMoodStyleAsync: vi.fn(),
  shouldRegenerate: vi.fn(() => false),
}));
vi.mock('../../db.js', () => ({
  countRecentMessages: vi.fn(() => 0),
}));

import {
  stripMoodTags,
  extractMoodTag,
  applyMoodTag,
  resolveMood,
} from './mood.js';
import { getGroupConfig } from './group-config.js';

// Baseline mood state returned by all readFileSync stubs.
const BASE_MOOD = JSON.stringify({
  current_mood: 'chill',
  energy: 6,
  updated_at: '',
  schedule: [],
  distribution: { chill: 100 },
});

// Fresh spies for each test.
let existsSpy: ReturnType<typeof vi.spyOn>;
let readSpy: ReturnType<typeof vi.spyOn>;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(BASE_MOOD as any);
  writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  // silence mkdirSync if mood.ts ever calls it
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(getGroupConfig).mockReturnValue({} as any);
});

// ── mood.fallback config ────────────────────────────────────────────────────

describe('mood fallback — group config', () => {
  it('defaults to chill/6 when mood.json is missing and no config fallback is set', () => {
    const resolved = resolveMood();
    expect(resolved.current_mood).toBe('chill');
    expect(resolved.energy).toBe(6);
  });

  it('uses the group config mood.fallback when mood.json is missing', () => {
    vi.mocked(getGroupConfig).mockReturnValue({
      mood: { fallback: { mood: 'excited', energy: 9 } },
    } as any);

    const resolved = resolveMood();
    expect(resolved.current_mood).toBe('excited');
    expect(resolved.energy).toBe(9);
  });
});

// ── FIX 1: extractMoodTag ──────────────────────────────────────────────────

describe('extractMoodTag — FIX 1', () => {
  it('extracts a distribution-format mood tag', () => {
    const text = 'some reply\n\n*[mood:tired:40,soft:35,playful:25:4]*';
    expect(extractMoodTag(text)).toBe('*[mood:tired:40,soft:35,playful:25:4]*');
  });

  it('extracts a simple-format mood tag', () => {
    const text = 'reply text *[mood:chill:6]*';
    expect(extractMoodTag(text)).toBe('*[mood:chill:6]*');
  });

  it('returns null when no mood tag is present', () => {
    expect(extractMoodTag('just plain text')).toBeNull();
  });

  it('returns null for old [mood:X energy:Y] format (not extracted)', () => {
    // Old format is stripped by stripMoodTags but not extracted for re-attachment
    expect(extractMoodTag('[mood:chill energy:6] some text')).toBeNull();
  });
});

// ── FIX 1: stripMoodTags leaves content intact ────────────────────────────

describe('stripMoodTags regression — FIX 1', () => {
  it('strips distribution tag from end of multi-bubble text', () => {
    const text =
      'first bubble\n\nsecond bubble\n\n*[mood:tired:40,soft:35,playful:25:4]*';
    expect(stripMoodTags(text)).toBe('first bubble\n\nsecond bubble');
  });

  it('strips simple tag', () => {
    expect(stripMoodTags('hello *[mood:chill:6]*')).toBe('hello');
  });

  it('returns empty string for a mood-tag-only text', () => {
    expect(stripMoodTags('*[mood:tired:40,soft:35,playful:25:4]*')).toBe('');
  });
});

// ── FIX 4: applyMoodTag rejects corrupted tags ────────────────────────────

describe('applyMoodTag — FIX 4 corruption guards', () => {
  it('rejects a distribution with "undefined" as a mood name', () => {
    const text = '*[mood:undefined:91,tired:6,soft:3:4]*';
    const { cleanText, mood } = applyMoodTag(text);
    // Must NOT persist a corrupted distribution
    expect(writeSpy).not.toHaveBeenCalled();
    // mood falls back to current state (not the literal string "undefined")
    expect(mood).not.toBe('undefined');
    // cleanText is the original (tag not stripped since parse failed);
    // the important thing is the write was skipped — content will be ignored
    // by the guard in sendToClient (FIX 2) if it hits that path.
    expect(typeof cleanText).toBe('string');
  });

  it('accepts a well-formed distribution tag and writes mood.json', () => {
    const text = 'some reply *[mood:tired:40,soft:35,playful:25:4]*';
    const { cleanText, mood } = applyMoodTag(text);
    expect(cleanText).toBe('some reply');
    expect(mood).toBe('tired'); // highest weight
    expect(writeSpy).toHaveBeenCalled();
    const written = JSON.parse(writeSpy.mock.calls[0][1] as string);
    // No corrupt key in the written distribution
    expect(Object.keys(written.distribution)).not.toContain('undefined');
    expect(Number.isFinite(written.energy)).toBe(true);
  });

  it('rejects a simple tag with "undefined" as the mood name', () => {
    const text = '*[mood:undefined:6]*';
    const { cleanText, mood } = applyMoodTag(text);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(cleanText.trim()).toBe('');
    expect(mood).not.toBe('undefined');
  });

  it('NaN-energy tag does not write to mood.json (regex requires \\d+ so tag is not matched)', () => {
    // MOOD_TAG_DIST requires \d+ for energy — a non-numeric suffix won't match
    const text = '*[mood:tired:40,soft:60:NaN]*';
    const { cleanText } = applyMoodTag(text);
    expect(writeSpy).not.toHaveBeenCalled();
    // Tag was not recognised, so cleanText equals original
    expect(cleanText).toContain('NaN');
  });

  it('existing corrupt distribution in mood.json does not render as "undefined" mood', () => {
    // Simulate a mood.json on disk that has {undefined: 91, tired: 6, soft: 3}
    // AND the updated_at is recent (within the override window).
    const corrupted = JSON.stringify({
      current_mood: 'undefined',
      energy: NaN,
      updated_at: new Date(Date.now() - 1000).toISOString(),
      schedule: [],
      distribution: { undefined: 91, tired: 6, soft: 3 },
    });
    existsSpy.mockReturnValue(true);
    readSpy.mockReturnValue(corrupted as any);

    // applyMoodTag on plain text (no tag) calls resolveMood internally
    const { mood } = applyMoodTag('plain text without a tag');
    // After normalizeDistribution filters out the "undefined" entry, the
    // primary must NOT be the literal string "undefined"
    expect(mood).not.toBe('undefined');
  });
});

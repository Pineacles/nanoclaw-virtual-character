import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db.js', () => ({
  getRecentUserMessages: vi.fn(() => []),
}));
vi.mock('./group-config.js', () => ({
  getUserName: vi.fn(() => 'TestUser'),
  getGroupConfig: vi.fn(() => ({})),
}));

import { formatUserStyleBlock, UserStyle } from './style-tracker.js';
import { getGroupConfig } from './group-config.js';

const SAMPLE_STYLE: UserStyle = {
  avg_length: 40,
  length_band: 'medium',
  question_density: 0.25,
  emoji_density: 'minimal',
  formality: 'casual',
  confidence: 'medium',
  generated_at: new Date().toISOString(),
  sample_size: 5,
};

describe('formatUserStyleBlock — group config', () => {
  it('uses the default signature-marker sentence when config is absent', () => {
    const block = formatUserStyleBlock(SAMPLE_STYLE);
    expect(block).toContain("TestUser's current style");
    expect(block).toContain(
      '(Your signature markers — short-line rhythm, occasional emoji, casual sentence fragments, trailing ellipses — NEVER bend based on his style. This is calibration, not mimicry.)',
    );
  });

  it('uses group config style.signature_markers when set', () => {
    vi.mocked(getGroupConfig).mockReturnValue({
      style: { signature_markers: ['lol', 'run-on sentences'] },
    } as any);

    const block = formatUserStyleBlock(SAMPLE_STYLE);
    expect(block).toContain(
      '(Your signature markers — lol, run-on sentences — NEVER bend based on his style. This is calibration, not mimicry.)',
    );

    vi.mocked(getGroupConfig).mockReturnValue({} as any);
  });

  it('uses group config style.signature_note verbatim when set', () => {
    vi.mocked(getGroupConfig).mockReturnValue({
      style: { signature_note: '(custom note)' },
    } as any);

    const block = formatUserStyleBlock(SAMPLE_STYLE);
    expect(block).toContain('(custom note)');
    expect(block).not.toContain('signature markers');

    vi.mocked(getGroupConfig).mockReturnValue({} as any);
  });
});

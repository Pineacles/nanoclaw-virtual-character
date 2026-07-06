import { describe, expect, it } from 'vitest';

import { fuzzMemoryByAge } from './humanity.js';

describe('fuzzMemoryByAge (forgetting curve)', () => {
  const recent = new Date().toISOString();
  const old120 = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const old300 = new Date(Date.now() - 300 * 86_400_000).toISOString();

  it('keeps a fresh, confident memory crisp', () => {
    const line = fuzzMemoryByAge(
      'TestUser is an electrician',
      'fact',
      recent,
      0.9,
    );
    expect(line).toBe('  - [fact] TestUser is an electrician');
    expect(line).not.toContain('hazy');
  });

  it('hedges an aged mid-confidence memory', () => {
    const line = fuzzMemoryByAge(
      'he mentioned a trip',
      'observation',
      old120,
      0.7,
    );
    expect(line).toContain('hazy');
  });

  it('drops a very old, already-shaky memory entirely', () => {
    const line = fuzzMemoryByAge('vague guess', 'observation', old300, 0.5);
    expect(line).toBeNull();
  });

  it('a fresh low-confidence memory survives but is hedged', () => {
    const line = fuzzMemoryByAge('weak inference', 'observation', recent, 0.5);
    expect(line).toContain('hazy');
  });

  it('treats a missing timestamp as fresh (no decay)', () => {
    const line = fuzzMemoryByAge('no date', 'fact', undefined, 0.9);
    expect(line).toBe('  - [fact] no date');
  });
});

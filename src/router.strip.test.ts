import { describe, expect, it } from 'vitest';

import { stripInternalTags } from './router.js';

describe('stripInternalTags', () => {
  it('removes a balanced <internal>...</internal> pair', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('removes multiple balanced pairs', () => {
    expect(
      stripInternalTags(
        '<internal>a</internal> visible <internal>b</internal>',
      ),
    ).toBe('visible');
  });

  it('drops everything after an unclosed opening tag', () => {
    expect(stripInternalTags('before <internal>dangling content')).toBe(
      'before',
    );
  });

  it('removes a lone </internal> close tag (orphan from chunked streaming)', () => {
    expect(stripInternalTags('hello </internal> world')).toBe('hello  world');
  });

  it('removes a lone <internal> open tag with nothing after it', () => {
    expect(stripInternalTags('hello <internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>all internal</internal>')).toBe('');
  });

  it('returns empty string when input is only an orphan close tag', () => {
    expect(stripInternalTags('</internal>')).toBe('');
  });

  it('returns empty string when input is only an orphan open tag', () => {
    expect(stripInternalTags('<internal>')).toBe('');
  });

  it('keeps visible text mixed with an internal block', () => {
    expect(
      stripInternalTags(
        'Good morning! <internal>mood: happy</internal> How are you?',
      ),
    ).toBe('Good morning!  How are you?');
  });

  it('handles multiline internal content', () => {
    expect(
      stripInternalTags('start\n<internal>\nline1\nline2\n</internal>\nend'),
    ).toBe('start\n\nend');
  });

  it('returns plain text unchanged', () => {
    expect(stripInternalTags('no tags here')).toBe('no tags here');
  });

  it('trims surrounding whitespace after stripping', () => {
    expect(stripInternalTags('  <internal>x</internal>  ')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildSocialContextHint,
  formatEventDescription,
} from './context-hint.js';
import type { SocialEvent } from './calendar.js';

function makeEvent(overrides: Partial<SocialEvent> = {}): SocialEvent {
  return {
    id: 'evt-001',
    date: '2026-06-13',
    start: '19:00',
    end: '21:00',
    who: 'Mia',
    what: 'dinner',
    where: 'that thai place in kreis 4',
    status: 'confirmed',
    phone_ok: true,
    ...overrides,
  };
}

describe('formatEventDescription', () => {
  it('includes what, who, where and phone note', () => {
    const desc = formatEventDescription(makeEvent());
    expect(desc).toContain('dinner');
    expect(desc).toContain('Mia');
    expect(desc).toContain('that thai place in kreis 4');
    expect(desc).toContain('glancing at phone');
  });

  it('uses "phone in your bag" when phone_ok is false', () => {
    const desc = formatEventDescription(makeEvent({ phone_ok: false }));
    expect(desc).toContain('phone in your bag');
    expect(desc).not.toContain('glancing at phone');
  });

  it('omits where clause when where is undefined', () => {
    const desc = formatEventDescription(makeEvent({ where: undefined }));
    // The output should look like "dinner with Mia (glancing at phone)"
    // i.e. "with Mia (" directly — no " at <place>" segment before the paren
    expect(desc).toContain('dinner with Mia (');
    expect(desc).not.toContain('that thai place');
  });
});

describe('buildSocialContextHint', () => {
  it('returns empty string when both current and upcoming are empty', () => {
    expect(buildSocialContextHint(null, [])).toBe('');
  });

  it('includes "right now" for the current event', () => {
    const hint = buildSocialContextHint(makeEvent(), []);
    expect(hint).toContain('right now');
    expect(hint).toContain('dinner with Mia');
  });

  it('includes upcoming events with day+time label', () => {
    const upcoming = makeEvent({
      id: 'evt-002',
      date: '2026-06-14',
      start: '15:00',
      who: 'Léa',
      what: 'coffee',
    });
    const hint = buildSocialContextHint(null, [upcoming]);
    expect(hint).toContain('coffee with Léa');
    expect(hint).toContain('15:00');
  });

  it('includes the "real plans" instruction', () => {
    const hint = buildSocialContextHint(makeEvent(), []);
    expect(hint).toContain('These are real plans');
    expect(hint).toContain('cancel/flake only if the calendar says so');
  });

  it('includes both current and upcoming', () => {
    const current = makeEvent({ who: 'Mia', what: 'dinner' });
    const upcoming = makeEvent({
      id: 'evt-003',
      date: '2026-06-14',
      start: '20:00',
      who: 'mom',
      what: 'call',
      phone_ok: true,
    });
    const hint = buildSocialContextHint(current, [upcoming]);
    expect(hint).toContain('right now');
    expect(hint).toContain('dinner with Mia');
    expect(hint).toContain('call with mom');
  });

  it('wraps the hint in square brackets', () => {
    const hint = buildSocialContextHint(makeEvent(), []);
    expect(hint.startsWith('[')).toBe(true);
    expect(hint.endsWith(']')).toBe(true);
  });
});

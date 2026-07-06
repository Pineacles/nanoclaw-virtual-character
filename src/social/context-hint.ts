/**
 * Social calendar context hint — formats current + upcoming events into a
 * compact instruction block for the per-message prefix.
 *
 * Exported as a pure function so it can be unit-tested independently.
 */
import type { SocialEvent } from './calendar.js';

/**
 * Build the single-line description of an event for injection.
 * e.g. "dinner with Mia at that thai place (phone in your bag, glances only)"
 */
export function formatEventDescription(ev: SocialEvent): string {
  const phoneNote = ev.phone_ok
    ? 'glancing at phone'
    : 'phone in your bag, no checking';
  const where = ev.where ? ` at ${ev.where}` : '';
  return `${ev.what} with ${ev.who}${where} (${phoneNote})`;
}

/**
 * Build the full [your plans: ...] hint block.
 *
 * @param current  - event whose window contains right now (or null)
 * @param upcoming - events in the next 36h that haven't started yet
 * @returns A bracketed hint string, or empty string if nothing to show.
 */
export function buildSocialContextHint(
  current: SocialEvent | null,
  upcoming: SocialEvent[],
): string {
  const parts: string[] = [];

  if (current) {
    parts.push(`right now — ${formatEventDescription(current)}`);
  }

  for (const ev of upcoming) {
    // Format start time as "DayName HH:MM" or just "HH:MM" for today
    const dateLabel = formatUpcomingDate(ev.date, ev.start);
    parts.push(`${dateLabel} — ${formatEventDescription(ev)}`);
  }

  if (parts.length === 0) return '';

  const list = parts.join('; ');
  return (
    `[your plans: ${list}. ` +
    `These are real plans: reference them naturally, never as a list, ` +
    `cancel/flake only if the calendar says so]`
  );
}

/**
 * Format an upcoming event date+time into a human-readable label.
 * For simplicity we use the raw date and time — the model can interpret them.
 * Output examples: "Thu 19:00", "2026-06-14 15:00"
 */
function formatUpcomingDate(date: string, start: string): string {
  try {
    // Parse as noon UTC so weekday calculation is stable across timezones
    const d = new Date(`${date}T12:00:00Z`);
    const weekday = d.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    });
    return `${weekday} ${start}`;
  } catch {
    return `${date} ${start}`;
  }
}

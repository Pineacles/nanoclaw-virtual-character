/**
 * Workflow verdict tags — accountability marker that says whether the agent
 * actually used a workflow that her incoming message was supposed to trigger.
 *
 * Format:  *[wf:✓ name1,name2 | ⚠ skipped1,skipped2]*
 * Either side can be empty; the whole tag is omitted when there's nothing to say.
 *
 * The tag is appended to the agent's reply BEFORE the existing mood tag so that
 * the mood-strip regex (anchored to end-of-string) keeps working unchanged.
 *
 * Web UI (MessageBubble.tsx) parses the tag and renders a chip.
 * WhatsApp/Telegram converts it to an italic suffix via formatWorkflowTagInline().
 */

/** Anchored to end-of-string: the verdict tag is always the last thing in the message. */
const WF_TAG_REGEX = /\s*\*\[wf:([^\]]+)\]\*\s*$/;
const WF_TAG_REGEX_GLOBAL = /\s*\*\[wf:([^\]]+)\]\*\s*/g;
/** Mood tag regexes — duplicated from mood.ts to avoid a circular import. */
const MOOD_TAG_DIST = /\s*\*\[mood:(?:\w+:\d+,)*\w+:\d+:\d+\]\*\s*$/;
const MOOD_TAG_SIMPLE = /\s*\*\[mood:\w+:\d+\]\*\s*$/;

export interface WorkflowVerdict {
  used: string[];
  skipped: string[];
}

/** Drop the .md extension and any trailing/leading whitespace for display. */
function pretty(filename: string): string {
  return filename.replace(/\.md$/i, '').trim();
}

/**
 * Build the *[wf:...]* tag for a verdict, or empty string if there's nothing to report.
 */
export function buildWorkflowVerdictTag(verdict: WorkflowVerdict): string {
  const used = verdict.used.map(pretty).filter(Boolean);
  const skipped = verdict.skipped.map(pretty).filter(Boolean);
  if (used.length === 0 && skipped.length === 0) return '';
  const parts: string[] = [];
  if (used.length > 0) parts.push(`✓ ${used.join(',')}`);
  if (skipped.length > 0) parts.push(`⚠ ${skipped.join(',')}`);
  return `*[wf:${parts.join(' | ')}]*`;
}

/**
 * Insert the workflow tag into agent text, placing it BEFORE any trailing mood
 * tag so existing mood-tag parsing remains intact.
 */
export function injectWorkflowTag(text: string, tag: string): string {
  if (!tag) return text;
  const moodMatch = text.match(MOOD_TAG_DIST) || text.match(MOOD_TAG_SIMPLE);
  if (moodMatch) {
    const moodTag = moodMatch[0];
    const before = text
      .slice(0, moodMatch.index ?? text.length - moodTag.length)
      .trimEnd();
    return `${before}\n\n${tag}${moodTag}`;
  }
  return `${text.trimEnd()}\n\n${tag}`;
}

/**
 * Strip *[wf:...]* tags entirely from text (for channels that can't show them).
 */
export function stripWorkflowTags(text: string): string {
  return text.replace(WF_TAG_REGEX_GLOBAL, '').trim();
}

/**
 * Convert a *[wf:...]* tag in `text` to a human-readable italic suffix
 * (e.g. for WhatsApp/Telegram). Returns the text unchanged if no tag is present.
 */
export function formatWorkflowTagInline(text: string): string {
  const m = text.match(WF_TAG_REGEX);
  if (!m) return text;
  const body = m[1].trim();
  // Reconstruct a friendly suffix. Body looks like: "✓ a,b | ⚠ c,d" or just one side.
  const segments = body
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const friendly = segments
    .map((seg) => {
      if (seg.startsWith('✓')) {
        const names = seg.slice(1).trim();
        return `✓ workflow: ${names}`;
      }
      if (seg.startsWith('⚠')) {
        const names = seg.slice(1).trim();
        return `⚠ skipped workflow: ${names}`;
      }
      return seg;
    })
    .join(' · ');
  const stripped = text.replace(WF_TAG_REGEX, '').trimEnd();
  return `${stripped}\n\n_— ${friendly}_`;
}

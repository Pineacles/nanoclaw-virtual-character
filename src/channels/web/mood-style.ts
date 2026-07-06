/**
 * Mood writing-style summarizer.
 *
 * Instead of injecting the full behavioral rules for each mood on every message
 * (which bloats the conversation transcript), we cache a single sentence written
 * by Claude Haiku that describes the writing style for the current blend.
 *
 * The cache is regenerated only when the distribution changes meaningfully.
 * Generation is fully async/non-blocking — the user's chat is never delayed.
 */

import fs from 'fs';
import {
  spawnEnv,
  tryAcquireHaikuSlot,
  releaseHaikuSlot,
} from '../../spawn-path.js';
import path from 'path';
import { spawn } from 'child_process';
import { GROUPS_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { getAssistantName, getGroupDir } from './group-config.js';

export interface MoodBehavior {
  rules: string;
  tone: string;
}

export interface CachedMoodStyle {
  distribution: Record<string, number>;
  energy: number;
  summary: string;
  generated_at: string;
}

function cachePath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'mood_style_cache.json');
}

/**
 * Read the cached mood style summary for a group, or null if missing/corrupt.
 */
export function getCachedMoodStyle(
  groupFolder: string,
): CachedMoodStyle | null {
  const p = cachePath(groupFolder);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (
      typeof raw?.summary === 'string' &&
      raw.distribution &&
      typeof raw.energy === 'number'
    ) {
      return raw as CachedMoodStyle;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Decide whether the new distribution differs enough from the old to warrant
 * regenerating the writing-style summary. Returns true if:
 *   - no previous distribution exists
 *   - the set of active moods changed (any mood added/removed)
 *   - any mood's weight shifted by ≥ 10 percentage points
 *   - the dominant mood changed
 */
export function shouldRegenerate(
  oldDist: Record<string, number> | undefined,
  newDist: Record<string, number>,
): boolean {
  if (!oldDist) return true;

  const oldKeys = new Set(Object.keys(oldDist));
  const newKeys = new Set(Object.keys(newDist));
  if (oldKeys.size !== newKeys.size) return true;
  for (const k of newKeys) if (!oldKeys.has(k)) return true;

  for (const k of newKeys) {
    const diff = Math.abs((newDist[k] || 0) - (oldDist[k] || 0));
    if (diff >= 10) return true;
  }

  const oldTop = Object.entries(oldDist).sort((a, b) => b[1] - a[1])[0]?.[0];
  const newTop = Object.entries(newDist).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (oldTop !== newTop) return true;

  return false;
}

/**
 * Build the prompt for Haiku. Includes ALL moods in the distribution
 * (unlimited blending — no top-N truncation).
 */
function buildHaikuPrompt(
  distribution: Record<string, number>,
  energy: number,
  behaviors: Record<string, MoodBehavior>,
): string {
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);

  const moodLines = sorted.map(([name, weight]) => {
    const b = behaviors[name];
    if (!b) return `- ${weight}% ${name}`;
    return `- ${weight}% ${name}: ${b.rules}${b.tone ? ` Tone examples: ${b.tone}` : ''}`;
  });

  const personaPath = path.join(getGroupDir(), '.system-prompt');
  let personaDesc = `a personal AI assistant named ${getAssistantName()}`;
  try {
    if (fs.existsSync(personaPath)) {
      const content = fs.readFileSync(personaPath, 'utf-8');
      personaDesc = content.slice(0, 500).replace(/\n/g, ' ').trim();
    }
  } catch {
    /* fallback to default */
  }

  return `You are summarizing a character's current writing style based on a blend of emotions she is feeling.

The character is ${getAssistantName()} — ${personaDesc}

Her current emotional blend is (weights are the strength of each mood):
${moodLines.join('\n')}

Energy level: ${energy}/10

Write ONE concise sentence (max 50 words) describing how she should write right now — message length, tone, word choice, what she does and doesn't do — given this specific blend. The sentence must reflect the WEIGHTS: a stronger mood dominates the voice, weaker moods only color it. Do not list the moods. Do not use the word "blend" or "mix". Write as a directive to the model (e.g. "Replies are short and dry, with..."). Return ONLY the sentence, nothing else.`;
}

/**
 * Fire-and-forget regeneration of the mood style summary.
 * Spawns the `claude` CLI in --print mode with Haiku, writes the cache when done.
 * Never throws. Never blocks. Errors are logged.
 */
export function regenerateMoodStyleAsync(
  groupFolder: string,
  distribution: Record<string, number>,
  energy: number,
  behaviors: Record<string, MoodBehavior>,
): void {
  const prompt = buildHaikuPrompt(distribution, energy, behaviors);

  // Don't await — fire and forget.
  if (!tryAcquireHaikuSlot()) {
    logger.debug(
      { groupFolder },
      'Mood style regen skipped — haiku slots saturated',
    );
    return;
  }
  void (async () => {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn(
          'claude',
          ['--print', '--model', 'claude-haiku-4-5-20251001'],
          {
            timeout: 30000,
            env: spawnEnv(),
          },
        );
        let out = '';
        let err = '';
        proc.stdout.on('data', (d: Buffer) => {
          out += d.toString();
        });
        proc.stderr.on('data', (d: Buffer) => {
          err += d.toString();
        });
        proc.on('close', (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`claude exit ${code}: ${err}`));
        });
        proc.on('error', reject);
        proc.stdin.write(prompt);
        proc.stdin.end();
      });

      const summary = stdout
        .trim()
        .replace(/^["']|["']$/g, '')
        .trim();
      if (!summary || summary.length > 500) {
        logger.warn(
          { groupFolder, length: summary.length },
          'Mood style summary empty or too long, skipping cache write',
        );
        return;
      }

      const cached: CachedMoodStyle = {
        distribution,
        energy,
        summary,
        generated_at: new Date().toISOString(),
      };
      const p = cachePath(groupFolder);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(cached, null, 2), 'utf-8');
      logger.info({ groupFolder, summary }, 'Mood style summary regenerated');
    } catch (err) {
      logger.error(
        { err, groupFolder },
        'Failed to regenerate mood style summary',
      );
    } finally {
      releaseHaikuSlot();
    }
  })();
}

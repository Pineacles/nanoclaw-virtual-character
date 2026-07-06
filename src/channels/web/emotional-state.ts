/**
 * Emotional state auto-generator.
 *
 * The assistant was originally instructed to maintain emotional_state.json by hand
 * during conversations — but rarely does (cognitive load, no feedback loop).
 * This module fires a fire-and-forget Haiku call after responses to
 * generate the file automatically. Smart triggering keeps the call rate low.
 *
 * The READ side already exists in context-builder.ts loadEmotionalState() —
 * we only need to write the file. Auto-expiry (6h) is already handled there.
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
import { getAssistantName, getUserName, getGroupDir } from './group-config.js';

export interface EmotionalState {
  mood: string;
  energy: number;
  trigger: string;
  duration_messages: number;
  resolves_when: string;
  underlying: string;
  updated_at: string;
}

export interface RecentMessage {
  sender_name: string;
  content: string;
  is_bot_message: boolean;
}

interface RegenState {
  lastRunAt: number; // ms epoch
  messagesSinceLastRun: number;
}

// In-memory throttle state, keyed by groupFolder.
// (Process-local — resets on restart, which is fine.)
const regenState = new Map<string, RegenState>();

const REGEN_EVERY_N_MESSAGES = 3;
const FORCE_REGEN_AFTER_GAP_MS = 30 * 60 * 1000; // 30 min

function statePath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'emotional_state.json');
}

/**
 * Decide whether the emotional state should be regenerated right now.
 * Triggers:
 *   - First run for this group in this process
 *   - Last run was > 30 min ago (re-engagement after a break)
 *   - 3+ messages have arrived since last run
 *   - moodShifted=true (caller knows mood-style regen also fired this turn)
 */
export function shouldRegenerate(
  groupFolder: string,
  moodShifted: boolean,
): boolean {
  const now = Date.now();
  const state = regenState.get(groupFolder);
  if (!state) return true;
  if (now - state.lastRunAt > FORCE_REGEN_AFTER_GAP_MS) return true;
  if (state.messagesSinceLastRun >= REGEN_EVERY_N_MESSAGES) return true;
  if (moodShifted) return true;
  return false;
}

/**
 * Note that a message was just processed (used by the throttle counter).
 * Call this every turn even when not regenerating.
 */
export function noteMessage(groupFolder: string): void {
  const state = regenState.get(groupFolder);
  if (state) {
    state.messagesSinceLastRun += 1;
  } else {
    regenState.set(groupFolder, { lastRunAt: 0, messagesSinceLastRun: 1 });
  }
}

/**
 * Read the current emotional_state.json (or null if missing/invalid).
 * Used both as Haiku input (continuity) and as the previous-state baseline.
 */
function readCurrentState(groupFolder: string): EmotionalState | null {
  const p = statePath(groupFolder);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (typeof raw?.mood === 'string') return raw as EmotionalState;
  } catch {
    /* fallthrough */
  }
  return null;
}

function buildHaikuPrompt(
  recentMessages: RecentMessage[],
  currentMoodPrimary: string,
  currentEnergy: number,
  previousState: EmotionalState | null,
): string {
  const transcript = recentMessages
    .map(
      (m) =>
        `${m.sender_name}: ${m.content.replace(/^\[System:[^\]]*\]\n?/, '').slice(0, 300)}`,
    )
    .join('\n');

  const previousBlock = previousState
    ? `Previous emotional state (for continuity — update or carry forward, don't reset):\n${JSON.stringify(previousState, null, 2)}\n`
    : 'No previous emotional state on record.\n';

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

  return `You are reading recent messages between ${getUserName()} and ${getAssistantName()}. Don't summarize what was said. Capture the EMOTIONAL UNDERCURRENT — WHY ${getAssistantName()} might feel what she feels right now, and what would shift it.

${getAssistantName()} — ${personaDesc}

Her current mood (from the latest tag she emitted): ${currentMoodPrimary}, energy ${currentEnergy}/10

${previousBlock}

Recent conversation (oldest first):
${transcript}

Based on this, output a single JSON object in this exact format (no markdown fences, no extra text):
{
  "mood": "${currentMoodPrimary}",
  "energy": ${currentEnergy},
  "trigger": "<one short phrase: what's affecting her right now>",
  "duration_messages": <integer: roughly how many messages this thread has been going>,
  "resolves_when": "<one short phrase: what would shift it>",
  "underlying": "<one short phrase: deeper feeling under the surface mood>",
  "updated_at": "${new Date().toISOString()}"
}

If nothing emotionally significant is happening — she's just chill, no unresolved thread, conversation is functional/practical — return exactly:
{}

Don't fabricate emotional drama. Be honest. The empty object is a valid and important answer.`;
}

/**
 * Fire-and-forget regeneration. Spawns claude --print, parses JSON output,
 * writes emotional_state.json. Never throws. Never blocks.
 */
export function regenerateEmotionalStateAsync(
  groupFolder: string,
  recentMessages: RecentMessage[],
  currentMoodPrimary: string,
  currentEnergy: number,
): void {
  // Mark the throttle state immediately so concurrent calls don't double-fire
  regenState.set(groupFolder, {
    lastRunAt: Date.now(),
    messagesSinceLastRun: 0,
  });

  const previous = readCurrentState(groupFolder);
  const prompt = buildHaikuPrompt(
    recentMessages,
    currentMoodPrimary,
    currentEnergy,
    previous,
  );

  if (!tryAcquireHaikuSlot()) {
    logger.debug(
      { groupFolder },
      'Emotional state regen skipped — haiku slots saturated',
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

      const trimmed = stdout
        .trim()
        .replace(/^```json\s*|\s*```$/g, '')
        .trim();

      // Empty object → don't update the file (let existing state expire naturally)
      if (trimmed === '{}' || trimmed === '') {
        logger.info(
          { groupFolder },
          'Emotional state: nothing significant, leaving file unchanged',
        );
        return;
      }

      let parsed: EmotionalState;
      try {
        parsed = JSON.parse(trimmed) as EmotionalState;
      } catch (parseErr) {
        logger.warn(
          { groupFolder, output: trimmed.slice(0, 200) },
          'Emotional state: Haiku returned non-JSON, skipping',
        );
        return;
      }

      // Sanity check the shape
      if (
        !parsed.mood ||
        !parsed.trigger ||
        !parsed.resolves_when ||
        !parsed.underlying
      ) {
        logger.warn(
          { groupFolder, parsed },
          'Emotional state: incomplete object, skipping write',
        );
        return;
      }

      const p = statePath(groupFolder);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
      logger.info(
        { groupFolder, trigger: parsed.trigger, underlying: parsed.underlying },
        'Emotional state regenerated',
      );
    } catch (err) {
      logger.error(
        { err, groupFolder },
        'Failed to regenerate emotional state',
      );
    } finally {
      releaseHaikuSlot();
    }
  })();
}

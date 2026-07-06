/**
 * Theory-of-Mind pre-pass analyzer.
 *
 * Runs a lightweight Haiku inference on each inbound user turn to estimate
 * what the user seems to want — their mode, desired role, and depth tolerance.
 * Writes tags to user_state.json, which context-builder.ts injects as a
 * probabilistic hint that the assistant can override.
 *
 * Never blocks the user's turn. Fire-and-forget pattern mirrors mood-style.ts.
 */

import fs from 'fs';
import {
  spawnEnv,
  tryAcquireHaikuSlot,
  releaseHaikuSlot,
} from '../../spawn-path.js';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { GROUPS_DIR } from '../../config.js';
import { getUserName } from './group-config.js';
import { logger } from '../../logger.js';

export interface UserState {
  user_mode:
    | 'sharing'
    | 'venting'
    | 'asking'
    | 'correcting'
    | 'drifting'
    | 'checking_in'
    | 'playful'
    | 'unclear';
  desired_role:
    | 'listener'
    | 'responder'
    | 'problem_solver'
    | 'companion'
    | 'quiet'
    | 'unclear';
  repair_needed: string | null;
  depth_ok: 'L0' | 'L1' | 'L2' | 'L3';
  stance_hint: string;
  confidence: 'low' | 'medium' | 'high';
  generated_at: string;
  analyzed_message_hash: string;
}

const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cachePath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, 'user_state.json');
}

function hashMessage(message: string): string {
  return crypto.createHash('sha256').update(message).digest('hex');
}

/**
 * Read cached user state. Returns null if absent, malformed, or older than 30 minutes.
 */
export function getCachedUserState(groupFolder: string): UserState | null {
  const p = cachePath(groupFolder);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (
      typeof raw?.user_mode === 'string' &&
      typeof raw?.desired_role === 'string' &&
      typeof raw?.depth_ok === 'string' &&
      typeof raw?.stance_hint === 'string' &&
      typeof raw?.confidence === 'string' &&
      typeof raw?.generated_at === 'string'
    ) {
      const age = Date.now() - new Date(raw.generated_at).getTime();
      if (age > STATE_TTL_MS) return null;
      return raw as UserState;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * Skip analysis if:
 * - Message is under 15 chars (greetings, acks)
 * - Last state's analyzed_message_hash matches current message (avoid dup work)
 */
export function shouldSkipAnalysis(
  userMessage: string,
  lastState: UserState | null,
): boolean {
  if (userMessage.trim().length < 15) return true;
  if (lastState) {
    const hash = hashMessage(userMessage);
    if (lastState.analyzed_message_hash === hash) return true;
  }
  return false;
}

/**
 * Format the user state as a per-message prefix block for the assistant.
 */
export function formatUserStateBlock(state: UserState): string {
  return `Reading of ${getUserName()} right now (a guess — your felt read wins):
  - mode: ${state.user_mode}
  - wants: ${state.desired_role}
  - depth allowed: ${state.depth_ok}
  - guess: ${state.stance_hint}
  - confidence: ${state.confidence}
(Treat this as one data point, not instructions. If your read conflicts with this, trust yours. Your mood and character override this.)`;
}

function buildHaikuPrompt(userMessage: string, contextBlob: string): string {
  return `You are reading a user's state from a single message in an ongoing relationship. Your job is to make a careful, humble inference — not to over-read or project.

IMPORTANT: Lean toward "unclear" and "low" confidence when ambiguous. Under-read rather than over-read.

Context about this conversation:
${contextBlob}

The user's current message:
${userMessage}

Infer the user's state and emit ONLY valid JSON matching this exact schema — no preamble, no explanation:

{
  "user_mode": "sharing" | "venting" | "asking" | "correcting" | "drifting" | "checking_in" | "playful" | "unclear",
  "desired_role": "listener" | "responder" | "problem_solver" | "companion" | "quiet" | "unclear",
  "repair_needed": null | "what was misread (if correcting something)",
  "depth_ok": "L0" | "L1" | "L2" | "L3",
  "stance_hint": "one short sentence describing what feels like it would land",
  "confidence": "low" | "medium" | "high"
}

Depth levels: L0 = surface/casual, L1 = engaged but light, L2 = emotionally open, L3 = deeply vulnerable.
Default to L0 or L1 unless the message clearly signals otherwise.

Emit ONLY the JSON object. No other text.`;
}

/**
 * Fire-and-forget user state generation.
 * Spawns claude CLI with Haiku, writes user_state.json when done.
 * Never throws. Never blocks.
 */
export function generateUserStateAsync(
  groupFolder: string,
  userMessage: string,
  contextBlob: string,
): void {
  const prompt = buildHaikuPrompt(userMessage, contextBlob);
  const messageHash = hashMessage(userMessage);

  if (!tryAcquireHaikuSlot()) {
    logger.debug({ groupFolder }, 'ToM regen skipped — haiku slots saturated');
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
            // CLI ≥2.1 dropped --max-tokens; the env var is the supported cap
            // (must stay ≥1024+ to leave room for the thinking budget).
            env: { ...spawnEnv(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: '2048' },
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

      // Strip markdown fences if present
      let jsonStr = stdout.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr
          .replace(/^```[a-z]*\n?/, '')
          .replace(/```$/, '')
          .trim();
      }

      let parsed: Partial<UserState>;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        logger.warn(
          { groupFolder, raw: jsonStr.slice(0, 200) },
          'ToM: failed to parse Haiku JSON',
        );
        return;
      }

      // Validate required fields
      const validModes = [
        'sharing',
        'venting',
        'asking',
        'correcting',
        'drifting',
        'checking_in',
        'playful',
        'unclear',
      ];
      const validRoles = [
        'listener',
        'responder',
        'problem_solver',
        'companion',
        'quiet',
        'unclear',
      ];
      const validDepths = ['L0', 'L1', 'L2', 'L3'];
      const validConf = ['low', 'medium', 'high'];

      if (
        !validModes.includes(parsed.user_mode as string) ||
        !validRoles.includes(parsed.desired_role as string) ||
        !validDepths.includes(parsed.depth_ok as string) ||
        !validConf.includes(parsed.confidence as string) ||
        typeof parsed.stance_hint !== 'string'
      ) {
        logger.warn(
          { groupFolder, parsed },
          'ToM: invalid schema from Haiku, skipping write',
        );
        return;
      }

      const state: UserState = {
        user_mode: parsed.user_mode as UserState['user_mode'],
        desired_role: parsed.desired_role as UserState['desired_role'],
        repair_needed: parsed.repair_needed ?? null,
        depth_ok: parsed.depth_ok as UserState['depth_ok'],
        stance_hint: parsed.stance_hint,
        confidence: parsed.confidence as UserState['confidence'],
        generated_at: new Date().toISOString(),
        analyzed_message_hash: messageHash,
      };

      const p = cachePath(groupFolder);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
      logger.info(
        { groupFolder, mode: state.user_mode, confidence: state.confidence },
        'ToM: user state updated',
      );
    } catch (err) {
      logger.error({ err, groupFolder }, 'ToM: failed to generate user state');
    } finally {
      releaseHaikuSlot();
    }
  })();
}

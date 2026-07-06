/**
 * Cron task title auto-generator.
 *
 * When a scheduled task is created without a title (or with an empty/placeholder
 * one), this module fires a fire-and-forget Haiku call that reads the task's
 * prompt and generates a 3-5 word title, then UPDATEs the scheduled_tasks row.
 *
 * Mirrors the proven generateSessionTitle / mood-style / emotional-state pattern.
 * Never blocks task creation. Errors are logged but never thrown.
 */

import { spawn } from 'child_process';
import { spawnEnv } from '../../spawn-path.js';
import { logger } from '../../logger.js';

/**
 * Fire-and-forget Haiku call to generate a 3-5 word title for a scheduled task.
 * Reads the prompt, asks Haiku for a clean title, UPDATEs the scheduled_tasks row.
 */
export function regenerateCronTitleAsync(taskId: string, prompt: string): void {
  const haikuPrompt = `Generate a 3-5 word title for this scheduled task. Return ONLY the title, nothing else. No quotes, no punctuation, no markdown. Title-case capitalization.

Task prompt:
${prompt.slice(0, 1500)}`;

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
        proc.stdin.write(haikuPrompt);
        proc.stdin.end();
      });

      const title = stdout
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/^#+\s*/, '')
        .trim();

      if (!title || title.length > 60) {
        logger.warn(
          { taskId, length: title.length },
          'Cron title empty or too long, skipping update',
        );
        return;
      }

      // Dynamic import to avoid circular dependency (db.ts → cron-title.ts → db.ts)
      const { updateTask } = await import('../../db.js');
      updateTask(taskId, { title });
      logger.info({ taskId, title }, 'Cron title regenerated');
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to regenerate cron title');
    }
  })();
}

/**
 * Heuristic check: does this title look "lazy" enough that we should regen?
 * Used by createTask to decide whether to fire the regenerator.
 */
export function isLazyCronTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const t = title.trim();
  if (t.length === 0) return true;
  return false;
}

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * process.env takes precedence over .env file values — this allows
 * systemd EnvironmentFile overrides for multi-instance deployments.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const wanted = new Set(keys);
  const remaining = new Set(keys);

  // Check process.env first (set by systemd EnvironmentFile or shell)
  for (const key of wanted) {
    if (process.env[key]) {
      result[key] = process.env[key]!;
      remaining.delete(key);
    }
  }

  // If all keys found in process.env, skip .env file
  if (remaining.size === 0) return result;

  // Fall back to the instance's env file for remaining keys.
  // NANOCLAW_ENV_FILE lets each instance point at its OWN file so a
  // multi-instance deployment never silently inherits another instance's
  // values from a shared ./.env (e.g. ASSISTANT_NAME bleeding across personas).
  // Defaults to ./.env for single-instance installs.
  const envFile =
    process.env.NANOCLAW_ENV_FILE || path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return result;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!remaining.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

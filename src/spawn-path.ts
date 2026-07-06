/**
 * PATH for child processes that need the `claude` CLI and `node`.
 *
 * Service managers (systemd/launchd) often start NanoClaw with a minimal
 * PATH that misses user-local bin dirs. Earlier code appended a hardcoded
 * NVM dir from a previous machine, which silently broke when the install
 * moved. Derive the candidates from the running process instead.
 */
import os from 'os';
import path from 'path';

export function spawnPath(): string {
  const parts = [process.env.PATH ?? ''];
  // Directory of the node binary running this process
  parts.push(path.dirname(process.execPath));
  // Common user-local install locations for the claude CLI
  parts.push(path.join(os.homedir(), '.local', 'bin'));
  parts.push(path.join(os.homedir(), '.claude', 'local'));
  return parts.filter(Boolean).join(':');
}

/** Spread-ready env for spawning the claude CLI. */
export function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: spawnPath() };
}

/**
 * Soft cap on concurrent fire-and-forget Haiku CLI spawns (ToM, mood style,
 * emotional state). These are best-effort enrichment — on a fast message
 * burst it is better to skip a regeneration (the next message re-triggers
 * it) than to stack claude processes. Callers must pair tryAcquireHaikuSlot
 * with releaseHaikuSlot in a finally block.
 */
const MAX_CONCURRENT_HAIKU = 3;
let haikuInFlight = 0;

export function tryAcquireHaikuSlot(): boolean {
  if (haikuInFlight >= MAX_CONCURRENT_HAIKU) return false;
  haikuInFlight += 1;
  return true;
}

export function releaseHaikuSlot(): void {
  haikuInFlight = Math.max(0, haikuInFlight - 1);
}

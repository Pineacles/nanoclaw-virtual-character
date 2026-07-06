import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import { stripMoodTags } from './channels/web/mood.js';
import { stripInternalTags } from './router.js';
import fs from 'fs';
import path from 'path';

import { buildSystemAppend } from './channels/web/context-builder.js';
import { isFeatureEnabled } from './channels/web/group-config.js';
import { buildCronRoomContext } from './room/cron-bleed.js';
import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

const DECISION_MODE_SUFFIX = `\n\nBefore responding, decide whether to send a message. Respond by calling EXACTLY ONE of these actions using the tags below. Do NOT write anything else — any text outside the tags will be discarded.\n\nTo send a message to the user:\n<ACTION>reach_out</ACTION>\n<MESSAGE>your full message to the user here</MESSAGE>\n\nTo decide not to send anything:\n<ACTION>stay_silent</ACTION>\n<REASON>short reason (for logs only, never shown to user)</REASON>`;

export function parseDecisionOutput(raw: string): {
  action: 'reach_out' | 'stay_silent' | 'malformed';
  message?: string;
  reason?: string;
} {
  const actionMatch = raw.match(/<ACTION>(reach_out|stay_silent)<\/ACTION>/);
  if (!actionMatch) return { action: 'malformed' };
  const action = actionMatch[1] as 'reach_out' | 'stay_silent';
  if (action === 'reach_out') {
    const msgMatch = raw.match(/<MESSAGE>([\s\S]*?)<\/MESSAGE>/);
    return { action, message: msgMatch ? msgMatch[1].trim() : '' };
  }
  const reasonMatch = raw.match(/<REASON>([\s\S]*?)<\/REASON>/);
  return { action, reason: reasonMatch ? reasonMatch[1].trim() : '' };
}

const MAX_INLINE_BYTES = 32 * 1024;

export function buildTaskPrompt(task: ScheduledTask, groupDir: string): string {
  const parts: string[] = [];

  if (task.workflow_ref) {
    const wfPath = path.join(groupDir, 'workflows', `${task.workflow_ref}.md`);
    try {
      const contents = fs.readFileSync(wfPath, 'utf8');
      parts.push(`--- Workflow: ${task.workflow_ref} ---\n${contents}`);
    } catch {
      logger.warn(
        { taskId: task.id, workflow: task.workflow_ref },
        'Workflow file not found, skipping',
      );
    }
  }

  if (task.reference_files) {
    const files = task.reference_files
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
    for (const filename of files) {
      const refPath = path.join(groupDir, filename);
      try {
        const contents = fs.readFileSync(refPath, 'utf8');
        parts.push(`--- Reference: ${filename} ---\n${contents}`);
      } catch {
        logger.warn(
          { taskId: task.id, file: filename },
          'Reference file not found, skipping',
        );
      }
    }
  }

  // Room context block (Phase D)
  if (task.room_read_level && isFeatureEnabled('room_runtime')) {
    try {
      const roomContext = buildCronRoomContext(
        task.group_folder,
        task.room_read_level,
      );
      if (roomContext) parts.push(roomContext);
    } catch {
      /* silent — room.db missing */
    }
  }

  if (parts.length === 0) return task.prompt;

  parts.push(`--- Your task ---\n${task.prompt}`);
  let combined = parts.join('\n\n');

  if (Buffer.byteLength(combined, 'utf8') > MAX_INLINE_BYTES) {
    // Truncate: rebuild section by section, largest first
    const taskSection = `--- Your task ---\n${task.prompt}`;
    const budget =
      MAX_INLINE_BYTES - Buffer.byteLength(taskSection, 'utf8') - 4;
    const inlineParts = parts.slice(0, -1); // all except task section
    let used = 0;
    const trimmed: string[] = [];
    for (const p of inlineParts) {
      const bytes = Buffer.byteLength(p, 'utf8');
      if (used + bytes <= budget) {
        trimmed.push(p);
        used += bytes;
      } else {
        const remaining = budget - used;
        if (remaining > 64) {
          trimmed.push(p.slice(0, remaining) + '\n[truncated]');
        }
        break;
      }
    }
    combined = [...trimmed, taskSection].join('\n\n');
  }

  return combined;
}

/** Returns the persona system prompt for a task, or null to use the group default. */
export function loadPersona(
  task: ScheduledTask,
  groupDir: string,
): string | null {
  if (!task.run_as || task.run_as === 'default' || task.run_as === '')
    return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(task.run_as)) {
    logger.warn(
      { taskId: task.id, runAs: task.run_as },
      'Invalid run_as name, using default',
    );
    return null;
  }
  const personaPath = path.join(groupDir, 'personas', `${task.run_as}.md`);
  if (!fs.existsSync(personaPath)) {
    logger.warn(
      { taskId: task.id, runAs: task.run_as, path: personaPath },
      'Persona file not found, using default',
    );
    return null;
  }
  try {
    return fs.readFileSync(personaPath, 'utf-8');
  } catch (err) {
    logger.warn({ taskId: task.id, err }, 'Failed to read persona file');
    return null;
  }
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  // Dynamic schedule — agent writes next check-in time to a file after each run.
  // File: groups/<group>/next_checkin.json with { "next_run_at": "ISO", "reason": "..." }
  // Safe bounds: min 20 minutes, max 12 hours. Falls back to 1h if missing/invalid.
  if (task.schedule_type === 'dynamic') {
    const MIN_GAP_MS = 20 * 60 * 1000; // 20 min floor
    const MAX_GAP_MS = 12 * 60 * 60 * 1000; // 12 hour ceiling
    const FALLBACK_MS = 60 * 60 * 1000; // 1 hour if file missing/invalid
    try {
      const groupDir = resolveGroupFolderPath(task.group_folder);
      const checkinPath = path.join(groupDir, 'next_checkin.json');
      if (fs.existsSync(checkinPath)) {
        const raw = JSON.parse(fs.readFileSync(checkinPath, 'utf-8'));
        if (raw.next_run_at && typeof raw.next_run_at === 'string') {
          const requested = new Date(raw.next_run_at).getTime();
          if (!isNaN(requested)) {
            const gap = requested - now;
            const boundedGap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, gap));
            const boundedAt = new Date(now + boundedGap).toISOString();
            logger.info(
              {
                taskId: task.id,
                requested: raw.next_run_at,
                chosen: boundedAt,
                reason: raw.reason,
              },
              'Dynamic schedule — next check-in set by agent',
            );
            return boundedAt;
          }
        }
      }
    } catch (err) {
      logger.warn(
        { taskId: task.id, err },
        'Dynamic schedule — failed to read next_checkin.json, using fallback',
      );
    }
    return new Date(now + FALLBACK_MS).toISOString();
  }

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  // Inject current date/time so the agent always knows when the task is running,
  // even if the session context has been compacted and lost date awareness.
  const taskNow = new Date().toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const basePrompt = buildTaskPrompt(task, groupDir);
  const withDecision =
    task.decision_mode === 1 ? basePrompt + DECISION_MODE_SUFFIX : basePrompt;
  const taskPrompt = `[Current date/time: ${taskNow}]\n\n${withDecision}`;

  // Build system instruction: persona override if set, otherwise group default.
  const persona = loadPersona(task, groupDir);
  let systemInstruction: string | undefined;
  if (persona) {
    systemInstruction = persona;
  } else {
    try {
      systemInstruction = buildSystemAppend({
        sessionId: sessionId || 'default',
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
      });
    } catch (err) {
      logger.warn(
        { err, taskId: task.id },
        'Failed to build systemAppend for task, continuing without it',
      );
    }
  }

  const personaPrefix =
    task.run_as && task.run_as !== 'default' && task.run_as !== ''
      ? `[${task.run_as}] `
      : '';

  let hasSent = false;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: taskPrompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        systemInstruction,
        model: task.model ?? undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result && !hasSent) {
          result = streamedOutput.result;
          hasSent = true;
          if (task.decision_mode === 1) {
            const decision = parseDecisionOutput(streamedOutput.result);
            if (decision.action === 'reach_out' && decision.message) {
              await deps.sendMessage(
                task.chat_jid,
                personaPrefix + decision.message,
              );
            } else if (decision.action === 'stay_silent') {
              logger.info(
                { taskId: task.id, reason: decision.reason },
                'Task decided to stay silent',
              );
            } else {
              logger.warn(
                { taskId: task.id },
                'Task output malformed — not sending',
              );
            }
          } else {
            const visible = stripInternalTags(
              stripMoodTags(streamedOutput.result),
            );
            if (visible) {
              await deps.sendMessage(task.chat_jid, personaPrefix + visible);
            } else {
              logger.info(
                { taskId: task.id },
                'Task result internal-only — nothing sent',
              );
            }
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Run a task immediately (test run or ad-hoc execution).
 * Does NOT update next_run or mark once-tasks as completed.
 */
export interface TaskProgressEvent {
  type: 'task_started' | 'task_progress' | 'task_complete';
  taskId: string;
  tool?: string;
  target?: string;
  status?: string;
  result?: string | null;
  error?: string | null;
  duration_ms?: number;
}

export async function runTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
  onProgress?: (event: TaskProgressEvent) => void,
): Promise<{
  status: string;
  result: string | null;
  error: string | null;
  duration_ms: number;
}> {
  const task = getTaskById(taskId);
  if (!task) {
    logger.warn({ taskId }, 'runTaskNow: task not found');
    return {
      status: 'error',
      result: null,
      error: 'Task not found',
      duration_ms: 0,
    };
  }
  logger.info(
    { taskId, prompt: task.prompt.slice(0, 80) },
    'runTaskNow: starting',
  );
  if (task.status !== 'active') {
    return {
      status: 'error',
      result: null,
      error: `Task status is '${task.status}', must be 'active'`,
      duration_ms: 0,
    };
  }

  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      status: 'error',
      result: null,
      error,
      duration_ms: Date.now() - startTime,
    };
  }
  fs.mkdirSync(groupDir, { recursive: true });

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );
  if (!group) {
    return {
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
      duration_ms: Date.now() - startTime,
    };
  }

  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // Write close sentinel directly — runTaskNow bypasses the queue's active
  // state tracking, so queue.closeStdin() would silently no-op.
  const writeCloseSentinel = () => {
    const inputDir = path.join(
      process.cwd(),
      'data',
      'ipc',
      task.group_folder,
      'input',
    );
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  };

  const scheduleClose = () => {
    if (closeTimer) return;
    closeTimer = setTimeout(writeCloseSentinel, TASK_CLOSE_DELAY_MS);
  };

  // Inject current date/time for task context
  const runNow = new Date().toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const runNowBase = buildTaskPrompt(task, groupDir);
  const runNowWithDecision =
    task.decision_mode === 1 ? runNowBase + DECISION_MODE_SUFFIX : runNowBase;
  const runNowPrompt = `[Current date/time: ${runNow}]\n\n${runNowWithDecision}`;

  const runNowPersona = loadPersona(task, groupDir);
  let runNowSystemInstruction: string | undefined;
  if (runNowPersona) {
    runNowSystemInstruction = runNowPersona;
  } else {
    try {
      runNowSystemInstruction = buildSystemAppend({
        sessionId: sessionId || 'default',
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
      });
    } catch {
      // continue without system instruction
    }
  }

  const runNowPersonaPrefix =
    task.run_as && task.run_as !== 'default' && task.run_as !== ''
      ? `[${task.run_as}] `
      : '';

  let hasSent = false;

  onProgress?.({ type: 'task_started', taskId });

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: runNowPrompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        systemInstruction: runNowSystemInstruction,
        model: task.model ?? undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.toolUse) {
          onProgress?.({
            type: 'task_progress',
            taskId,
            tool: streamedOutput.toolUse.tool,
            target: streamedOutput.toolUse.target,
          });
        }
        if (streamedOutput.result && !hasSent) {
          result = streamedOutput.result;
          hasSent = true;
          if (task.decision_mode === 1) {
            const decision = parseDecisionOutput(streamedOutput.result);
            if (decision.action === 'reach_out' && decision.message) {
              await deps.sendMessage(
                task.chat_jid,
                runNowPersonaPrefix + decision.message,
              );
            } else if (decision.action === 'stay_silent') {
              logger.info(
                { taskId: task.id, reason: decision.reason },
                'Task decided to stay silent',
              );
            } else {
              logger.warn(
                { taskId: task.id },
                'Task output malformed — not sending',
              );
            }
          } else {
            const visibleNow = stripInternalTags(
              stripMoodTags(streamedOutput.result),
            );
            if (visibleNow) {
              await deps.sendMessage(
                task.chat_jid,
                runNowPersonaPrefix + visibleNow,
              );
            } else {
              logger.info(
                { taskId: task.id },
                'Task result internal-only — nothing sent',
              );
            }
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startTime;
  onProgress?.({
    type: 'task_complete',
    taskId,
    status: error ? 'error' : 'success',
    result,
    error,
    duration_ms: durationMs,
  });

  // Log the run but do NOT update next_run or mark as completed (test/ad-hoc run)
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  return {
    status: error ? 'error' : 'success',
    result,
    error,
    duration_ms: durationMs,
  };
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}

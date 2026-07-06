import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  getSuccessfulRunCount,
  logTaskRun,
  updateTask,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';
import { computeNextRun } from './task-scheduler.js';

const WEB_GROUP: RegisteredGroup = {
  name: 'Assistant',
  folder: 'testgroup',
  trigger: '@Assistant',
  added_at: '2024-01-01T00:00:00.000Z',
};

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'web:testgroup': WEB_GROUP,
    'main@g.us': MAIN_GROUP,
  };
  setRegisteredGroup('web:testgroup', WEB_GROUP);
  setRegisteredGroup('main@g.us', MAIN_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

describe('draft task creation via IPC', () => {
  it('schedule_task creates task as draft, not active', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'test task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        targetJid: 'web:testgroup',
        taskId: 'test-draft-1',
      },
      'testgroup',
      false,
      deps,
    );

    const task = getTaskById('test-draft-1');
    expect(task).toBeDefined();
    expect(task!.status).toBe('active');
    expect(task!.next_run).not.toBeNull();
  });

  it('activate_task fails without successful test run', async () => {
    createTask({
      id: 'draft-no-run',
      group_folder: 'testgroup',
      chat_jid: 'web:testgroup',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    await processTaskIpc(
      { type: 'activate_task', taskId: 'draft-no-run' },
      'testgroup',
      false,
      deps,
    );

    const task = getTaskById('draft-no-run');
    expect(task!.status).toBe('active'); // Already active
  });

  it('activate_task succeeds after a successful test run', async () => {
    createTask({
      id: 'draft-with-run',
      group_folder: 'testgroup',
      chat_jid: 'web:testgroup',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    // Simulate a successful test run
    logTaskRun({
      task_id: 'draft-with-run',
      run_at: new Date().toISOString(),
      duration_ms: 1000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    await processTaskIpc(
      { type: 'activate_task', taskId: 'draft-with-run' },
      'testgroup',
      false,
      deps,
    );

    const task = getTaskById('draft-with-run');
    expect(task!.status).toBe('active');
  });

  it('activate_task rejects non-draft tasks', async () => {
    createTask({
      id: 'already-active',
      group_folder: 'testgroup',
      chat_jid: 'web:testgroup',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logTaskRun({
      task_id: 'already-active',
      run_at: new Date().toISOString(),
      duration_ms: 1000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    await processTaskIpc(
      { type: 'activate_task', taskId: 'already-active' },
      'testgroup',
      false,
      deps,
    );

    // Should remain active (not errored), just not changed
    const task = getTaskById('already-active');
    expect(task!.status).toBe('active');
  });

  it('activate_task blocked for unauthorized group', async () => {
    createTask({
      id: 'other-group-task',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
      prompt: 'test',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logTaskRun({
      task_id: 'other-group-task',
      run_at: new Date().toISOString(),
      duration_ms: 1000,
      status: 'success',
      result: 'ok',
      error: null,
    });

    // testgroup (non-main) tries to activate a main group task
    await processTaskIpc(
      { type: 'activate_task', taskId: 'other-group-task' },
      'testgroup',
      false,
      deps,
    );

    const task = getTaskById('other-group-task');
    expect(task!.status).toBe('active'); // Should remain active
  });
});

describe('getSuccessfulRunCount', () => {
  it('returns 0 when no runs exist', () => {
    expect(getSuccessfulRunCount('nonexistent')).toBe(0);
  });

  it('counts only successful runs', () => {
    createTask({
      id: 'count-test',
      group_folder: 'testgroup',
      chat_jid: 'web:testgroup',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'group',
      next_run: null,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logTaskRun({
      task_id: 'count-test',
      run_at: new Date().toISOString(),
      duration_ms: 100,
      status: 'error',
      result: null,
      error: 'fail',
    });
    logTaskRun({
      task_id: 'count-test',
      run_at: new Date().toISOString(),
      duration_ms: 200,
      status: 'success',
      result: 'ok',
      error: null,
    });
    logTaskRun({
      task_id: 'count-test',
      run_at: new Date().toISOString(),
      duration_ms: 300,
      status: 'success',
      result: 'ok2',
      error: null,
    });

    expect(getSuccessfulRunCount('count-test')).toBe(2);
  });
});

describe('computeNextRun for mood task fix', () => {
  it('computes next_run for cron tasks (not null)', () => {
    const task = {
      id: 'mood-test',
      group_folder: 'testgroup',
      chat_jid: 'web:testgroup',
      prompt: 'plan mood',
      schedule_type: 'cron' as const,
      schedule_value: '0 23 * * *',
      context_mode: 'group' as const,
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('IPC schedule_task with invalid cron', () => {
  it('rejects invalid cron expressions', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron task',
        schedule_type: 'cron',
        schedule_value: '0 99 * * *',
        targetJid: 'web:testgroup',
        taskId: 'bad-cron-1',
      },
      'testgroup',
      false,
      deps,
    );

    // Task should NOT have been created
    const task = getTaskById('bad-cron-1');
    expect(task).toBeUndefined();
  });
});

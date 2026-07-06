/**
 * useTasks — adapted from web-ui-legacy/src/hooks/useTasks.ts
 * Same REST endpoints: /api/tasks, /api/tasks/:id, /api/tasks/:id/run
 * Live progress via WS task_started / task_progress / task_complete events.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';

export interface Task {
  id: string;
  title: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  status: 'active' | 'paused' | 'completed' | 'draft';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  created_at: string;
  run_as?: string;
  decision_mode?: number;
  workflow_ref?: string | null;
  reference_files?: string | null;
  model?: string | null;
}

export interface TaskProgress {
  tool: string;
  target?: string;
}

export interface TaskEvent {
  type: 'task_started' | 'task_progress' | 'task_complete';
  taskId: string;
  tool?: string;
  target?: string;
  status?: string;
  result?: string | null;
  error?: string | null;
  duration_ms?: number;
}

export interface UseTasksResult {
  tasks: Task[];
  runningTaskIds: Set<string>;
  taskProgress: Record<string, TaskProgress>;
  isLoading: boolean;
  refresh: () => Promise<void>;
  createTask: (task: {
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    title?: string;
  }) => Promise<void>;
  updateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  testRun: (taskId: string) => Promise<void>;
  handleTaskEvent: (event: TaskEvent) => void;
}

export function useTasks(authenticated: boolean): UseTasksResult {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());
  const [taskProgress, setTaskProgress] = useState<Record<string, TaskProgress>>({});
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setIsLoading(true);
    try {
      const data = await api.get<Task[]>('/api/tasks');
      setTasks(data);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createTask = useCallback(async (task: {
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    title?: string;
  }) => {
    await api.post('/api/tasks', task);
    await refresh();
  }, [refresh]);

  const updateTask = useCallback(async (id: string, updates: Partial<Task>) => {
    await api.put(`/api/tasks/${id}`, updates);
    await refresh();
  }, [refresh]);

  const deleteTask = useCallback(async (id: string) => {
    await api.delete(`/api/tasks/${id}`);
    await refresh();
  }, [refresh]);

  const testRun = useCallback(async (taskId: string) => {
    await api.post<{ status: string; taskId: string }>(`/api/tasks/${taskId}/run`, {});
  }, []);

  const handleTaskEvent = useCallback((event: TaskEvent) => {
    if (event.type === 'task_started') {
      setRunningTaskIds((prev) => new Set(prev).add(event.taskId));
      setTaskProgress((prev) => {
        const next = { ...prev };
        delete next[event.taskId];
        return next;
      });
    }
    if (event.type === 'task_progress' && event.tool) {
      setTaskProgress((prev) => ({
        ...prev,
        [event.taskId]: { tool: event.tool!, target: event.target },
      }));
    }
    if (event.type === 'task_complete') {
      setRunningTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(event.taskId);
        return next;
      });
      setTaskProgress((prev) => {
        const next = { ...prev };
        delete next[event.taskId];
        return next;
      });
      void refresh();
    }
  }, [refresh]);

  return {
    tasks,
    runningTaskIds,
    taskProgress,
    isLoading,
    refresh,
    createTask,
    updateTask,
    deleteTask,
    testRun,
    handleTaskEvent,
  };
}

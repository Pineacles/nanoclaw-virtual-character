import { useState } from 'react';
import { cn } from '../../lib/cn';
import { IconPlus, IconX } from '../../components/icons';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { useTasks } from '../../hooks/useTasks';
import { TaskList } from './TaskList';

interface TasksPageProps {
  isMobile: boolean;
  authenticated: boolean;
}

type ScheduleType = 'cron' | 'interval' | 'once';

/**
 * Tasks page — full-page task manager.
 * Header with subtitle (active/paused counts) and "+ New task" button.
 * Body: TaskList (Active first, then Paused).
 * New task form appears inline below header.
 */
export function TasksPage({ isMobile, authenticated }: TasksPageProps) {
  const {
    tasks,
    runningTaskIds,
    taskProgress,
    isLoading,
    createTask,
    updateTask,
    deleteTask,
    testRun,
  } = useTasks(authenticated);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [newScheduleType, setNewScheduleType] = useState<ScheduleType>('cron');
  const [newScheduleValue, setNewScheduleValue] = useState('');
  const [createError, setCreateError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const activeCount = tasks.filter((t) => t.status === 'active').length;
  const pausedCount = tasks.filter((t) => t.status === 'paused').length;
  const subtitle = isLoading
    ? 'Loading…'
    : `${activeCount} active · ${pausedCount} paused`;

  const handleCreate = async () => {
    if (!newPrompt.trim()) { setCreateError('Prompt is required'); return; }
    if (newScheduleType !== 'once' && !newScheduleValue.trim()) {
      setCreateError('Schedule value is required');
      return;
    }
    setIsCreating(true);
    setCreateError('');
    try {
      await createTask({
        prompt: newPrompt.trim(),
        schedule_type: newScheduleType,
        schedule_value: newScheduleValue.trim(),
      });
      setShowNewForm(false);
      setNewPrompt('');
      setNewScheduleValue('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Error creating task');
    } finally {
      setIsCreating(false);
    }
  };

  const handlePause = (id: string) => void updateTask(id, { status: 'paused' });
  const handleResume = (id: string) => void updateTask(id, { status: 'active' });
  const handleDelete = (id: string) => void deleteTask(id);
  const handleRunNow = (id: string) => void testRun(id);
  const handleUpdate = (id: string, updates: Partial<typeof tasks[0]>) => void updateTask(id, updates);

  const inputClass = cn(
    'w-full h-9 px-3 rounded-[8px] border border-nc-border bg-nc-surface',
    'text-[13px] text-nc-text outline-none focus:border-nc-accent',
    'transition-colors duration-[--nc-dur-micro] placeholder:text-nc-text-dim',
  );

  return (
    <BackgroundMesh variant="filled" className="flex flex-col h-full">
      {/* Page header */}
      <div
        className={cn(
          'nc-page flex-shrink-0 bg-nc-bg border-b border-nc-border-soft',
          'flex items-center justify-between',
          isMobile ? 'px-4 py-3 h-14' : 'px-6 py-4',
        )}
      >
        <div>
          <h1 className={cn('text-nc-text font-semibold tracking-[-0.01em] m-0', isMobile ? 'text-[15px]' : 'text-[17px]')}>
            Tasks
          </h1>
          <p className="text-[12px] text-nc-text-dim m-0 mt-0.5">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => setShowNewForm((v) => !v)}
          aria-label={showNewForm ? 'Cancel new task' : 'New task'}
          className={cn(
            'nc-press flex items-center gap-1.5 cursor-pointer text-white font-medium rounded-[8px]',
            showNewForm ? 'border border-nc-border bg-nc-surface text-nc-text-muted px-3 py-[6px]' : 'nc-gradient-fill',
            isMobile ? 'w-8 h-8 justify-center' : 'px-3 py-[6px] text-[13px]',
          )}
          style={!showNewForm ? { boxShadow: '0 1px 3px var(--nc-accent)40' } : undefined}
        >
          {showNewForm ? <IconX size={14} /> : <IconPlus size={14} />}
          {!isMobile && (showNewForm ? 'Cancel' : 'New task')}
        </button>
      </div>

      {/* New task form */}
      {showNewForm && (
        <div className={cn(
          'nc-page flex-shrink-0 bg-nc-surface border-b border-nc-border-soft',
          'px-4 py-4 flex flex-col gap-3',
          isMobile ? 'px-4' : 'px-6',
        )}>
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="Describe what this task should do…"
            aria-label="Task prompt"
            rows={3}
            className={cn(
              'w-full px-3 py-2 rounded-[8px] border border-nc-border bg-nc-bg',
              'text-[13px] text-nc-text outline-none focus:border-nc-accent resize-none',
              'transition-colors duration-[--nc-dur-micro] placeholder:text-nc-text-dim',
            )}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={newScheduleType}
              onChange={(e) => setNewScheduleType(e.target.value as ScheduleType)}
              aria-label="Schedule type"
              className={cn(inputClass, 'w-auto pr-8')}
            >
              <option value="cron">Cron</option>
              <option value="interval">Interval</option>
              <option value="once">Once</option>
            </select>
            {newScheduleType !== 'once' && (
              <input
                type="text"
                value={newScheduleValue}
                onChange={(e) => setNewScheduleValue(e.target.value)}
                placeholder={newScheduleType === 'cron' ? '0 7 * * *' : '4h'}
                aria-label="Schedule value"
                className={cn(inputClass, 'flex-1 min-w-[120px]')}
              />
            )}
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={isCreating}
              aria-label="Create task"
              className="nc-press nc-gradient-fill h-9 px-4 rounded-[8px] text-[13px] text-white font-medium disabled:opacity-50 cursor-pointer flex-shrink-0"
            >
              {isCreating ? 'Creating…' : 'Create'}
            </button>
          </div>
          {createError && <p className="text-[12px] text-red-500 m-0">{createError}</p>}
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        <div className={cn(
          'mx-auto py-5',
          isMobile ? 'px-4 max-w-full' : 'px-6 max-w-[760px]',
        )}>
          <TaskList
            tasks={tasks}
            runningTaskIds={runningTaskIds}
            taskProgress={taskProgress}
            onRunNow={handleRunNow}
            onPause={handlePause}
            onResume={handleResume}
            onDelete={handleDelete}
            onUpdate={handleUpdate}
          />
        </div>
      </div>
    </BackgroundMesh>
  );
}

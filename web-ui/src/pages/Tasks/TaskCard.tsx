import { useState } from 'react';
import { cn } from '../../lib/cn';
import {
  IconClock, IconSpinner, IconPlay, IconPause, IconEdit, IconTrash, IconChevronDown, IconCheck, IconX,
} from '../../components/icons';
import { TaskScheduleBadge } from './TaskScheduleBadge';
import type { Task, TaskProgress } from '../../hooks/useTasks';

interface TaskCardProps {
  task: Task;
  isRunning: boolean;
  progress: TaskProgress | undefined;
  onRunNow: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Task>) => void;
}

/**
 * Collapsible task card.
 * Collapsed: icon + title + schedule + status badge.
 * Expanded: prompt, live progress indicator, last result, action row.
 * Expand/collapse uses nc-ease-state at 240ms.
 */
export function TaskCard({
  task,
  isRunning,
  progress,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onUpdate,
}: TaskCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editPrompt, setEditPrompt] = useState(task.prompt);
  const [editScheduleType, setEditScheduleType] = useState<Task['schedule_type']>(task.schedule_type);
  const [editScheduleValue, setEditScheduleValue] = useState(task.schedule_value);
  const [isSaving, setIsSaving] = useState(false);

  const startEdit = () => {
    setEditTitle(task.title);
    setEditPrompt(task.prompt);
    setEditScheduleType(task.schedule_type);
    setEditScheduleValue(task.schedule_value);
    setIsEditing(true);
  };

  const cancelEdit = () => setIsEditing(false);

  const saveEdit = async () => {
    setIsSaving(true);
    try {
      onUpdate(task.id, {
        title: editTitle.trim() || task.title,
        prompt: editPrompt.trim() || task.prompt,
        schedule_type: editScheduleType,
        schedule_value: editScheduleValue.trim(),
      });
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const isActive = task.status === 'active';
  const isPaused = task.status === 'paused';

  const ScheduleIcon = task.schedule_type === 'interval' ? IconSpinner : IconClock;

  return (
    <div
      className={cn(
        'nc-page rounded-[12px] border overflow-hidden',
        'bg-nc-surface border-nc-border',
      )}
    >
      {/* Card header — click to expand */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`${task.title} — ${expanded ? 'collapse' : 'expand'}`}
        className={cn(
          'w-full px-3.5 py-3 flex items-center gap-3 cursor-pointer',
          'bg-transparent border-none text-left',
          'hover:bg-nc-surface-alt transition-colors duration-[--nc-dur-micro]',
        )}
      >
        {/* Status icon */}
        <span
          aria-hidden="true"
          className={cn(
            'w-8 h-8 rounded-[8px] flex-shrink-0 flex items-center justify-center',
            isActive ? 'bg-nc-accent-soft text-nc-accent' : 'bg-nc-surface-hi text-nc-text-dim',
          )}
        >
          {isRunning
            ? <IconSpinner size={14} className="text-nc-accent" />
            : <ScheduleIcon size={14} />
          }
        </span>

        {/* Title + schedule */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13.5px] text-nc-text font-medium">{task.title}</span>
            {isRunning && (
              <span className="text-[10.5px] px-[7px] py-[1px] rounded-pill bg-nc-accent-soft text-nc-accent font-medium">
                running
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <TaskScheduleBadge scheduleType={task.schedule_type} scheduleValue={task.schedule_value} />
            {task.next_run && (
              <span className="text-[11.5px] text-nc-text-dim">
                · next {task.next_run}
              </span>
            )}
          </div>
        </div>

        {/* Status badge + chevron */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className={cn(
              'text-[10.5px] px-2 py-[2px] rounded-pill font-medium uppercase tracking-[0.04em]',
              isActive ? 'bg-nc-accent-soft text-nc-accent' : 'bg-nc-surface-hi text-nc-text-dim',
            )}
          >
            {task.status}
          </span>
          <IconChevronDown
            size={12}
            className={cn(
              'text-nc-text-dim transition-transform',
              expanded && 'rotate-180',
            )}
            style={{ transition: `transform var(--nc-dur-standard) var(--nc-ease-state)` }}
          />
        </div>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div
          className="px-3.5 pb-3.5 border-t border-nc-border-soft pt-3"
          style={{ animation: `@media (prefers-reduced-motion: no-preference) { nc-page var(--nc-dur-standard) }` }}
        >
          {/* Prompt */}
          <div className="text-[11px] text-nc-text-dim font-medium uppercase tracking-[0.04em] mb-1.5">
            Prompt
          </div>
          <div className="text-[13px] text-nc-text leading-[1.55] mb-3.5">
            {task.prompt}
          </div>

          {/* Live progress */}
          {isRunning && progress && (
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-[8px] mb-3',
                'bg-nc-accent-soft border border-nc-accent/20',
              )}
            >
              <span
                aria-hidden="true"
                className="w-1.5 h-1.5 rounded-full bg-nc-accent nc-pulse-anim flex-shrink-0"
              />
              <span className="text-[11.5px] text-nc-text">
                Working:{' '}
                <span
                  className="text-nc-accent font-mono"
                  style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
                >
                  {progress.tool}{progress.target ? ` → ${progress.target}` : ''}
                </span>
              </span>
            </div>
          )}

          {/* Last result */}
          {task.last_result && (
            <div className="mb-3.5">
              <div className="text-[11px] text-nc-text-dim font-medium uppercase tracking-[0.04em] mb-1.5">
                Last result
              </div>
              <div
                className={cn(
                  'text-[12.5px] text-nc-text-muted leading-[1.55]',
                  'px-2.5 py-2 rounded-[7px] bg-nc-surface-alt font-mono',
                )}
                style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
              >
                {task.last_result.slice(0, 200)}
                {task.last_result.length > 200 && '…'}
              </div>
            </div>
          )}

          {/* Inline edit form */}
          {isEditing && (
            <div className="mb-3.5 flex flex-col gap-2 p-3 rounded-[9px] border border-nc-border bg-nc-surface-alt">
              <div>
                <label className="text-[10.5px] text-nc-text-dim font-medium uppercase tracking-[0.04em] block mb-1">Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  aria-label="Task title"
                  className="w-full h-8 px-2.5 text-[12.5px] rounded-[6px] border border-nc-border bg-nc-bg text-nc-text outline-none focus:border-nc-accent transition-colors duration-[--nc-dur-micro]"
                />
              </div>
              <div>
                <label className="text-[10.5px] text-nc-text-dim font-medium uppercase tracking-[0.04em] block mb-1">Prompt</label>
                <textarea
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                  aria-label="Task prompt"
                  rows={3}
                  className="w-full px-2.5 py-1.5 text-[12.5px] rounded-[6px] border border-nc-border bg-nc-bg text-nc-text outline-none focus:border-nc-accent transition-colors duration-[--nc-dur-micro] resize-none"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[10.5px] text-nc-text-dim font-medium uppercase tracking-[0.04em] block mb-1">Schedule</label>
                  <select
                    value={editScheduleType}
                    onChange={(e) => setEditScheduleType(e.target.value as Task['schedule_type'])}
                    aria-label="Schedule type"
                    className="w-full h-8 px-2.5 text-[12.5px] rounded-[6px] border border-nc-border bg-nc-bg text-nc-text outline-none focus:border-nc-accent transition-colors duration-[--nc-dur-micro]"
                  >
                    <option value="cron">Cron</option>
                    <option value="interval">Interval</option>
                    <option value="once">Once</option>
                  </select>
                </div>
                {editScheduleType !== 'once' && (
                  <div className="flex-1">
                    <label className="text-[10.5px] text-nc-text-dim font-medium uppercase tracking-[0.04em] block mb-1">Value</label>
                    <input
                      type="text"
                      value={editScheduleValue}
                      onChange={(e) => setEditScheduleValue(e.target.value)}
                      placeholder={editScheduleType === 'cron' ? '0 7 * * *' : '4h'}
                      aria-label="Schedule value"
                      className="w-full h-8 px-2.5 text-[12.5px] rounded-[6px] border border-nc-border bg-nc-bg text-nc-text outline-none focus:border-nc-accent transition-colors duration-[--nc-dur-micro]"
                    />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void saveEdit()}
                  disabled={isSaving}
                  aria-label="Save task edits"
                  className="nc-press nc-gradient-fill flex items-center gap-1 h-7 px-2.5 rounded-[6px] text-[12px] text-white font-medium disabled:opacity-50 cursor-pointer"
                >
                  <IconCheck size={10} />
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={cancelEdit}
                  aria-label="Cancel edit"
                  className="nc-press flex items-center gap-1 h-7 px-2.5 rounded-[6px] text-[12px] border border-nc-border bg-nc-surface text-nc-text-muted cursor-pointer"
                >
                  <IconX size={10} />
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Action row */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onRunNow(task.id)}
              disabled={isRunning}
              aria-label="Run now"
              className={cn(
                'nc-press flex items-center gap-1 px-2.5 py-1.5 rounded-[7px] text-[12.5px]',
                'border border-nc-border bg-nc-surface text-nc-text-muted',
                'hover:bg-nc-surface-hi disabled:opacity-50 transition-colors duration-[--nc-dur-micro] cursor-pointer',
              )}
            >
              <IconPlay size={11} />
              Run now
            </button>

            {isActive && !isRunning && (
              <button
                type="button"
                onClick={() => onPause(task.id)}
                aria-label="Pause task"
                className={cn(
                  'nc-press flex items-center gap-1 px-2.5 py-1.5 rounded-[7px] text-[12.5px]',
                  'border border-nc-border bg-nc-surface text-nc-text-muted',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
                )}
              >
                <IconPause size={11} />
                Pause
              </button>
            )}

            {isPaused && (
              <button
                type="button"
                onClick={() => onResume(task.id)}
                aria-label="Resume task"
                className={cn(
                  'nc-press flex items-center gap-1 px-2.5 py-1.5 rounded-[7px] text-[12.5px]',
                  'border border-nc-border bg-nc-surface text-nc-text-muted',
                  'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro] cursor-pointer',
                )}
              >
                <IconPlay size={11} />
                Resume
              </button>
            )}

            <button
              type="button"
              onClick={isEditing ? cancelEdit : startEdit}
              aria-label={isEditing ? 'Cancel edit' : 'Edit task'}
              className={cn(
                'nc-press flex items-center gap-1 px-2.5 py-1.5 rounded-[7px] text-[12.5px]',
                'border border-nc-border bg-nc-surface cursor-pointer transition-colors duration-[--nc-dur-micro]',
                isEditing ? 'text-nc-accent border-nc-accent/40 bg-nc-accent-soft' : 'text-nc-text-muted hover:bg-nc-surface-hi',
              )}
            >
              <IconEdit size={11} />
              {isEditing ? 'Editing' : 'Edit'}
            </button>

            <div className="flex-1" />

            {confirmDelete ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] text-nc-text-dim">Delete?</span>
                <button
                  type="button"
                  onClick={() => { onDelete(task.id); setConfirmDelete(false); }}
                  aria-label="Confirm delete task"
                  className="nc-press px-2 py-1 rounded-[7px] text-[11.5px] bg-red-500/10 text-red-500 border border-red-400/40 cursor-pointer"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  aria-label="Cancel delete"
                  className="nc-press px-2 py-1 rounded-[7px] text-[11.5px] border border-nc-border bg-nc-surface text-nc-text-muted cursor-pointer"
                >
                  No
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete task"
                className={cn(
                  'nc-press w-7 h-7 rounded-[7px] flex items-center justify-center',
                  'border border-nc-border bg-nc-surface text-nc-text-dim',
                  'hover:text-red-500 hover:border-red-400/50 transition-colors duration-[--nc-dur-micro] cursor-pointer',
                )}
              >
                <IconTrash size={13} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

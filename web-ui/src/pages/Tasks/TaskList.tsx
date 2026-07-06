import { cn } from '../../lib/cn';
import { TaskCard } from './TaskCard';
import type { Task, TaskProgress } from '../../hooks/useTasks';

interface TaskListProps {
  tasks: Task[];
  runningTaskIds: Set<string>;
  taskProgress: Record<string, TaskProgress>;
  onRunNow: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Task>) => void;
}

/** Renders tasks split into Active and Paused groups. */
export function TaskList({
  tasks,
  runningTaskIds,
  taskProgress,
  onRunNow,
  onPause,
  onResume,
  onDelete,
  onUpdate,
}: TaskListProps) {
  const active = tasks.filter((t) => t.status === 'active' || t.status === 'completed');
  const paused = tasks.filter((t) => t.status === 'paused' || t.status === 'draft');

  const sectionLabel = (label: string) => (
    <div className="text-[11px] text-nc-text-dim font-semibold tracking-[0.06em] uppercase mb-2.5">
      {label}
    </div>
  );

  const cardList = (group: Task[]) => (
    <div className="flex flex-col gap-2">
      {group.map((t) => (
        <TaskCard
          key={t.id}
          task={t}
          isRunning={runningTaskIds.has(t.id)}
          progress={taskProgress[t.id]}
          onRunNow={onRunNow}
          onPause={onPause}
          onResume={onResume}
          onDelete={onDelete}
          onUpdate={onUpdate}
        />
      ))}
    </div>
  );

  if (tasks.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-16 text-nc-text-dim text-sm')}>
        No tasks yet — create one to get started
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {active.length > 0 && (
        <section aria-label="Active tasks">
          {sectionLabel('Active')}
          {cardList(active)}
        </section>
      )}
      {paused.length > 0 && (
        <section aria-label="Paused tasks">
          {sectionLabel('Paused')}
          {cardList(paused)}
        </section>
      )}
    </div>
  );
}

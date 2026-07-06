import { cn } from '../../lib/cn';
import { IconClock, IconSpinner } from '../../components/icons';
import type { Task } from '../../hooks/useTasks';

interface TaskScheduleBadgeProps {
  scheduleType: Task['schedule_type'];
  scheduleValue: string;
}

/** Pill showing schedule type icon + value. Cron value uses monospace. */
export function TaskScheduleBadge({ scheduleType, scheduleValue }: TaskScheduleBadgeProps) {
  const isCron = scheduleType === 'cron';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11.5px] text-nc-text-dim',
        isCron && 'font-mono',
      )}
      style={isCron ? { fontFamily: 'JetBrains Mono, ui-monospace, monospace' } : undefined}
    >
      {scheduleType === 'interval' ? (
        <IconSpinner size={11} className="text-nc-text-dim" />
      ) : (
        <IconClock size={11} className="text-nc-text-dim" />
      )}
      {scheduleValue}
    </span>
  );
}

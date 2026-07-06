import { cn } from '../../lib/cn';
import { WorkflowCard } from './WorkflowCard';
import type { WorkflowMeta } from '../../hooks/useWorkflows';

interface WorkflowListProps {
  workflows: WorkflowMeta[];
  activeFilename: string | null;
  onSelect: (filename: string) => void;
  className?: string;
}

/** Left panel — scrollable list of workflow cards. */
export function WorkflowList({ workflows, activeFilename, onSelect, className }: WorkflowListProps) {
  if (workflows.length === 0) {
    return (
      <div className={cn('flex items-center justify-center py-12 text-nc-text-dim text-sm', className)}>
        No workflows yet
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1.5 p-3.5 overflow-y-auto', className)}>
      {workflows.map((wf) => (
        <WorkflowCard
          key={wf.filename}
          workflow={wf}
          isActive={activeFilename === wf.filename}
          onClick={() => onSelect(wf.filename)}
        />
      ))}
    </div>
  );
}

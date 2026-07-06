import { cn } from '../../lib/cn';
import { WorkflowScopeChip } from './WorkflowScopeChip';
import type { WorkflowMeta } from '../../hooks/useWorkflows';

interface WorkflowCardProps {
  workflow: WorkflowMeta;
  isActive: boolean;
  onClick: () => void;
}

/**
 * Workflow card in the left list.
 * Shows: name (mono), scope chip, description, trigger pills, modified date.
 */
export function WorkflowCard({ workflow, isActive, onClick }: WorkflowCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'nc-press w-full px-3.5 py-3 rounded-[10px] border text-left',
        'flex flex-col gap-1.5 cursor-pointer',
        'transition-colors duration-[--nc-dur-micro]',
        isActive
          ? 'bg-nc-accent-soft border-nc-accent/40'
          : 'bg-nc-surface border-nc-border hover:bg-nc-surface-hi',
      )}
    >
      {/* Name + scope */}
      <div className="flex items-center gap-2">
        <span
          className="text-[13.5px] text-nc-text font-medium truncate"
          style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
        >
          {workflow.name}
        </span>
        <WorkflowScopeChip scope={workflow.scope} />
      </div>

      {/* Description */}
      {workflow.description && (
        <div className="text-[12px] text-nc-text-muted leading-[1.5] line-clamp-2">
          {workflow.description}
        </div>
      )}

      {/* Trigger pills */}
      {workflow.triggers.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {workflow.triggers.slice(0, 4).map((t) => (
            <span
              key={t}
              className="text-[10.5px] px-[7px] py-[1px] rounded-pill bg-nc-surface-hi text-nc-text-muted font-mono"
              style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {/* Modified date */}
      <div className="text-[11px] text-nc-text-dim">
        {new Date(workflow.modified).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short', year: 'numeric',
        })}
      </div>
    </button>
  );
}

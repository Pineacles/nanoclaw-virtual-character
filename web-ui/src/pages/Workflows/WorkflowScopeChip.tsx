import { cn } from '../../lib/cn';

interface WorkflowScopeChipProps {
  scope: string;
}

/**
 * Scope chip: green "global" for scope=group, violet "session" for scope=session:*.
 * Colors use inline CSS vars defined in tokens.css (wf badges) for global,
 * and a violet inline token for session scope (added to tokens.css).
 */
export function WorkflowScopeChip({ scope }: WorkflowScopeChipProps) {
  const isSession = scope.startsWith('session');

  return (
    <span
      className={cn(
        'inline-flex items-center text-[10px] px-[7px] py-[1px] rounded-pill',
        'font-medium uppercase tracking-[0.05em] flex-shrink-0',
      )}
      style={
        isSession
          ? {
              background: 'var(--nc-scope-session-bg)',
              color: 'var(--nc-scope-session-fg)',
            }
          : {
              background: 'var(--nc-badge-wf-bg)',
              color: 'var(--nc-badge-wf-fg)',
              border: '1px solid var(--nc-badge-wf-bd)',
            }
      }
    >
      {isSession ? 'session' : 'global'}
    </span>
  );
}

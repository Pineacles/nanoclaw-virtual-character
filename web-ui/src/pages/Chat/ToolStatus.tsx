import type { ToolStatus as ToolStatusData } from '../../hooks/useChat';

interface ToolStatusProps {
  status: ToolStatusData;
}

/**
 * Animated tool-in-use pill shown below messages during streaming.
 * Pulsing dot + tool name (bold) + target path (mono, muted).
 */
export function ToolStatus({ status }: ToolStatusProps) {
  return (
    <div className="nc-tool-slide inline-flex items-center gap-2 px-3 py-1.5 rounded-pill bg-nc-accent-soft border border-[color:var(--nc-accent)]/20 text-xs text-nc-text">
      <span
        className="w-1.5 h-1.5 rounded-full bg-nc-accent nc-pulse-anim flex-shrink-0"
        aria-hidden="true"
      />
      <span className="font-medium">{status.tool}</span>
      {status.target && (
        <span className="text-nc-text-muted font-mono text-[11px]">{status.target}</span>
      )}
    </div>
  );
}

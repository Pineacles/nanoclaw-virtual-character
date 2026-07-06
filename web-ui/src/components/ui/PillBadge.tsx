import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type BadgeVariant = 'persona' | 'memory' | 'workflow' | 'mood';

interface PillBadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
  className?: string;
}

/**
 * Pill-shaped badge for:
 * - `persona` — coral gradient fill (brand identity, used in top bar + composer)
 * - `memory` — amber/orange (auto-loaded memory files below bot message)
 * - `workflow` — green (workflow verdict below bot message)
 * - `mood` — subtle border (mood label next to sender name)
 */
export function PillBadge({ variant, children, className }: PillBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill text-[11px] px-2 py-0.5',
        variant === 'persona' && 'nc-gradient-fill text-white font-medium tracking-[0.02em]',
        variant === 'memory' && [
          'font-mono',
          'bg-[var(--nc-badge-memory-bg)]',
          'text-[var(--nc-badge-memory-fg)]',
          'border border-[var(--nc-badge-memory-bd)]',
        ],
        variant === 'workflow' && [
          'bg-[var(--nc-badge-wf-bg)]',
          'text-[var(--nc-badge-wf-fg)]',
          'border border-[var(--nc-badge-wf-bd)]',
        ],
        variant === 'mood' && [
          'text-nc-text-dim font-normal',
          'border border-nc-border-soft',
          'py-[1px]',
        ],
        className,
      )}
    >
      {children}
    </span>
  );
}

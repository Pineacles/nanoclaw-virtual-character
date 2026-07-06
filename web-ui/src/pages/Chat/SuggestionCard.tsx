import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface SuggestionCardProps {
  icon: ReactNode;
  title: string;
  desc: string;
  onClick?: () => void;
  compact?: boolean;
  className?: string;
}

/**
 * Quick-action suggestion card shown in the greeting state.
 * Clicking sends the card's desc text as a message.
 */
export function SuggestionCard({
  icon,
  title,
  desc,
  onClick,
  compact = false,
  className,
}: SuggestionCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'nc-press text-left cursor-pointer rounded-card',
        'bg-nc-surface border border-nc-border',
        'flex flex-col gap-1',
        'transition-colors duration-[--nc-dur-micro]',
        'hover:bg-nc-surface-hi',
        compact ? 'p-3' : 'p-[14px]',
        compact ? 'min-h-[64px]' : 'min-h-[72px]',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-nc-text-muted">
        {icon}
        <span className="text-xs font-medium text-nc-text-muted tracking-[0.01em]">
          {title}
        </span>
      </div>
      <div className={cn('text-nc-text leading-[1.4] font-normal', compact ? 'text-[13px]' : 'text-[13.5px]')}>
        {desc}
      </div>
    </button>
  );
}

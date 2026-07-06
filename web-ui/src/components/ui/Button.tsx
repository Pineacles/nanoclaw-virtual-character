import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'icon';
  children?: ReactNode;
}

/**
 * Button variants:
 * - `primary` — gradient fill (coral → pink), white text. Used for send, create, etc.
 * - `ghost` — surface bg + border, nc-text. Used for secondary actions.
 * - `icon` — transparent bg, nc-text-muted. For toolbar icon-only buttons.
 */
export function Button({ variant = 'ghost', className, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'nc-press inline-flex items-center justify-center gap-1.5 cursor-pointer',
        'transition-colors duration-[--nc-dur-micro]',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary' && [
          'nc-gradient-fill text-white rounded-btn px-3 h-8',
          'text-[12.5px] font-medium',
          'shadow-send',
        ],
        variant === 'ghost' && [
          'bg-nc-surface border border-nc-border text-nc-text rounded-btn',
          'px-2.5 h-7 text-xs font-medium',
          'hover:bg-nc-surface-hi',
        ],
        variant === 'icon' && [
          'bg-transparent text-nc-text-muted rounded-btn',
          'w-8 h-8',
          'hover:bg-nc-surface-hi hover:text-nc-text',
        ],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

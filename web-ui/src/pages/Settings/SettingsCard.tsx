import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface SettingsCardProps {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  /** Grid-column span on desktop (1-12). Default 6. */
  span?: number;
  className?: string;
}

/**
 * Bento-style settings card wrapper.
 * On desktop: uses grid-column span prop.
 * On mobile: full width (stacked by parent).
 */
export function SettingsCard({ title, children, action, span = 6, className }: SettingsCardProps) {
  return (
    <div
      className={cn(
        'nc-page rounded-card border border-nc-border bg-nc-surface',
        'flex flex-col gap-3 p-[18px]',
        className,
      )}
      style={{ gridColumn: `span ${span}` }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-nc-text tracking-[-0.01em]">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

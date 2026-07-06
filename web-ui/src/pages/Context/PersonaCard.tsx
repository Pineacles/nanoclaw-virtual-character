import { cn } from '../../lib/cn';

interface PersonaCardProps {
  label: string;
  title: string;
  desc: string;
  variant: 'accent' | 'default';
  onClick: () => void;
  isSelected?: boolean;
}

/**
 * Featured identity file card (Persona / CLAUDE.md).
 * accent variant = accentSoft bg + accent border. default = surface + border.
 */
export function PersonaCard({ label, title, desc, variant, onClick, isSelected }: PersonaCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isSelected}
      aria-label={`${label}: ${title}`}
      className={cn(
        'nc-press w-full text-left px-[14px] py-[12px] rounded-[10px] cursor-pointer',
        'flex flex-col gap-1 border',
        'transition-colors duration-[--nc-dur-micro]',
        variant === 'accent'
          ? 'bg-nc-accent-soft border-[color:var(--nc-accent)]/40'
          : 'bg-nc-surface border-nc-border hover:bg-nc-surface-hi',
        isSelected && variant !== 'accent' && 'bg-nc-surface-hi',
      )}
    >
      <span
        className={cn(
          'text-[11px] font-semibold uppercase tracking-[0.04em]',
          variant === 'accent' ? 'text-nc-accent' : 'text-nc-text-dim',
        )}
      >
        {label}
      </span>
      <span className="text-[13.5px] text-nc-text font-medium">{title}</span>
      <span className="text-[11.5px] text-nc-text-muted">{desc}</span>
    </button>
  );
}

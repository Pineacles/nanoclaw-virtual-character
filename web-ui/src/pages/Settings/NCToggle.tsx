import { cn } from '../../lib/cn';

interface NCToggleProps {
  on: boolean;
}

/**
 * Pill toggle — accent gradient when on, border-color when off.
 * Purely visual; interactivity (role=switch, onClick) goes on the parent button.
 */
export function NCToggle({ on }: NCToggleProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex w-[34px] h-[20px] rounded-full flex-shrink-0',
        'transition-all duration-150',
        on ? 'nc-gradient-fill' : 'bg-nc-border',
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] w-4 h-4 rounded-full bg-white',
          'transition-all duration-150',
          on ? 'left-[16px]' : 'left-[2px]',
        )}
        style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }}
      />
    </span>
  );
}

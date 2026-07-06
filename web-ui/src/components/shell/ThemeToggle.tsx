import { useTheme } from '../../hooks/useTheme';
import { cn } from '../../lib/cn';

interface ThemeToggleProps {
  className?: string;
}

/**
 * Light/dark toggle button. Shows sun (light) or moon (dark).
 * Reads and sets theme via useTheme.
 */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { resolved, toggle } = useTheme();

  return (
    <button
      onClick={toggle}
      aria-label={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'nc-press w-8 h-8 flex items-center justify-center rounded-btn',
        'bg-transparent text-nc-text-muted hover:text-nc-text hover:bg-nc-surface-hi',
        'transition-colors duration-[--nc-dur-micro]',
        className,
      )}
    >
      {resolved === 'dark' ? (
        /* Sun icon */
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      ) : (
        /* Moon icon */
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
        </svg>
      )}
    </button>
  );
}

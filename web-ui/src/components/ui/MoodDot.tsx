import { cn } from '../../lib/cn';

interface MoodDotProps {
  size?: number;
  color?: string;
  className?: string;
}

/**
 * Small mood indicator dot with the nc-mood-breathe breathing animation.
 * Color defaults to var(--nc-accent) (coral = focused).
 */
export function MoodDot({ size = 10, color, className }: MoodDotProps) {
  // Build the inline styles for the dynamic radial gradient and box-shadow.
  // These can't be expressed as static Tailwind classes — dynamic values require style={}.
  const col = color ?? 'var(--nc-accent)';

  return (
    <span
      className={cn('nc-mood-breathe inline-block rounded-full flex-shrink-0', className)}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 35% 30%, ${col}ee, ${col}99)`,
        boxShadow: `0 0 0 2px ${col}1a`,
      }}
      aria-hidden="true"
    />
  );
}

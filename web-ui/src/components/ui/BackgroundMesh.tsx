import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface BackgroundMeshProps {
  variant: 'greeting' | 'filled';
  children: ReactNode;
  className?: string;
}

/**
 * Full-bleed radial gradient mesh background.
 * - `greeting` — stronger mesh (bgGreeting), used when message area is empty.
 * - `filled`   — subtle mesh (bgMesh), used with message traffic.
 * Chrome surfaces (header, sidebar, composer) must sit on solid backgrounds.
 */
export function BackgroundMesh({ variant, children, className }: BackgroundMeshProps) {
  return (
    <div
      className={cn('w-full h-full', className)}
      style={{
        background: variant === 'greeting'
          ? 'var(--nc-bg-greeting)'
          : 'var(--nc-bg-mesh)',
      }}
    >
      {children}
    </div>
  );
}

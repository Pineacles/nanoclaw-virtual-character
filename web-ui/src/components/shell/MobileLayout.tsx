import type { ReactNode } from 'react';
import { MobileTabBar } from './MobileTabBar';
import type { PageView } from '../../App';

interface MobileLayoutProps {
  active: PageView;
  onNavigate: (view: PageView) => void;
  moodColor?: string;
  onMoreClick: () => void;
  children: ReactNode;
}

/**
 * Mobile shell: full-height flex column.
 * children (the page) fills flex-1.
 * MobileTabBar is pinned to bottom.
 */
export function MobileLayout({
  active,
  onNavigate,
  moodColor,
  onMoreClick,
  children,
}: MobileLayoutProps) {
  return (
    <div className="flex flex-col w-full h-full overflow-hidden bg-nc-bg">
      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {children}
      </main>
      <MobileTabBar
        active={active}
        onNavigate={onNavigate}
        moodColor={moodColor}
        onMoreClick={onMoreClick}
      />
    </div>
  );
}

import { cn } from '../../lib/cn';
import { IconChat, IconBrain, IconWorkflow, IconClock, IconMore } from '../icons';
import { MoodDot } from '../ui/MoodDot';
import type { PageView } from '../../App';

interface MobileTabBarProps {
  active: PageView;
  onNavigate: (view: PageView) => void;
  moodColor?: string;
  onMoreClick: () => void;
}

const TABS = [
  { view: 'chat' as PageView, icon: IconChat, label: 'Chat' },
  { view: 'memory' as PageView, icon: IconBrain, label: 'Memory' },
  { view: 'workflows' as PageView, icon: IconWorkflow, label: 'Flows' },
  { view: 'tasks' as PageView, icon: IconClock, label: 'Tasks' },
] as const;

/**
 * Mobile bottom navigation bar.
 * Chat / Memory / Flows / Tasks / More (opens sheet).
 * Uses the same tab bar across all pages (Option A from design chat).
 */
export function MobileTabBar({ active, onNavigate, moodColor, onMoreClick }: MobileTabBarProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="nc-page flex-shrink-0 flex items-center bg-nc-bg border-t border-nc-border-soft"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {TABS.map(({ view, icon: Icon, label }) => {
        const isActive = active === view;
        return (
          <button
            key={view}
            onClick={() => onNavigate(view)}
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'nc-press flex-1 flex flex-col items-center justify-center gap-1',
              'h-14 min-w-[44px]',
              'text-[10px] font-medium tracking-[0.01em]',
              'transition-colors duration-[--nc-dur-micro]',
              isActive ? 'text-nc-accent' : 'text-nc-text-dim',
            )}
          >
            <Icon size={20} />
            <span>{label}</span>
            {isActive && (
              <span
                className="nc-tab-indicator absolute bottom-0 w-5 h-0.5 rounded-pill nc-gradient-fill"
                aria-hidden="true"
              />
            )}
          </button>
        );
      })}

      {/* More — opens sheet */}
      <button
        onClick={onMoreClick}
        aria-label="More options"
        className={cn(
          'nc-press flex-1 flex flex-col items-center justify-center gap-1',
          'h-14 min-w-[44px]',
          'text-[10px] font-medium tracking-[0.01em] text-nc-text-dim',
          'transition-colors duration-[--nc-dur-micro]',
        )}
      >
        <div className="relative">
          <IconMore size={20} />
          {moodColor && (
            <MoodDot
              size={7}
              color={moodColor}
              className="absolute -top-0.5 -right-0.5"
            />
          )}
        </div>
        <span>More</span>
      </button>
    </nav>
  );
}

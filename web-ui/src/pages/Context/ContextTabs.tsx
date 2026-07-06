import { cn } from '../../lib/cn';

export interface ContextTab {
  id: string;
  label: string;
}

interface ContextTabsProps {
  tabs: ContextTab[];
  activeId: string;
  onSelect: (id: string) => void;
}

/**
 * Horizontal scrolling tab strip.
 * Active tab: accent border-bottom + text-nc-text + font-medium.
 * Uses role="tablist" / role="tab" + aria-selected for accessibility.
 */
export function ContextTabs({ tabs, activeId, onSelect }: ContextTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Context categories"
      className={cn(
        'flex gap-0 overflow-x-auto border-b border-nc-border-soft flex-shrink-0',
        'px-4 md:px-6',
        'scrollbar-none',
      )}
      style={{ scrollbarWidth: 'none' }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-controls={`context-panel-${tab.id}`}
            id={`context-tab-${tab.id}`}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={cn(
              'nc-press px-[13px] py-[10px] border-none bg-transparent cursor-pointer',
              'text-[12.5px] whitespace-nowrap flex-shrink-0',
              'border-b-2 -mb-px transition-colors duration-[--nc-dur-micro]',
              isActive
                ? 'text-nc-text font-medium border-nc-accent nc-tab-indicator'
                : 'text-nc-text-muted font-normal border-transparent hover:text-nc-text',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

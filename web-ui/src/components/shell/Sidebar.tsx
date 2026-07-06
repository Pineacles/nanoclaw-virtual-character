import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  IconChat, IconBrain, IconWorkflow, IconClock,
  IconLayers, IconVoice, IconSettings, IconEdit,
} from '../icons';
import { MoodDot } from '../ui/MoodDot';
import { PersonaAvatar } from '../PersonaAvatar';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import type { PageView } from '../../App';

interface SidebarProps {
  active: PageView;
  onNavigate: (view: PageView) => void;
  activeSessionName?: string;
  sessions?: SessionItem[];
  moodColor?: string;
  moodLabel?: string;
  onNewChat?: () => void;
  /** Slot for SessionsPanel content below sessions header */
  sessionsSlot?: ReactNode;
}

interface SessionItem {
  id: string;
  name: string;
  mode: 'persona' | 'plain' | 'whatsapp';
  active: boolean;
}

const NAV_ITEMS = [
  { view: 'chat' as PageView, icon: IconChat, label: 'Chat' },
  { view: 'memory' as PageView, icon: IconBrain, label: 'Memory' },
  { view: 'workflows' as PageView, icon: IconWorkflow, label: 'Workflows' },
  { view: 'tasks' as PageView, icon: IconClock, label: 'Tasks' },
  { view: 'context' as PageView, icon: IconLayers, label: 'Context' },
  { view: 'voice' as PageView, icon: IconVoice, label: 'Voice' },
  { view: 'settings' as PageView, icon: IconSettings, label: 'Settings' },
];

const MODE_COLORS: Record<string, string> = {
  whatsapp: 'var(--nc-session-whatsapp)',
  plain: 'var(--nc-text-dim)',
  persona: 'var(--nc-accent)',
};

/**
 * Desktop left sidebar.
 * Width 248px, surfaceAlt bg, borderRight.
 * Sections: brand → new chat → nav → sessions → footer (mood + user).
 */
export function Sidebar({
  active,
  onNavigate,
  sessions = [],
  moodColor,
  moodLabel,
  onNewChat,
  sessionsSlot,
}: SidebarProps) {
  const { groupConfig } = useGroupConfig();
  const userName = groupConfig?.user?.name ?? '';
  const assistantName = groupConfig?.assistant?.name ?? '';

  return (
    <aside
      aria-label="Sidebar navigation"
      className="nc-page w-[248px] h-full flex flex-col flex-shrink-0 bg-nc-surface-alt border-r border-nc-border-soft"
    >
      {/* Brand mark */}
      <div className="px-[18px] py-[16px] pb-3 flex items-center gap-[9px]">
        <div
          aria-hidden="true"
          className="w-6 h-6 rounded-brand flex items-center justify-center text-white text-xs font-bold nc-gradient-fill"
          style={{ boxShadow: '0 2px 6px var(--nc-accent)40' }}
        >
          n
        </div>
        <span className="text-sm font-semibold text-nc-text tracking-[-0.01em]">nanoclaw</span>
      </div>

      {/* New chat button */}
      <div className="px-2.5 pb-2.5">
        <button
          onClick={onNewChat}
          aria-label="New chat"
          className={cn(
            'nc-press w-full px-2.5 py-2 rounded-[9px]',
            'border border-nc-border bg-nc-surface',
            'flex items-center gap-2',
            'text-nc-text text-[13px] font-medium cursor-pointer',
            'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]',
          )}
        >
          <IconEdit size={16} className="text-nc-text-muted" />
          New chat
        </button>
      </div>

      {/* Nav items */}
      <nav aria-label="Page navigation">
        <ul className="px-2.5 flex flex-col gap-[1px] list-none m-0 p-0 px-2.5">
          {NAV_ITEMS.map(({ view, icon: Icon, label }) => {
            const isActive = active === view;
            return (
              <li key={view}>
                <button
                  onClick={() => onNavigate(view)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'nc-press w-full px-2.5 py-[7px] rounded-[7px] border-none',
                    'flex items-center gap-2.5 cursor-pointer text-left',
                    'text-[13px] transition-colors duration-[--nc-dur-micro]',
                    isActive
                      ? 'bg-nc-surface-hi text-nc-text font-medium'
                      : 'bg-transparent text-nc-text font-normal hover:bg-nc-surface-hi',
                  )}
                >
                  <Icon
                    size={16}
                    className={cn(isActive ? 'text-nc-accent' : 'text-nc-text-muted')}
                  />
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Sessions — header is rendered by SessionsPanel itself, with a + button.
          Keep the legacy header only when no slot is provided (fallback mode). */}
      {!sessionsSlot && (
        <div
          aria-label="Sessions"
          className="px-[18px] pt-5 pb-1.5 text-[11px] text-nc-text-dim font-medium tracking-[0.06em] uppercase"
        >
          Sessions
        </div>
      )}

      <div className={cn(
        'flex-1 flex flex-col gap-[1px] overflow-y-auto min-h-0',
        sessionsSlot ? 'pt-2' : 'px-2.5',
      )}>
        {sessionsSlot ?? sessions.map((s) => (
          <button
            key={s.id}
            aria-current={s.active ? 'true' : undefined}
            className={cn(
              'nc-press w-full px-2.5 py-1.5 rounded-[7px] border-none',
              'flex items-center gap-[9px] cursor-pointer text-left',
              'text-[13px] transition-colors duration-[--nc-dur-micro]',
              s.active
                ? 'bg-nc-surface-hi text-nc-text font-medium'
                : 'bg-transparent text-nc-text-muted font-normal hover:bg-nc-surface-hi',
            )}
          >
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: MODE_COLORS[s.mode] ?? 'var(--nc-accent)' }}
            />
            <span className="truncate">{s.name}</span>
          </button>
        ))}
      </div>

      {/* Footer: mood + user */}
      <footer className="px-3.5 py-3 border-t border-nc-border-soft flex items-center gap-2.5">
        <div
          aria-hidden="true"
          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[11px] font-semibold flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--nc-accent), var(--nc-avatar-gradient-end))' }}
        >
          {userName.charAt(0).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12.5px] text-nc-text font-medium">{userName}</div>
          <div className="text-[11px] text-nc-text-dim flex items-center gap-1">
            <PersonaAvatar size={14} className="text-[7px]" />
            <MoodDot size={6} color={moodColor} />
            <span>{assistantName.toLowerCase()} · {moodLabel ?? 'focused'}</span>
          </div>
        </div>
      </footer>
    </aside>
  );
}

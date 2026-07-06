import { cn } from '../../lib/cn';
import { IconEdit, IconSearch, IconSettings, IconMedia } from '../../components/icons';
import { MoodDot } from '../../components/ui/MoodDot';
import { PillBadge } from '../../components/ui/PillBadge';
import { ThemeToggle } from '../../components/shell/ThemeToggle';
import type { PresenceEvent } from '../../hooks/useChat';

/** Format lastSeenAt ISO string to a human-readable time/date label. */
function formatLastSeen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return hhmm;
  if (diffDays === 1) return `yesterday ${hhmm}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${hhmm}`;
}

/** Small colored dot + status text for presence display. */
function PresenceIndicator({
  presence,
  isTyping,
}: {
  presence: PresenceEvent;
  isTyping: boolean;
}) {
  // While bot is typing/streaming, treat as online.
  const state = isTyping ? 'online' : presence.state;

  let dotColor: string;
  let label: string;

  switch (state) {
    case 'online':
      dotColor = 'bg-emerald-400';
      label = 'online';
      break;
    case 'away': {
      dotColor = 'bg-amber-400';
      const t = formatLastSeen(presence.lastSeenAt);
      label = t ? `last seen ${t}` : 'away';
      break;
    }
    case 'sleeping':
      dotColor = 'bg-nc-text-dim';
      label = 'sleeping';
      break;
    case 'offline':
    default: {
      dotColor = 'bg-nc-text-dim';
      const t = formatLastSeen(presence.lastSeenAt);
      label = t ? `last seen ${t}` : 'offline';
      break;
    }
  }

  return (
    <span className="flex items-center gap-1 text-xs text-nc-text-muted select-none">
      <span
        className={cn('inline-block w-[7px] h-[7px] rounded-full flex-shrink-0', dotColor)}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

/* ── Mobile header ── */
interface MobileChatHeaderProps {
  sessionName: string;
  moodColor?: string;
  presence?: PresenceEvent | null;
  isTyping?: boolean;
  onSessionSwitch: () => void;
  onNewChat: () => void;
  onMediaOpen?: () => void;
}

export function MobileChatHeader({
  sessionName,
  moodColor,
  presence,
  isTyping = false,
  onSessionSwitch,
  onNewChat,
  onMediaOpen,
}: MobileChatHeaderProps) {
  return (
    <header className="nc-page flex-shrink-0 flex items-center justify-between px-4 py-2.5 bg-nc-bg border-b border-nc-border-soft">
      <div className="flex items-center gap-2">
        <MoodDot size={9} color={moodColor} />
        <div className="flex flex-col items-start">
          <button
            onClick={onSessionSwitch}
            aria-label="Switch session"
            className={cn(
              'nc-press flex items-center gap-1.5 border-none bg-transparent',
              'cursor-pointer px-2 py-1 rounded-btn text-nc-text',
            )}
          >
            <span className="text-sm font-medium">{sessionName}</span>
            {/* chevron */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {presence != null && (
            <div className="px-2 pb-0.5">
              <PresenceIndicator presence={presence} isTyping={isTyping} />
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-1">
        <ThemeToggle />
        {onMediaOpen && (
          <button
            onClick={onMediaOpen}
            aria-label="Open media gallery"
            className="nc-press w-8 h-8 flex items-center justify-center rounded-btn bg-transparent text-nc-text-muted hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]"
          >
            <IconMedia size={16} />
          </button>
        )}
        <button
          onClick={onNewChat}
          aria-label="New chat"
          className="nc-press w-8 h-8 flex items-center justify-center rounded-btn bg-transparent text-nc-text hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]"
        >
          <IconEdit size={16} />
        </button>
      </div>
    </header>
  );
}

/* ── Desktop header ── */
interface DesktopChatHeaderProps {
  sessionName: string;
  sessionMode?: 'persona' | 'plain' | 'whatsapp';
  hasMessages: boolean;
  modelLabel?: string;
  presence?: PresenceEvent | null;
  isTyping?: boolean;
  onMediaOpen?: () => void;
}

export function DesktopChatHeader({
  sessionName,
  sessionMode,
  hasMessages,
  modelLabel = 'Sonnet 4.5',
  presence,
  isTyping = false,
  onMediaOpen,
}: DesktopChatHeaderProps) {
  return (
    <header
      className={cn(
        'nc-page flex-shrink-0 flex items-center justify-between px-6 py-[14px]',
        'border-b border-nc-border-soft',
        hasMessages
          ? 'bg-transparent'
          : 'backdrop-blur-[12px]',
      )}
      style={{
        background: hasMessages
          ? 'transparent'
          : 'color-mix(in oklch, var(--nc-bg) 80%, transparent)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-nc-text">{sessionName}</span>
          {presence != null && (
            <PresenceIndicator presence={presence} isTyping={isTyping} />
          )}
        </div>
        {sessionMode === 'persona' && (
          <PillBadge variant="persona">persona</PillBadge>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <ThemeToggle />
        <button
          aria-label="Search messages"
          className="nc-press flex items-center gap-1.5 px-2.5 py-1.5 rounded-btn border-none bg-transparent text-nc-text-muted text-[12.5px] cursor-pointer hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]"
        >
          <IconSearch size={16} />
          Search
        </button>
        {onMediaOpen && (
          <button
            aria-label="Open media gallery"
            onClick={onMediaOpen}
            className="nc-press w-8 h-8 flex items-center justify-center rounded-btn border-none bg-transparent text-nc-text-muted cursor-pointer hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]"
          >
            <IconMedia size={16} />
          </button>
        )}
        <button
          aria-label="Session settings"
          className="nc-press w-8 h-8 flex items-center justify-center rounded-btn border-none bg-transparent text-nc-text-muted cursor-pointer hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]"
        >
          <IconSettings size={16} />
        </button>
      </div>
      {!hasMessages && modelLabel && (
        <span className="absolute left-1/2 -translate-x-1/2 text-[11px] text-nc-text-dim">
          {modelLabel} · Persona on · Memory active
        </span>
      )}
    </header>
  );
}

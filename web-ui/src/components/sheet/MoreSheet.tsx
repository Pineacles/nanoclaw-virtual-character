import { cn } from '../../lib/cn';
import { MoodDot } from '../ui/MoodDot';
import { IconLayers, IconVoice, IconSettings } from '../icons';
import { SessionsPanel } from './SessionsPanel';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import type { WebSession } from './SessionsPanel';
import type { PageView } from '../../App';

interface MoreSheetProps {
  onClose: () => void;
  moodColor?: string;
  moodLabel?: string;
  authenticated: boolean;
  activeSessionId?: string;
  onSessionSelect?: (session: WebSession) => void;
  onSessionCreated?: (session: WebSession) => void;
  onNavigate: (view: PageView) => void;
}

const QUICK_LINKS: { view: PageView; icon: typeof IconLayers; label: string }[] = [
  { view: 'context', icon: IconLayers, label: 'Context' },
  { view: 'voice', icon: IconVoice, label: 'Voice' },
  { view: 'settings', icon: IconSettings, label: 'Settings' },
];

/**
 * Mobile bottom sheet — sessions + quick links + mood footer.
 * nc-bottom-sheet animation on open. Backdrop dismisses.
 */
export function MoreSheet({
  onClose,
  moodColor,
  moodLabel,
  authenticated,
  activeSessionId,
  onSessionSelect,
  onSessionCreated,
  onNavigate,
}: MoreSheetProps) {
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? '';

  const handleNavAndClose = (view: PageView) => {
    onNavigate(view);
    onClose();
  };

  const handleSessionSelect = (s: WebSession) => {
    onSessionSelect?.(s);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="More options"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end"
    >
      {/* Scrim */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div className="nc-bottom-sheet relative w-full bg-nc-surface rounded-t-[22px] border-t border-nc-border-soft z-10 flex flex-col max-h-[82vh] pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
        {/* Handle */}
        <div className="pt-3 pb-1 flex justify-center flex-shrink-0" aria-hidden="true">
          <div className="w-10 h-1 rounded-pill bg-nc-border" />
        </div>

        {/* Quick links */}
        <div className="flex gap-2 px-4 py-3 flex-shrink-0 border-b border-nc-border-soft">
          {QUICK_LINKS.map(({ view, icon: Icon, label }) => (
            <button
              key={view}
              type="button"
              onClick={() => handleNavAndClose(view)}
              aria-label={label}
              className={cn(
                'nc-press flex-1 flex flex-col items-center gap-1.5 py-2.5 px-1 rounded-[10px] cursor-pointer',
                'border border-nc-border bg-nc-surface-alt text-nc-text-muted',
                'hover:bg-nc-surface-hi transition-colors duration-[--nc-dur-micro]',
              )}
            >
              <Icon size={18} />
              <span className="text-[11px] font-medium text-nc-text-dim">{label}</span>
            </button>
          ))}
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-hidden">
          <SessionsPanel
            authenticated={authenticated}
            activeSessionId={activeSessionId}
            onSessionSelect={handleSessionSelect}
            onSessionCreated={onSessionCreated}
          />
        </div>

        {/* Footer: mood */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-nc-border-soft flex items-center gap-2">
          <MoodDot size={8} color={moodColor} className="nc-mood-breathe" />
          <span className="text-[12.5px] text-nc-text-muted">
            {assistantName.toLowerCase()} · {moodLabel ?? 'focused'}
          </span>
        </div>
      </div>
    </div>
  );
}

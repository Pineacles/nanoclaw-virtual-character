import { cn } from '../../lib/cn';
import type { VoiceState } from './VoiceRing';

interface VoiceControlsProps {
  state: VoiceState;
  onConnect: () => void;
  onDisconnect: () => void;
  isMobile?: boolean;
}

/** End-call and connect buttons. */
export function VoiceControls({ state, onConnect, onDisconnect, isMobile }: VoiceControlsProps) {
  const isConnected = state !== 'idle' && state !== 'connecting';
  const isConnecting = state === 'connecting';

  return (
    <div className={cn('flex items-center justify-center gap-3', isMobile ? 'pb-2' : '')}>
      {isConnected ? (
        <button
          type="button"
          onClick={onDisconnect}
          aria-label="End voice call"
          className={cn(
            'nc-press flex items-center gap-2 border-none cursor-pointer',
            'text-white font-medium rounded-full',
            isMobile ? 'h-12 px-7 text-[14px]' : 'h-11 px-6 text-[13.5px]',
          )}
          style={{
            background: 'var(--nc-end-call)',
            boxShadow: '0 2px 8px var(--nc-end-call-shadow)',
          }}
        >
          {/* Phone-off icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.5 6l-1.5 1.5 1.5 1.5-4 4-1.5-1.5L9.5 13l-3 3 1.4 1.4a10 10 0 0013-13L19.5 3l-3 3z" />
            <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          End call
        </button>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={isConnecting}
          aria-label={isConnecting ? 'Connecting…' : 'Start voice call'}
          className={cn(
            'nc-press nc-gradient-fill flex items-center gap-2 border-none cursor-pointer',
            'text-white font-medium rounded-full disabled:opacity-60',
            isMobile ? 'h-12 px-7 text-[14px]' : 'h-11 px-6 text-[13.5px]',
          )}
          style={{ boxShadow: '0 2px 8px var(--nc-accent-shadow)' }}
        >
          {/* Phone icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
          </svg>
          {isConnecting ? 'Connecting…' : 'Start call'}
        </button>
      )}
    </div>
  );
}

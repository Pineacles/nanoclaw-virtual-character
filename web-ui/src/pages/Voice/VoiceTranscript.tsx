import { cn } from '../../lib/cn';

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  streaming?: boolean;
}

interface VoiceTranscriptProps {
  entries: TranscriptEntry[];
  duration?: string;
}

/**
 * Live transcript panel for voice call.
 * Shows alternating user/assistant lines.
 * Last streaming assistant line gets the blinking cursor.
 */
export function VoiceTranscript({ entries, duration }: VoiceTranscriptProps) {
  return (
    <div
      className={cn(
        'rounded-[14px] border border-nc-border bg-nc-surface',
        'flex flex-col h-full overflow-hidden',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-nc-border-soft flex-shrink-0">
        <span className="text-[11px] text-nc-text-dim font-semibold uppercase tracking-[0.04em]">
          Transcript
        </span>
        {duration && (
          <span
            className="text-[11.5px] text-nc-text-muted"
            style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}
          >
            {duration}
          </span>
        )}
      </div>

      {/* Lines */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5">
        {entries.length === 0 && (
          <p className="text-[13px] text-nc-text-dim text-center py-4">Waiting for conversation to begin…</p>
        )}
        {entries.map((entry, i) => (
          <div key={i} className="text-[13px] leading-[1.5]">
            <span
              className="text-nc-text-dim mr-1.5 uppercase"
              style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '10.5px' }}
            >
              {entry.role === 'user' ? 'M' : 'S'}
            </span>
            <span className={cn(entry.role === 'user' ? 'text-nc-text-muted' : 'text-nc-text')}>
              {entry.text}
            </span>
            {entry.streaming && (
              <span
                aria-hidden="true"
                className="nc-blink inline-block w-[6px] h-[12px] ml-0.5 bg-nc-accent align-[-2px]"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

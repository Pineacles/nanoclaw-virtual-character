import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { BackgroundMesh } from '../../components/ui/BackgroundMesh';
import { VoiceRing } from './VoiceRing';
import { VoiceTranscript } from './VoiceTranscript';
import { VoiceControls } from './VoiceControls';
import { getToken } from '../../lib/api';
import { PersonaAvatar } from '../../components/PersonaAvatar';
import { useGroupConfig } from '../../hooks/useGroupConfig';
import type { VoiceState } from './VoiceRing';
import type { TranscriptEntry } from './VoiceTranscript';

interface VoicePageProps {
  isMobile: boolean;
  authenticated: boolean;
  /** Voice call feature enabled via group config */
  voiceEnabled?: boolean;
}

const STATE_LABELS: Record<VoiceState, string> = {
  idle: 'Ready to connect',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  interrupted: 'Interrupted',
};

function buildStateSub(assistantName: string): Record<VoiceState, string> {
  return {
    idle: 'Press Start call to begin',
    connecting: 'Opening voice channel',
    listening: `Say something to ${assistantName}`,
    thinking: `${assistantName} is processing`,
    speaking: `${assistantName} is responding`,
    interrupted: 'Connection paused',
  };
}

/**
 * Voice call page — animated ring + live transcript + controls.
 * Wires to /voice-ws WebSocket.
 * If voice is disabled, renders a static "not enabled" banner instead.
 */
export function VoicePage({ isMobile, authenticated, voiceEnabled = true }: VoicePageProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { groupConfig } = useGroupConfig();
  const stateSub = buildStateSub(groupConfig?.assistant?.name ?? 'the assistant');

  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    stopTimer();
    setState('idle');
    setDuration(0);
  }, [stopTimer]);

  const connect = useCallback(() => {
    if (!authenticated || !voiceEnabled) return;
    setState('connecting');
    setError(null);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/voice-ws?token=${encodeURIComponent(getToken())}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    let didOpen = false;

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          state?: VoiceState;
          role?: 'user' | 'assistant';
          text?: string;
          streaming?: boolean;
          error?: string;
        };
        if (msg.type === 'state' && msg.state) {
          setState(msg.state);
        }
        if (msg.type === 'transcript' && msg.role && msg.text !== undefined) {
          const entry: TranscriptEntry = {
            role: msg.role,
            text: msg.text,
            timestamp: new Date().toISOString(),
            streaming: msg.streaming,
          };
          setTranscript((prev) => {
            if (msg.streaming) {
              const last = prev[prev.length - 1];
              if (last && last.streaming && last.role === msg.role) {
                return [...prev.slice(0, -1), entry];
              }
            }
            return [...prev, entry];
          });
        }
        if (msg.type === 'error') {
          setError(msg.error ?? 'Voice error');
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onerror = () => {
      // onerror fires when the connection is refused or unreachable (service down)
      if (!didOpen) setError('voice-offline');
      setState('idle');
      stopTimer();
    };

    ws.onopen = () => {
      didOpen = true;
      setState('listening');
      startTimer();
    };

    ws.onclose = (evt) => {
      // Abnormal close before ever opening → service unreachable
      if (!didOpen && evt.code !== 1000) {
        setError('voice-offline');
      }
      setState('idle');
      stopTimer();
    };
  }, [authenticated, voiceEnabled, startTimer, stopTimer]);

  useEffect(() => () => { disconnect(); }, [disconnect]);

  const durationLabel = `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`;

  const ring = <VoiceRing state={state} />;
  const stateLabel = (
    <div className="text-center">
      <div className={cn(
        'font-medium text-nc-text',
        isMobile ? 'text-[17px]' : 'text-[16px]',
      )}>
        {STATE_LABELS[state]}
      </div>
      <div className="text-[12.5px] text-nc-text-muted mt-1">
        {stateSub[state]}
      </div>
    </div>
  );
  const controls = (
    <VoiceControls
      state={state}
      onConnect={connect}
      onDisconnect={disconnect}
      isMobile={isMobile}
    />
  );

  return (
    <BackgroundMesh variant="filled" className="flex flex-col h-full">
      {/* Page header */}
      <div
        className={cn(
          'nc-page flex-shrink-0 bg-nc-bg border-b border-nc-border-soft',
          'flex items-center gap-2.5',
          isMobile ? 'px-4 py-3 h-14' : 'px-6 py-4',
        )}
      >
        <PersonaAvatar size={isMobile ? 28 : 32} />
        <div>
          <h1 className={cn('text-nc-text font-semibold tracking-[-0.01em] m-0', isMobile ? 'text-[15px]' : 'text-[17px]')}>
            Voice call
          </h1>
          <p className="text-[12px] text-nc-text-dim m-0 mt-0.5">
            {state === 'idle' ? 'Not in session' : `In session · ${durationLabel}`}
          </p>
        </div>
      </div>

      {/* Feature-disabled banner */}
      {!voiceEnabled && (
        <div className="m-4 px-4 py-3 rounded-[10px] border border-nc-warning bg-nc-warning-soft">
          <p className="text-[13px] text-nc-warning-text m-0">
            Voice not enabled — flip the <strong>Voice call</strong> subsystem toggle in Settings to use it.
          </p>
        </div>
      )}

      {/* Error chip */}
      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-[8px] bg-red-500/10 border border-red-400/40">
          <p className="text-[12.5px] text-red-500 m-0">
            {error === 'voice-offline'
              ? 'Voice service is offline.'
              : error}
          </p>
        </div>
      )}

      {/* Body */}
      {isMobile ? (
        <div className="flex-1 flex flex-col items-center gap-4.5 px-4 py-5 overflow-hidden">
          {ring}
          {stateLabel}
          <div className="w-full flex-1 min-h-0">
            <VoiceTranscript entries={transcript} duration={state !== 'idle' ? durationLabel : undefined} />
          </div>
          {controls}
        </div>
      ) : (
        <div className="flex-1 overflow-hidden px-6 py-5 flex justify-center">
          <div className="w-full max-w-[760px] grid grid-cols-2 gap-6 items-center">
            <div className="flex flex-col items-center gap-4.5">
              {ring}
              {stateLabel}
              {controls}
            </div>
            <VoiceTranscript entries={transcript} duration={state !== 'idle' ? durationLabel : undefined} />
          </div>
        </div>
      )}
    </BackgroundMesh>
  );
}

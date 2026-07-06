import { cn } from '../../lib/cn';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'interrupted';

interface VoiceRingProps {
  state: VoiceState;
}

/**
 * Animated voice blob: outer pulsing ring + inner morphing blob.
 * State-color: listening=voice-listening, speaking/thinking=accent, idle/connecting=text-dim.
 */
export function VoiceRing({ state }: VoiceRingProps) {
  const isActive = state !== 'idle' && state !== 'connecting';
  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';

  const ringColor = isListening
    ? 'var(--nc-voice-listening)'
    : state === 'idle' || state === 'connecting'
      ? 'var(--nc-text-dim)'
      : 'var(--nc-accent)';

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: 220, height: 220 }}
      aria-label={`Voice state: ${state}`}
      role="img"
    >
      {/* Outer pulse ring */}
      <div
        className={cn(
          'absolute rounded-full border-2',
          isActive ? 'nc-ring-pulse' : '',
        )}
        style={{
          width: 220,
          height: 220,
          borderColor: ringColor,
          opacity: 0.15,
        }}
      />
      {/* Mid pulse ring */}
      <div
        className={cn(
          'absolute rounded-full border-2',
          isActive ? 'nc-ring-pulse-delayed' : '',
        )}
        style={{
          width: 180,
          height: 180,
          borderColor: ringColor,
          opacity: 0.3,
        }}
      />
      {/* Core blob */}
      <div
        className={cn(isSpeaking ? 'nc-blob' : '')}
        style={{
          width: 140,
          height: 140,
          borderRadius: '60% 40% 30% 70% / 60% 30% 70% 40%',
          background: `radial-gradient(circle at 35% 30%, ${ringColor}ee, ${ringColor}99)`,
          boxShadow: `0 0 60px ${ringColor}66, inset 0 2px 0 rgba(255,255,255,0.2)`,
        }}
      />
    </div>
  );
}

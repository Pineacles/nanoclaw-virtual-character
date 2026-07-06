import { useEffect, useState } from 'react';
import { cn } from '../lib/cn';
import { getAvatarUrl } from '../lib/api';
import { useGroupConfig } from '../hooks/useGroupConfig';

interface PersonaAvatarProps {
  size: number;
  className?: string;
  /** Letter shown when there's no avatar image. Defaults to the assistant's first initial. */
  fallbackInitial?: string;
}

/**
 * Persona avatar — renders `/api/avatar` (group's avatar.png/.jpg/.webp) when
 * present. Falls back to the existing gradient + initial look on 404/error,
 * so groups without an avatar file render exactly as before.
 */
export function PersonaAvatar({ size, className, fallbackInitial }: PersonaAvatarProps) {
  const { groupConfig } = useGroupConfig();
  const assistantName = groupConfig?.assistant?.name ?? '';
  const initial = (fallbackInitial ?? assistantName).charAt(0).toUpperCase();
  const [failed, setFailed] = useState(false);

  // Re-attempt the image if the avatar URL changes (e.g. token refresh).
  const src = getAvatarUrl();
  useEffect(() => {
    setFailed(false);
  }, [src]);

  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-full flex items-center justify-center text-white font-semibold flex-shrink-0 overflow-hidden',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: 'linear-gradient(135deg, var(--nc-accent), var(--nc-avatar-gradient-end))',
      }}
    >
      {failed ? (
        initial
      ) : (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

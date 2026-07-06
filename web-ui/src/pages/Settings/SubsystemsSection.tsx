import { cn } from '../../lib/cn';
import { SettingsCard } from './SettingsCard';
import { NCToggle } from './NCToggle';

const SUBSYSTEMS = [
  { key: 'memory', label: 'Memory' },
  { key: 'diary', label: 'Diary' },
  { key: 'mood', label: 'Mood system' },
  { key: 'emotional_state', label: 'Emotional state' },
  { key: 'schedule', label: 'Schedule', warning: true },
  { key: 'personality', label: 'Personality' },
  { key: 'relationship', label: 'Relationship' },
  { key: 'voice_call', label: 'Voice call' },
] as const;

type SubsystemKey = typeof SUBSYSTEMS[number]['key'];

interface SubsystemsHealth {
  enabled: boolean;
  healthy: boolean;
  missing_tasks?: string[];
}

interface SubsystemsSectionProps {
  features: Record<string, boolean>;
  featureHealth: Record<string, SubsystemsHealth>;
  onToggle: (key: string) => void;
  isMobile?: boolean;
}

/** Warning icon (inline SVG to avoid adding a new icon export) */
function WarningIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

export function SubsystemsSection({ features, featureHealth, onToggle, isMobile }: SubsystemsSectionProps) {
  return (
    <SettingsCard title="Subsystems" span={12}>
      <div className={cn(
        'grid gap-2.5',
        isMobile ? 'grid-cols-1' : 'grid-cols-4',
      )}>
        {SUBSYSTEMS.map((s) => {
          const isOn = features[s.key] ?? false;
          const health = featureHealth[s.key];
          const hasWarning = s.key === 'schedule' || (health && !health.healthy && health.enabled);
          return (
            <div
              key={s.key}
              className={cn(
                'flex items-center justify-between gap-2 px-3 py-2.5 rounded-[9px] border',
                'bg-nc-surface-alt border-nc-border-soft',
              )}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] text-nc-text font-medium">{s.label}</span>
                  {hasWarning && (
                    <span className="text-nc-warning flex">
                      <WarningIcon />
                    </span>
                  )}
                </div>
                {hasWarning && (
                  <div className="text-[10.5px] text-nc-warning-text mt-0.5">Setup needed</div>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isOn}
                aria-label={`Toggle ${s.label}`}
                onClick={() => onToggle(s.key)}
                className="nc-press cursor-pointer border-none bg-transparent p-0 flex-shrink-0"
              >
                <NCToggle on={isOn} />
              </button>
            </div>
          );
        })}
      </div>
    </SettingsCard>
  );
}

export type { SubsystemKey };
